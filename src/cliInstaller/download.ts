/** @file Selected-registry transport with strict origins, cancellation and bounded HTTPS downloads. */
import * as https from 'node:https';
import { validateRegistryUrl, type CliInstallSource } from './sources';

/** Read package bytes without credentials; redirects remain restricted to the selected source. */
export function downloadOfficial(url: string, signal: AbortSignal, progress: (bytes: number, total?: number) => void = () => {}, limit = 256 * 1024 * 1024, redirects = 0, source: CliInstallSource = 'official'): Promise<Buffer> {
    let target: URL;
    try { target = validateRegistryUrl(url, source); } catch (error) { return Promise.reject(error); }
    if (signal.aborted) return Promise.reject(new Error('Download cancelled'));
    return new Promise((resolve, reject) => {
        const request = https.get(target, { headers: { accept: '*/*' }, signal }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
                response.resume(); if (redirects >= 3 || !response.headers.location) { reject(new Error('Invalid registry redirect')); return; }
                downloadOfficial(new URL(response.headers.location, target).href, signal, progress, limit, redirects + 1, source).then(resolve, reject); return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`Official registry returned HTTP ${response.statusCode}`)); return; }
            const total = Number(response.headers['content-length']) || undefined;
            if (total && total > limit) { response.destroy(); reject(new Error('Download exceeds limit')); return; }
            const chunks: Buffer[] = []; let received = 0;
            response.on('data', (chunk: Buffer) => { received += chunk.length; if (received > limit) { request.destroy(new Error('Download exceeds limit')); return; } chunks.push(chunk); progress(received, total); });
            response.on('error', reject); response.on('aborted', () => reject(new Error('Download interrupted')));
            response.on('end', () => { if (total && received !== total) reject(new Error('Incomplete download')); else resolve(Buffer.concat(chunks)); });
        });
        request.setTimeout(30000, () => request.destroy(new Error('Registry request timed out')));
        const timeout = setTimeout(() => request.destroy(new Error('Download deadline exceeded')), 300000);
        request.on('close', () => clearTimeout(timeout)); request.on('error', reject);
    });
}
