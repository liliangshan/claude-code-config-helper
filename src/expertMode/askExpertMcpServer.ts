/**
 * @file in-process ask_expert MCP server。
 *
 * 自实现一个最小 MCP（Model Context Protocol）stdio JSON-RPC server，
 * 仅暴露一个工具 `ask_expert`。该 server 设计为：
 *
 * 1. 由扩展宿主进程直接 spawn 一个 Node 子进程运行本模块的 CLI 入口，
 *    Claude CLI 通过 `--mcp-config` 注入后即可通过 stdio 与之通信。
 * 2. 子进程通过环境变量拿到 Relay 端口、专家模型 id、auth token，
 *    自身在每次 tool call 时实例化 ExpertSubturnService 并执行一次 sub-turn。
 *
 * 该实现遵循 MCP 2024-11-05 spec 的最小子集：
 * - `initialize` / `initialized`
 * - `tools/list`
 * - `tools/call`
 * - `notifications/cancelled`
 */

import { ExpertSubturnService, type ExpertSubturnServiceDeps } from './expertSubturnService';
import { defaultExpertSubturnOptions } from './expertConfig';
import { readExtensionVersion } from '../mcpKit/stdioServer';

/** ask_expert 工具名（MCP 工具裸名，未加 mcp__askExpert__ 前缀）。 */
export const ASK_EXPERT_TOOL_NAME = 'ask_expert' as const;

/** ask_expert MCP server 在 Claude CLI mcpServers 注册时使用的 server 名。 */
export const ASK_EXPERT_MCP_SERVER_NAME = 'askExpert' as const;

/** Claude CLI 暴露给主模型时看到的完整工具名（含 mcp__<server>__ 前缀）。 */
export const ASK_EXPERT_FULL_TOOL_NAME = `mcp__${ASK_EXPERT_MCP_SERVER_NAME}__${ASK_EXPERT_TOOL_NAME}` as const;

/**
 * ask_expert MCP 工具的 JSON Schema 描述（参考 §5.2）。
 *
 * 该 schema 同时被 MCP server 自身的 tools/list 响应、以及 Relay 工具列表注入
 * （路径 P2 fallback）共用。
 */
export const ASK_EXPERT_TOOL_SCHEMA = {
    name: ASK_EXPERT_TOOL_NAME,
    description:
        'Delegate a single, self-contained engineering question to a stronger expert model. ' +
        'The expert receives ONLY the question text — no chat history. Use only when truly needed.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            question: {
                type: 'string' as const,
                description: 'A self-contained question / task description for the expert.'
            }
        },
        required: ['question']
    }
} as const;

/** 专家未配置时返回给主模型的固定提示文本。 */
export const NO_EXPERT_AVAILABLE_MESSAGE =
    'There is currently no available expert. Please answer the question yourself.';

/** JSON-RPC 2.0 请求结构（仅覆盖我们用到的字段）。 */
interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: number | string | null;
    method: string;
    params?: unknown;
}

/** JSON-RPC 2.0 响应结构。 */
interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

/** MCP server 启动选项。 */
export interface AskExpertMcpServerOptions {
    /** ExpertSubturnService 依赖项（端口、模型、配置读取）。 */
    deps: ExpertSubturnServiceDeps;
    /** 标准输入；缺省使用 process.stdin。 */
    stdin?: NodeJS.ReadableStream;
    /** 标准输出；缺省使用 process.stdout。 */
    stdout?: NodeJS.WritableStream;
}

/**
 * 一个最小 MCP stdio JSON-RPC server，只暴露 ask_expert 工具。
 *
 * 协议消息按 NDJSON（每行一条 JSON）传输——这是 Claude CLI 等 MCP host 的默认
 * 传输方式。无需额外引入 @modelcontextprotocol/sdk。
 */
export class AskExpertMcpServer {
    /** 实际执行专家 sub-turn 的服务。 */
    private readonly subturnService: ExpertSubturnService;

    /** 标准输入流。 */
    private readonly stdin: NodeJS.ReadableStream;

    /** 标准输出流。 */
    private readonly stdout: NodeJS.WritableStream;

    /** stdin 行缓冲区。 */
    private buffer = '';

    /** 是否已收到 initialized 通知（主机告知 init 完成）。 */
    private initialized = false;

    /** 正在运行的 sub-turn 取消控制器，按 request id 索引。 */
    private readonly inflight = new Map<number | string, AbortController>();

    /**
     * 创建 ask_expert MCP server。
     *
     * @param options 启动选项。
     */
    public constructor(options: AskExpertMcpServerOptions) {
        this.subturnService = new ExpertSubturnService(options.deps);
        this.stdin = options.stdin ?? process.stdin;
        this.stdout = options.stdout ?? process.stdout;
    }

    /**
     * 启动 server——开始监听 stdin。
     */
    public start(): void {
        this.stdin.setEncoding?.('utf-8');
        this.stdin.on('data', (chunk: string | Buffer) => {
            this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
            this.flushLines();
        });
        this.stdin.on('end', () => {
            this.flushLines();
        });
    }

    /**
     * 关闭 server——取消所有 in-flight sub-turn。
     */
    public dispose(): void {
        for (const ctrl of this.inflight.values()) {
            try {
                ctrl.abort();
            } catch {
                // ignore
            }
        }
        this.inflight.clear();
        this.subturnService.dispose();
    }

    /**
     * 将 buffer 中已完整的行依次喂给 handleRequest。
     */
    private flushLines(): void {
        let idx = this.buffer.indexOf('\n');
        while (idx >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line.length > 0) {
                void this.handleLine(line);
            }
            idx = this.buffer.indexOf('\n');
        }
    }

    /**
     * 处理单行 JSON-RPC 消息。
     */
    private async handleLine(line: string): Promise<void> {
        let request: JsonRpcRequest;
        try {
            request = JSON.parse(line) as JsonRpcRequest;
        } catch (err) {
            this.write({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: `Parse error: ${String(err)}` }
            });
            return;
        }

        if (request.method === 'notifications/initialized') {
            this.initialized = true;
            return;
        }

        if (request.method === 'notifications/cancelled') {
            const params = (request.params && typeof request.params === 'object')
                ? request.params as Record<string, unknown>
                : {};
            const requestId = params.requestId as number | string | undefined;
            if (requestId !== undefined) {
                const ctrl = this.inflight.get(requestId);
                ctrl?.abort();
                this.inflight.delete(requestId);
            }
            return;
        }

        const id = request.id ?? null;
        try {
            const result = await this.dispatch(request);
            if (id !== null) {
                this.write({ jsonrpc: '2.0', id, result });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.write({
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message }
            });
        }
    }

    /**
     * 按 method 分派 JSON-RPC 请求。
     */
    private async dispatch(request: JsonRpcRequest): Promise<unknown> {
        switch (request.method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'llsccai-ask-expert', version: readExtensionVersion() }
                };
            case 'tools/list':
                return {
                    tools: [
                        {
                            name: ASK_EXPERT_TOOL_SCHEMA.name,
                            description: ASK_EXPERT_TOOL_SCHEMA.description,
                            inputSchema: ASK_EXPERT_TOOL_SCHEMA.inputSchema
                        }
                    ]
                };
            case 'tools/call':
                return this.handleToolCall(request);
            default:
                throw new Error(`Method not found: ${request.method}`);
        }
    }

    /**
     * 处理 tools/call 请求；仅识别 ask_expert，其它工具名返回错误。
     */
    private async handleToolCall(request: JsonRpcRequest): Promise<unknown> {
        const params = (request.params && typeof request.params === 'object')
            ? request.params as Record<string, unknown>
            : {};
        const name = params.name;
        const args = (params.arguments && typeof params.arguments === 'object')
            ? params.arguments as Record<string, unknown>
            : {};

        if (name !== ASK_EXPERT_TOOL_NAME) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }]
            };
        }

        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) {
            return {
                isError: true,
                content: [{ type: 'text', text: '`question` is required and must be a non-empty string.' }]
            };
        }

        const id = request.id ?? `auto-${Date.now()}`;
        const controller = new AbortController();
        this.inflight.set(id, controller);

        try {
            const result = await this.subturnService.run({
                question,
                signal: controller.signal
            });
            if (result.failureReason === 'noModel') {
                return {
                    content: [{ type: 'text', text: NO_EXPERT_AVAILABLE_MESSAGE }]
                };
            }
            if (!result.ok) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: result.text || 'Expert sub-turn failed.' }]
                };
            }
            return {
                content: [{ type: 'text', text: result.text }]
            };
        } finally {
            this.inflight.delete(id);
        }
    }

    /**
     * 将一条 JSON-RPC 响应以 NDJSON 形式写入 stdout。
     */
    private write(response: JsonRpcResponse): void {
        this.stdout.write(`${JSON.stringify(response)}\n`);
    }
}

/**
 * 便捷工厂：用默认配置 + 给定依赖项启动 ask_expert MCP server 并阻塞当前进程。
 *
 * 子进程模式入口可直接调用：`startAskExpertMcpServer({ deps })`。
 */
export function startAskExpertMcpServer(options: AskExpertMcpServerOptions): AskExpertMcpServer {
    const server = new AskExpertMcpServer(options);
    server.start();
    return server;
}

/**
 * 返回内置 default 配置的副本，方便子进程入口在缺失某些环境变量时兜底。
 */
export function getDefaultExpertSubturnOptions() {
    return { ...defaultExpertSubturnOptions };
}
