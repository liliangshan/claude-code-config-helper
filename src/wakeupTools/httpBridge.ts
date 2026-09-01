/**
 * @file llsccaiWakeup MCP 子进程到扩展宿主的 HTTP bridge。
 *
 * 本文件同时被 MCP 子进程与扩展宿主加载，因此**只能 `import type` 引用宿主侧模块**，
 * 真实依赖一律惰性 require——静态 import 链一旦拉进 `vscode`，子进程会直接崩溃，
 * 整组工具在模型侧静默消失（参考 3.2.23 browser 工具事故）。
 */

import type * as http from 'http';

import type { WakeupToolExecutor, WakeupToolResult } from './wakeupHost';
import type { WakeupToolName } from './tools';
import { WAKEUP_BRIDGE } from './bridge';
import { createHttpForwardingHost, createToolRelayHandler } from '../mcpKit/httpBridge';

/** 定时唤醒工具 HTTP bridge 路径。 */
export const WAKEUP_TOOL_HTTP_PATH = WAKEUP_BRIDGE.httpPath;

/** 定时唤醒工具 relay port 环境变量名。 */
export const WAKEUP_TOOL_RELAY_PORT_ENV = WAKEUP_BRIDGE.relayPortEnv;

/** 定时唤醒工具 HTTP 请求体。 */
export interface WakeupToolHttpRequestBody {
    /** 工具裸名。 */
    name: WakeupToolName;
    /** 工具入参。 */
    arguments?: Record<string, unknown>;
}

/**
 * 创建子进程侧 HTTP 转发宿主。
 *
 * @param port relay 端口。
 * @returns 执行器实例。
 */
export function createWakeupHttpHost(port: number): WakeupToolExecutor {
    return createHttpForwardingHost<WakeupToolName, WakeupToolResult>(WAKEUP_BRIDGE, port);
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
export function createWakeupToolRelayHandler(
    host: WakeupToolExecutor
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
    return createToolRelayHandler(WAKEUP_BRIDGE, () => host);
}
