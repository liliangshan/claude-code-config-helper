/** @file Safe image storage primitives: bounded reads, atomic publication and single-writer locks. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImageError } from './types';

/** Resolve a trusted root and reject every symlink component beneath it; read-only calls never mkdir. */
export async function safeDirectory(root: string, parts: string[], create: boolean): Promise<string> {
    let directory = await fs.realpath(root);
    for (const part of parts) {
        if (!/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..') throw new ImageError('IMAGE_STORAGE_FAILED');
        directory = path.join(directory, part);
        if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ImageError('IMAGE_STORAGE_FAILED');
    }
    return directory;
}
/** Reject symlinks/nonregular files and read with a bounded allocation. */
export async function readJson(file: string, max = 1024 * 1024): Promise<unknown> {
    const before = await fs.lstat(file);
    if (before.isSymbolicLink() || !before.isFile() || before.size > max) throw new ImageError('IMAGE_STORAGE_FAILED');
    const handle = await fs.open(file, 'r');
    try {
        const bytes = Buffer.alloc(max + 1); let bytesRead = 0;
        const stat = await handle.stat();
        if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > max) throw new ImageError('IMAGE_STORAGE_FAILED');
        while (bytesRead < bytes.length) {
            const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
            if (!chunk.bytesRead) break; bytesRead += chunk.bytesRead;
        }
        if (bytesRead > max) throw new ImageError('IMAGE_STORAGE_FAILED');
        return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
}
/** Atomically publish a JSON checkpoint; new records use exclusive linking and never overwrite. */
export async function writeJson(file: string, value: unknown, exclusive = false): Promise<void> {
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new ImageError('IMAGE_STORAGE_FAILED'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = path.join(path.dirname(file), `${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
        finally { await handle.close(); }
        if (exclusive) await fs.link(temporary, file); else await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
}
/** Exclusive ownership. Stale locks are not stolen because PID reuse cannot prove ownership. */
export class ImageFileLock {
    private token = randomUUID();
    private owned = false;
    /** The caller supplies a path in an already validated directory. */
    public constructor(private readonly file: string) {}
    /** Acquire a single-writer lock without waiting or taking over an existing owner. */
    public async acquire(): Promise<void> {
        let handle;
        try { handle = await fs.open(this.file, 'wx', 0o600); }
        catch { throw new ImageError('IMAGE_STORAGE_LOCKED'); }
        try { await handle.writeFile(JSON.stringify({ token: this.token, pid: process.pid, createdAt: Date.now() })); this.owned = true; }
        catch (error) { await fs.unlink(this.file).catch(() => {}); throw error; }
        finally { await handle.close(); }
    }
    /** Validate ownership immediately before each state mutation. */
    public async check(): Promise<void> {
        const value = await readJson(this.file) as { token?: string };
        if (!this.owned || value.token !== this.token) throw new ImageError('IMAGE_STORAGE_LOCKED');
    }
    /** Release only our own lock, leaving foreign or damaged locks visible for recovery. */
    public async release(): Promise<void> {
        if (!this.owned) return;
        await this.check(); await fs.unlink(this.file); this.owned = false;
    }
}
