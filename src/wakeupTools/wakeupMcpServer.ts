/**
 * @file 定时唤醒工具 MCP server（stdio JSON-RPC 子进程入口）。
 *
 * 由 claude CLI 以 `node -e require(...).startWakeupMcpServer()` 启动，
 * 进程内没有 vscode 运行时，因此本文件只能 `import type` 引用宿主侧模块。
 */

import type { WakeupToolExecutor } from './wakeupHost';
import type { WakeupToolName } from './tools';
import { WAKEUP_BRIDGE } from './bridge';
import { createWakeupHttpHost } from './httpBridge';
import { McpStdioServer, startStdioServerFromEnv } from '../mcpKit/stdioServer';

/** 定时唤醒 MCP server 启动选项。 */
export interface WakeupMcpServerOptions {
    /** 工具宿主执行器；缺省时由 relay 端口决定。 */
    host?: WakeupToolExecutor;
    /** 标准输入；缺省使用 process.stdin。 */
    stdin?: NodeJS.ReadableStream;
    /** 标准输出；缺省使用 process.stdout。 */
    stdout?: NodeJS.WritableStream;
}

/** 最小 MCP stdio JSON-RPC server，暴露定时唤醒工具。 */
export class WakeupMcpServer extends McpStdioServer<WakeupToolName> {
    /**
     * @param options 启动选项。
     */
    public constructor(options: WakeupMcpServerOptions = {}) {
        super({ ...options, descriptor: WAKEUP_BRIDGE });
    }
}

/**
 * 启动定时唤醒 MCP server。
 *
 * relay 端口缺失时走 mcpKit 的兜底执行器——工具仍会出现在 tools/list 中，
 * 但调用时明确报错，好过整组工具静默消失。
 *
 * @param options 启动选项。
 * @returns server 实例。
 */
export function startWakeupMcpServer(options: WakeupMcpServerOptions = {}) {
    return startStdioServerFromEnv(WAKEUP_BRIDGE, { ...options, createRelayHost: createWakeupHttpHost });
}

if (require.main === module) {
    startWakeupMcpServer();
}
