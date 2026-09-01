/**
 * @file MCP 子进程与扩展宿主之间的 HTTP bridge 公共实现。
 *
 * 三套桥此前各自复制了一份 postJson / readRequestBody / writeJson 与
 * relay handler 主体，这里收敛为一份，差异全部由 descriptor 承载。
 *
 * 约束：本文件同时被扩展宿主与 MCP 子进程加载，禁止静态 import 宿主模块
 * （尤其是 `vscode`），只允许 Node 内置模块与 `import type`。宿主侧实现
 * 一律通过调用方注入的 resolveHost 回调惰性获取。
 */

import * as http from 'http';

import type { McpBridgeDescriptor } from './registry';
import type { McpToolExecutor } from './types';
import { createToolNameGuard } from './types';

/** HTTP bridge 最大请求 body 大小。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** HTTP bridge 请求体：工具裸名 + 入参。 */
export interface McpToolHttpRequestBody<TName extends string = string> {
    /** 工具裸名。 */
    name: TName;
    /** 工具入参。 */
    arguments?: Record<string, unknown>;
}

/**
 * 发送 JSON POST 请求并解析 JSON 响应。
 *
 * @param port 目标端口。
 * @param path relay HTTP 路径。
 * @param body 请求体。
 * @returns 解析后的响应体。
 */
function postJson<T>(port: number, path: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path,
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
 * @param tooLargeMessage 超限时抛出的错误文案。
 * @returns body 文本。
 */
function readRequestBody(req: http.IncomingMessage, tooLargeMessage: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.setEncoding('utf-8');
        req.on('data', (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > MAX_BODY_BYTES) {
                reject(new Error(tooLargeMessage));
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

/**
 * 创建子进程侧 HTTP 转发执行器：把 execute 转成 POST 给扩展宿主 relay。
 *
 * @param descriptor 该套桥的静态声明，提供 relay HTTP 路径。
 * @param port 扩展宿主 relay 服务端口。
 * @returns 与宿主侧同接口的执行器。
 */
export function createHttpForwardingHost<TName extends string, TResult>(
    descriptor: McpBridgeDescriptor<TName>,
    port: number
): McpToolExecutor<TName, TResult> {
    return {
        execute: (name: TName, args: Record<string, unknown> = {}) =>
            postJson<TResult>(port, descriptor.httpPath, { name, arguments: args })
    };
}

/**
 * 创建扩展宿主侧 relay handler。
 *
 * `resolveHost` 用惰性回调统一两种形态：browser / vscode 在未注入 host 时
 * 回调内 require 默认宿主，wakeup 直接返回外部注入的实例（其 timer 必须活在
 * 扩展宿主的同一个 WakeupScheduler 上）。回调只在首次请求时求值一次。
 *
 * @param descriptor 该套桥的静态声明。
 * @param resolveHost 宿主执行器的惰性解析回调。
 * @returns handler，路径不匹配时返回 false 让后续 handler 继续处理。
 */
export function createToolRelayHandler<TName extends string>(
    descriptor: McpBridgeDescriptor<TName>,
    resolveHost: () => McpToolExecutor<TName, unknown>
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
    const isToolName = createToolNameGuard(descriptor.schemas);
    let host: McpToolExecutor<TName, unknown> | undefined;
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
        const path = (req.url ?? '').split('?', 1)[0];
        if (path !== descriptor.httpPath) return false;
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            writeJson(res, 405, { error: 'method_not_allowed' });
            return true;
        }
        try {
            const rawBody = await readRequestBody(req, descriptor.bodyTooLargeMessage);
            const body = JSON.parse(rawBody) as { name?: unknown; arguments?: unknown };
            if (!isToolName(body.name)) {
                writeJson(res, 400, { error: `unknown_tool: ${String(body.name)}` });
                return true;
            }
            const args = (body.arguments && typeof body.arguments === 'object')
                ? body.arguments as Record<string, unknown>
                : {};
            host ??= resolveHost();
            writeJson(res, 200, await host.execute(body.name, args));
        } catch (err) {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
    };
}
