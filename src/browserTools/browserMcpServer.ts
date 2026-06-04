/** @file 浏览器工具 MCP server。 */

import { BrowserToolHost, type BrowserToolExecutor, type BrowserToolResult } from './browserToolHost';
import { createBrowserHttpHost, BROWSER_TOOL_RELAY_PORT_ENV } from './httpBridge';
import { BROWSER_TOOL_SCHEMAS, isBrowserToolName } from './tools';

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

/** BrowserMcpServer 启动选项。 */
export interface BrowserMcpServerOptions {
    /** 浏览器工具宿主执行器。 */
    host?: BrowserToolExecutor;
    /** 标准输入；缺省使用 process.stdin。 */
    stdin?: NodeJS.ReadableStream;
    /** 标准输出；缺省使用 process.stdout。 */
    stdout?: NodeJS.WritableStream;
}

/** 一个最小 MCP stdio JSON-RPC server，暴露 browser_* 工具全集。 */
export class BrowserMcpServer {
    /** 实际执行浏览器工具的宿主执行器。 */
    private readonly host: BrowserToolExecutor;

    /** 标准输入流。 */
    private readonly stdin: NodeJS.ReadableStream;

    /** 标准输出流。 */
    private readonly stdout: NodeJS.WritableStream;

    /** stdin 行缓冲区。 */
    private buffer = '';

    /** 是否已收到 initialized 通知。 */
    private initialized = false;

    /** 创建 browser MCP server。 */
    public constructor(options: BrowserMcpServerOptions = {}) {
        this.host = options.host ?? new BrowserToolHost();
        this.stdin = options.stdin ?? process.stdin;
        this.stdout = options.stdout ?? process.stdout;
    }

    /** 启动 server，开始监听 stdin。 */
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

    /** 将 buffer 中完整的 NDJSON 行依次处理。 */
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

    /** 处理单行 JSON-RPC 消息。 */
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

    /** 按 method 分派 JSON-RPC 请求。 */
    private async dispatch(request: JsonRpcRequest): Promise<unknown> {
        switch (request.method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'llsccai-browser', version: '1.0.0' }
                };
            case 'tools/list':
                return { tools: BROWSER_TOOL_SCHEMAS };
            case 'tools/call':
                return this.handleToolCall(request);
            default:
                throw new Error(`Method not found: ${request.method}`);
        }
    }

    /** 处理 tools/call 请求并转发给 BrowserToolHost。 */
    private async handleToolCall(request: JsonRpcRequest): Promise<BrowserToolResult> {
        const params = (request.params && typeof request.params === 'object')
            ? request.params as Record<string, unknown>
            : {};
        const name = params.name;
        const args = (params.arguments && typeof params.arguments === 'object')
            ? params.arguments as Record<string, unknown>
            : {};

        if (!isBrowserToolName(name)) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }]
            };
        }
        return this.host.execute(name, args);
    }

    /** 将一条 JSON-RPC 响应以 NDJSON 形式写入 stdout。 */
    private write(response: JsonRpcResponse): void {
        this.stdout.write(`${JSON.stringify(response)}\n`);
    }
}

/** 启动 browser MCP server 并返回实例。 */
export function startBrowserMcpServer(options: BrowserMcpServerOptions = {}): BrowserMcpServer {
    const port = Number(process.env[BROWSER_TOOL_RELAY_PORT_ENV] || 0);
    const server = new BrowserMcpServer({
        ...options,
        host: options.host ?? (port > 0 ? createBrowserHttpHost(port) : undefined)
    });
    server.start();
    return server;
}

if (require.main === module) {
    startBrowserMcpServer();
}
