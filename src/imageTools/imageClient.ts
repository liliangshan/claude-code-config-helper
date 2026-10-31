/** @file Bounded Images JSON client and credential-free, DNS-pinned public image downloads. */
import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ImageError, type ImageGenerationExecutionSnapshot, type ImageSubmission } from './types';

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

/** Permit only globally routable IPs; mapped IPv4 and transition ranges are denied conservatively. */
export function isPublicImageAddress(address: string): boolean {
    const family = isIP(address);
    return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 ? !blockedV6.check(address, 'ipv6') : false;
}
/** Read one HTTP response with an absolute abort signal, hard byte cap, no redirects and no retries. */
async function requestBytes(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body: string | undefined,
    limit: number, signal: AbortSignal, publicOnly: boolean): Promise<Buffer> {
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
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.destroy(); reject(new ImageError(`IMAGE_HTTP_${res.statusCode ?? 0}`)); return;
            }
            if (Number(res.headers['content-length']) > limit) { res.destroy(); reject(new ImageError('IMAGE_RESPONSE_TOO_LARGE')); return; }
            const chunks: Buffer[] = []; let size = 0;
            res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > limit) { res.destroy(new ImageError('IMAGE_RESPONSE_TOO_LARGE')); return; }
                chunks.push(chunk);
            });
            res.on('error', error => reject(error instanceof ImageError ? error : new ImageError('IMAGE_UPSTREAM_FAILED')));
            res.on('aborted', () => reject(new ImageError('IMAGE_UPSTREAM_FAILED')));
            res.on('end', () => resolve(Buffer.concat(chunks, size)));
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
/** Validate editing sources without fetching or persisting them; public URL DNS is resolved by the provider. */
export function validateImageSource(value: unknown, limit: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new ImageError('IMAGE_ARGUMENT_INVALID');
    if (/^https?:\/\//i.test(value)) {
        let url: URL; try { url = new URL(value); } catch { throw new ImageError('IMAGE_ARGUMENT_INVALID'); }
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (url.username || url.password || host === 'localhost' || (isIP(host) && !isPublicImageAddress(host))) throw new ImageError('IMAGE_DOWNLOAD_BLOCKED');
    } else decodeImage(value, limit);
    return value;
}
/** Send exactly one Images JSON request; provider timeouts never trigger automatic POST replay. */
export async function generateImages(snapshot: ImageGenerationExecutionSnapshot, input: ImageSubmission, signal: AbortSignal): Promise<unknown[]> {
    const editing = input.operation === 'edit';
    const payload = JSON.stringify({ model: editing ? snapshot.config.editModelId || snapshot.config.modelId : snapshot.config.modelId,
        prompt: input.prompt, size: input.size, ...(editing ? { image: input.image } : {}) });
    const bytes = await requestBytes(new URL(editing ? snapshot.editUrl : snapshot.generationUrl), 'POST', snapshot.headers, payload, snapshot.config.maxResponseBytes, signal, false);
    let result: { data?: unknown[] }; try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new ImageError('IMAGE_UPSTREAM_FAILED'); }
    if (!Array.isArray(result?.data) || !result.data.length) throw new ImageError('IMAGE_UPSTREAM_FAILED');
    return result.data;
}
/** Prefer Base64; download URLs with no authentication, cookies, redirects or private-network access. */
export async function loadGeneratedImage(item: unknown, limit: number, signal: AbortSignal): Promise<Buffer> {
    const value = item as { b64_json?: unknown; url?: unknown };
    if (typeof value?.b64_json === 'string' && value.b64_json) return decodeImage(value.b64_json, limit);
    if (typeof value?.url !== 'string') throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    if (/^(data:|[A-Za-z0-9+/]+=*$)/.test(value.url) && !/^https?:/.test(value.url)) return decodeImage(value.url, limit);
    let url: URL; try { url = new URL(value.url); } catch { throw new ImageError('IMAGE_FORMAT_UNSUPPORTED'); }
    const bytes = await requestBytes(url, 'GET', {}, undefined, limit, signal, true); imageType(bytes); return bytes;
}
