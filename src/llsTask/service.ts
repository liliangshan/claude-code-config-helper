/** @file LLS CCAI 任务流核心服务。 */

import * as vscode from 'vscode';

import type { ConfigManager } from '../configManager';
import { getLlsCcaiTaskTexts } from './messages';
import { LLS_CCAI_TASK_TOOL_NAME } from './tools';
import type { TaskFlowStore } from './store';
import type {
    LlsTaskSnapshot,
    LlsTaskStatus,
    LlsTaskStatusUpdate,
    LlsTaskUpdateResult,
    LlsTaskWorkflow
} from './types';

/**
 * 允许工具回写的状态集合。
 *
 * 不含 'blocked'：阻塞/失败的任务若能被标记，续推会因为「没有 pending 也没有全部完成」
 * 而陷入死循环。模型遇到做不下去的任务时应把原因写进 .LLSOAI/task_error.md，任务本身
 * 仍保持 pending 或标记 completed。历史落盘数据里的 'blocked' 仍可正常读入。
 */
const VALID_STATUSES: ReadonlySet<LlsTaskStatus> = new Set(['pending', 'in_progress', 'completed']);
/**
 * LLS CCAI 任务流核心服务。
 *
 * 负责维护内存任务流状态、构造主模型继续推进提示，并在创建/更新工具回写时更新任务流。
 */
export class LlsTaskService implements vscode.Disposable {
    /** 任务流状态变更事件发送器。 */
    private readonly changeEmitter = new vscode.EventEmitter<LlsTaskSnapshot>();

    /** 任务流状态变更事件。 */
    public readonly onDidChange = this.changeEmitter.event;

    /** 当前任务流快照。 */
    private snapshot: LlsTaskSnapshot = { workflow: null, updatedAt: Date.now() };

    /** 任务流续推前压缩待拦截的过期时间戳；0 表示没有待拦截请求。 */
    private preContinueCompactionUntil = 0;

    /** 是否处于等待主模型创建 workflow 的阶段。 */
    private workflowCreationPending = false;

    /** 上一次 active workflow 响应是否没有调用任务流状态更新工具。 */
    private workflowUpdateMissing = false;

    /** 持久化防抖定时器句柄；undefined 表示当前没有待落盘的写。 */
    private persistTimer: NodeJS.Timeout | undefined;

    /** 恢复阶段标志：为 true 时 emitChange 跳过一次 persist，避免“载入即回写”。 */
    private restoring = false;

    /**
     * 创建任务流服务。
     *
     * @param configManager 配置管理器，用于读取 UI 语言。
     * @param store 可选的任务流持久化存储；省略时退化为纯内存模式（便于现有单测无需改桩）。
     */
    public constructor(
        private readonly configManager: ConfigManager,
        private readonly store?: TaskFlowStore
    ) {}

    /**
     * 从磁盘恢复上次未完成的任务流到内存。
     *
     * 仅当存在持久化 store、读回的 workflow 非空且**未全部完成**时才恢复；
     * 已完成的任务流没有续推价值，恢复反而会误弹「运行中」提示。
     * 恢复过程用 {@link restoring} 标志跳过一次 persist，避免「载入即回写」。
     *
     * 任何异常都被 store 内部吞掉，restore 不抛出，绝不阻塞扩展激活。
     *
     * @returns 实际恢复出未完成任务流时返回 true，供调用方决定是否弹恢复对话框。
     */
    public async restore(): Promise<boolean> {
        if (!this.store) return false;
        const loaded = await this.store.load();
        if (!loaded || !loaded.workflow) return false;
        const tasks = loaded.workflow.tasks;
        const allCompleted = tasks.length > 0 && tasks.every((task) => task.status === 'completed');
        if (allCompleted) return false;
        this.restoring = true;
        try {
            this.snapshot = loaded;
            this.emitChange();
        } finally {
            this.restoring = false;
        }
        return true;
    }

    /**
     * 获取当前任务流快照副本。
     *
     * @returns 当前任务流快照。
     */
    public getSnapshot(): LlsTaskSnapshot {
        return JSON.parse(JSON.stringify(this.snapshot)) as LlsTaskSnapshot;
    }

    /**
     * 标记下一次任务流续推前压缩请求可由 Relay 本地拦截。
     *
     * @param ttlMs 标记有效期，单位毫秒。
     */
    public markPreContinueCompactionPending(ttlMs = 120_000): void {
        if (!this.hasActiveWorkflow()) return;
        this.preContinueCompactionUntil = Date.now() + ttlMs;
    }

    /**
     * 消费任务流续推前压缩拦截标记。
     *
     * @returns 标记存在且未过期时返回 true。
     */
    public consumePreContinueCompactionPending(): boolean {
        if (!this.hasActiveWorkflow() || !this.preContinueCompactionUntil) return false;
        if (Date.now() > this.preContinueCompactionUntil) {
            this.preContinueCompactionUntil = 0;
            return false;
        }
        this.preContinueCompactionUntil = 0;
        return true;
    }

    /**
     * 判断当前是否存在活跃任务流。
     *
     * @returns 是否有未完成 workflow。
     */
    public hasActiveWorkflow(): boolean {
        return !!this.snapshot.workflow && !this.isWorkflowCompleted();
    }

    /**
     * 判断当前是否正在等待主模型创建 workflow。
     *
     * @returns 是否需要继续注入创建工具与创建提示。
     */
    public hasPendingWorkflowCreation(): boolean {
        return this.workflowCreationPending && !this.snapshot.workflow;
    }

    /**
     * 标记当前请求已经触发 workflow 创建流程。
     *
     * Claude Code 可能会先让主模型调用 read 等工具读取方案文档，随后再发起 tool_result 请求；
     * 该状态用于在这些后续请求中继续注入 create_llsccai_task_workflow 工具和创建提示。
     *
     * 同时把触发时 IDE 中打开的方案规划文档路径与用户手输入的原始提示词
     * 记录到 snapshot，让后续续推提示词和系统规则可以反复展示给模型，避免
     * 多轮续推后丢失"原始用户上下文"。
     *
     * @param planningDocumentPath 触发任务流时 IDE 打开的方案文档相对路径；
     *                             用户未打开任何文档或路径为空时传入空串。
     * @param originalUserPrompt 用户在 `@llsccai-task` 后面手输入的原始提示词；
     *                           已剥离 IDE 注入标签与默认占位文案；为空时不更新。
     */
    public markWorkflowCreationPending(
        planningDocumentPath = '',
        originalUserPrompt = ''
    ): void {
        const normalizedPath = planningDocumentPath.trim();
        const normalizedPrompt = originalUserPrompt.trim();
        const justStarted = !this.snapshot.workflow && !this.workflowCreationPending;
        const pathChanged = !!normalizedPath && normalizedPath !== this.snapshot.planningDocumentPath;
        const promptChanged = !!normalizedPrompt && normalizedPrompt !== this.snapshot.originalUserPrompt;
        if (!justStarted && !pathChanged && !promptChanged) return;
        this.workflowCreationPending = true;
        if (pathChanged || promptChanged) {
            this.snapshot = {
                ...this.snapshot,
                ...(pathChanged ? { planningDocumentPath: normalizedPath } : {}),
                ...(promptChanged ? { originalUserPrompt: normalizedPrompt } : {}),
                updatedAt: Date.now()
            };
        }
        this.emitChange();
    }

    /**
     * 判断当前任务流是否已经全部完成。
     *
     * @returns workflow 存在且全部任务 completed 时返回 true。
     */
    public isWorkflowCompleted(): boolean {
        const workflow = this.snapshot.workflow;
        return !!workflow && workflow.tasks.length > 0 && workflow.tasks.every((task) => task.status === 'completed');
    }

    /**
     * 清空当前任务流状态。
     */
    public clear(): void {
        this.workflowCreationPending = false;
        this.workflowUpdateMissing = false;
        this.snapshot = { workflow: null, updatedAt: Date.now() };
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        void this.store?.clear();
        this.emitChange();
    }

    /**
     * 标记上一轮 active workflow 响应没有调用状态更新工具。
     */
    public markWorkflowUpdateMissing(): void {
        if (!this.hasActiveWorkflow() || this.workflowUpdateMissing) return;
        this.workflowUpdateMissing = true;
        this.emitChange();
    }

    /**
     * 清除“缺失状态回写工具”标记。
     */
    public clearWorkflowUpdateMissing(): void {
        if (!this.workflowUpdateMissing) return;
        this.workflowUpdateMissing = false;
        this.emitChange();
    }

    /**
     * 构造主模型继续推进提示（自包含续推消息）。
     *
     * 该提示由 {@link AutoContinueScheduler} 经 submitter 直接作为一条普通用户消息发送给
     * CLI，因此必须「自包含」——把续推所需的全部上下文都写进文本，而不再依赖请求体里
     * 注入的任务流 system 规则或 Workflow JSON 快照（那会让每轮请求前缀变化、击穿缓存）。
     *
     * 文本包含两部分：
     * 1. 只点名「下一个待执行任务」一条（带原始序号 + 状态 + 标题 + 描述），不再罗列完整
     *    序列，保持续推消息精简、稳定，避免模型重复已完成任务或反复询问；
     * 2. 明确指示：执行后必须调用 {@link LLS_CCAI_TASK_TOOL_NAME} 回写状态，禁止只用
     *    文字声称完成，禁止询问是否继续。
     *
     * 当上一轮只回文本未调用任何工具（{@link workflowUpdateMissing} 为 true）时，再追加
     * 一段强约束提示，要求本轮必须以真实 tool_use 执行。
     *
     * @param snapshot 可选快照；未传时使用当前快照。
     * @returns 注入到 Claude Code 输入框的自包含续推提示。
     */
    public buildContinuePrompt(snapshot: LlsTaskSnapshot = this.snapshot): string {
        const workflow = snapshot.workflow;
        const texts = getLlsCcaiTaskTexts(this.configManager.getResolvedUiLanguage());
        if (!workflow) {
            return texts.startPrompt;
        }
        const nextIndex = workflow.tasks.findIndex(
            (task) => task.status === 'pending' || task.status === 'in_progress'
        );
        const nextTask = nextIndex >= 0 ? workflow.tasks[nextIndex] : undefined;
        // 没有可执行任务（例如剩下的全是历史 blocked）时返回空串，让调度器停止续推，
        // 否则会一直推送一条没有下一步的提示，形成死循环。
        if (!nextTask) {
            return '';
        }
        const nextLine = `${texts.continueNextTaskLabel}: ${nextIndex + 1}. [${nextTask.status}] ${nextTask.title}`;
        const descriptionLine = nextTask.description.trim();
        const updateInstruction = texts.continueUpdateInstruction.replace('{{tool}}', LLS_CCAI_TASK_TOOL_NAME);
        const pathSuffix = snapshot.planningDocumentPath
            ? `\n\n${texts.planningPathLabel}: ${snapshot.planningDocumentPath}`
            : '';
        const promptSuffix = snapshot.originalUserPrompt
            ? `\n\nOriginal request: ${snapshot.originalUserPrompt}`
            : '';
        const missingSuffix = this.workflowUpdateMissing
            ? `\n\n${texts.continuePromptWhenToolMissing}`
            : '';
        const lines = [
            texts.continuePrompt,
            ...(nextLine ? ['', nextLine] : []),
            ...(descriptionLine ? [descriptionLine] : []),
            '',
            updateInstruction
        ];
        return `${lines.join('\n')}${pathSuffix}${promptSuffix}${missingSuffix}`;
    }

    /**
     * 获取当前 UI 语言下的任务流文案。
     *
     * 供 {@link AutoContinueScheduler} 等不持有 configManager 的协作者读取
     * 多语言文案（例如熔断警告），避免重复传递 configManager。
     *
     * @returns 当前 UI 语言对应的任务流文案集合。
     */
    public getTexts() {
        return getLlsCcaiTaskTexts(this.configManager.getResolvedUiLanguage());
    }

    /**
     * 根据工具调用更新任务状态。
     *
     * @param updates 工具传入的状态更新数组。
     * @returns 更新执行结果。
     */
    public updateTaskStatuses(updates: LlsTaskStatusUpdate[]): LlsTaskUpdateResult {
        const workflow = this.snapshot.workflow;
        if (!workflow) {
            return { ok: false, updated: 0, progress: '0/0', message: 'No active workflow.' };
        }
        this.clearWorkflowUpdateMissing();
        if (!Array.isArray(updates)) {
            return { ok: false, updated: 0, progress: this.buildProgressText(workflow), message: 'Invalid updates.' };
        }
        let changed = 0;
        for (const update of updates) {
            if (!update || typeof update.taskId !== 'string' || !VALID_STATUSES.has(update.status)) continue;
            const task = workflow.tasks.find((item) => item.id === update.taskId);
            if (!task || task.status === update.status) continue;
            task.status = update.status;
            changed += 1;
        }
        if (changed > 0) {
            this.snapshot = {
                ...this.snapshot,
                workflow: { ...workflow, tasks: workflow.tasks.map((task) => ({ ...task })) },
                updatedAt: Date.now()
            };
            this.emitChange();
        }
        const progress = this.buildProgressText(this.snapshot.workflow ?? workflow);
        return {
            ok: true,
            updated: changed,
            progress,
            message: `Workflow status updated: ${progress}.`
        };
    }

    /**
     * 通过主模型工具调用创建并保存新的任务流。
     *
     * @param workflow 主模型通过 create_llsccai_task_workflow 传入的 workflow。
     * @param planningDocumentPath 模型在 create 工具中回传的方案文档路径；为空表示纯提示词驱动。
     * @param originalUserPrompt 模型在 create 工具中回传的用户原始需求文本，用于后续续推锚定原始意图。
     * @returns 创建执行结果。
     */
    public createWorkflow(
        workflow: unknown,
        planningDocumentPath = '',
        originalUserPrompt = ''
    ): LlsTaskUpdateResult {
        this.workflowCreationPending = false;
        try {
            const normalized = this.normalizeWorkflow(workflow as Partial<LlsTaskWorkflow>);
            const trimmedPath = planningDocumentPath.trim();
            const trimmedPrompt = originalUserPrompt.trim();
            this.snapshot = {
                workflow: normalized,
                planningDocumentPath: trimmedPath || undefined,
                originalUserPrompt: trimmedPrompt || undefined,
                updatedAt: Date.now()
            };
            this.emitChange();
            return {
                ok: true,
                updated: normalized.tasks.length,
                progress: this.buildProgressText(normalized),
                message: `Workflow created: ${normalized.title}. ${this.buildProgressText(normalized)}.`
            };
        } catch (err) {
            const message = `Workflow create failed: ${err instanceof Error ? err.message : String(err)}`;
            this.setError(message);
            return { ok: false, updated: 0, progress: '0/0', message };
        }
    }

    /**
     * 释放事件资源，并把待落盘的快照立即刷盘。
     */
    public dispose(): void {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
            void this.store?.save(this.getSnapshot());
        }
        this.changeEmitter.dispose();
    }

    /**
     * 把模型返回对象规范化为合法 workflow。
     *
     * @param raw 原始解析对象。
     * @returns 合法 workflow。
     */
    private normalizeWorkflow(raw: Partial<LlsTaskWorkflow>): LlsTaskWorkflow {
        if (!raw || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
            throw new Error('任务流 JSON 缺少非空 tasks 数组。');
        }
        const tasks = raw.tasks.map((task, index) => ({
            id: String(task?.id || index + 1),
            title: String(task?.title || `Task ${index + 1}`),
            description: String(task?.description || ''),
            status: VALID_STATUSES.has(task?.status as LlsTaskStatus) ? task.status as LlsTaskStatus : 'pending'
        }));
        return {
            title: String(raw.title || 'LLS CCAI Task Workflow'),
            summary: String(raw.summary || ''),
            tasks
        };
    }

    /**
     * 记录错误并触发变更。
     *
     * @param message 错误消息。
     */
    private setError(message: string): void {
        this.snapshot = { ...this.snapshot, lastError: message, updatedAt: Date.now() };
        this.emitChange();
    }

    /**
     * 发送状态变更事件，并按需触发防抖落盘。
     *
     * 恢复阶段（{@link restoring} 为 true）只 fire 事件、跳过 persist，避免
     * 「从磁盘载入即又写回磁盘」的无谓写。
     */
    private emitChange(): void {
        this.changeEmitter.fire(this.getSnapshot());
        if (!this.restoring) this.persist();
    }

    /**
     * 防抖落盘当前快照（250ms trailing）。
     *
     * 把一次批量 {@link updateTaskStatuses} 引发的连续 emitChange 合并为一次磁盘写。
     * 无 store 时直接返回，退化为纯内存模式。
     */
    private persist(): void {
        if (!this.store) return;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            void this.store?.save(this.getSnapshot());
        }, 250);
    }

    /**
     * 构造进度文本。
     *
     * @param workflow 任务流对象。
     * @returns completed/total 形式的进度文本。
     */
    private buildProgressText(workflow: LlsTaskWorkflow): string {
        const completed = workflow.tasks.filter((task) => task.status === 'completed').length;
        return `${completed}/${workflow.tasks.length}`;
    }
}
