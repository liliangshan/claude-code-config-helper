/**
 * @file VS Code 工具 MCP server（stdio JSON-RPC 子行程入口）。
 *
 * 由 claude CLI 以 `node -e require(...).startVscodeMcpServer()` 啟動，
 * 行程內沒有 vscode 執行期，因此本檔只能 `import type` 引用宿主側模組。
 */

import type { VscodeToolExecutor, VscodeToolResult } from './diagnosticsHost';
import type { VscodeToolName } from './tools';
import { VSCODE_BRIDGE } from './bridge';
import { createVscodeHttpHost } from './httpBridge';
import { McpStdioServer, startStdioServerFromEnv } from '../mcpKit/stdioServer';

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
export class VscodeMcpServer extends McpStdioServer<VscodeToolName, VscodeToolResult> {
    /** 建立 VS Code MCP server。 */
    public constructor(options: VscodeMcpServerOptions = {}) {
        super({ ...options, descriptor: VSCODE_BRIDGE });
    }
}

/**
 * 啟動 VS Code 工具 MCP server。
 *
 * relay 埠缺失時走 mcpKit 的兜底執行器：工具仍留在 tools/list 中，
 * 呼叫時明確報錯，不再惰性 require 宿主模組（子行程裡沒有 vscode）。
 *
 * @param options 啟動選項。
 * @returns server 實例。
 */
export function startVscodeMcpServer(options: VscodeMcpServerOptions = {}) {
    return startStdioServerFromEnv(VSCODE_BRIDGE, { ...options, createRelayHost: createVscodeHttpHost });
}

if (require.main === module) {
    startVscodeMcpServer();
}
