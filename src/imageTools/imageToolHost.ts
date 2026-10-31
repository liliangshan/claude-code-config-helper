/** @file Host-facing image orchestration: global config, validated direct submission and scoped task ownership. */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import type { McpToolResult } from '../mcpKit/types';
import { ImageConfigStore } from './configStore';
import { ImageTaskManager } from './taskManager';
import { ImageTaskStore } from './taskStore';
import { safeDirectory } from './storage';
import { validateImageSource } from './imageClient';
import { IMAGE_TOOL_SCHEMAS, isImageToolName } from './tools';
import { isImageTaskTerminal } from './results';
import { IMAGE_BODY_LIMIT, ImageError, imageErrorCode, type ImageScope, type ImageSubmission, type ImageTask, type ImageWebviewMessage, type ImageWebviewRequest } from './types';

/** A bound presentation supplies its own current task scope and never selects a global model itself. */
export interface ImageViewBinding {
    scope(): Promise<ImageScope>; post(message: ImageWebviewMessage): void;
    /** Read the durable result-delivery receipt for this exact conversation and task. */
    delivered?(scope: ImageScope, task: ImageTask): boolean;
    /** Persist a completion user event and deliver it once; return false while this conversation is busy or changed. */
    complete?(scope: ImageScope, task: ImageTask): Promise<boolean>;
}
const lifecycleLabels: Record<string, { background: string; stop: string; running: string; restoreFailed: string }> = {
    en: { background: 'Continue in background', stop: 'Stop locally', running: 'Image tasks are still running; stopping locally does not guarantee provider cancellation.', restoreFailed: 'Image task recovery failed. Check workspace storage and locks.' },
    'zh-cn': { background: '继续后台执行', stop: '本地中止', running: '图片任务仍在运行；本地中止不保证服务商停止或免于计费。', restoreFailed: '图片任务恢复失败，请检查工作区存储和锁文件。' },
    'zh-tw': { background: '繼續背景執行', stop: '本機中止', running: '圖片任務仍在執行；本機中止不保證服務商停止或免於計費。', restoreFailed: '圖片任務恢復失敗，請檢查工作區儲存與鎖定檔案。' },
    ja: { background: 'バックグラウンドで続行', stop: 'ローカルで停止', running: '画像処理中です。ローカル停止はプロバイダー側の取消や無料を保証しません。', restoreFailed: '画像タスクを復元できません。保存先とロックを確認してください。' },
    ko: { background: '백그라운드 계속', stop: '로컬 중지', running: '이미지 작업 실행 중입니다. 로컬 중지는 제공자의 취소나 요금 면제를 보장하지 않습니다.', restoreFailed: '이미지 작업 복원 실패. 작업 공간 저장소와 잠금을 확인하세요.' },
    fr: { background: 'Continuer en arrière-plan', stop: 'Arrêter localement', running: 'Des tâches image sont actives. L’arrêt local ne garantit pas l’annulation ni l’absence de frais.', restoreFailed: 'Restauration des tâches image impossible. Vérifiez le stockage et les verrous.' },
    de: { background: 'Im Hintergrund fortsetzen', stop: 'Lokal stoppen', running: 'Bildaufgaben laufen noch. Lokales Stoppen garantiert weder Abbruch beim Anbieter noch Kostenfreiheit.', restoreFailed: 'Bildaufgaben konnten nicht wiederhergestellt werden. Speicher und Sperren prüfen.' }
};
/** Extension-lifetime service owns queues and result listeners independently of CLI processes. */
export class ImageToolHost {
    public readonly config: ImageConfigStore;
    private readonly queues = new Map<string, ImageTaskManager>();
    private readonly views = new Set<ImageViewBinding>();
    private readonly delivered = new WeakMap<ImageViewBinding, Set<string>>();
    private readonly delivering = new WeakMap<ImageViewBinding, Set<string>>();
    private readonly retryTimers = new Map<ImageViewBinding, NodeJS.Timeout>();
    private readonly calls = new Map<string, { fingerprint: string; result: Promise<McpToolResult> }>();
    private readonly providerSubscription: vscode.Disposable;
    private stopped = false;
    private updateTimer?: NodeJS.Timeout;
    /** Bind global storage without copying provider secrets or conversation-specific model defaults. */
    public constructor(private readonly context: vscode.ExtensionContext, private readonly manager: ConfigManager) {
        this.config = new ImageConfigStore(context.globalStorageUri.fsPath, context.secrets, manager);
        this.config.on('change', () => {
            if (this.updateTimer) clearTimeout(this.updateTimer);
            this.updateTimer = setTimeout(() => { void this.broadcast(); }, 80);
        });
        this.providerSubscription = manager.onDidChange(() => this.config.refresh());
    }
    /** Initialize settings and recover only existing workspace task stores; never replay paid requests. */
    public async initialize(): Promise<void> {
        await this.config.initialize();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (!vscode.workspace.isTrusted || !['file', 'vscode-remote'].includes(folder.uri.scheme)) continue;
            try {
                await safeDirectory(folder.uri.fsPath, ['.LLSOAI', 'openapi-image-generation'], false);
                await (await this.queue(folder.uri.fsPath)).restore();
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    const labels = lifecycleLabels[this.manager.getResolvedUiLanguage()] || lifecycleLabels.en;
                    void vscode.window.showWarningMessage(`${labels.restoreFailed} (${imageErrorCode(error)})`);
                }
            }
        }
    }
    /** Attach a chat without retaining its Webview after disposal. */
    public attach(view: ImageViewBinding): vscode.Disposable {
        this.views.add(view);
        const delivered = this.delivered.get(view); if (delivered) delivered.clear();
        return { dispose: () => { this.views.delete(view); const timer = this.retryTimers.get(view); if (timer) clearTimeout(timer); this.retryTimers.delete(view); } };
    }
    /** Refresh all configuration chips and scheduling limits, never replacing open form drafts. */
    private async broadcast(): Promise<void> {
        if (this.stopped) return;
        try {
            const state = await this.config.publicState();
            for (const queue of this.queues.values()) queue.configure(state.config.maxConcurrent, state.config.maxQueue);
            for (const view of this.views) view.post({ type: 'imageGeneration/state', state });
        } catch { /* The next explicit read reports storage failure without leaking internal errors. */ }
    }
    /** Resolve a real workspace directory; virtual/absent/untrusted workspaces cannot receive generated files. */
    private async workspace(cwd: string, writable = true): Promise<string> {
        if (!vscode.workspace.isTrusted || !path.isAbsolute(cwd)) throw new ImageError('IMAGE_WORKSPACE_REQUIRED');
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.some(folder => ['file', 'vscode-remote'].includes(folder.uri.scheme))) throw new ImageError('IMAGE_WORKSPACE_REQUIRED');
        const root = await fs.realpath(cwd);
        const roots = await Promise.all(folders.filter(folder => ['file', 'vscode-remote'].includes(folder.uri.scheme)).map(folder => fs.realpath(folder.uri.fsPath)));
        if (!roots.some(folder => root === folder || (!path.relative(folder, root).startsWith('..') && !path.isAbsolute(path.relative(folder, root))))) throw new ImageError('IMAGE_WORKSPACE_REQUIRED');
        await fs.access(root, writable ? fs.constants.W_OK : fs.constants.R_OK); return root;
    }
    /** Reuse one scheduler per canonical workspace and send updates only to its owning conversations. */
    private async queue(cwd: string): Promise<ImageTaskManager> {
        const root = await this.workspace(cwd); let queue = this.queues.get(root);
        if (!queue) {
            queue = new ImageTaskManager(new ImageTaskStore(root)); this.queues.set(root, queue);
            queue.on('change', (scopeId: string) => { void this.notifyTasks(root, scopeId); });
        }
        return queue;
    }
    /** Retry local receipt delivery only while the original scope remains current; this never polls or calls the provider. */
    private scheduleResultDelivery(view: ImageViewBinding, scope: ImageScope): void {
        if (this.stopped || this.retryTimers.has(view) || !this.views.has(view)) return;
        const timer = setTimeout(() => {
            this.retryTimers.delete(view);
            if (!this.stopped && this.views.has(view)) void this.publishTasks(view, scope).catch(() => {});
        }, 750);
        timer.unref?.(); this.retryTimers.set(view, timer);
    }
    /** Deliver each terminal task once per bound history, rechecking ownership after every asynchronous read. */
    private async publishTasks(view: ImageViewBinding, scope: ImageScope, requestId?: string, replay = false): Promise<void> {
        const cwd = await fs.realpath(scope.cwd); const tasks = await new ImageTaskStore(cwd).list(scope.id);
        const current = await view.scope();
        if (current.id !== scope.id || current.cwd !== scope.cwd || this.stopped) return;
        view.post({ type: 'imageGeneration/taskUpdate', scopeId: scope.id, tasks: tasks.slice(0, 100), requestId });
        const delivered = this.delivered.get(view) ?? new Set<string>(); this.delivered.set(view, delivered);
        const delivering = this.delivering.get(view) ?? new Set<string>(); this.delivering.set(view, delivering);
        const resultTasks = tasks.slice(0, 100).filter(isImageTaskTerminal).reverse();
        const undelivered = resultTasks.filter(task => !delivered.has(task.taskId) && !view.delivered?.(scope, task));
        const candidates = undelivered.length ? undelivered : replay ? resultTasks : [];
        for (const task of candidates) {
            if (!view.complete) continue;
            if (delivering.has(task.taskId)) { this.scheduleResultDelivery(view, scope); continue; }
            delivering.add(task.taskId);
            try {
                const latest = await view.scope();
                if (this.stopped || latest.id !== scope.id || latest.cwd !== scope.cwd) return;
                if (await view.complete(scope, task)) delivered.add(task.taskId);
                else { this.scheduleResultDelivery(view, scope); return; }
            } finally { delivering.delete(task.taskId); }
        }
    }
    /** Refresh task cards and append terminal results only in the owning conversation, even when the dialog is closed. */
    private async notifyTasks(cwd: string, scopeId: string): Promise<void> {
        for (const view of this.views) {
            try {
                const scope = await view.scope();
                if (scope.id === scopeId && await fs.realpath(scope.cwd) === cwd) await this.publishTasks(view, scope);
            } catch { /* Saved task results remain available for the next ready/refresh if a view disappears. */ }
        }
    }
    /** Enforce schema fields and tool envelope size again at the trusted host boundary. */
    private validate(name: string, args: Record<string, unknown>): void {
        const schema = IMAGE_TOOL_SCHEMAS.find(item => item.name === name);
        if (!schema || !args || Array.isArray(args) || typeof args !== 'object') throw new ImageError('IMAGE_ARGUMENT_INVALID');
        if (Object.keys(args).some(key => !Object.hasOwnProperty.call(schema.inputSchema.properties, key))) throw new ImageError('IMAGE_ARGUMENT_INVALID');
        if (Buffer.byteLength(JSON.stringify({ name, arguments: args })) > IMAGE_BODY_LIMIT) throw new ImageError('IMAGE_PAYLOAD_TOO_LARGE');
    }
    /** Deduplicate only a stable bridge request identity, never unrelated submissions with equal prompts. */
    public execute(scope: ImageScope, name: string, args: Record<string, unknown>, requestId: string, stillCurrent: () => boolean): Promise<McpToolResult> {
        const byteLength = Buffer.byteLength(JSON.stringify({ name, arguments: args }));
        if (byteLength > IMAGE_BODY_LIMIT) return Promise.resolve({ isError: true, content: [{ type: 'text', text: 'IMAGE_PAYLOAD_TOO_LARGE' }] });
        if (name !== 'openapi_generate_image' && name !== 'openapi_edit_image') {
            return this.dispatch(scope, name, args, stillCurrent).then(value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }),
                error => ({ isError: true, content: [{ type: 'text', text: imageErrorCode(error) }] }));
        }
        const key = `${scope.cwd}:${scope.id}:${requestId}`; const fingerprint = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
        const old = this.calls.get(key);
        if (old) return old.fingerprint === fingerprint ? old.result : Promise.resolve({ isError: true, content: [{ type: 'text', text: 'IMAGE_ARGUMENT_INVALID' }] });
        const result = this.dispatch(scope, name, args, stillCurrent).then(value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] } as McpToolResult),
            error => ({ isError: true, content: [{ type: 'text', text: imageErrorCode(error) }] } as McpToolResult));
        this.calls.set(key, { fingerprint, result });
        if (this.calls.size > 10000) this.calls.delete(this.calls.keys().next().value!);
        return result;
    }
    /** Dispatch read-only tools locally and submit enabled generation/edit calls directly after snapshot validation. */
    private async dispatch(scope: ImageScope, name: string, args: Record<string, unknown>, stillCurrent: () => boolean): Promise<unknown> {
        if (this.stopped || !stillCurrent() || !isImageToolName(name)) throw new ImageError('IMAGE_PERMISSION_DENIED');
        this.validate(name, args);
        if (name === 'openapi_image_generation_info') {
            const state = await this.config.publicState(); const c = state.config;
            return { enabled: c.enabled, configured: !state.error && !!c.modelId, model: c.modelId, sizeRequired: true,
                storageDirectory: '.LLSOAI/openapi-image-generation',
                editEnabled: c.editEnabled, timeoutMs: c.timeoutMs, maxConcurrent: c.maxConcurrent, maxQueue: c.maxQueue,
                maxResponseBytes: c.maxResponseBytes, maxFileBytes: c.maxFileBytes, error: state.error };
        }
        const cwd = await this.workspace(scope.cwd, name === 'openapi_generate_image' || name === 'openapi_edit_image'); const store = new ImageTaskStore(cwd);
        if (name === 'openapi_get_image_task') return store.get(scope.id, String(args.taskId ?? ''));
        if (name === 'openapi_list_images' || name === 'openapi_search_images') {
            const offset = args.offset ?? 0, limit = args.limit ?? 20;
            if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new ImageError('IMAGE_ARGUMENT_INVALID');
            let tasks = await store.list(scope.id);
            if (name === 'openapi_search_images') {
                if (typeof args.query !== 'string' || !args.query.trim() || args.query.trim().length > 1000) throw new ImageError('IMAGE_ARGUMENT_INVALID');
                const query = args.query.trim().toLowerCase(); tasks = tasks.filter(task => task.prompt.toLowerCase().includes(query));
            }
            return { total: tasks.length, offset, limit, items: tasks.slice(offset as number, (offset as number) + (limit as number)) };
        }
        const config = await this.config.read();
        if (!config.enabled) throw new ImageError('IMAGE_CONFIG_REQUIRED');
        const snapshot = await this.config.resolve(config);
        const operation = name === 'openapi_edit_image' ? 'edit' : 'generate';
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        const size = args.size;
        if (!prompt || prompt.length > 10000 || typeof size !== 'string' || !/^[1-9]\d{0,5}x[1-9]\d{0,5}$/.test(size)) throw new ImageError('IMAGE_ARGUMENT_INVALID');
        const input: ImageSubmission = { prompt, size, operation };
        if (operation === 'edit') {
            if (!config.editEnabled) throw new ImageError('IMAGE_EDIT_DISABLED');
            const sources = Array.isArray(args.image) ? args.image : [args.image];
            if (!sources.length || sources.length > 16) throw new ImageError('IMAGE_ARGUMENT_INVALID');
            const images = sources.map(source => validateImageSource(source, config.maxFileBytes));
            input.image = Array.isArray(args.image) ? images : images[0];
        }
        if (this.stopped || !stillCurrent()) throw new ImageError('IMAGE_PERMISSION_DENIED');
        const latest = await this.config.resolve(await this.config.read());
        if (JSON.stringify(latest) !== JSON.stringify(snapshot) || !latest.config.enabled) throw new ImageError('IMAGE_CONFIG_CONFLICT');
        const queue = await this.queue(cwd); queue.configure(config.maxConcurrent, config.maxQueue);
        const task = await queue.submit(scope.id, snapshot, input, async () => {
            if (this.stopped || !stillCurrent()) throw new ImageError('IMAGE_PERMISSION_DENIED');
            if (JSON.stringify(await this.config.resolve(await this.config.read())) !== JSON.stringify(snapshot)) throw new ImageError('IMAGE_CONFIG_CONFLICT');
            if (this.stopped || !stillCurrent()) throw new ImageError('IMAGE_PERMISSION_DENIED');
        });
        return { taskId: task.taskId, status: task.status, createdAt: task.createdAt, completionNotification: 'automatic', pollingRequired: false };
    }
    /** Handle image-only Webview requests without changing ordinary/flow models or restarting CLI. */
    public async receive(request: ImageWebviewRequest, view: ImageViewBinding): Promise<void> {
        if (!request || typeof request.requestId !== 'string' || request.requestId.length > 100 || this.stopped) return;
        try {
            if (request.type === 'imageGeneration/configGet') {
                view.post({ type: 'imageGeneration/state', state: await this.config.publicState(), requestId: request.requestId }); return;
            }
            if (request.type === 'imageGeneration/configSave' || request.type === 'imageGeneration/configCheck') {
                if (!vscode.workspace.isTrusted) throw new ImageError('IMAGE_WORKSPACE_REQUIRED');
                if (request.type === 'imageGeneration/configCheck') {
                    await this.config.check(request.input); await this.workspace((await view.scope()).cwd);
                } else await this.config.save(request.input);
                view.post({ type: 'imageGeneration/state', state: await this.config.publicState() });
                view.post({ type: 'imageGeneration/saveResult', requestId: request.requestId, ok: true, checked: request.type === 'imageGeneration/configCheck' }); return;
            }
            const scope = await view.scope(); const cwd = await this.workspace(scope.cwd, false); const store = new ImageTaskStore(cwd);
            if (request.type === 'imageGeneration/tasksList') {
                await this.publishTasks(view, scope, request.requestId, true); return;
            }
            if (request.type === 'imageGeneration/imageOpen') {
                if (request.scopeId !== undefined && request.scopeId !== scope.id) throw new ImageError('IMAGE_TASK_NOT_FOUND');
                const file = await store.imagePath(scope.id, request.taskId, request.imageId);
                const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === 'vscode-remote'
                    && (scope.cwd === item.uri.fsPath || scope.cwd.startsWith(item.uri.fsPath + path.sep)));
                const uri = folder ? folder.uri.with({ path: file.replace(/\\/g, '/') }) : vscode.Uri.file(file);
                await vscode.commands.executeCommand('vscode.open', uri);
            }
        } catch (error) { view.post({ type: 'imageGeneration/saveResult', requestId: request.requestId, ok: false, error: imageErrorCode(error) }); }
    }
    /** Ask only when a user closes a chat with accepted work; extension shutdown skips this prompt. */
    public async closing(scope: ImageScope): Promise<void> {
        if (this.stopped) return;
        const queue = this.queues.get(await fs.realpath(scope.cwd)); if (!queue?.hasPending(scope.id)) return;
        const labels = lifecycleLabels[this.manager.getResolvedUiLanguage()] || lifecycleLabels.en;
        const choice = await vscode.window.showWarningMessage(labels.running, { modal: true }, labels.background, labels.stop);
        if (choice === labels.stop) await queue.interruptScope(scope.id);
    }
    /** Stop all admissions before closing views and draining local task writes. */
    public async close(): Promise<void> {
        this.stopped = true; if (this.updateTimer) clearTimeout(this.updateTimer);
        for (const timer of this.retryTimers.values()) clearTimeout(timer); this.retryTimers.clear();
        this.providerSubscription.dispose(); this.config.dispose(); this.views.clear();
        const pendingAtClose = [...this.queues.values()];
        const outcomes = await Promise.allSettled(pendingAtClose.map(queue => queue.close())); this.queues.clear(); this.calls.clear();
        if (outcomes.some(outcome => outcome.status === 'rejected')) throw new ImageError('IMAGE_STORAGE_FAILED');
    }
}
