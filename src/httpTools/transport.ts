/** @file Authenticated, bounded loopback transport for HTTP tool subprocesses; no VS Code imports. */
import * as http from 'node:http';
import type { McpToolResult } from '../mcpKit/types';
import { HTTP_TIMEOUT_MS } from './tools';

export const HTTP_ENVELOPE_LIMIT = 4 * 1024 * 1024;
const RESULT_LIMIT = 16 * 1024 * 1024;

/** Read a bounded tool envelope without retaining arbitrarily large input. */
export async function readHttpToolRequest(request: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.length;
        if (bytes > HTTP_ENVELOPE_LIMIT) throw new Error('HTTP_TOOL_PAYLOAD_TOO_LARGE');
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** Forward once to the owned loopback relay; capability is transport-only, never supplied by the model. */
export async function forwardHttpTool(endpoint: URL, name: string, args: Record<string, unknown>, capability?: string, bridge?: string): Promise<McpToolResult> {
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('HTTP_INVALID_RELAY');
    const body = JSON.stringify({ name, arguments: args, ...(bridge ? { bridge } : {}) });
    if (Buffer.byteLength(body) > HTTP_ENVELOPE_LIMIT) throw new Error('HTTP_TOOL_PAYLOAD_TOO_LARGE');
    return new Promise((resolve, reject) => {
        const request = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(capability ? { 'x-lls-http-capability': capability } : {}) } }, response => {
            const chunks: Buffer[] = []; let bytes = 0;
            response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > RESULT_LIMIT) response.destroy(new Error('HTTP_TOOL_RESULT_TOO_LARGE')); else chunks.push(chunk); });
            response.on('error', () => reject(new Error('HTTP_RELAY_DISCONNECTED')));
            response.on('aborted', () => reject(new Error('HTTP_RELAY_DISCONNECTED')));
            response.on('end', () => {
                try {
                    if (response.statusCode !== 200) throw new Error('HTTP_RELAY_REJECTED');
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch { reject(new Error('HTTP_RELAY_REJECTED')); }
            });
        });
        const timer = setTimeout(() => request.destroy(new Error('HTTP_RELAY_TIMEOUT')), HTTP_TIMEOUT_MS + 10000);
        request.once('close', () => clearTimeout(timer)); request.on('error', () => reject(new Error('HTTP_RELAY_UNAVAILABLE'))); request.end(body);
    });
}
