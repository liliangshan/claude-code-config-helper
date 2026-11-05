/** Workspace-local flat task/image storage matching the reference MCP, with metadata-based ownership checks. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, safeDirectory, writeJson } from './storage';
import { imageType } from './imageClient';
import { ImageError, type ImageTask, type ImageFile } from './types';
import { parseImageResponsePreview } from './responsePreview';
import { imageAnimationOptions } from './animation';

export const IMAGE_TASK_ID = /^\d{8}T\d{9}Z_[0-9a-f-]{36}$/;

/** Validate host-generated scope keys, never accepting directory segments from the model. */
export function assertImageScope(scope: string): void {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new ImageError('IMAGE_TASK_NOT_FOUND');
}
/**
 * Validate restored GIF/static fields and keep only bounded, sanitized diagnostic metadata.
 * @param raw Task data loaded from disk or prepared for persistence.
 * @param scope Expected host-owned conversation identity.
 * @returns An allowlisted task record with no credentials or full response payloads.
 */
export function parseImageTask(raw: unknown, scope: string): ImageTask {
    const v = raw as ImageTask;
    if (!v || v.version !== 1 || v.scopeId !== scope || !IMAGE_TASK_ID.test(v.taskId)
        || !['generate', 'edit'].includes(v.operation) || typeof v.prompt !== 'string' || v.prompt.length > 10000
        || typeof v.model !== 'string' || typeof v.size !== 'string' || !Number.isSafeInteger(v.configRevision)
        || !Number.isFinite(v.createdAt) || !Array.isArray(v.images) || v.images.length > 16
        || !['queued', 'running', 'succeeded', 'partially_failed', 'failed', 'interrupted'].includes(v.status)) throw new ImageError('IMAGE_STORAGE_FAILED');
    const images = v.images.map(item => {
        if (!item || !/^[a-f0-9-]{36}$/.test(item.id) || !/^images\/[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(item.relativePath)
            || path.basename(item.relativePath).split('.')[0] !== item.id || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mimeType)
            || !Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new ImageError('IMAGE_STORAGE_FAILED');
        return { id: item.id, relativePath: item.relativePath, mimeType: item.mimeType, bytes: item.bytes };
    });
    const responsePreview = parseImageResponsePreview(v.responsePreview);
    return { version: 1, taskId: v.taskId, scopeId: scope, operation: v.operation, prompt: v.prompt, model: v.model,
        configRevision: v.configRevision, size: v.size, ...imageAnimationOptions(v, v.size, true), status: v.status, createdAt: v.createdAt, images,
        ...(Number.isFinite(v.startedAt) ? { startedAt: v.startedAt } : {}), ...(Number.isFinite(v.finishedAt) ? { finishedAt: v.finishedAt } : {}),
        ...(typeof v.error === 'string' && /^IMAGE_[A-Z0-9_]+$/.test(v.error) ? { error: v.error } : {}),
        ...(responsePreview ? { responsePreview } : {}) };
}
/** Independent task writer: UUID files are owned in memory, never by a workspace-wide runtime.lock. */
export class ImageTaskStore {
    private writable = false;
    private readonly ownedTasks = new Map<string, string>();
    private readonly writes = new Map<string, Promise<void>>();
    /** Bind the actual workspace rather than the focused editor or extension installation path. */
    public constructor(public readonly cwd: string) {}
    /** Validate the optional owner but resolve one shared tasks/images root, matching the reference MCP. */
    private directory(scope?: string, create = false): Promise<string> {
        if (scope) assertImageScope(scope);
        return safeDirectory(this.cwd, ['.LLSOAI', 'openapi-image-generation'], create);
    }
    /**
     * Enable this writer without acquiring runtime.lock or changing tasks belonging to other hosts.
     * Existing unfinished records remain read-only: another window or remote host may still own them.
     * @returns Completion after the shared output directory is validated.
     */
    public async acquire(): Promise<void> {
        await this.directory(undefined, true); this.writable = true;
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
    /**
     * Serialize updates of each owned UUID independently; other task files and hosts do not share a lock.
     * @param task Metadata snapshot whose scope must match the original accepted task.
     * @param exclusive Whether this is the initial, non-overwriting creation of this task.
     * @returns Completion after this particular task checkpoint has been published.
     */
    public async save(task: ImageTask, exclusive = false): Promise<void> {
        const clean = parseImageTask(task, task.scopeId);
        if (!this.writable) throw new ImageError('IMAGE_STORAGE_CLOSED');
        const operation = (this.writes.get(clean.taskId) ?? Promise.resolve()).catch(() => {}).then(async () => {
            if (!exclusive && this.ownedTasks.get(clean.taskId) !== clean.scopeId) throw new ImageError('IMAGE_TASK_NOT_OWNED');
            const directory = await safeDirectory(await this.directory(clean.scopeId, true), ['tasks'], true);
            await writeJson(path.join(directory, `${clean.taskId}.json`), clean, exclusive);
            if (exclusive) this.ownedTasks.set(clean.taskId, clean.scopeId);
        });
        this.writes.set(clean.taskId, operation);
        try { await operation; }
        finally { if (this.writes.get(clean.taskId) === operation) this.writes.delete(clean.taskId); }
    }
    /**
     * Publish a random image file without a shared runtime lock or overwriting an existing image.
     * @param scope Host-owned conversation identity.
     * @param bytes Verified output image bytes to persist.
     * @returns The published image's local metadata.
     */
    public async saveImage(scope: string, bytes: Buffer): Promise<ImageFile> {
        if (!this.writable) throw new ImageError('IMAGE_STORAGE_CLOSED');
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
    /**
     * Drain this writer's pending checkpoints without touching other writers or legacy runtime.lock files.
     * @returns Completion after pending task writes settle and local write ownership is released.
     */
    public async release(): Promise<void> {
        this.writable = false;
        await Promise.allSettled([...this.writes.values()]); this.ownedTasks.clear();
    }
}
