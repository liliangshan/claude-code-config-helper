/** @file Stateless, bounded native fetch execution; no login, cookies, configuration persistence or retries. */
import { BlockList, isIP } from 'node:net';
import type { McpToolResult } from '../mcpKit/types';
import { HTTP_BODY_LIMIT, HTTP_MAX_REDIRECTS, HTTP_RESPONSE_LIMIT, HTTP_TIMEOUT_MS } from './tools';
import { decodeHtmlResponse, htmlToText, isHtmlResponse } from './htmlText';

/** Complete response metadata, with truncation and encoding explicit to the caller. */
export interface HttpFetchResponse {
    url: string;
    status: number;
    statusText: string;
    ok: boolean;
    headers: Record<string, string>;
    body: string;
    encoding: 'text' | 'base64';
    /** Present only for HTML converted to readable text; original headers and byte counts remain unchanged. */
    bodyFormat?: 'html-text';
    title?: string;
    bytes: number;
    truncated: boolean;
    redirectFollowed: boolean;
    /** Actual followed hops; the final response remains inspectable when a redirect is stopped. */
    redirectCount: number;
    redirectStopped?: 'limit' | 'unsafe_target' | 'https_downgrade' | 'cross_origin_method' | 'unsupported_status';
}

/** Host policy and transport injection keep tests local without changing production safety limits. */
export interface HttpHostOptions {
    isTrusted?: () => boolean;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

const metadataAddresses = new BlockList();
metadataAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
metadataAddresses.addSubnet('fe80::', 10, 'ipv6');
metadataAddresses.addAddress('fd00:ec2::254', 'ipv6');
metadataAddresses.addAddress('100.100.100.200', 'ipv4');

/** Validate every explicit and redirected destination using the same scheme, credential and metadata policy. */
function validateUrl(url: URL): void {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP_INVALID_URL');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'metadata.google.internal' || host === 'instance-data' || (isIP(host) && metadataAddresses.check(host, isIP(host) === 6 ? 'ipv6' : 'ipv4'))) throw new Error('HTTP_METADATA_ADDRESS_BLOCKED');
}

/** Only supplied fetch arguments are accepted; policy, transport and disk paths are not model-controlled. */
function parseRequest(args: Record<string, unknown>): { url: URL; init: RequestInit } {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['url', 'options'].includes(key)) || typeof args.url !== 'string') throw new Error('HTTP_INVALID_ARGUMENTS');
    const url = new URL(args.url);
    validateUrl(url);
    const raw = args.options;
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('HTTP_INVALID_OPTIONS');
    const options = (raw ?? {}) as Record<string, unknown>;
    if (Object.keys(options).some(key => !['method', 'headers', 'body'].includes(key))) throw new Error('HTTP_INVALID_OPTIONS');
    if (options.method !== undefined && typeof options.method !== 'string') throw new Error('HTTP_INVALID_METHOD');
    const method = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET';
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new Error('HTTP_INVALID_METHOD');
    if (options.body !== undefined && typeof options.body !== 'string') throw new Error('HTTP_BODY_MUST_BE_STRING');
    if (options.body !== undefined && ['GET', 'HEAD'].includes(method)) throw new Error('HTTP_BODY_NOT_ALLOWED');
    if (typeof options.body === 'string' && Buffer.byteLength(options.body) > HTTP_BODY_LIMIT) throw new Error('HTTP_BODY_TOO_LARGE');
    const headers = new Headers();
    if (options.headers !== undefined) {
        if (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers)) throw new Error('HTTP_INVALID_HEADERS');
        let bytes = 0;
        for (const [name, value] of Object.entries(options.headers)) {
            if (typeof value !== 'string') throw new Error('HTTP_INVALID_HEADERS');
            if (/^(host|connection|content-length|transfer-encoding|upgrade|proxy-authorization|proxy-connection|te|trailer)$/i.test(name)) throw new Error('HTTP_TRANSPORT_HEADER_NOT_ALLOWED');
            bytes += Buffer.byteLength(name + value);
            if (bytes > 32768) throw new Error('HTTP_HEADERS_TOO_LARGE');
            headers.set(name, value);
        }
    }
    return { url, init: { method, headers, body: options.body as string | undefined, redirect: 'manual', credentials: 'omit' } };
}

/** Each host belongs to one relay/runtime and cancels its own requests without sharing credentials or responses. */
export class HttpToolHost {
    private readonly controllers = new Set<AbortController>();
    private disposed = false;
    /** Inject the trust gate and native fetch; no global dispatcher or environment settings are modified. */
    public constructor(private readonly options: HttpHostOptions = {}) {}

    /** Fetch with bounded 301/302 following; cross-origin headers/body and HTTPS downgrade never propagate. */
    private async fetchRedirects(nativeFetch: typeof fetch, input: ReturnType<typeof parseRequest>, signal: AbortSignal): Promise<{ response: Response; url: URL; count: number; stopped?: HttpFetchResponse['redirectStopped'] }> {
        let url = input.url, init = input.init, count = 0;
        for (;;) {
            signal.throwIfAborted();
            const response = await nativeFetch(url, { ...init, signal });
            const location = response.headers.get('location');
            if (![301, 302].includes(response.status) || !location) {
                const stopped = location && [303, 307, 308].includes(response.status) ? 'unsupported_status' as const : undefined;
                return { response, url, count, stopped };
            }
            if (count >= HTTP_MAX_REDIRECTS) return { response, url, count, stopped: 'limit' };
            let next: URL;
            try { next = new URL(location, url); validateUrl(next); }
            catch { return { response, url, count, stopped: 'unsafe_target' }; }
            if (url.protocol === 'https:' && next.protocol === 'http:') return { response, url, count, stopped: 'https_downgrade' };
            const method = init.method === 'POST' ? 'GET' : init.method ?? 'GET';
            const body = init.method === 'POST' ? undefined : init.body;
            const crossOrigin = next.origin !== url.origin;
            if (crossOrigin && (!['GET', 'HEAD'].includes(method) || body !== undefined)) return { response, url, count, stopped: 'cross_origin_method' };
            // All explicitly supplied headers are dropped across origins: even an unrecognized custom header may be a secret.
            const headers = crossOrigin ? new Headers() : new Headers(init.headers);
            if (init.method === 'POST') for (const header of ['content-type', 'content-encoding', 'content-language', 'content-location']) headers.delete(header);
            await response.body?.cancel();
            signal.throwIfAborted();
            init = { ...init, method, body, headers }; url = next; count++;
        }
    }

    /** Execute one request chain under one deadline; HTML is extracted and redirects do not trigger error retries. */
    public async execute(name: string, args: Record<string, unknown> = {}, externalSignal?: AbortSignal): Promise<McpToolResult> {
        if (name !== 'http_fetch') return this.error('HTTP_UNKNOWN_TOOL');
        if (this.disposed || externalSignal?.aborted) return this.error('HTTP_ABORTED');
        if (this.options.isTrusted && !this.options.isTrusted()) return this.error('HTTP_WORKSPACE_NOT_TRUSTED');
        let input: ReturnType<typeof parseRequest>;
        try { input = parseRequest(args); }
        catch (error) { return this.error(error instanceof Error && /^HTTP_[A-Z_]+$/.test(error.message) ? error.message : 'HTTP_INVALID_ARGUMENTS'); }
        if (this.disposed || externalSignal?.aborted) return this.error('HTTP_ABORTED');
        const controller = new AbortController(); this.controllers.add(controller);
        const abort = () => controller.abort(); externalSignal?.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? HTTP_TIMEOUT_MS);
        try {
            const nativeFetch = this.options.fetch ?? globalThis.fetch;
            if (!nativeFetch) return this.error('HTTP_NATIVE_FETCH_UNAVAILABLE');
            if (controller.signal.aborted) throw new Error('HTTP_ABORTED');
            const followed = await this.fetchRedirects(nativeFetch, input, controller.signal);
            const response = followed.response;
            const chunks: Uint8Array[] = []; let bytes = 0, truncated = false;
            const reader = response.body?.getReader();
            if (reader) {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const remaining = HTTP_RESPONSE_LIMIT - bytes;
                        if (value.length > remaining) {
                            if (remaining) chunks.push(value.subarray(0, remaining));
                            bytes += remaining; truncated = true; await reader.cancel(); break;
                        }
                        chunks.push(value); bytes += value.length;
                    }
                } finally { reader.releaseLock(); }
            }
            if (controller.signal.aborted) throw new Error('HTTP_ABORTED');
            const buffer = Buffer.concat(chunks), type = response.headers.get('content-type') ?? '';
            const utf8 = buffer.toString('utf8');
            const html = isHtmlResponse(type, utf8);
            const extracted = html ? htmlToText(decodeHtmlResponse(buffer, type)) : undefined;
            const binary = !html && !!type && !/^(?:text\/)|json|xml|javascript|x-www-form-urlencoded|svg\+xml/i.test(type);
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => { headers[key] = value; });
            const result: HttpFetchResponse = { url: response.url || followed.url.href, status: response.status, statusText: response.statusText, ok: response.ok, headers,
                body: extracted ? extracted.text : binary ? buffer.toString('base64') : utf8,
                encoding: binary ? 'base64' : 'text', bytes, truncated, redirectFollowed: followed.count > 0, redirectCount: followed.count,
                ...(followed.stopped ? { redirectStopped: followed.stopped } : {}),
                ...(extracted ? { bodyFormat: 'html-text' as const, ...(extracted.title ? { title: extracted.title } : {}) } : {}) };
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch {
            return this.error(timedOut ? 'HTTP_TIMEOUT' : controller.signal.aborted ? 'HTTP_ABORTED' : 'HTTP_NETWORK_ERROR');
        } finally {
            clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); this.controllers.delete(controller);
        }
    }

    /** Cancel in-flight requests; this cannot guarantee cancellation of remote mutations. */
    public abort(): void { for (const controller of this.controllers) controller.abort(); }
    /** Permanently stop this owned host and release pending requests. */
    public dispose(): void { this.disposed = true; this.abort(); }
    /** Avoid reflecting request URLs, tokens, headers or bodies in locally generated errors. */
    private error(code: string): McpToolResult {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, retryAutomatic: false, note: 'Inspect remote effects before manually retrying a mutating request.' }) }] };
    }
}
