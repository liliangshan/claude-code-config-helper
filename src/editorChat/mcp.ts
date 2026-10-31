/** @file Editor-owned MCP transport; descriptors reuse existing browser/diagnostic/wakeup tools. */
import * as http from 'node:http';
import { McpStdioServer } from '../mcpKit/stdioServer';
import { BROWSER_BRIDGE } from '../browserTools/bridge';
import { VSCODE_BRIDGE } from '../vscodeTools/bridge';
import { WAKEUP_BRIDGE } from '../wakeupTools/bridge';
import { IMAGE_BRIDGE } from '../imageTools/bridge';
import { forwardImageTool } from '../imageTools/transport';

/** Launch a bridge with a revocable editor capability, without importing VS Code into the subprocess. */
export function startEditorBridge(): void {
    const descriptor = [BROWSER_BRIDGE, VSCODE_BRIDGE, WAKEUP_BRIDGE, IMAGE_BRIDGE].find(item => item.serverName === process.env.LLS_EDITOR_BRIDGE);
    const endpoint = new URL(process.env.LLS_EDITOR_TOOL_URL ?? 'http://127.0.0.1:0/');
    if (!descriptor || endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('Invalid editor bridge');
    new McpStdioServer({ descriptor, host: { execute: async (name, args) => {
        try {
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
