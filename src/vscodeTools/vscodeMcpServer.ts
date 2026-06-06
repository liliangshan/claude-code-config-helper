/** @file VS Code 工具 MCP server。 */

import type { VscodeToolExecutor, VscodeToolResult } from './diagnosticsHost';
import { createVscodeHttpHost, VSCODE_TOOL_RELAY_PORT_ENV } from './httpBridge';
import { isVscodeToolName, VSCODE_TOOL_SCHEMAS } from './tools';

/** JSON-RPC 2.0 請求結構。 */
interface JsonRpcRequest {
    /** JSON-RPC 版本。 */
    jsonrpc: '2.0';
    /** 請求 id；通知可缺省。 */
    id?: number | string | null;
    /** 方法名。 */
    method: string;
    /** 方法參數。 */
    params?: unknown;
}

/** JSON-RPC 2.0 回應結構。 */
interface JsonRpcResponse {
    /** JSON-RPC 版本。 */
    jsonrpc: '2.0';
    /** 請求 id。 */
    id: number | string | null;
    /** 成功結果。 */
    result?: unknown;
    /** 錯誤物件。 */
    error?: { code: number; message: string; data?: unknown };
}

/** VS Code MCP server 啟動選項。 */
export interface VscodeMcpServerOptions {
    /** VS Code 工具宿主執行器。 */
    host?: VscodeToolExecutor;
    /** 標準輸入；缺省使用 process.stdin。 */
    stdin?: NodeJS.ReadableStream;
    /** 標準輸出；缺省使用 process.stdout。 */
    stdout?: NodeJS.WritableStream;
}

/** 最小 MCP stdio JSON-RPC server，暴露 VS Code 工具。 */
export class VscodeMcpServer {
    /** 實際執行 VS Code 工具的宿主執行器。 */
    private readonly host: VscodeToolExecutor;

    /** 標準輸入流。 */
    private readonly stdin: NodeJS.ReadableStream;

    /** 標準輸出流。 */
    private readonly stdout: NodeJS.WritableStream;

    /** stdin 行緩衝區。 */
    private buffer = '';

    /** 是否已收到 initialized 通知。 */
    private initialized = false;

    /** 建立 VS Code MCP server。 */
    public constructor(options: VscodeMcpServerOptions = {}) {
        // DiagnosticsHost 顶层 import 了真实 `vscode`，子进程入口（claude CLI 以
        // `node -e require(...)` 启动）没有 vscode 运行时，因此只在确实需要进程内
        // fallback 时才惰性 require，避免模块加载阶段就因找不到 vscode 而崩溃。
        this.host = options.host ?? new (require('./diagnosticsHost') as typeof import('./diagnosticsHost')).DiagnosticsHost();
        this.stdin = options.stdin ?? process.stdin;
        this.stdout = options.stdout ?? process.stdout;
    }

    /** 啟動 server 並開始監聽 stdin。 */
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

    /** 關閉 server。 */
    public dispose(): void {
        this.buffer = '';
    }

    /** 將 buffer 中完整的 NDJSON 行依序處理。 */
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

    /** 處理單行 JSON-RPC 訊息。 */
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

    /** 依 method 分派 JSON-RPC 請求。 */
    private async dispatch(request: JsonRpcRequest): Promise<unknown> {
        switch (request.method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'llsccai-vscode', version: '1.0.0' }
                };
            case 'tools/list':
                return { tools: VSCODE_TOOL_SCHEMAS };
            case 'tools/call':
                return this.handleToolCall(request);
            default:
                throw new Error(`Method not found: ${request.method}`);
        }
    }

    /** 處理 tools/call 請求並轉發給 VS Code 工具宿主。 */
    private async handleToolCall(request: JsonRpcRequest): Promise<VscodeToolResult> {
        const params = (request.params && typeof request.params === 'object')
            ? request.params as Record<string, unknown>
            : {};
        const name = params.name;
        const args = (params.arguments && typeof params.arguments === 'object')
            ? params.arguments as Record<string, unknown>
            : {};

        if (!isVscodeToolName(name)) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }]
            };
        }
        return this.host.execute(name, args);
    }

    /** 將一條 JSON-RPC 回應以 NDJSON 形式寫入 stdout。 */
    private write(response: JsonRpcResponse): void {
        this.stdout.write(`${JSON.stringify(response)}\n`);
    }
}

/** 啟動 VS Code MCP server 並返回實例。 */
export function startVscodeMcpServer(options: VscodeMcpServerOptions = {}): VscodeMcpServer {
    const port = Number(process.env[VSCODE_TOOL_RELAY_PORT_ENV] || 0);
    const server = new VscodeMcpServer({
        ...options,
        host: options.host ?? (port > 0 ? createVscodeHttpHost(port) : undefined)
    });
    server.start();
    return server;
}

if (require.main === module) {
    startVscodeMcpServer();
}
