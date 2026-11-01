/** @file Host-free HTTP MCP bridge descriptor and per-host loopback capability. */
import { randomUUID } from 'node:crypto';
import type { McpBridgeDescriptor } from '../mcpKit/registry';
import { HTTP_MCP_SERVER_NAME, HTTP_TOOL_SCHEMAS, type HttpToolName } from './tools';

/** Never expose this capability in model parameters or request logs. */
export const HTTP_CAPABILITY_ENV = 'LLS_HTTP_TOOL_CAPABILITY';
export const HTTP_CAPABILITY = randomUUID();

/** Shared schema/entry metadata; transport authorization is checked separately by the owning relay. */
export const HTTP_BRIDGE: McpBridgeDescriptor<HttpToolName> = {
    serverName: HTTP_MCP_SERVER_NAME, serverInfoName: 'llsccai-http', displayName: 'HTTP',
    httpPath: '/llsccai/http-tool', relayPortEnv: 'LLS_HTTP_TOOL_RELAY_PORT',
    entryModule: '../../httpTools/httpMcpServer', entryStarter: 'startHttpMcpServer', schemas: HTTP_TOOL_SCHEMAS,
    unavailableMessage: 'HTTP tools require the extension host relay.', bodyTooLargeMessage: 'HTTP tool request is too large.'
};
