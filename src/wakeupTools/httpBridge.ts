/**
 * @file llsccaiWakeup MCP 子进程到扩展宿主的 HTTP bridge。
 *
 * 本文件同时被 MCP 子进程与扩展宿主加载，因此**只能 `import type` 引用宿主侧模块**，
 * 真实依赖一律惰性 require——静态 import 链一旦拉进 `vscode`，子进程会直接崩溃，
 * 整组工具在模型侧静默消失（参考 3.2.23 browser 工具事故）。
 */

import * as http from 'http';

import type { WakeupToolExecutor, WakeupToolResult } from './wakeupHost';
import { isWakeupToolName, type WakeupToolName } from './tools';

/** 定时唤醒工具 HTTP bridge 路径。 */
export const WAKEUP_TOOL_HTTP_PATH = '/llsccai/wakeup-tool';

/** 定时唤醒工具 relay port 环境变量名。 */
export const WAKEUP_TOOL_RELAY_PORT_ENV = 'LLS_WAKEUP_TOOL_RELAY_PORT';

/** HTTP bridge 最大请求 body 大小。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 定时唤醒工具 HTTP 请求体。 */
export interface WakeupToolHttpRequestBody {
    /** 工具裸名。 */
    name: WakeupToolName;
    /** 工具入参。 */
    arguments?: Record<string, unknown>;
}

/** 子进程侧执行器：通过 HTTP POST 转发给扩展宿主。 */
export class WakeupHttpForwardingHost implements WakeupToolExecutor {
    /**
     * @param port 扩展宿主 relay 服务端口。
     */
    public constructor(private readonly port: number) {}

    /**
     * 把工具调用 POST 给宿主 relay 并返回结果。
     *
     * @param name 工具裸名。
     * @param args 工具入参。
     * @returns 宿主返回的工具结果。
     */
    public async execute(name: WakeupToolName, args: Record<string, unknown> = {}): Promise<WakeupToolResult> {
        const body: WakeupToolHttpRequestBody = { name, arguments: args };
        return await postJson<WakeupToolResult>(this.port, body);
    }
}

/**
 * 创建子进程侧 HTTP 转发宿主。
 *
 * @param port relay 端口。
 * @returns 执行器实例。
 */
export function createWakeupHttpHost(port: number): WakeupToolExecutor {
    return new WakeupHttpForwardingHost(port);
}

/**
 * 创建扩展宿主侧 relay handler。
 *
 * 与 vscodeTools 版本的差异：`host` 是必填参数，不能惰性 new 一个默认宿主——
 * WakeupHost 依赖持有 timer 与磁盘状态的同一个 WakeupScheduler 实例，
 * 另起一个宿主会导致下单的闹钟无人触发。
 *
 * @param host 宿主执行器（由 extension.ts 注入）。
 * @returns handler，路径不匹配时返回 false 让后续 handler 继续处理。
 */
export function createWakeupToolRelayHandler(host: WakeupToolExecutor) {
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
        const path = (req.url ?? '').split('?', 1)[0];
        if (path !== WAKEUP_TOOL_HTTP_PATH) return false;
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            writeJson(res, 405, { error: 'method_not_allowed' });
            return true;
        }
        try {
            const rawBody = await readRequestBody(req);
            const body = JSON.parse(rawBody) as { name?: unknown; arguments?: unknown };
            if (!isWakeupToolName(body.name)) {
                writeJson(res, 400, { error: `unknown_tool: ${String(body.name)}` });
                return true;
            }
            const args = (body.arguments && typeof body.arguments === 'object')
                ? body.arguments as Record<string, unknown>
                : {};
            const result = await host.execute(body.name, args);
            writeJson(res, 200, result);
        } catch (err) {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
    };
}

/**
 * 发送 JSON POST 请求并解析 JSON 响应。
 *
 * @param port 目标端口。
 * @param body 请求体。
 * @returns 解析后的响应体。
 */
function postJson<T>(port: number, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: WAKEUP_TOOL_HTTP_PATH,
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

/**
 * 读取 HTTP 请求 body 并限制大小。
 *
 * @param req 请求对象。
 * @returns body 文本。
 */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.setEncoding('utf-8');
        req.on('data', (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Wakeup tool request body is too large.'));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

/**
 * 写出 JSON HTTP 响应。
 *
 * @param res 响应对象。
 * @param statusCode HTTP 状态码。
 * @param body 响应体。
 */
function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}
