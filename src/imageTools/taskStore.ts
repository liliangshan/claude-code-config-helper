/** Workspace-local flat task/image storage matching the reference MCP, with metadata-based ownership checks. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImageFileLock, readJson, safeDirectory, writeJson } from './storage';
import { imageType } from './imageClient';
import { ImageError, type ImageTask, type ImageFile } from './types';

export const IMAGE_TASK_ID = /^\d{8}T\d{9}Z_[0-9a-f-]{36}$/;

/** Validate host-generated scope keys, never accepting directory segments from the model. */
export function assertImageScope(scope: string): void {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new ImageError('IMAGE_TASK_NOT_FOUND');
}
/** Validate every restored field used for paths, state or display. No unknown fields survive. */
export function parseImageTask(raw: unknown, scope: string): ImageTask {
    const v = raw as ImageTask;
    if (!v || v.version !== 1 || v.scopeId !== scope || !IMAGE_TASK_ID.test(v.taskId)
        || !['generate', 'edit'].includes(v.operation) || typeof v.prompt !== 'string' || v.prompt.length > 10000
        || typeof v.model !== 'string' || typeof v.size !== 'string' || !Number.isSafeInteger(v.configRevision)
        || !Number.isFinite(v.createdAt) || !Array.isArray(v.images) || v.images.length > 16
        || !['queued', 'running', 'succeeded', 'partially_failed', 'failed', 'interrupted'].includes(v.status)) throw new ImageError('IMAGE_STORAGE_FAILED');
    const images = v.images.map(item => {
        if (!item || !/^[a-f0-9-]{36}$/.test(item.id) || !/^images\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(item.relativePath)
            || path.basename(item.relativePath).split('.')[0] !== item.id || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)
            || !Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new ImageError('IMAGE_STORAGE_FAILED');
        return { id: item.id, relativePath: item.relativePath, mimeType: item.mimeType, bytes: item.bytes };
    });
    return { version: 1, taskId: v.taskId, scopeId: scope, operation: v.operation, prompt: v.prompt, model: v.model,
        configRevision: v.configRevision, size: v.size, status: v.status, createdAt: v.createdAt, images,
        ...(Number.isFinite(v.startedAt) ? { startedAt: v.startedAt } : {}), ...(Number.isFinite(v.finishedAt) ? { finishedAt: v.finishedAt } : {}),
        ...(typeof v.error === 'string' && /^IMAGE_[A-Z0-9_]+$/.test(v.error) ? { error: v.error } : {}) };
}
/** One instance per workspace, shared by all conversations; read-only history never creates directories. */
export class ImageTaskStore {
    private lock?: ImageFileLock;
    /** Bind the actual workspace rather than the focused editor or extension installation path. */
    public constructor(public readonly cwd: string) {}
    /** Validate the optional owner but resolve one shared tasks/images root, matching the reference MCP. */
    private directory(scope?: string, create = false): Promise<string> {
        if (scope) assertImageScope(scope);
        return safeDirectory(this.cwd, ['.LLSOAI', 'openapi-image-generation'], create);
    }
    /** Acquire a workspace writer, then mark unfinished records interrupted without replaying them. */
    public async acquire(): Promise<void> {
        if (this.lock) return;
        const root = await this.directory(undefined, true);
        const lock = new ImageFileLock(path.join(root, 'runtime.lock')); await lock.acquire(); this.lock = lock;
        try {
            for (const task of await this.records()) if (task.status === 'queued' || task.status === 'running') {
                task.status = 'interrupted'; task.error = 'IMAGE_INTERRUPTED'; task.finishedAt = Date.now(); await this.save(task);
            }
        } catch (error) { this.lock = undefined; await lock.release(); throw error; }
    }
    /** Read extension-owned records from the MCP-compatible flat tasks directory without changing external tasks. */
    private async records(): Promise<ImageTask[]> {
        let directory: string;
        try { directory = await safeDirectory(await this.directory(), ['tasks'], false); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        const tasks: ImageTask[] = [];
        for (const name of await fs.readdir(directory)) {
            if (!name.endsWith('.json')) continue;
            if (!IMAGE_TASK_ID.test(name.slice(0, -5))) throw new ImageError('IMAGE_STORAGE_FAILED');
            const raw = await readJson(path.join(directory, name)) as Record<string, unknown>;
            // The reference MCP owns projectName/schemaVersion records; never recover or rewrite those.
            if (raw && typeof raw.projectName === 'string' && raw.scopeId === undefined) continue;
            assertImageScope(String(raw?.scopeId ?? ''));
            const task = parseImageTask(raw, raw.scopeId as string);
            if (task.taskId !== name.slice(0, -5)) throw new ImageError('IMAGE_STORAGE_FAILED'); tasks.push(task);
        }
        return tasks.sort((a, b) => b.createdAt - a.createdAt || b.taskId.localeCompare(a.taskId));
    }
    /** Filter shared task files by host-owned scope metadata, not per-conversation directories. */
    public async list(scope: string): Promise<ImageTask[]> {
        assertImageScope(scope); return (await this.records()).filter(task => task.scopeId === scope);
    }
    /** Resolve a single owned record; foreign or absent IDs receive the same safe error. */
    public async get(scope: string, taskId: string): Promise<ImageTask> {
        assertImageScope(scope);
        if (!IMAGE_TASK_ID.test(taskId)) throw new ImageError('IMAGE_TASK_NOT_FOUND');
        try {
            const directory = await safeDirectory(await this.directory(scope), ['tasks'], false);
            const raw = await readJson(path.join(directory, `${taskId}.json`)) as Record<string, unknown>;
            if (raw?.scopeId !== scope) throw new ImageError('IMAGE_TASK_NOT_FOUND');
            const task = parseImageTask(raw, scope);
            if (task.taskId !== taskId) throw new ImageError('IMAGE_STORAGE_FAILED'); return task;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ImageError('IMAGE_TASK_NOT_FOUND'); throw error; }
    }
    /** Commit only sanitized task metadata while retaining the exclusive workspace owner. */
    public async save(task: ImageTask, exclusive = false): Promise<void> {
        if (!this.lock) throw new ImageError('IMAGE_STORAGE_LOCKED'); await this.lock.check();
        const clean = parseImageTask(task, task.scopeId);
        const directory = await safeDirectory(await this.directory(task.scopeId, true), ['tasks'], true);
        await writeJson(path.join(directory, `${task.taskId}.json`), clean, exclusive);
    }
    /** Publish a raster without overwriting anything and return only its local relative reference. */
    public async saveImage(scope: string, bytes: Buffer): Promise<ImageFile> {
        if (!this.lock) throw new ImageError('IMAGE_STORAGE_LOCKED'); await this.lock.check();
        const { mimeType, extension } = imageType(bytes); const id = randomUUID();
        const directory = await safeDirectory(await this.directory(scope, true), ['images'], true);
        const temporary = path.join(directory, `${id}.tmp`); const destination = path.join(directory, `${id}.${extension}`);
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            await fs.link(temporary, destination);
        } finally { await fs.unlink(temporary).catch(() => {}); }
        return { id, relativePath: `images/${id}.${extension}`, mimeType, bytes: bytes.length };
    }
    /** Resolve only an image recorded in this task and revalidate the file before opening it. */
    public async imagePath(scope: string, taskId: string, imageId: string): Promise<string> {
        const task = await this.get(scope, taskId); const image = task.images.find(item => item.id === imageId);
        if (!image) throw new ImageError('IMAGE_TASK_NOT_FOUND');
        const directory = await safeDirectory(await this.directory(scope), ['images'], false);
        const file = path.join(directory, path.basename(image.relativePath)); const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== image.bytes) throw new ImageError('IMAGE_STORAGE_FAILED');
        const handle = await fs.open(file, 'r');
        try {
            const opened = await handle.stat();
            if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new ImageError('IMAGE_STORAGE_FAILED');
            const signature = Buffer.alloc(12); const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
            if (imageType(signature.subarray(0, bytesRead)).mimeType !== image.mimeType) throw new ImageError('IMAGE_FORMAT_UNSUPPORTED');
        } finally { await handle.close(); }
        return file;
    }
    /** Release the workspace only after all task writes have drained. */
    public async release(): Promise<void> { await this.lock?.release(); this.lock = undefined; }
}
