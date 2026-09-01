/**
 * Claude CLI stream-json 事件处理与工具授权交互。
 *
 * 拆分自 extension.ts：把「CLI 事件到达 → 分发到会话/Webview」这条入站链路，
 * 以及工具授权请求、AskUserQuestion 问答回写、最终回复日志收敛到一个模块。
 *
 * 依赖方向：本模块位于 routeState / cliLifecycle / chatSession 之上，
 * 上层协作函数通过 {@link configureCliEventHandlers} 注入，
 * 避免反向 import 造成循环依赖。
 */
import * as vscode from 'vscode';

import type { ParsedCliEvent, ToolPermissionRequestEvent } from '../chat/cli/cliAdapter';
import { buildAskUserUpdatedInput, parseAskUserQuestions as parseAskUserQuestionsPure } from '../chat/askUserQuestion';
import type { AskUserQuestionItem, ChatRoute, ChatSegment, WebviewToExtension } from '../chat/protocol';
import { Logger } from '../logger';
import { getChatViewHost } from '../runtime';
import { getChatCliConfigService, getChatCliSessionStore } from './cliLifecycle';
import { appendAssistantSegments, finishActiveAssistantMessage, getTokenBudgetServiceRef, pushSessionTitleToWebview } from './chatSession';
import {
    assistantTurnTextBySource,
    chatSessionRouteById,
    getSessionIdForRoute,
    getStreamAdapterForRoute,
    hiddenCliResponseTurnsByRoute,
    pendingAskUserRequests,
    routes
} from './routeState';

/** cliEventHandlers 需要但仍留在 extension.ts 的协作函数集合。 */
export interface CliEventHandlerDeps {
    /** 向 Webview 推送轻提示。 */
    showChatToast: (level: 'info' | 'success' | 'warn' | 'error', text: string) => Promise<void>;
}

/** 已注入的协作函数集合，未装配前访问会抛错。 */
let deps: CliEventHandlerDeps | undefined;

/** 装配 cliEventHandlers 依赖，必须在 activate 早期调用一次。 */
export function configureCliEventHandlers(value: CliEventHandlerDeps): void {
    deps = value;
}

/** 读取已装配的依赖，未装配时抛出明确错误便于定位装配顺序问题。 */
function requireDeps(): CliEventHandlerDeps {
    if (!deps) throw new Error('cliEventHandlers 尚未装配');
    return deps;
}

export function formatLogPreview(text: string, limit = 1000): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

export function getSegmentLogText(segment: ChatSegment): string {
    if (segment.kind === 'usage' || segment.kind === 'tool' || segment.kind === 'permission' || segment.kind === 'task' || segment.kind === 'image') {
        return '';
    }
    return typeof segment.text === 'string'
        ? segment.text
        : typeof segment.sourceText === 'string'
            ? segment.sourceText
            : '';
}

export async function handleFinalAssistantText(source: ChatRoute, finalText: string): Promise<boolean> {
    if (!finalText) return false;
    Logger.info(`模型最终回复(${source})：${formatLogPreview(finalText)}`);
    return false;
}

/**
 * 向用户弹出权限拦截警告并引导调整配置。
 *
 * 仅在用户交互层负责"提示 + 跳转设置"，节流逻辑已在 StreamJsonCliAdapter
 * 内部处理（按 PERMISSION_DENIED_NOTIFY_INTERVAL_MS 节流），因此本函数可以
 * 直接使用 `showWarningMessage` 而无需自行去重。
 *
 * @param resultText 触发本次拦截的 tool_result 原始文本，会截断后用作详情。
 */
export function notifyPermissionDeniedToUser(resultText: string): void {
    const preview = resultText.length > 200 ? `${resultText.slice(0, 200)}…` : resultText;
    const message =
        'Claude CLI 拦截了一次工具调用（可能因为非交互模式下默认权限策略不允许该操作）：\n\n' +
        preview +
        '\n\n可在设置中将 “claudeCodeConfigHelper.chat.permissionMode” 调整为 ' +
        '“acceptEdits”（放行编辑）或 “bypassPermissions”（完全放行）。';
    void vscode.window
        .showWarningMessage(message, '打开设置', '忽略')
        .then((action) => {
            if (action === '打开设置') {
                void vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'claudeCodeConfigHelper.chat.permissionMode'
                );
            }
        });
}

/**
 * 处理 CLI 适配器解析出的事件，并更新 ChatSession/Webview。
 *
 * @param event 已解析的 CLI 事件。
 * @param source 事件来源路由；taskFlow 复用 normal CLI，事件仍以 `'normal'` 上报。
 */
export async function handleParsedCliEvent(event: ParsedCliEvent, source: ChatRoute = 'normal'): Promise<void> {
    switch (event.type) {
        case 'segments':
            {
                const chunkText = event.segments.map(getSegmentLogText).filter(Boolean).join('');
                if (chunkText) assistantTurnTextBySource[source] += chunkText;
                if (event.done) {
                    const finalText = assistantTurnTextBySource[source].trim();
                    assistantTurnTextBySource[source] = '';
                    await handleFinalAssistantText(source, finalText);
                }
            }
            if (hiddenCliResponseTurnsByRoute[source] > 0) {
                if (event.done) hiddenCliResponseTurnsByRoute[source] = Math.max(0, hiddenCliResponseTurnsByRoute[source] - 1);
                return;
            }
            await appendAssistantSegments(event.segments, event.done ?? false);
            return;
        case 'done':
            {
                const finalText = assistantTurnTextBySource[source].trim();
                if (finalText) {
                    await handleFinalAssistantText(source, finalText);
                }
                assistantTurnTextBySource[source] = '';
            }
            if (hiddenCliResponseTurnsByRoute[source] > 0) {
                hiddenCliResponseTurnsByRoute[source] = Math.max(0, hiddenCliResponseTurnsByRoute[source] - 1);
                return;
            }
            await finishActiveAssistantMessage();
            return;
        case 'error':
            assistantTurnTextBySource[source] = '';
            await finishActiveAssistantMessage();
            Logger.error(`Chat CLI 事件错误：${event.message}${event.detail ? ` :: ${event.detail}` : ''}`);
            await requireDeps().showChatToast('error', event.detail ? `${event.message}：${event.detail}` : event.message);
            return;
        case 'session/init':
            await getChatCliSessionStore()?.writeSessionId(event.cwd, event.sessionId, source);
            chatSessionRouteById.set(event.sessionId, source);
            // taskFlow 复用 normal CLI 进程，session_id 同时记到两条路由，
            // 保证 usageSink 在活动路由为 taskFlow 时也能拿到正确会话。
            routes.normal.sessionId = event.sessionId;
            routes.taskFlow.sessionId = event.sessionId;
            void pushSessionTitleToWebview(event.cwd, event.sessionId);
            return;
        case 'compact/status':
            handleCliCompactStatus(event, source);
            return;
        case 'tool/permissionRequest':
            await handleToolPermissionRequest(event, source);
            return;
        default:
            return;
    }
}

export function handleCliCompactStatus(
    event: Extract<ParsedCliEvent, { type: 'compact/status' }>,
    source: ChatRoute
): void {
    const sessionId = event.sessionId || getSessionIdForRoute(source);
    if (event.status === 'compacting') {
        // CLI 自己开始压缩（用户手敲 /compact 或 CLI 自动压缩）时也要登记在途，
        // 否则 TokenBudgetService 看不到这次压缩，防抖窗口失效会再压一次。
        getTokenBudgetServiceRef()?.noteExternalCompaction(sessionId);
        void getChatViewHost()?.postMessage({
            type: 'compaction/started',
            sessionId,
            beforeTokens: 0
        });
        return;
    }
    if (event.compactResult === 'success') {
        getTokenBudgetServiceRef()?.finishNativeCompaction(sessionId, true);
        void getChatViewHost()?.postMessage({
            type: 'compaction/finished',
            oldSessionId: sessionId,
            newSessionId: sessionId,
            beforeTokens: 0,
            afterTokens: 0,
            summary: ''
        });
        return;
    }
    getTokenBudgetServiceRef()?.finishNativeCompaction(sessionId, false, event.compactResult || 'compact failed');
    void getChatViewHost()?.postMessage({
        type: 'compaction/failed',
        sessionId,
        error: event.compactResult || 'compact failed'
    });
}

/**
 * 处理 Claude CLI stdio 工具授权请求。
 *
 * 当前实现先使用 VS Code 模态确认框打通官方 `can_use_tool` 授权闭环：CLI 发出
 * `control_request` 后，本函数向用户展示工具名与关键参数；用户选择允许/拒绝后，
 * 再通过 `StreamJsonCliAdapter.respondToToolPermission` 写回 `control_response`。
 * 这样 Bash 等需要授权的工具在非交互 stream-json 模式下也能继续执行。
 *
 * 特例：`AskUserQuestion` 的答案按 CLI 约定必须经授权通道的
 * `updatedInput.answers` 回传，因此不弹通用确认框，而是把 questions 转发给
 * Chat Webview 渲染选择弹窗，并保持 CLI 阻塞直到 `askUser/answers` 回包。
 *
 * @param event 适配器解析出的工具授权请求事件。
 */
export async function handleToolPermissionRequest(event: ToolPermissionRequestEvent, source: ChatRoute): Promise<void> {
    const adapter = getStreamAdapterForRoute(source);
    if (!adapter) {
        Logger.warn(`收到 ${source} 工具授权请求但 stream-json 适配器不存在：requestId=${event.requestId}`);
        return;
    }
    if (event.toolName === 'AskUserQuestion') {
        const questions = parseAskUserQuestions(event.input);
        const viewHost = getChatViewHost();
        if (questions.length > 0 && viewHost) {
            pendingAskUserRequests.set(event.requestId, { route: source, input: event.input });
            Logger.info(`AskUserQuestion 授权请求已转发 Webview 弹窗：requestId=${event.requestId}, questions=${questions.length}`);
            await viewHost.postMessage({
                type: 'askUser/request',
                requestId: event.requestId,
                route: source,
                questions
            });
            return;
        }
        // questions 解析失败或 webview 不可用时退回通用确认框，避免 CLI 永久阻塞。
        Logger.warn(`AskUserQuestion 无法走弹窗（questions=${questions.length}, webview=${Boolean(getChatViewHost())}），退回通用授权框：requestId=${event.requestId}`);
    }
    // bypass 模式下 stdio 通道仅为拦截 AskUserQuestion 而保留；
    // 其余工具授权请求直接自动放行，维持「跳过权限检查」的非交互体验。
    if (getChatCliConfigService()?.getConfig().permissionMode === 'bypassPermissions') {
        Logger.info(`bypassPermissions 模式自动放行工具授权：requestId=${event.requestId}, tool=${event.toolName}`);
        adapter.respondToToolPermission(event.requestId, {
            behavior: 'allow',
            updatedInput: event.input,
            updatedPermissions: []
        });
        return;
    }
    const allow = '允许本次执行';
    const deny = '拒绝';
    const message = buildToolPermissionPromptMessage(event);
    Logger.info(`等待用户确认工具授权：requestId=${event.requestId}, tool=${event.toolName}`);
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, allow, deny);
    if (choice === allow) {
        adapter.respondToToolPermission(event.requestId, {
            behavior: 'allow',
            updatedInput: event.input,
            updatedPermissions: []
        });
        await requireDeps().showChatToast('success', `已允许 ${event.toolName} 本次执行`);
        return;
    }
    adapter.respondToToolPermission(event.requestId, {
        behavior: 'deny',
        message: '用户拒绝了本次工具调用。',
        interrupt: false
    });
    await requireDeps().showChatToast('warn', `已拒绝 ${event.toolName} 本次执行`);
}

/**
 * 构造展示给用户的工具授权确认文案。
 *
 * 为避免 VS Code 弹窗过长，工具输入会被格式化并截断；对于 Bash 命令优先展示
 * `command` 字段，方便用户快速判断是否允许。
 *
 * @param event 工具授权请求事件。
 * @returns 可直接传给 showWarningMessage 的提示文本。
 */
export function buildToolPermissionPromptMessage(event: ToolPermissionRequestEvent): string {
    const title = event.title || event.displayName || `${event.toolName} 需要授权`;
    const reason = event.decisionReason || event.description || 'Claude CLI 请求确认是否允许执行该工具。';
    const inputPreview = formatToolPermissionInput(event.input);
    const blockedPath = event.blockedPath ? `\n\n路径：${event.blockedPath}` : '';
    return `${title}\n\n工具：${event.toolName}\n原因：${reason}${blockedPath}\n\n参数：\n${inputPreview}`;
}

/**
 * 格式化工具授权请求参数并限制长度。
 *
 * @param input 工具原始输入。
 * @returns 截断后的可读参数文本。
 */
export function formatToolPermissionInput(input: unknown): string {
    const limit = 1200;
    let text: string;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const record = input as Record<string, unknown>;
        const command = record.command;
        if (typeof command === 'string' && command.trim()) {
            text = command;
        } else {
            text = JSON.stringify(input, null, 2);
        }
    } else if (typeof input === 'string') {
        text = input;
    } else {
        text = JSON.stringify(input, null, 2) ?? String(input);
    }
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 从 AskUserQuestion 授权请求的原始 input 中解析出结构化问题列表。
 *
 * 实现委托给 askUserQuestion.ts 的纯函数（便于单测）。
 *
 * @param input control_request 的工具输入。
 * @returns 规范化后的问题列表。
 */
export function parseAskUserQuestions(input: unknown): AskUserQuestionItem[] {
    return parseAskUserQuestionsPure(input);
}

/**
 * 处理 Webview 弹窗提交的 AskUserQuestion 答案。
 *
 * 按 CLI 约定把 answers（问题文本 → 选项文本）合并进原始工具输入的
 * `answers` 字段、notes 合并进 `annotations`，随后以 allow 写回
 * control_response 解除 CLI 阻塞；CLI 会把答案打包成 tool_result 继续推理。
 *
 * @param message Webview 回传的 askUser/answers 消息。
 */
export function handleAskUserAnswers(message: Extract<WebviewToExtension, { type: 'askUser/answers' }>): void {
    const pending = pendingAskUserRequests.get(message.requestId);
    if (!pending) {
        Logger.warn(`收到未登记的 askUser/answers：requestId=${message.requestId}，已忽略`);
        return;
    }
    pendingAskUserRequests.delete(message.requestId);
    const adapter = getStreamAdapterForRoute(pending.route);
    if (!adapter) {
        Logger.warn(`askUser/answers 对应路由 ${pending.route} 的适配器已不存在：requestId=${message.requestId}`);
        return;
    }
    const updatedInput = buildAskUserUpdatedInput(pending.input, message.answers, message.notes);
    Logger.info(`AskUserQuestion 答案已写回 CLI：requestId=${message.requestId}, route=${pending.route}`);
    adapter.respondToToolPermission(message.requestId, {
        behavior: 'allow',
        updatedInput,
        updatedPermissions: []
    });
}
