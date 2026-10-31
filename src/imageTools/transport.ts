/** @file Host-free authenticated image transport with bounded envelopes and stable submission IDs. */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpToolResult } from '../mcpKit/types';
import { IMAGE_BODY_LIMIT, ImageError } from './types';

/** Read an image-only HTTP envelope with a streaming cap before JSON parsing. */
export async function readImageRequest(request: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []; let length = 0;
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); length += chunk.length;
        if (length > IMAGE_BODY_LIMIT) throw new ImageError('IMAGE_PAYLOAD_TOO_LARGE'); chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** Send one bounded request without retrying; requestId belongs to transport, never model arguments. */
export async function forwardImageTool(endpoint: URL, name: string, args: Record<string, unknown>, bridge?: string): Promise<McpToolResult> {
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new ImageError('IMAGE_PERMISSION_DENIED');
    const body = JSON.stringify({ name, arguments: args, requestId: randomUUID(), ...(bridge ? { bridge } : {}) });
    if (Buffer.byteLength(body) > IMAGE_BODY_LIMIT) throw new ImageError('IMAGE_PAYLOAD_TOO_LARGE');
    return new Promise((resolve, reject) => {
        const request = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > IMAGE_BODY_LIMIT) response.destroy(new ImageError('IMAGE_PAYLOAD_TOO_LARGE')); else chunks.push(chunk); });
            response.on('error', () => reject(new ImageError('IMAGE_UPSTREAM_FAILED')));
            response.on('aborted', () => reject(new ImageError('IMAGE_UPSTREAM_FAILED')));
            response.on('end', () => {
                try { if (response.statusCode !== 200) throw new ImageError('IMAGE_PERMISSION_DENIED'); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { reject(new ImageError('IMAGE_UPSTREAM_FAILED')); }
            });
        });
        request.on('error', () => reject(new ImageError('IMAGE_UPSTREAM_FAILED')));
        request.setTimeout(110000, () => request.destroy(new ImageError('IMAGE_INTERRUPTED'))); request.end(body);
    });
}
