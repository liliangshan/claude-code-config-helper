/** @file 定时唤醒 MCP 桥的静态声明。 */

import type { McpBridgeDescriptor } from '../mcpKit/registry';
import { WAKEUP_MCP_SERVER_NAME, WAKEUP_TOOL_SCHEMAS, type WakeupToolName } from './tools';

/**
 * 定时唤醒工具桥 descriptor：注入 / 日志 / relay / stdio server 共用。
 *
 * 与另外两套不同，这里没有进程内 fallback：定时器必须活在扩展宿主，
 * 子进程内起的 timer 会随 MCP 进程退出而消失。
 */
export const WAKEUP_BRIDGE: McpBridgeDescriptor<WakeupToolName> = {
    serverName: WAKEUP_MCP_SERVER_NAME,
    serverInfoName: 'llsccai-wakeup',
    displayName: 'Wakeup',
    httpPath: '/llsccai/wakeup-tool',
    relayPortEnv: 'LLS_WAKEUP_TOOL_RELAY_PORT',
    entryModule: '../../wakeupTools/wakeupMcpServer',
    entryStarter: 'startWakeupMcpServer',
    schemas: WAKEUP_TOOL_SCHEMAS,
    unavailableMessage: 'Wakeup tools require the extension host relay.',
    bodyTooLargeMessage: 'Wakeup tool request body is too large.'
};
