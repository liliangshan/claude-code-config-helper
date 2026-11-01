/** @file HTTP MCP entry; the CLI subprocess only forwards to its authorized extension host. */
import { startStdioServerFromEnv } from '../mcpKit/stdioServer';
import { HTTP_BRIDGE, HTTP_CAPABILITY_ENV } from './bridge';
import { forwardHttpTool } from './transport';

/** List the tool even without a relay; calls then report unavailability instead of using a second HTTP client. */
export function startHttpMcpServer() {
    return startStdioServerFromEnv(HTTP_BRIDGE, { createRelayHost: port => ({ execute: async (name, args = {}) => {
        try {
            const capability = process.env[HTTP_CAPABILITY_ENV];
            if (!capability) throw new Error('HTTP_RELAY_UNAVAILABLE');
            return await forwardHttpTool(new URL(`http://127.0.0.1:${port}${HTTP_BRIDGE.httpPath}`), name, args, capability);
        } catch { return { isError: true, content: [{ type: 'text' as const, text: 'HTTP relay unavailable. Request was not automatically retried.' }] }; }
    } }) });
}

if (require.main === module) startHttpMcpServer();
