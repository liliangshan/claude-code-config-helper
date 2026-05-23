/** @file LLS CCAI 任务流核心服务。 */

import * as vscode from 'vscode';

import type { ConfigManager } from '../configManager';
import { getLlsCcaiTaskTexts } from './messages';
import type {
    LlsTaskSnapshot,
    LlsTaskStatus,
    LlsTaskStatusUpdate,
    LlsTaskUpdateResult,
    LlsTaskWorkflow
} from './types';

/** 允许任务流使用的状态集合。 */
const VALID_STATUSES: ReadonlySet<LlsTaskStatus> = new Set(['pending', 'in_progress', 'completed', 'blocked']);

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

    /** 是否处于等待主模型创建 workflow 的阶段。 */
    private workflowCreationPending = false;

    /** 上一次 active workflow 响应是否没有调用任务流状态更新工具。 */
    private workflowUpdateMissing = false;

    /**
     * 创建任务流服务。
     *
    * @param configManager 配置管理器，用于读取 UI 语言。
     */
    public constructor(private readonly configManager: ConfigManager) {}

    /**
     * 获取当前任务流快照副本。
     *
     * @returns 当前任务流快照。
     */
    public getSnapshot(): LlsTaskSnapshot {
        return JSON.parse(JSON.stringify(this.snapshot)) as LlsTaskSnapshot;
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
     */
    public markWorkflowCreationPending(): void {
        if (this.snapshot.workflow || this.workflowCreationPending) return;
        this.workflowCreationPending = true;
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
     * 构造主模型继续推进提示。
     *
     * 当上一轮主对话只回了文本却没有调用任何工具时（{@link workflowUpdateMissing}
     * 为 true），会在基础 continuePrompt 后再拼接一段更强约束的补充提示，要求
     * 本轮必须以 tool_use 工具调用形式执行，避免模型再次"幻觉"地用文字声称
     * 已完成任务。
     *
     * @param snapshot 可选快照；未传时使用当前快照。
     * @returns 注入到 Claude Code 输入框的任务流上下文提示。
     */
    public buildContinuePrompt(snapshot: LlsTaskSnapshot = this.snapshot): string {
        const workflow = snapshot.workflow;
        const texts = getLlsCcaiTaskTexts(this.configManager.getResolvedUiLanguage());
        if (!workflow) {
            return texts.startPrompt;
        }
        if (this.workflowUpdateMissing) {
            return `${texts.continuePrompt}\n\n${texts.continuePromptWhenToolMissing}`;
        }
        return texts.continuePrompt;
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
            this.snapshot = { workflow: { ...workflow, tasks: workflow.tasks.map((task) => ({ ...task })) }, updatedAt: Date.now() };
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
     * @returns 创建执行结果。
     */
    public createWorkflow(workflow: unknown): LlsTaskUpdateResult {
        this.workflowCreationPending = false;
        try {
            const normalized = this.normalizeWorkflow(workflow as Partial<LlsTaskWorkflow>);
            this.snapshot = { workflow: normalized, updatedAt: Date.now() };
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
     * 释放事件资源。
     */
    public dispose(): void {
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
     * 发送状态变更事件。
     */
    private emitChange(): void {
        this.changeEmitter.fire(this.getSnapshot());
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
