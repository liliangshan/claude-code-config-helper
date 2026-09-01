/** @file llsccaiVscode MCP 子行程到擴充宿主的 HTTP bridge。 */

import type * as http from 'http';

import type { VscodeToolExecutor, VscodeToolResult } from './diagnosticsHost';
import type { VscodeToolName } from './tools';
import { VSCODE_BRIDGE } from './bridge';
import { createHttpForwardingHost, createToolRelayHandler } from '../mcpKit/httpBridge';

/** VS Code 工具 HTTP bridge 路徑。 */
export const VSCODE_TOOL_HTTP_PATH = VSCODE_BRIDGE.httpPath;

/** VS Code 工具 relay port 環境變數。 */
export const VSCODE_TOOL_RELAY_PORT_ENV = VSCODE_BRIDGE.relayPortEnv;

/** VS Code 工具 HTTP 請求體。 */
export interface VscodeToolHttpRequestBody {
    /** 工具裸名。 */
    name: VscodeToolName;
    /** 工具入參。 */
    arguments?: Record<string, unknown>;
}

/** 建立子行程側 VS Code HTTP 轉發宿主。 */
export function createVscodeHttpHost(port: number): VscodeToolExecutor {
    return createHttpForwardingHost<VscodeToolName, VscodeToolResult>(VSCODE_BRIDGE, port);
}

/**
 * 建立擴充宿主側 VS Code 工具 relay handler。
 *
 * DiagnosticsHost 頂層 import 真實 `vscode`，僅在宿主側未注入 host 時惰性
 * require，避免本模組被子行程入口鏈拉入時因缺少 vscode 而崩潰。
 *
 * @param host 宿主執行器；缺省時惰性建立 DiagnosticsHost。
 */
export function createVscodeToolRelayHandler(
    host?: VscodeToolExecutor
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
    return createToolRelayHandler(VSCODE_BRIDGE, () => host
        ?? new (require('./diagnosticsHost') as typeof import('./diagnosticsHost')).DiagnosticsHost());
}
