/** @file Local edit-image input: host-readable paths only, with no workspace boundary or extra authorization dialog. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_TOTAL_LIMIT, ImageError } from './types';
import { imageType } from './imageClient';

/** Resolve a literal host path; URLs and inline image encodings are never downloaded or decoded. */
export function resolveImageSourcePath(value: unknown, cwd: string): string {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ImageError('IMAGE_SOURCE_PATH_INVALID');
    if (/^file:/i.test(value)) {
        try {
            const url = new URL(value);
            if (url.search || url.hash) throw new Error('Invalid file URI');
            return fileURLToPath(url);
        } catch { throw new ImageError('IMAGE_SOURCE_PATH_INVALID'); }
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !path.isAbsolute(value)) throw new ImageError('IMAGE_SOURCE_PATH_INVALID');
    if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) return path.resolve(os.homedir(), value.slice(2));
    return path.resolve(cwd, value);
}

/** Read a bounded regular file snapshot; symlinks and paths outside the workspace are deliberately supported. */
async function readLocalImage(filename: string, limit: number, assertCurrent: () => void): Promise<Buffer> {
    try {
        assertCurrent();
        const stat = await fs.stat(filename);
        assertCurrent();
        if (!stat.isFile()) throw new ImageError('IMAGE_SOURCE_NOT_FILE');
        if (stat.size > limit) throw new ImageError('IMAGE_SOURCE_TOO_LARGE');
        // Nonblocking open prevents a path replaced by a FIFO from hanging the host before fstat.
        const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        try {
            assertCurrent();
            const opened = await file.stat();
            if (!opened.isFile()) throw new ImageError('IMAGE_SOURCE_NOT_FILE');
            if (opened.size > limit) throw new ImageError('IMAGE_SOURCE_TOO_LARGE');
            const chunks: Buffer[] = []; let length = 0;
            for (;;) {
                assertCurrent();
                const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - length + 1));
                const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
                assertCurrent();
                if (!bytesRead) break;
                length += bytesRead;
                if (length > limit) throw new ImageError('IMAGE_SOURCE_TOO_LARGE');
                chunks.push(chunk.subarray(0, bytesRead));
            }
            return Buffer.concat(chunks, length);
        } finally { await file.close(); }
    } catch (error) {
        if (error instanceof ImageError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') throw new ImageError('IMAGE_SOURCE_NOT_FOUND');
        throw new ImageError('IMAGE_SOURCE_READ_FAILED');
    }
}

/**
 * Wrap source bytes in a complete Data URL without narrowing the provider's supported source formats.
 * Recognized raster signatures take precedence over the filename; other formats use a MIME hint only.
 * @param bytes The frozen local file contents, before Base64 encoding.
 * @param filename The resolved source filename used only as a fallback MIME hint.
 * @returns A Data URL containing the MIME type, Base64 marker and unchanged source bytes.
 */
function localImageDataUrl(bytes: Buffer, filename: string): string {
    let mimeType: string;
    try { mimeType = imageType(bytes).mimeType; } catch (error) {
        if (!(error instanceof ImageError) || error.code !== 'IMAGE_FORMAT_UNSUPPORTED') throw error;
        const mimeByExtension: Record<string, string> = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
            '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
            '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif', '.ico': 'image/x-icon'
        };
        mimeType = mimeByExtension[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    }
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/**
 * Read 1–16 local paths into transient Data URLs without persisting paths or source bytes in task metadata.
 * @param value A single host-readable path or an array of paths, never model-supplied inline data.
 * @param cwd The conversation workspace used to resolve relative paths.
 * @param maxFileBytes The maximum unencoded byte length allowed for each source file.
 * @param assertCurrent A guard that aborts reads when the owning conversation or configuration is stale.
 * @returns One complete Data URL or an array matching the input shape and source order.
 */
export async function loadLocalImageSources(value: unknown, cwd: string, maxFileBytes: number, assertCurrent: () => void = () => {}): Promise<string | string[]> {
    const sources = Array.isArray(value) ? value : [value];
    if (!sources.length || sources.length > 16) throw new ImageError('IMAGE_ARGUMENT_INVALID');
    const filenames = sources.map(source => resolveImageSourcePath(source, cwd));
    const encoded: string[] = []; let total = 0;
    for (const filename of filenames) {
        const bytes = await readLocalImage(filename, Math.min(maxFileBytes, IMAGE_TOTAL_LIMIT - total), assertCurrent);
        total += bytes.length; encoded.push(localImageDataUrl(bytes, filename));
    }
    return Array.isArray(value) ? encoded : encoded[0];
}
