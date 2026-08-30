/**
 * @file 定时唤醒工具 MCP server（stdio JSON-RPC 子进程入口）。
 *
 * 由 claude CLI 以 `node -e require(...).startWakeupMcpServer()` 启动，
 * 进程内没有 vscode 运行时，因此本文件只能 `import type` 引用宿主侧模块。
 */

import type { WakeupToolExecutor, WakeupToolResult } from './wakeupHost';
import { createWakeupHttpHost, WAKEUP_TOOL_RELAY_PORT_ENV } from './httpBridge';
import { isWakeupToolName, WAKEUP_TOOL_SCHEMAS } from './tools';

/** JSON-RPC 2.0 请求结构。 */
interface JsonRpcRequest {
    /** JSON-RPC 版本。 */
    jsonrpc: '2.0';
    /** 请求 id；通知可缺省。 */
    id?: number | string | null;
    /** 方法名。 */
    method: string;
    /** 方法参数。 */
    params?: unknown;
}

/** JSON-RPC 2.0 响应结构。 */
interface JsonRpcResponse {
    /** JSON-RPC 版本。 */
    jsonrpc: '2.0';
    /** 请求 id。 */
    id: number | string | null;
    /** 成功结果。 */
    result?: unknown;
    /** 错误对象。 */
    error?: { code: number; message: string; data?: unknown };
}

/** 定时唤醒 MCP server 启动选项。 */
export interface WakeupMcpServerOptions {
    /** 工具宿主执行器；缺省时由 relay 端口决定。 */
    host?: WakeupToolExecutor;
    /** 标准输入；缺省使用 process.stdin。 */
    stdin?: NodeJS.ReadableStream;
    /** 标准输出；缺省使用 process.stdout。 */
    stdout?: NodeJS.WritableStream;
}

/**
 * 未接通扩展宿主 relay 时的兜底执行器。
 *
 * 与 vscodeTools 不同，这里没有进程内 fallback：定时器必须活在扩展宿主，
 * 子进程内起的 timer 会随 MCP 进程退出而消失。
 */
const UNAVAILABLE_HOST: WakeupToolExecutor = {
    execute: () => Promise.resolve({
        isError: true,
        content: [{ type: 'text', text: 'Wakeup tools require the extension host relay.' }]
    })
};

/** 最小 MCP stdio JSON-RPC server，暴露定时唤醒工具。 */
export class WakeupMcpServer {
    /** 实际执行工具的宿主执行器。 */
    private readonly host: WakeupToolExecutor;

    /** 标准输入流。 */
    private readonly stdin: NodeJS.ReadableStream;

    /** 标准输出流。 */
    private readonly stdout: NodeJS.WritableStream;

    /** stdin 行缓冲区。 */
    private buffer = '';

    /**
     * @param options 启动选项。
     */
    public constructor(options: WakeupMcpServerOptions = {}) {
        this.host = options.host ?? UNAVAILABLE_HOST;
        this.stdin = options.stdin ?? process.stdin;
        this.stdout = options.stdout ?? process.stdout;
    }

    /** 启动 server 并开始监听 stdin。 */
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

    /** 关闭 server。 */
    public dispose(): void {
        this.buffer = '';
    }

    /** 把 buffer 中完整的 NDJSON 行依序处理。 */
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
     *
     * @param line 一行 NDJSON 文本。
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

        if (request.method === 'notifications/initialized') return;
        if (request.method === 'notifications/cancelled') return;

        const id = request.id ?? null;
        try {
            const result = await this.dispatch(request);
            if (id !== null) this.write({ jsonrpc: '2.0', id, result });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.write({ jsonrpc: '2.0', id, error: { code: -32603, message } });
        }
    }

    /**
     * 按 method 分派 JSON-RPC 请求。
     *
     * @param request JSON-RPC 请求。
     * @returns 方法结果。
     */
    private async dispatch(request: JsonRpcRequest): Promise<unknown> {
        switch (request.method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'llsccai-wakeup', version: '1.0.0' }
                };
            case 'tools/list':
                return { tools: WAKEUP_TOOL_SCHEMAS };
            case 'tools/call':
                return this.handleToolCall(request);
            default:
                throw new Error(`Method not found: ${request.method}`);
        }
    }

    /**
     * 处理 tools/call 请求并转发给宿主执行器。
     *
     * @param request JSON-RPC 请求。
     * @returns 工具结果。
     */
    private async handleToolCall(request: JsonRpcRequest): Promise<WakeupToolResult> {
        const params = (request.params && typeof request.params === 'object')
            ? request.params as Record<string, unknown>
            : {};
        const name = params.name;
        const args = (params.arguments && typeof params.arguments === 'object')
            ? params.arguments as Record<string, unknown>
            : {};

        if (!isWakeupToolName(name)) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }]
            };
        }
        return this.host.execute(name, args);
    }

    /**
     * 把一条 JSON-RPC 响应以 NDJSON 形式写入 stdout。
     *
     * @param response 响应对象。
     */
    private write(response: JsonRpcResponse): void {
        this.stdout.write(`${JSON.stringify(response)}\n`);
    }
}

/**
 * 启动定时唤醒 MCP server。
 *
 * relay 端口缺失时使用 `UNAVAILABLE_HOST`——工具仍会出现在 tools/list 中，
 * 但调用时明确报错，好过整组工具静默消失。
 *
 * @param options 启动选项。
 * @returns server 实例。
 */
export function startWakeupMcpServer(options: WakeupMcpServerOptions = {}): WakeupMcpServer {
    const port = Number(process.env[WAKEUP_TOOL_RELAY_PORT_ENV] || 0);
    const server = new WakeupMcpServer({
        ...options,
        host: options.host ?? (port > 0 ? createWakeupHttpHost(port) : undefined)
    });
    server.start();
    return server;
}

if (require.main === module) {
    startWakeupMcpServer();
}
