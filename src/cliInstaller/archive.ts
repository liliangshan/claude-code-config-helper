/** @file Official npm platform resolution and bounded, script-free tar extraction. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** Resolve the official package for the extension host, not the UI client machine. */
export function platformPackage(platform: string, arch: string, musl = false): string {
    if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported CLI platform: ${platform}/${arch}`);
    return `@anthropic-ai/claude-code-${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
}
/** Verify npm SRI without claiming it is an independent publisher signature. */
export function verifyIntegrity(bytes: Buffer, integrity: string): void {
    const entry = integrity.split(/\s+/).find(value => value.startsWith('sha512-'));
    if (!entry) throw new Error('Official package has no SHA512 integrity');
    const expected = Buffer.from(entry.slice(7), 'base64'), actual = createHash('sha512').update(bytes).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('CLI package integrity mismatch');
}
/** Decode a bounded POSIX tar integer, rejecting base-256 and malformed size fields. */
function octal(block: Buffer, offset: number, length: number): number {
    const text = block.subarray(offset, offset + length).toString('ascii').replace(/\0/g, '').trim();
    if (!/^[0-7]*$/.test(text)) throw new Error('Unsupported tar integer');
    const value = parseInt(text || '0', 8); if (!Number.isSafeInteger(value)) throw new Error('Tar size overflow'); return value;
}

/** Extract only regular files/directories into a fresh staging tree; no links or lifecycle scripts execute. */
export async function extractPlatformArchive(bytes: Buffer, directory: string, platform: string): Promise<string> {
    const tar = gunzipSync(bytes, { maxOutputLength: 768 * 1024 * 1024 });
    const paths = new Set<string>(); let count = 0; let offset = 0;
    const binaries: string[] = [];
    while (offset + 512 <= tar.length) {
        const block = tar.subarray(offset, offset + 512); offset += 512;
        if (block.every(byte => byte === 0)) break;
        let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : block[i];
        if (checksum !== octal(block, 148, 8)) throw new Error('Invalid tar checksum');
        const field = (start: number, size: number) => block.subarray(start, start + size).toString('utf8').split('\0')[0];
        const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/').replace(/\/$/, '');
        const size = octal(block, 124, 12), type = block[156];
        if (++count > 2048 || offset + size > tar.length) throw new Error('Invalid or excessive archive');
        if (!name.startsWith('package/') && name !== 'package') throw new Error('Unexpected npm archive root');
        if (name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..') || paths.has(name.toLowerCase())) throw new Error('Unsafe archive path');
        paths.add(name.toLowerCase());
        if (![0, 48, 53].includes(type)) throw new Error('Archive links and special entries are not allowed');
        const target = path.join(directory, ...name.split('/'));
        if (type === 53) { if (size) throw new Error('Invalid directory entry'); await fs.mkdir(target, { recursive: true, mode: 0o700 }); }
        else {
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await fs.writeFile(target, tar.subarray(offset, offset + size), { flag: 'wx', mode: 0o600 });
            if (path.basename(target) === (platform === 'win32' ? 'claude.exe' : 'claude')) binaries.push(target);
        }
        offset += Math.ceil(size / 512) * 512;
    }
    if (binaries.length !== 1) throw new Error('Platform archive must contain exactly one Claude executable');
    if (platform !== 'win32') await fs.chmod(binaries[0], 0o700);
    return binaries[0];
}
