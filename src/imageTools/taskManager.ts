/** @file Host-owned asynchronous image queue; accepted tasks survive Webview and CLI changes. */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ImageTaskStore } from './taskStore';
import { generateImages, loadGeneratedImage } from './imageClient';
import { IMAGE_TOTAL_LIMIT, ImageError, imageErrorCode, type ImageGenerationExecutionSnapshot, type ImageSubmission, type ImageTask } from './types';

/** Transient queue item: secrets and edit sources never reach task JSON. */
interface Work { task: ImageTask; snapshot: ImageGenerationExecutionSnapshot; input: ImageSubmission }
/** Injectable client supports local deterministic tests without any billable service. */
export interface ImageTaskClient {
    generate: typeof generateImages; load: typeof loadGeneratedImage;
}
/** Workspace-wide concurrency/queue gate shared by main, left and retained editor conversations. */
export class ImageTaskManager extends EventEmitter {
    private pending: Work[] = [];
    private running = new Map<string, { promise: Promise<void>; controller: AbortController; scope: string }>();
    private admission: Promise<unknown> = Promise.resolve();
    private initializing?: Promise<void>;
    private stopped = false;
    private maxConcurrent = 1;
    private maxQueue = 100;
    /** Bind one single-writer store and optionally a simulated transport. */
    public constructor(public readonly store: ImageTaskStore, private readonly client: ImageTaskClient = { generate: generateImages, load: loadGeneratedImage }) { super(); }
    /** Update shared scheduling limits without changing already accepted request snapshots. */
    public configure(maxConcurrent: number, maxQueue: number): void { this.maxConcurrent = maxConcurrent; this.maxQueue = maxQueue; this.pump(); }
    /** Restore existing tasks without admitting or replaying any generation request. */
    public async restore(): Promise<void> {
        if (this.stopped) throw new ImageError('IMAGE_INTERRUPTED');
        this.initializing ??= this.store.acquire().catch(error => { this.initializing = undefined; throw error; });
        await this.initializing;
    }
    /** Persist acceptance before acknowledging, serializing lock acquisition and capacity checks. */
    public submit(scope: string, snapshot: ImageGenerationExecutionSnapshot, input: ImageSubmission, admit?: () => Promise<void>): Promise<ImageTask> {
        const operation = this.admission.then(async () => {
            if (this.stopped) throw new ImageError('IMAGE_INTERRUPTED');
            await this.restore();
            await admit?.();
            if (this.stopped) throw new ImageError('IMAGE_INTERRUPTED');
            if (this.pending.length >= this.maxQueue) throw new ImageError('IMAGE_QUEUE_FULL');
            const task: ImageTask = { version: 1, taskId: `${new Date().toISOString().replace(/[-:.]/g, '')}_${randomUUID()}`,
                scopeId: scope, operation: input.operation, prompt: input.prompt,
                model: input.operation === 'edit' ? snapshot.config.editModelId || snapshot.config.modelId : snapshot.config.modelId,
                configRevision: snapshot.config.revision, size: input.size, status: 'queued', createdAt: Date.now(), images: [] };
            await this.store.save(task, true);
            const accepted = JSON.parse(JSON.stringify(task)) as ImageTask;
            this.pending.push({ task, snapshot: { ...snapshot, config: { ...snapshot.config }, headers: { ...snapshot.headers } }, input: { ...input, ...(Array.isArray(input.image) ? { image: [...input.image] } : {}) } });
            this.emit('change', scope); this.pump(); return accepted;
        });
        this.admission = operation.catch(() => {}); return operation;
    }
    /** Fill slots without holding an MCP request open for generation. */
    private pump(): void {
        while (!this.stopped && this.running.size < this.maxConcurrent && this.pending.length) {
            const work = this.pending.shift()!; const controller = new AbortController();
            const promise = this.execute(work, controller).catch(() => { this.stopped = true; }).finally(() => { this.running.delete(work.task.taskId); this.pump(); });
            this.running.set(work.task.taskId, { promise, controller, scope: work.task.scopeId });
        }
    }
    /** Execute once, checkpoint each saved image, and preserve partial results on any later failure. */
    private async execute(work: Work, controller: AbortController): Promise<void> {
        const { task, snapshot, input } = work; const timer = setTimeout(() => controller.abort(), snapshot.config.timeoutMs);
        try {
            task.status = 'running'; task.startedAt = Date.now(); await this.store.save(task); this.emit('change', task.scopeId);
            const items = await this.client.generate(snapshot, input, controller.signal);
            let total = 0; let failure = items.length > 16 ? 'IMAGE_RESPONSE_TOO_LARGE' : undefined;
            for (const item of items.slice(0, 16)) {
                try {
                    controller.signal.throwIfAborted();
                    const bytes = await this.client.load(item, Math.min(snapshot.config.maxFileBytes, IMAGE_TOTAL_LIMIT - total), controller.signal);
                    controller.signal.throwIfAborted(); total += bytes.length;
                    if (total > IMAGE_TOTAL_LIMIT) throw new ImageError('IMAGE_RESPONSE_TOO_LARGE');
                    task.images.push(await this.store.saveImage(task.scopeId, bytes)); await this.store.save(task);
                } catch (error) { failure = imageErrorCode(error); if (controller.signal.aborted) break; }
            }
            task.status = failure ? (task.images.length ? 'partially_failed' : 'failed') : 'succeeded'; task.error = failure;
            if (controller.signal.aborted) throw new ImageError('IMAGE_INTERRUPTED');
        } catch (error) {
            task.status = controller.signal.aborted ? 'interrupted' : task.images.length ? 'partially_failed' : 'failed';
            task.error = controller.signal.aborted ? 'IMAGE_INTERRUPTED' : imageErrorCode(error);
        } finally {
            clearTimeout(timer); task.finishedAt = Date.now();
            try { await this.store.save(task); }
            catch { task.error = 'IMAGE_STORAGE_FAILED'; this.stopped = true; }
            this.emit('change', task.scopeId);
        }
    }
    /** Test or shutdown helper waits for both accepted and active operations. */
    public async idle(): Promise<void> {
        await this.admission;
        while (this.running.size) await Promise.all([...this.running.values()].map(item => item.promise));
    }
    /** Check whether closing a conversation needs a background-task decision. */
    public hasPending(scope: string): boolean { return this.pending.some(work => work.task.scopeId === scope) || [...this.running.values()].some(work => work.scope === scope); }
    /** Abort local work for one scope only; this never claims to cancel provider billing. */
    public async interruptScope(scope: string): Promise<void> {
        await this.admission;
        const removed = this.pending.filter(work => work.task.scopeId === scope); this.pending = this.pending.filter(work => work.task.scopeId !== scope);
        for (const work of removed) { work.task.status = 'interrupted'; work.task.error = 'IMAGE_INTERRUPTED'; work.task.finishedAt = Date.now(); await this.store.save(work.task); }
        const active = [...this.running.values()].filter(work => work.scope === scope);
        for (const work of active) work.controller.abort();
        await Promise.all(active.map(work => work.promise)); this.emit('change', scope);
    }
    /** Stop admissions, interrupt all local work, checkpoint, and release the workspace writer. */
    public async close(): Promise<void> {
        this.stopped = true; await this.admission;
        const scopes = new Set([...this.pending.map(work => work.task.scopeId), ...[...this.running.values()].map(work => work.scope)]);
        try { for (const scope of scopes) await this.interruptScope(scope); }
        finally { await this.store.release(); this.removeAllListeners(); }
    }
}
