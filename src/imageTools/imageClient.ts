/** @file Bounded Images JSON client and credential-free, DNS-pinned public image downloads. */
import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ImageError, type ImageGenerationExecutionSnapshot, type ImageSubmission } from './types';
import { IMAGE_ERROR_CAPTURE_BYTES, imageResponsePreview } from './responsePreview';

/** A successful bounded response retains its HTTP status for malformed-body diagnostics. */
interface ImageHttpResponse { bytes: Buffer; status: number }

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

/** Permit only globally routable IPs; mapped IPv4 and transition ranges are denied conservatively. */
export function isPublicImageAddress(address: string): boolean {
    const family = isIP(address);
    return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 ? !blockedV6.check(address, 'ipv6') : false;
}
/**
 * Read one response with bounded error capture, no redirects and no automatic retries.
 * @param url Provider API or validated public download URL.
 * @param method Request method; POST is never replayed.
 * @param headers Host-resolved request headers, used only locally to redact echoed credentials.
 * @param body Optional JSON request body, never included in diagnostics.
 * @param limit Maximum successful response byte count.
 * @param signal Absolute request deadline or explicit cancellation signal.
 * @param publicOnly Whether public DNS/IP pinning is required for an unauthenticated image download.
 * @returns Successful response bytes with status, or an ImageError carrying a sanitized failure excerpt.
 */
async function requestBytes(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body: string | undefined,
    limit: number, signal: AbortSignal, publicOnly: boolean): Promise<ImageHttpResponse> {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let pinned: { address: string; family: number } | undefined;
    if (publicOnly) {
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ImageError('IMAGE_DOWNLOAD_BLOCKED');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
            const aborted = () => reject(new ImageError('IMAGE_INTERRUPTED'));
            signal.addEventListener('abort', aborted, { once: true });
            dns.lookup(hostname, { all: true }).then(resolve, () => reject(new ImageError('IMAGE_UPSTREAM_FAILED'))).finally(() => signal.removeEventListener('abort', aborted));
        });
        if (!addresses.length || addresses.some(item => !isPublicImageAddress(item.address))) throw new ImageError('IMAGE_DOWNLOAD_BLOCKED');
        pinned = addresses[0];
    }
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = { method, headers, signal, agent: false };
        if (pinned) {
            options.family = pinned.family;
            Object.assign(options, { autoSelectFamily: false });
            options.lookup = (_host, _options, callback) => callback(null, pinned!.address, pinned!.family);
        }
        const req = (url.protocol === 'https:' ? https : http).request(url, options, res => {
            if (publicOnly) {
                const remote = res.socket.remoteAddress?.replace(/^::ffff:(?=\d+\.)/, '');
                if (!remote || !isPublicImageAddress(remote) || remote !== pinned?.address) {
                    res.destroy(); reject(new ImageError('IMAGE_DOWNLOAD_BLOCKED')); return;
                }
            }
            const status = res.statusCode ?? 0;
            const failed = status < 200 || status >= 300;
            const secrets = Object.entries(headers).filter(([name]) => !['content-type', 'accept', 'user-agent', 'content-length'].includes(name.toLowerCase()))
                .flatMap(([, value]) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]);
            const captureLimit = Math.min(limit, IMAGE_ERROR_CAPTURE_BYTES);
            const chunks: Buffer[] = [], previewChunks: Buffer[] = []; let size = 0, previewSize = 0;
            /** Capture only a bounded prefix and redact secrets before it can leave the request reader. */
            const failure = (code: string, incomplete = false) => new ImageError(code,
                imageResponsePreview(Buffer.concat(previewChunks, previewSize).toString('utf8'), status, secrets, incomplete || size > previewSize));
            if (!failed && Number(res.headers['content-length']) > limit) { res.destroy(); reject(new ImageError('IMAGE_RESPONSE_TOO_LARGE')); return; }
            res.on('data', (chunk: Buffer) => {
                const prefix = chunk.subarray(0, Math.max(0, captureLimit - previewSize));
                if (prefix.length) { previewChunks.push(Buffer.from(prefix)); previewSize += prefix.length; }
                if (failed) {
                    size += chunk.length;
                    if (previewSize >= captureLimit) { reject(failure(`IMAGE_HTTP_${status}`, true)); res.destroy(); }
                    return;
                }
                size += chunk.length;
                if (size > limit) { res.destroy(new ImageError('IMAGE_RESPONSE_TOO_LARGE')); return; }
                chunks.push(chunk);
            });
            res.on('error', error => reject(error instanceof ImageError ? error : failure(failed ? `IMAGE_HTTP_${status}` : 'IMAGE_UPSTREAM_FAILED', true)));
            res.on('aborted', () => reject(failure(failed ? `IMAGE_HTTP_${status}` : 'IMAGE_UPSTREAM_FAILED', true)));
            res.on('end', () => failed ? reject(failure(`IMAGE_HTTP_${status}`)) : resolve({ bytes: Buffer.concat(chunks, size), status }));
        });
        req.on('error', error => reject(error instanceof ImageError ? error : new ImageError(signal.aborted ? 'IMAGE_INTERRUPTED' : 'IMAGE_UPSTREAM_FAILED')));
        req.end(body);
    });
}
/** Recognize only raster signatures, never trust filenames or response Content-Type. */
export function imageType(bytes: Buffer): { mimeType: string; extension: string } {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mimeType: 'image/png', extension: 'png' };
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mimeType: 'image/jpeg', extension: 'jpg' };
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
    throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
}
/** Strict bounded Base64 decoding rejects malformed input before allocating excessive memory. */
export function decodeImage(value: string, limit: number): Buffer {
    const raw = value.replace(/^data:image\/(?:png|jpeg|webp);base64,/i, '');
    if (!raw || raw.length > Math.ceil(limit / 3) * 4) throw new ImageError('IMAGE_RESPONSE_TOO_LARGE');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length > limit || bytes.toString('base64') !== raw) throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    imageType(bytes); return bytes;
}
/**
 * Send one Images JSON request; edits use an images array of image_url Data URL objects and n: 1.
 * Invalid success responses retain a sanitized 500-character excerpt.
 * @param snapshot Frozen provider configuration and credentials.
 * @param input Host-prepared prompt, dimensions and optional edit Data URLs.
 * @param signal Request deadline or explicit cancellation.
 * @returns Generated-image entries; failures never trigger POST replay.
 */
export async function generateImages(snapshot: ImageGenerationExecutionSnapshot, input: ImageSubmission, signal: AbortSignal): Promise<unknown[]> {
    const editing = input.operation === 'edit';
    const sources = editing ? (Array.isArray(input.image) ? input.image : [input.image]) : [];
    if (editing && (!sources.length || sources.length > 16 || sources.some(source => typeof source !== 'string' || !source.trim()))) throw new ImageError('IMAGE_ARGUMENT_INVALID');
    const payload = JSON.stringify({ model: editing ? snapshot.config.editModelId || snapshot.config.modelId : snapshot.config.modelId,
        prompt: input.prompt, size: input.size, ...(editing ? { images: sources.map(image_url => ({ image_url })), n: 1 } : {}) });
    const { bytes, status } = await requestBytes(new URL(editing ? snapshot.editUrl : snapshot.generationUrl), 'POST', snapshot.headers, payload, snapshot.config.maxResponseBytes, signal, false);
    const secrets = Object.entries(snapshot.headers).filter(([name]) => !['content-type', 'accept', 'user-agent', 'content-length'].includes(name.toLowerCase()))
        .flatMap(([, value]) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]);
    /** Build a bounded diagnostic for HTTP-success bodies that are not a valid Images result. */
    const failure = () => new ImageError('IMAGE_UPSTREAM_FAILED', imageResponsePreview(bytes.subarray(0, IMAGE_ERROR_CAPTURE_BYTES).toString('utf8'), status, secrets, bytes.length > IMAGE_ERROR_CAPTURE_BYTES));
    let result: { data?: unknown[] }; try { result = JSON.parse(bytes.toString('utf8')); } catch { throw failure(); }
    if (!Array.isArray(result?.data) || !result.data.length) throw failure();
    return result.data;
}
/**
 * Prefer returned Base64, or download an image without authentication, cookies or redirects.
 * @param item An image entry from the provider's data array.
 * @param limit Maximum decoded or downloaded bytes.
 * @param signal Request deadline or explicit cancellation.
 * @returns Verified PNG, JPEG or WebP bytes.
 */
export async function loadGeneratedImage(item: unknown, limit: number, signal: AbortSignal): Promise<Buffer> {
    const value = item as { b64_json?: unknown; url?: unknown };
    if (typeof value?.b64_json === 'string' && value.b64_json) return decodeImage(value.b64_json, limit);
    if (typeof value?.url !== 'string') throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    if (/^(data:|[A-Za-z0-9+/]+=*$)/.test(value.url) && !/^https?:/.test(value.url)) return decodeImage(value.url, limit);
    let url: URL; try { url = new URL(value.url); } catch { throw new ImageError('IMAGE_FORMAT_UNSUPPORTED'); }
    const { bytes } = await requestBytes(url, 'GET', {}, undefined, limit, signal, true); imageType(bytes); return bytes;
}
