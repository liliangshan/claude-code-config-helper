/** @file Editor-owned MCP transport; descriptors reuse existing browser/diagnostic/wakeup tools. */
import * as http from 'node:http';
import { McpStdioServer } from '../mcpKit/stdioServer';
import { BROWSER_BRIDGE } from '../browserTools/bridge';
import { VSCODE_BRIDGE } from '../vscodeTools/bridge';
import { WAKEUP_BRIDGE } from '../wakeupTools/bridge';
import { IMAGE_BRIDGE } from '../imageTools/bridge';
import { imageToolSchemas } from '../imageTools/tools';
import { IMAGE_GIF_ENV } from '../imageTools/animation';
import { HTTP_BRIDGE } from '../httpTools/bridge';
import { forwardHttpTool } from '../httpTools/transport';
import { forwardImageTool } from '../imageTools/transport';

/** Launch an owned bridge with capability-specific image schemas and bounded, non-retrying HTTP transport. */
export function startEditorBridge(): void {
    const base = [BROWSER_BRIDGE, VSCODE_BRIDGE, WAKEUP_BRIDGE, IMAGE_BRIDGE, HTTP_BRIDGE].find(item => item.serverName === process.env.LLS_EDITOR_BRIDGE);
    const descriptor = base?.serverName === IMAGE_BRIDGE.serverName ? { ...base, schemas: imageToolSchemas(process.env[IMAGE_GIF_ENV] === '1') } : base;
    const endpoint = new URL(process.env.LLS_EDITOR_TOOL_URL ?? 'http://127.0.0.1:0/');
    if (!descriptor || endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('Invalid editor bridge');
    new McpStdioServer({ descriptor, host: { execute: async (name, args) => {
        try {
            if (descriptor.serverName === HTTP_BRIDGE.serverName) return await forwardHttpTool(new URL(endpoint.toString() + '/http'), name, args ?? {}, undefined, descriptor.serverName);
            if (descriptor.serverName === IMAGE_BRIDGE.serverName) return await forwardImageTool(new URL(endpoint.toString() + '/image'), name, args ?? {}, descriptor.serverName);
            const payload = JSON.stringify({ bridge: descriptor.serverName, name, arguments: args });
            return await new Promise<any>((resolve, reject) => {
                const request = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
                    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; if (body.length > 32 * 1024 * 1024) request.destroy(new Error('Tool output too large')); });
                    response.on('error', reject); response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(body); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
                }); request.on('error', reject); request.setTimeout(120000, () => request.destroy(new Error('Editor tool timeout'))); request.end(payload);
            });
        } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
    } } }).start();
}
