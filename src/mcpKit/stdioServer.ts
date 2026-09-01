/**
 * @file MCP stdio JSON-RPC server 的公共实现。
 *
 * 三套 server（browser / vscode / wakeup）此前各自复制了同一份行缓冲、
 * 方法分派与 NDJSON 输出，这里收敛为一份，差异全部由 descriptor 承载。
 *
 * 约束：本文件运行在没有 `vscode` 的 MCP 子进程里，禁止静态 import 宿主模块，
 * 只允许 Node 内置模块与 `import type`；宿主实现由调用方注入或惰性 require。
 */

import { JSON_RPC_ERROR, type JsonRpcRequest, type JsonRpcResponse } from './jsonRpc';
import type { McpBridgeDescriptor } from './registry';
import { createToolNameGuard, type McpToolExecutor, type McpToolResult } from './types';

/** MCP stdio server 启动选项。 */
export interface McpStdioServerOptions<TName extends string = string, TResult = McpToolResult> {
    /** 该套桥的静态声明。 */
    descriptor: McpBridgeDescriptor<TName>;
    /** 实际执行工具的宿主执行器；缺省时使用返回 unavailableMessage 的兜底执行器。 */
    host?: McpToolExecutor<TName, TResult>;
    /** 标准输入；缺省使用 process.stdin。 */
    stdin?: NodeJS.ReadableStream;
    /** 标准输出；缺省使用 process.stdout。 */
    stdout?: NodeJS.WritableStream;
}

/** 最小 MCP stdio JSON-RPC server：行缓冲 + 标准方法分派 + NDJSON 输出。 */
export class McpStdioServer<TName extends string = string, TResult = McpToolResult> {
    /** 该套桥的静态声明。 */
    private readonly descriptor: McpBridgeDescriptor<TName>;

    /** 实际执行工具的宿主执行器。 */
    private readonly host: McpToolExecutor<TName, TResult | McpToolResult>;

    /** 工具名守卫，由 descriptor.schemas 生成。 */
    private readonly isToolName: (value: unknown) => value is TName;

    /** 标准输入流。 */
    private readonly stdin: NodeJS.ReadableStream;

    /** 标准输出流。 */
    private readonly stdout: NodeJS.WritableStream;

    /** stdin 行缓冲区。 */
    private buffer = '';

    /**
     * @param options 启动选项。
     */
    public constructor(options: McpStdioServerOptions<TName, TResult>) {
        this.descriptor = options.descriptor;
        this.host = options.host ?? createUnavailableHost(options.descriptor);
        this.isToolName = createToolNameGuard(options.descriptor.schemas);
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

    /** 把 buffer 中完整的 NDJSON 行依序处理，不完整的一行留待下个 chunk。 */
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
                error: { code: JSON_RPC_ERROR.PARSE_ERROR, message: `Parse error: ${String(err)}` }
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
            this.write({ jsonrpc: '2.0', id, error: { code: JSON_RPC_ERROR.INTERNAL_ERROR, message } });
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
                    serverInfo: { name: this.descriptor.serverInfoName, version: readExtensionVersion() }
                };
            case 'tools/list':
                return { tools: this.descriptor.schemas };
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
    private async handleToolCall(request: JsonRpcRequest): Promise<TResult | McpToolResult> {
        const params = (request.params && typeof request.params === 'object')
            ? request.params as Record<string, unknown>
            : {};
        const name = params.name;
        const args = (params.arguments && typeof params.arguments === 'object')
            ? params.arguments as Record<string, unknown>
            : {};

        if (!this.isToolName(name)) {
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
 * 读取扩展版本号用于 initialize 的 serverInfo。
 *
 * 走惰性 require 而非静态 import：编译产物在 out/ 下，package.json 的相对位置
 * 依赖构建布局，读不到时退回占位版本，不能让 server 起不来。
 *
 * @returns package.json 中的版本号，读取失败时返回 '0.0.0'。
 */
export function readExtensionVersion(): string {
    try {
        return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * 按 descriptor 与 env 中的 relay 端口装配并启动一个 stdio server。
 *
 * relay 端口缺失时使用返回 descriptor.unavailableMessage 的兜底执行器——
 * 工具仍会出现在 tools/list 中，但调用时明确报错，好过整组工具静默消失。
 *
 * @param descriptor 该套桥的静态声明。
 * @param options 启动选项；host 缺省时按 relay 端口决定。
 * @returns 已启动的 server 实例。
 */
export function startStdioServerFromEnv<TName extends string, TResult = McpToolResult>(
    descriptor: McpBridgeDescriptor<TName>,
    options: {
        /** 宿主执行器；缺省时按 relay 端口走 HTTP 转发。 */
        host?: McpToolExecutor<TName, TResult>;
        /** 标准输入；缺省使用 process.stdin。 */
        stdin?: NodeJS.ReadableStream;
        /** 标准输出；缺省使用 process.stdout。 */
        stdout?: NodeJS.WritableStream;
        /** relay 端口可用时创建转发执行器的工厂。 */
        createRelayHost?: (port: number) => McpToolExecutor<TName, TResult>;
    } = {}
): McpStdioServer<TName, TResult> {
    const port = Number(process.env[descriptor.relayPortEnv] || 0);
    const relayHost = port > 0 ? options.createRelayHost?.(port) : undefined;
    const server = new McpStdioServer<TName, TResult>({
        descriptor,
        host: options.host ?? relayHost,
        stdin: options.stdin,
        stdout: options.stdout
    });
    server.start();
    return server;
}

/**
 * 构造未接通 relay 时的兜底执行器。
 *
 * @param descriptor 该套桥的静态声明，提供说明文案。
 */
function createUnavailableHost<TName extends string>(
    descriptor: McpBridgeDescriptor<TName>
): McpToolExecutor<TName, McpToolResult> {
    return {
        execute: () => Promise.resolve({
            isError: true,
            content: [{ type: 'text' as const, text: descriptor.unavailableMessage }]
        })
    };
}
