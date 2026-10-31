/** @file Image MCP entry point; no VS Code imports or fallback credential/queue ownership. */
import { McpStdioServer } from '../mcpKit/stdioServer';
import { IMAGE_BRIDGE } from './bridge';
import { forwardImageTool } from './transport';
import { imageErrorCode } from './types';

/** Launch an authenticated, revocable main-chat bridge; missing relay remains visibly unavailable. */
export function startImageMcpServer(): void {
    const port = Number(process.env.LLS_IMAGE_TOOL_RELAY_PORT || 0);
    const capability = process.env.LLS_IMAGE_TOOL_CAPABILITY || '';
    const host = port > 0 && /^[a-f0-9-]{36}$/.test(capability) ? {
        execute: async (name: string, args: Record<string, unknown> = {}) => {
            try { return await forwardImageTool(new URL(`http://127.0.0.1:${port}${IMAGE_BRIDGE.httpPath}/${capability}`), name, args); }
            catch (error) { return { isError: true, content: [{ type: 'text' as const, text: imageErrorCode(error) }] }; }
        }
    } : undefined;
    new McpStdioServer({ descriptor: IMAGE_BRIDGE, host }).start();
}
