/** @file 浏览器 MCP 桥的静态声明。 */

import type { McpBridgeDescriptor } from '../mcpKit/registry';
import { BROWSER_MCP_SERVER_NAME, BROWSER_TOOL_SCHEMAS, type BrowserToolName } from './tools';

/** 浏览器工具桥 descriptor：注入 / 日志 / relay / stdio server 共用。 */
export const BROWSER_BRIDGE: McpBridgeDescriptor<BrowserToolName> = {
    serverName: BROWSER_MCP_SERVER_NAME,
    serverInfoName: 'llsccai-browser',
    displayName: 'Browser',
    httpPath: '/llsccai/browser-tool',
    relayPortEnv: 'LLS_BROWSER_TOOL_RELAY_PORT',
    entryModule: '../../browserTools/browserMcpServer',
    entryStarter: 'startBrowserMcpServer',
    schemas: BROWSER_TOOL_SCHEMAS,
    unavailableMessage: 'Browser tools require the extension host relay.',
    bodyTooLargeMessage: 'Browser tool request body is too large.'
};
