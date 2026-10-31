/** @file Image bridge descriptor shared by host injection and the host-free MCP subprocess. */
import type { McpBridgeDescriptor } from '../mcpKit/registry';
import { IMAGE_MCP_SERVER_NAME, IMAGE_TOOL_SCHEMAS, type ImageToolName } from './tools';

export const IMAGE_BRIDGE: McpBridgeDescriptor<ImageToolName> = {
    serverName: IMAGE_MCP_SERVER_NAME, serverInfoName: 'llsccai-image', displayName: 'Image generation',
    httpPath: '/llsccai/image-tool', relayPortEnv: 'LLS_IMAGE_TOOL_RELAY_PORT',
    entryModule: '../../imageTools/imageMcpServer', entryStarter: 'startImageMcpServer', schemas: IMAGE_TOOL_SCHEMAS,
    unavailableMessage: 'Image tools require the authenticated extension host relay.', bodyTooLargeMessage: 'IMAGE_PAYLOAD_TOO_LARGE'
};
