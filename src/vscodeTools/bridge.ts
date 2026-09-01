/** @file VS Code 工具 MCP 桥的静态声明。 */

import type { McpBridgeDescriptor } from '../mcpKit/registry';
import { VSCODE_MCP_SERVER_NAME, VSCODE_TOOL_SCHEMAS, type VscodeToolName } from './tools';

/** VS Code 诊断工具桥 descriptor：注入 / 日志 / relay / stdio server 共用。 */
export const VSCODE_BRIDGE: McpBridgeDescriptor<VscodeToolName> = {
    serverName: VSCODE_MCP_SERVER_NAME,
    serverInfoName: 'llsccai-vscode',
    displayName: 'VS Code',
    httpPath: '/llsccai/vscode-tool',
    relayPortEnv: 'LLS_VSCODE_TOOL_RELAY_PORT',
    entryModule: '../../vscodeTools/vscodeMcpServer',
    entryStarter: 'startVscodeMcpServer',
    schemas: VSCODE_TOOL_SCHEMAS,
    unavailableMessage: 'VS Code diagnostics tools require the extension host relay.',
    bodyTooLargeMessage: 'VS Code tool request body is too large.'
};
