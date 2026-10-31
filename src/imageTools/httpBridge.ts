/** @file Authenticated main image relay; requests are bounded before parsing and never logged. */
import type * as http from 'node:http';
import { IMAGE_BRIDGE } from './bridge';
import { getImageService, imageCapability } from './entry';
import { readImageRequest } from './transport';
import { ImageError, imageErrorCode } from './types';
/** Handle only this bridge path, checking capability before reading tool arguments. */
export async function handleImageRelay(request: http.IncomingMessage, response: http.ServerResponse): Promise<boolean> {
    const prefix = `${IMAGE_BRIDGE.httpPath}/`; const url = request.url || '';
    if (!url.startsWith(prefix) && url !== IMAGE_BRIDGE.httpPath) return false;
    const token = url.slice(prefix.length); const capability = imageCapability(token);
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST' || !capability || !getImageService()) { response.writeHead(403); response.end('{}'); return true; }
    try {
        const scope = await capability.binding.scope();
        if (scope.cwd !== capability.cwd) throw new ImageError('IMAGE_PERMISSION_DENIED');
        const body = JSON.parse(await readImageRequest(request));
        if (!body || typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId)) throw new ImageError('IMAGE_ARGUMENT_INVALID');
        const result = await getImageService()!.execute(scope, body.name, body.arguments ?? {}, body.requestId, capability.current);
        response.end(JSON.stringify(result));
    } catch (error) { if (!response.destroyed) response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: imageErrorCode(error) }] })); }
    return true;
}
