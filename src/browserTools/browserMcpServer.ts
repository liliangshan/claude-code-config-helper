/**
 * @file browser 工具 MCP server（stdio JSON-RPC 子进程入口）。
 *
 * 由 claude CLI 以 `node -e require(...).startBrowserMcpServer()` 启动，
 * 进程内没有 vscode 运行时，因此本文件只能 `import type` 引用宿主侧模块。
 */

import type { BrowserToolExecutor, BrowserToolResult } from './browserToolHost';
import type { BrowserToolName } from './tools';
import { BROWSER_BRIDGE } from './bridge';
import { createBrowserHttpHost } from './httpBridge';
import { McpStdioServer, startStdioServerFromEnv } from '../mcpKit/stdioServer';

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
export class BrowserMcpServer extends McpStdioServer<BrowserToolName, BrowserToolResult> {
    /** 创建 browser MCP server。 */
    public constructor(options: BrowserMcpServerOptions = {}) {
        super({ ...options, descriptor: BROWSER_BRIDGE });
    }
}

/**
 * 启动 browser MCP server 并返回实例。
 *
 * relay 端口缺失时走 mcpKit 的兜底执行器：工具仍留在 tools/list 中，
 * 调用时明确报错，不再惰性 require 宿主模块（子进程里没有 vscode）。
 *
 * @param options 启动选项。
 * @returns server 实例。
 */
export function startBrowserMcpServer(options: BrowserMcpServerOptions = {}) {
    return startStdioServerFromEnv(BROWSER_BRIDGE, { ...options, createRelayHost: createBrowserHttpHost });
}

if (require.main === module) {
    startBrowserMcpServer();
}
