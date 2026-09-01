/** @file 浏览器 MCP 子进程到扩展宿主的 HTTP bridge（工具式协议 {name, arguments}）。 */

import type * as http from 'http';

// 本模块同时被扩展宿主和独立的 MCP 子进程加载，而 browserToolHost 会链式引入
// logger → require('vscode')，子进程里没有该模块。因此只保留类型导入，
// 真正需要 BrowserToolHost 的宿主侧路径再惰性 require。
import type { BrowserToolExecutor, BrowserToolResult } from './browserToolHost';
import type { BrowserSessionStore } from './sessionStore';
import type { BrowserToolName } from './tools';
import { BROWSER_BRIDGE } from './bridge';
import { createHttpForwardingHost, createToolRelayHandler } from '../mcpKit/httpBridge';

export const BROWSER_TOOL_HTTP_PATH = BROWSER_BRIDGE.httpPath;
export const BROWSER_TOOL_RELAY_PORT_ENV = BROWSER_BRIDGE.relayPortEnv;

/** HTTP bridge 请求体：工具裸名 + 入参。 */
export interface BrowserToolHttpRequestBody {
    /** 工具裸名。 */
    name: BrowserToolName;
    /** 工具入参。 */
    arguments?: Record<string, unknown>;
}

/** 创建子进程侧 HTTP 转发宿主。 */
export function createBrowserHttpHost(port: number): BrowserToolExecutor {
    return createHttpForwardingHost<BrowserToolName, BrowserToolResult>(BROWSER_BRIDGE, port);
}

/**
 * 创建扩展宿主侧 relay handler，用真实 BrowserToolHost 执行工具。
 *
 * @param host 宿主执行器；缺省时惰性 require 默认的 BrowserToolHost。
 * @param sessionStore 浏览器会话存储，仅在需要新建默认宿主时使用。
 */
export function createBrowserToolRelayHandler(
    host?: BrowserToolExecutor,
    sessionStore?: BrowserSessionStore
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
    return createToolRelayHandler(BROWSER_BRIDGE, () => host
        ?? new (require('./browserToolHost') as typeof import('./browserToolHost')).BrowserToolHost({ sessionStore }));
}
