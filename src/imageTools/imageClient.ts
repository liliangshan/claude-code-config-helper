/** @file Bounded Images JSON client and credential-free downloads using the host's normal DNS routing. */
import * as http from 'node:http';
import * as https from 'node:https';
import { ImageError, type ImageGenerationExecutionSnapshot, type ImageSubmission } from './types';
import { IMAGE_ERROR_CAPTURE_BYTES, imageResponsePreview } from './responsePreview';
import { imageOutputOptions } from './formats';
import { validateSvg } from './svg';

/** A successful bounded response retains its HTTP status for malformed-body diagnostics. */
interface ImageHttpResponse { bytes: Buffer; status: number }

/**
 * Read one response with bounded error capture, no redirects and no automatic retries.
 * @param url Provider API or HTTP(S) image download URL; no destination IP filtering is applied.
 * @param method Request method; POST is never replayed.
 * @param headers Host-resolved request headers, used only locally to redact echoed credentials.
 * @param body Optional JSON request body, never included in diagnostics.
 * @param limit Maximum successful response byte count.
 * @param signal Absolute request deadline or explicit cancellation signal.
 * @param download Whether URL scheme and embedded-credential checks apply to a returned image URL.
 * @returns Successful response bytes with status, or an ImageError carrying a sanitized failure excerpt.
 */
async function requestBytes(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body: string | undefined,
    limit: number, signal: AbortSignal, download: boolean): Promise<ImageHttpResponse> {
    signal.throwIfAborted();
    if (download && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)) throw new ImageError('IMAGE_DOWNLOAD_BLOCKED');
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = { method, headers, signal, agent: false };
        const req = (url.protocol === 'https:' ? https : http).request(url, options, res => {
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
/** Recognize raster signatures or validate a complete, self-contained static SVG without trusting Content-Type. */
export function imageType(bytes: Buffer): { mimeType: string; extension: string } {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mimeType: 'image/png', extension: 'png' };
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mimeType: 'image/jpeg', extension: 'jpg' };
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return { mimeType: 'image/gif', extension: 'gif' };
    if (bytes.subarray(0, 256).toString('utf8').replace(/^﻿/, '').trimStart().startsWith('<')) {
        validateSvg(bytes); return { mimeType: 'image/svg+xml', extension: 'svg' };
    }
    throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
}
/** Strict bounded Base64 decoding includes validated SVG Data URLs without allowing executable image content. */
export function decodeImage(value: string, limit: number): Buffer {
    const raw = value.replace(/^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);base64,/i, '');
    if (!raw || raw.length > Math.ceil(limit / 3) * 4) throw new ImageError('IMAGE_RESPONSE_TOO_LARGE');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length > limit || bytes.toString('base64') !== raw) throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    imageType(bytes); return bytes;
}
/**
 * Send one Images JSON request with an explicit enabled output format; only GIF includes frame settings.
 * JPG uses the provider's standard jpeg value; edits keep images[].image_url and n: 1.
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
    const output = imageOutputOptions(input, input.size, snapshot.config);
    const payload = JSON.stringify({ model: editing ? snapshot.config.editModelId || snapshot.config.modelId : snapshot.config.modelId,
        prompt: input.prompt, size: input.size, ...output, output_format: output.output_format === 'jpg' ? 'jpeg' : output.output_format,
        ...(editing ? { images: sources.map(image_url => ({ image_url })), n: 1 } : {}) });
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
 * @returns Verified raster or self-contained static SVG bytes; no response text is executed.
 */
export async function loadGeneratedImage(item: unknown, limit: number, signal: AbortSignal): Promise<Buffer> {
    const value = item as { b64_json?: unknown; url?: unknown };
    if (typeof value?.b64_json === 'string' && value.b64_json) return decodeImage(value.b64_json, limit);
    if (typeof value?.url !== 'string') throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
    if (/^(data:|[A-Za-z0-9+/]+=*$)/.test(value.url) && !/^https?:/.test(value.url)) return decodeImage(value.url, limit);
    let url: URL; try { url = new URL(value.url); } catch { throw new ImageError('IMAGE_FORMAT_UNSUPPORTED'); }
    const { bytes } = await requestBytes(url, 'GET', {}, undefined, limit, signal, true); imageType(bytes); return bytes;
}
