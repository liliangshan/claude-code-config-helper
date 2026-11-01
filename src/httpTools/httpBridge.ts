/** @file Authenticated extension-host endpoint for the stateless HTTP MCP tool. */
import type * as http from 'node:http';
import { HTTP_BRIDGE, HTTP_CAPABILITY } from './bridge';
import { readHttpToolRequest } from './transport';
import { HttpToolHost } from './httpHost';

/** Create one host-owned handler; capability and trust checks precede all outbound network activity. */
export function createHttpToolRelayHandler(host: HttpToolHost, capability: string = HTTP_CAPABILITY) {
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
        if ((req.url ?? '').split('?', 1)[0] !== HTTP_BRIDGE.httpPath) return false;
        if (req.method !== 'POST' || req.headers['x-lls-http-capability'] !== capability) {
            res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"HTTP_RELAY_REJECTED"}'); return true;
        }
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', onClose);
        try {
            const body = JSON.parse(await readHttpToolRequest(req)) as { name?: unknown; arguments?: unknown };
            if (!body || typeof body.name !== 'string' || !body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) throw new Error('HTTP_INVALID_ARGUMENTS');
            const result = await host.execute(body.name, body.arguments as Record<string, unknown>, controller.signal);
            if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
        } catch {
            if (!res.destroyed) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"HTTP_INVALID_REQUEST"}'); }
        } finally { res.off('close', onClose); }
        return true;
    };
}
