/**
 * LLS CCAI 任务流命令层：菜单、进度、续推、恢复对话框与提示词路由。
 *
 * 拆分自 extension.ts：把状态栏点击菜单、任务流进度 QuickPick、手动续推、
 * Chat 首次 ready 的恢复对话框，以及「提示词发到内置 Chat 还是外部 Claude Code」
 * 的路由决策收敛到一个模块，并由本模块持有自动续推调度器与恢复弹窗标志。
 *
 * 依赖方向：本模块位于 chatRuntime 之上；外部 Claude Code 粘贴链路仍留在
 * extension.ts，通过 {@link configureTaskFlowCommands} 注入，避免反向 import。
 */
import * as vscode from 'vscode';

import { appendUserMessageAndSend, fillBuiltInChatComposer } from '../chatRuntime/chatMessaging';
import { AutoContinueScheduler } from '../llsTask/autoContinue';
import { getLlsCcaiTaskTexts } from '../llsTask/messages';
import { pasteToClaudeCode } from '../llsTask/paster';
import type { LlsTaskItem } from '../llsTask/types';
import { Logger } from '../logger';
import { getChatViewHost, getConfigManager, getLlsTaskService } from '../runtime';

/** taskFlowCommands 需要但仍留在 extension.ts 的协作函数集合。 */
export interface TaskFlowCommandsDeps {
    /** 把任务流提示词粘贴到外部 Claude Code 输入框并回车提交。 */
    pasteTaskFlowToExternalClaudeCode: (prompt: string) => Promise<void>;
}

/** 已注入的协作函数集合，未装配前访问会抛错。 */
let deps: TaskFlowCommandsDeps | undefined;

/** 装配 taskFlowCommands 依赖，必须在 activate 早期调用一次。 */
export function configureTaskFlowCommands(value: TaskFlowCommandsDeps): void {
    deps = value;
}

/** 读取已装配的依赖，未装配时抛出明确错误便于定位装配顺序问题。 */
function requireDeps(): TaskFlowCommandsDeps {
    if (!deps) throw new Error('taskFlowCommands 尚未装配');
    return deps;
}

/** 模块级自动续推调度器实例。 */
let autoContinueScheduler: AutoContinueScheduler | undefined;

/** 恢复出未完成任务流后，待 Chat 首次 ready 时弹一次恢复对话框的标志。 */
let pendingRestorePrompt = false;

/** 注入（或清空）自动续推调度器实例，由 activate/deactivate 调用。 */
export function setAutoContinueScheduler(value: AutoContinueScheduler | undefined): void {
    autoContinueScheduler = value;
}

/** 读取当前自动续推调度器实例，供 activate 期的事件接线使用。 */
export function getAutoContinueScheduler(): AutoContinueScheduler | undefined {
    return autoContinueScheduler;
}

/** 设置「待弹一次任务流恢复对话框」标志。 */
export function setPendingRestorePrompt(value: boolean): void {
    pendingRestorePrompt = value;
}
/**
 * 构造点击 CC任务流 状态栏后写入剪贴板的默认文本。
 *
 * @returns 需要粘贴到 Claude Code 聊天框的任务流提示词。
 */
export function buildTaskFlowPrompt(): string {
    return '@lls-task 请根据当前任务流继续推进：先检查未完成项，再给出下一步执行计划。';
}

/**
 * 打开 LLS CCAI 任务流统一菜单。
 *
 * 行为规则：
 * 1. 当前没有任务流 → 直接把启动提示词填入内置 Chat 输入框，无提示。
 * 2. 当前任务流已完成 → 静默清空当前任务流并把启动提示词填入输入框，无提示。
 * 3. 当前任务流仍在运行 → 弹确认框，让用户选择"继续推进"或"清空并重新开始"，
 *    避免在运行中误清掉模型已有的上下文。
 */
export async function openLlsCcaiTaskMenu(): Promise<void> {
    const manager = getConfigManager();
    const service = getLlsTaskService();
    if (!manager || !service) return;
    const texts = getLlsCcaiTaskTexts(manager.getResolvedUiLanguage());
    const snapshot = service.getSnapshot();

    // 1) 无任务流：直接填入启动提示词。
    if (!snapshot.workflow) {
        await fillBuiltInChatComposer(texts.startPrompt, true);
        return;
    }

    // 2) 已完成任务流：静默清空 + 填入启动提示词，不再弹确认。
    if (service.isWorkflowCompleted()) {
        autoContinueScheduler?.cancel('点击 CC 任务流：自动清空已完成任务流');
        autoContinueScheduler?.resetMissingToolCounter('清空已完成任务流');
        service.clear();
        await fillBuiltInChatComposer(texts.startPrompt, true);
        return;
    }

    // 3) 运行中任务流：仍需提示，避免误清正在进行的上下文。
    const continueLabel = texts.continueAction;
    const clearLabel = texts.clearAndNew;
    const cancelLabel = texts.cancel;
    const choice = await vscode.window.showInformationMessage(
        texts.runningTooltip,
        continueLabel,
        clearLabel,
        cancelLabel
    );
    if (choice === continueLabel) {
        await fillBuiltInChatComposer(service.buildContinuePrompt(), true);
    } else if (choice === clearLabel) {
        autoContinueScheduler?.cancel('用户从任务流菜单清空运行中任务流');
        autoContinueScheduler?.resetMissingToolCounter('用户清空运行中任务流');
        service.clear();
        await fillBuiltInChatComposer(texts.startPrompt, true);
    }
}

/**
 * 显示当前 LLS CCAI 任务流进度 QuickPick。
 */
export async function showLlsCcaiTaskProgress(): Promise<void> {
    const service = getLlsTaskService();
    if (!service) return;
    const workflow = service.getSnapshot().workflow;
    if (!workflow) return;
    await vscode.window.showQuickPick(
        workflow.tasks.map((task, index) => ({
            label: `${index + 1}. ${getTaskStatusIcon(task)} ${task.title}`,
            description: task.status,
            detail: task.description
        })),
        { title: workflow.title, placeHolder: workflow.summary }
    );
}

/**
 * 手动继续推进当前 LLS CCAI 任务流。
 */
export async function continueLlsCcaiTask(): Promise<void> {
    const service = getLlsTaskService();
    if (!service) return;
    autoContinueScheduler?.cancel('用户手动继续任务流');
    await fillBuiltInChatComposer(service.buildContinuePrompt(), true);
}

/**
 * Chat 首次 ready 时，按需弹一次任务流恢复对话框。
 *
 * 仅当 {@link pendingRestorePrompt} 为真且当前确有未完成任务流时下发
 * taskFlow/restorePrompt；下发后立即清标志，保证整个会话只弹一次。
 */
export async function maybePostTaskFlowRestorePrompt(): Promise<void> {
    if (!pendingRestorePrompt) return;
    pendingRestorePrompt = false;
    const service = getLlsTaskService();
    if (!service || !service.hasActiveWorkflow()) return;
    const workflow = service.getSnapshot().workflow;
    if (!workflow) return;
    const completed = workflow.tasks.filter((task) => task.status === 'completed').length;
    await getChatViewHost()?.postMessage({
        type: 'taskFlow/restorePrompt',
        title: workflow.title,
        summary: workflow.summary,
        progress: `${completed}/${workflow.tasks.length}`
    });
}

/**
 * 处理 webview 恢复对话框回传的用户选择。
 *
 * - continue：启动 CLI 并自动发送续推提示（等 CLI 起好后用
 *   {@link appendUserMessageAndSend} 自动提交，无需用户手动回车）。
 * - clear：清空任务流并删除持久化文件（复用 {@link clearLlsCcaiTask}）。
 * - dismiss：内存与磁盘均保留，用户之后仍可从任务流菜单继续。
 *
 * @param choice 用户在对话框中的选择。
 */
export async function handleTaskFlowRestoreChoice(choice: 'continue' | 'clear' | 'dismiss'): Promise<void> {
    if (choice === 'continue') {
        const service = getLlsTaskService();
        if (!service) return;
        try {
            autoContinueScheduler?.cancel('用户从恢复对话框继续任务流');
            const prompt = service.buildContinuePrompt();
            await appendUserMessageAndSend(prompt);
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            Logger.error(`[LlsTask] 恢复继续任务流失败：${text}`);
            await getChatViewHost()?.postMessage({ type: 'toast', level: 'error', text });
        }
        return;
    }
    if (choice === 'clear') {
        autoContinueScheduler?.resetMissingToolCounter('用户从恢复对话框清除任务流');
        clearLlsCcaiTask();
    }
}

/** 任务流提示词发送选项。 */
export interface TaskFlowPromptSendOptions {
    /** 是否直接提交到目标聊天入口。 */
    autoSubmit: boolean;
}

/**
 * 根据 taskFlow.target 配置把任务流提示词路由到内置 Chat 或旧 Claude Code 输入框。
 *
 * 这里不切换模型：任务流的创建阶段始终使用主模型，任务流专用模型只在自动续推
 * 前由 `applyTaskFlowModelForContinue()` 切入，并在工作流结束后还原。
 *
 * @param prompt 任务流提示词。
 * @param options 发送选项。
 */
export async function sendTaskFlowPrompt(prompt: string, options: TaskFlowPromptSendOptions): Promise<void> {
    if (getConfigManager()?.getTaskFlowTarget() === 'builtinChat') {
        if (await trySendTaskFlowPromptToBuiltInChat(prompt, options)) return;
        Logger.warn('taskFlow.target=builtinChat 但内置 Chat 不可用，降级到 externalClaudeCode');
    }
    if (options.autoSubmit) {
        await requireDeps().pasteTaskFlowToExternalClaudeCode(prompt);
        return;
    }
    await pasteToClaudeCode(prompt, { autoSubmit: false });
}

/**
 * 尝试把任务流提示词发送或填充到内置 Chat。
 *
 * `forceRoute: 'taskFlow'` 只影响 busy 记账与工具注入，不改变模型，
 * 因此创建阶段天然走主模型。
 *
 * @param prompt 任务流提示词。
 * @param options 发送选项。
 * @returns 成功使用内置 Chat 时返回 true；需要降级时返回 false。
 */
export async function trySendTaskFlowPromptToBuiltInChat(prompt: string, options: TaskFlowPromptSendOptions): Promise<boolean> {
    try {
        if (options.autoSubmit) {
            await appendUserMessageAndSend(prompt, { forceRoute: 'taskFlow' });
        } else {
            await fillBuiltInChatComposer(prompt, true);
        }
        return true;
    } catch (err) {
        Logger.error('任务流发送到内置 Chat 失败', err);
        return false;
    }
}

/**
 * 清空当前 LLS CCAI 任务流。
 */
export function clearLlsCcaiTask(): void {
    autoContinueScheduler?.cancel('用户清空当前任务流');
    getLlsTaskService()?.clear();
}

/**
 * 根据任务状态返回 QuickPick 图标。
 *
 * @param task 任务项。
 * @returns 状态图标。
 */
export function getTaskStatusIcon(task: LlsTaskItem): string {
    switch (task.status) {
        case 'completed':
            return '✓';
        case 'in_progress':
            return '↻';
        case 'blocked':
            return '⚠';
        case 'pending':
        default:
            return '○';
    }
}