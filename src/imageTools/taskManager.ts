/** @file Host-owned asynchronous image queue; accepted tasks survive Webview and CLI changes. */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ImageTaskStore } from './taskStore';
import { generateImages, loadGeneratedImage } from './imageClient';
import { IMAGE_TOTAL_LIMIT, ImageError, imageErrorCode, type ImageGenerationExecutionSnapshot, type ImageSubmission, type ImageTask } from './types';
import { parseImageResponsePreview } from './responsePreview';

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
    private readonly unsaved = new Map<string, ImageTask>();
    private maxConcurrent = 1;
    private maxQueue = 100;
    /** Bind one task-owning writer and optionally a simulated transport; no workspace lock is acquired. */
    public constructor(public readonly store: ImageTaskStore, private readonly client: ImageTaskClient = { generate: generateImages, load: loadGeneratedImage }) { super(); }
    /** Update shared scheduling limits without changing already accepted request snapshots. */
    public configure(maxConcurrent: number, maxQueue: number): void { this.maxConcurrent = maxConcurrent; this.maxQueue = maxQueue; this.pump(); }
    /** Prepare this host's task writer without recovering, modifying or replaying other hosts' tasks. */
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
    /**
     * Retain a task-local storage failure in memory and notify diagnostics without stopping unrelated work.
     * @param task Task whose checkpoint failed; its original images and safe metadata are preserved.
     * @param error Filesystem or stable storage error, never a provider request/response object.
     * @param stage Checkpoint phase for the diagnostic log.
     * @returns Nothing; listeners receive only allowlisted codes and identifiers.
     */
    private storageFailure(task: ImageTask, error: unknown, stage: string): void {
        const code = imageErrorCode(error);
        task.error = code;
        if (task.status !== 'interrupted') task.status = task.images.length ? 'partially_failed' : 'failed';
        task.finishedAt = Date.now();
        this.unsaved.set(task.taskId, JSON.parse(JSON.stringify(task)) as ImageTask);
        const errno = error instanceof ImageError ? /^IMAGE_STORAGE_RENAME_([A-Z0-9_]+)$/.exec(error.code)?.[1] : (error as NodeJS.ErrnoException)?.code;
        this.emit('storageFailure', { taskId: task.taskId, stage, code, ...(typeof errno === 'string' && /^[A-Z0-9_]{1,64}$/.test(errno) ? { errno } : {}) });
    }
    /**
     * Overlay unpersisted terminal states only for this queue's owned tasks and requested scope.
     * @param scope Conversation identity whose records may be returned.
     * @param records Durable records read from the shared task directory.
     * @returns Scope-filtered snapshots with local storage errors replacing stale queued/running entries.
     */
    public visibleTasks(scope: string, records: ImageTask[]): ImageTask[] {
        const tasks = new Map(records.filter(task => task.scopeId === scope).map(task => [task.taskId, task]));
        for (const task of this.unsaved.values()) if (task.scopeId === scope) tasks.set(task.taskId, JSON.parse(JSON.stringify(task)) as ImageTask);
        return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt || b.taskId.localeCompare(a.taskId));
    }
    /** Fill slots without holding an MCP request open; task-local failures never disable the whole queue. */
    private pump(): void {
        while (!this.stopped && this.running.size < this.maxConcurrent && this.pending.length) {
            const work = this.pending.shift()!; const controller = new AbortController();
            const promise = this.execute(work, controller).catch(error => {
                this.storageFailure(work.task, error, 'execute'); this.emit('change', work.task.scopeId);
            }).finally(() => { this.running.delete(work.task.taskId); this.pump(); });
            this.running.set(work.task.taskId, { promise, controller, scope: work.task.scopeId });
        }
    }
    /**
     * Execute once, preserving saved images and bounded response diagnostics for terminal failures.
     * Emit completion only after a terminal checkpoint succeeds, never during history reads.
     * @param work Frozen task, provider settings and transient input images.
     * @param controller Cancellation controller shared with timeout and explicit local stop.
     * @returns Completion after durable state is written and owning views are notified.
     */
    private async execute(work: Work, controller: AbortController): Promise<void> {
        const { task, snapshot, input } = work; const timer = setTimeout(() => controller.abort(), snapshot.config.timeoutMs);
        try {
            task.status = 'running'; task.startedAt = Date.now();
            try { await this.store.save(task); }
            catch (error) { this.storageFailure(task, error, 'running'); throw error; }
            this.emit('change', task.scopeId);
            controller.signal.throwIfAborted();
            const items = await this.client.generate(snapshot, input, controller.signal);
            let total = 0; let failure = items.length > 16 ? 'IMAGE_RESPONSE_TOO_LARGE' : undefined;
            for (const item of items.slice(0, 16)) {
                try {
                    controller.signal.throwIfAborted();
                    const bytes = await this.client.load(item, Math.min(snapshot.config.maxFileBytes, IMAGE_TOTAL_LIMIT - total), controller.signal);
                    controller.signal.throwIfAborted(); total += bytes.length;
                    if (total > IMAGE_TOTAL_LIMIT) throw new ImageError('IMAGE_RESPONSE_TOO_LARGE');
                    task.images.push(await this.store.saveImage(task.scopeId, bytes)); await this.store.save(task);
                } catch (error) {
                    failure = imageErrorCode(error);
                    task.responsePreview = error instanceof ImageError ? parseImageResponsePreview(error.responsePreview) : undefined;
                    if (controller.signal.aborted) break;
                }
            }
            task.status = failure ? (task.images.length ? 'partially_failed' : 'failed') : 'succeeded'; task.error = failure;
            if (controller.signal.aborted) throw new ImageError('IMAGE_INTERRUPTED');
        } catch (error) {
            task.status = controller.signal.aborted ? 'interrupted' : task.images.length ? 'partially_failed' : 'failed';
            task.error = controller.signal.aborted ? 'IMAGE_INTERRUPTED' : imageErrorCode(error);
            task.responsePreview = error instanceof ImageError ? parseImageResponsePreview(error.responsePreview) : undefined;
        } finally {
            clearTimeout(timer); task.finishedAt = Date.now();
            let completed: ImageTask | undefined;
            try {
                await this.store.save(task); this.unsaved.delete(task.taskId);
                completed = JSON.parse(JSON.stringify(task)) as ImageTask;
            } catch (error) { this.storageFailure(task, error, 'terminal'); }
            this.emit('change', task.scopeId);
            if (completed) this.emit('completed', completed);
        }
    }
    /** Test or shutdown helper waits for both accepted and active operations. */
    public async idle(): Promise<void> {
        await this.admission;
        while (this.running.size) await Promise.all([...this.running.values()].map(item => item.promise));
    }
    /** Check whether closing a conversation needs a background-task decision. */
    public hasPending(scope: string): boolean { return this.pending.some(work => work.task.scopeId === scope) || [...this.running.values()].some(work => work.scope === scope); }
    /**
     * Stop only the requested scope; a failed cancellation checkpoint cannot block other cancellations.
     * @param scope Host-owned conversation identity.
     * @returns Completion after its running tasks settle, without replaying provider requests.
     */
    public async interruptScope(scope: string): Promise<void> {
        await this.admission;
        const removed = this.pending.filter(work => work.task.scopeId === scope); this.pending = this.pending.filter(work => work.task.scopeId !== scope);
        for (const work of removed) {
            work.task.status = 'interrupted'; work.task.error = 'IMAGE_INTERRUPTED'; work.task.finishedAt = Date.now();
            try { await this.store.save(work.task); }
            catch (error) { this.storageFailure(work.task, error, 'cancel'); }
        }
        const active = [...this.running.values()].filter(work => work.scope === scope);
        for (const work of active) work.controller.abort();
        await Promise.all(active.map(work => work.promise)); this.emit('change', scope);
    }
    /** Stop admissions and drain only this host's tasks/writes without claiming shared workspace ownership. */
    public async close(): Promise<void> {
        this.stopped = true; await this.admission;
        const scopes = new Set([...this.pending.map(work => work.task.scopeId), ...[...this.running.values()].map(work => work.scope)]);
        try { for (const scope of scopes) await this.interruptScope(scope); }
        finally { await this.store.release(); this.removeAllListeners(); }
    }
}
