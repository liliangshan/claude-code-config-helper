/** @file 浏览器 MCP 子进程到扩展宿主的 HTTP bridge（工具式协议 {name, arguments}）。 */

import * as http from 'http';

// 本模块同时被扩展宿主和独立的 MCP 子进程加载，而 browserToolHost 会链式引入
// logger → require('vscode')，子进程里没有该模块。因此只保留类型导入，
// 真正需要 BrowserToolHost 的宿主侧路径再惰性 require。
import type { BrowserToolExecutor, BrowserToolResult } from './browserToolHost';
import type { BrowserSessionStore } from './sessionStore';
import { isBrowserToolName, type BrowserToolName } from './tools';

export const BROWSER_TOOL_HTTP_PATH = '/llsccai/browser-tool';
export const BROWSER_TOOL_RELAY_PORT_ENV = 'LLS_BROWSER_TOOL_RELAY_PORT';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** HTTP bridge 请求体：工具裸名 + 入参。 */
export interface BrowserToolHttpRequestBody {
    /** 工具裸名。 */
    name: BrowserToolName;
    /** 工具入参。 */
    arguments?: Record<string, unknown>;
}

/** 子进程侧执行器：把 execute 转成 HTTP POST 给扩展宿主 relay。 */
export class BrowserHttpForwardingHost implements BrowserToolExecutor {
    /** 创建转发宿主。 */
    public constructor(private readonly port: number) {}

    /** 把工具调用 POST 给宿主 relay，返回宿主侧 BrowserToolResult。 */
    public async execute(name: BrowserToolName, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
        const body: BrowserToolHttpRequestBody = { name, arguments: args };
        return await postJson<BrowserToolResult>(this.port, body);
    }
}

/** 创建子进程侧 HTTP 转发宿主。 */
export function createBrowserHttpHost(port: number): BrowserToolExecutor {
    return new BrowserHttpForwardingHost(port);
}

/** 创建扩展宿主侧 relay handler，用真实 BrowserToolHost 执行工具。 */
export function createBrowserToolRelayHandler(
    host?: BrowserToolExecutor,
    sessionStore?: BrowserSessionStore
) {
    const executor = host ?? new (require('./browserToolHost') as typeof import('./browserToolHost')).BrowserToolHost({ sessionStore });
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
        const path = (req.url ?? '').split('?', 1)[0];
        if (path !== BROWSER_TOOL_HTTP_PATH) {
            return false;
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            writeJson(res, 405, { error: 'method_not_allowed' });
            return true;
        }
        try {
            const rawBody = await readRequestBody(req);
            const body = JSON.parse(rawBody) as { name?: unknown; arguments?: unknown };
            if (!isBrowserToolName(body.name)) {
                writeJson(res, 400, { error: `unknown_tool: ${String(body.name)}` });
                return true;
            }
            const args = (body.arguments && typeof body.arguments === 'object')
                ? body.arguments as Record<string, unknown>
                : {};
            const result = await executor.execute(body.name, args);
            writeJson(res, 200, result);
        } catch (err) {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
    };
}

function postJson<T>(port: number, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: BROWSER_TOOL_HTTP_PATH,
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

function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.setEncoding('utf-8');
        req.on('data', (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Browser tool request body is too large.'));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}
