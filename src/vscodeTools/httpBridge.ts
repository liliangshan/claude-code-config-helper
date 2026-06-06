/** @file llsccaiVscode MCP 子行程到擴充宿主的 HTTP bridge。 */

import * as http from 'http';

import type { VscodeToolExecutor, VscodeToolResult } from './diagnosticsHost';
import { isVscodeToolName, type VscodeToolName } from './tools';

/** VS Code 工具 HTTP bridge 路徑。 */
export const VSCODE_TOOL_HTTP_PATH = '/llsccai/vscode-tool';

/** VS Code 工具 relay port 環境變數。 */
export const VSCODE_TOOL_RELAY_PORT_ENV = 'LLS_VSCODE_TOOL_RELAY_PORT';

/** HTTP bridge 最大請求 body 大小。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** VS Code 工具 HTTP 請求體。 */
export interface VscodeToolHttpRequestBody {
    /** 工具裸名。 */
    name: VscodeToolName;
    /** 工具入參。 */
    arguments?: Record<string, unknown>;
}

/** 子行程側執行器：透過 HTTP POST 轉發給擴充宿主。 */
export class VscodeHttpForwardingHost implements VscodeToolExecutor {
    /** 建立 VS Code HTTP 轉發宿主。 */
    public constructor(private readonly port: number) {}

    /** 將工具呼叫 POST 給宿主 relay 並回傳結果。 */
    public async execute(name: VscodeToolName, args: Record<string, unknown> = {}): Promise<VscodeToolResult> {
        const body: VscodeToolHttpRequestBody = { name, arguments: args };
        return await postJson<VscodeToolResult>(this.port, body);
    }
}

/** 建立子行程側 VS Code HTTP 轉發宿主。 */
export function createVscodeHttpHost(port: number): VscodeToolExecutor {
    return new VscodeHttpForwardingHost(port);
}

/** 建立擴充宿主側 VS Code 工具 relay handler。 */
export function createVscodeToolRelayHandler(host?: VscodeToolExecutor) {
    // DiagnosticsHost 顶层 import 真实 `vscode`，仅在宿主侧未注入 host 时惰性
    // require，避免本模块被子进程入口链拉入时因缺少 vscode 而崩溃。
    const resolvedHost = host
        ?? new (require('./diagnosticsHost') as typeof import('./diagnosticsHost')).DiagnosticsHost();
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
        const path = (req.url ?? '').split('?', 1)[0];
        if (path !== VSCODE_TOOL_HTTP_PATH) return false;
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            writeJson(res, 405, { error: 'method_not_allowed' });
            return true;
        }
        try {
            const rawBody = await readRequestBody(req);
            const body = JSON.parse(rawBody) as { name?: unknown; arguments?: unknown };
            if (!isVscodeToolName(body.name)) {
                writeJson(res, 400, { error: `unknown_tool: ${String(body.name)}` });
                return true;
            }
            const args = (body.arguments && typeof body.arguments === 'object')
                ? body.arguments as Record<string, unknown>
                : {};
            const result = await resolvedHost.execute(body.name, args);
            writeJson(res, 200, result);
        } catch (err) {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
    };
}

/** 送出 JSON POST 請求並解析 JSON 回應。 */
function postJson<T>(port: number, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: VSCODE_TOOL_HTTP_PATH,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if ((res.statusCode ?? 500) >= 400) {
                    reject(new Error(data || `HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data) as T);
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

/** 讀取 HTTP 請求 body 並限制大小。 */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.setEncoding('utf-8');
        req.on('data', (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > MAX_BODY_BYTES) {
                reject(new Error('VS Code tool request body is too large.'));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

/** 寫出 JSON HTTP 回應。 */
function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}
