/**
 * Chat Webview 入站消息分发与出站状态推送。
 *
 * 拆分自 extension.ts：把 `handleChatWebviewMessage` 的逐 case 分发、
 * 各类 `postChat*` 出站推送，以及路由 / 权限模式 / 缓存时长切换收敛到一个模块。
 * 逐 case 行为与拆分前保持等价，仅把跨模块调用改为直接 import 或注入回调。
 *
 * 依赖方向：本模块位于 chatRuntime 的最上层；任务流菜单、浏览器自动放行等
 * 仍留在 extension.ts 的函数通过 {@link configureWebviewMessages} 注入，
 * 避免反向 import 造成循环依赖。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

import { COMMANDS, type ChatCacheTtl } from '../constants';
import type { ChatMessage, ChatModelOption, LlsTaskSnapshotPayload, ChatQuickPermissionMode, ChatRoute, ChatRoutedModelSelection, ChatUiLanguage, SessionListItem, WebviewToExtension } from '../chat/protocol';
import { Logger } from '../logger';
import { getChatViewHost, getConfigManager, getLlsTaskService } from '../runtime';
import {
    currentChatCliSessionIdSync,
    getChatCliConfigService,
    getChatCliSessionStore,
    restartChatCli,
    restartChatCliPair,
    restartChatRelayAndCli,
    selectChatCli
} from './cliLifecycle';
import {
    appendAssistantSegments,
    appendLocalChatMessage,
    chatSessionState,
    clearPersistedChatSession,
    extractSessionTitle,
    getTokenBudgetServiceRef,
    parseSessionJsonl,
    resolveClaudeProjectDir,
    writeSessionCustomTitle
} from './chatSession';
import {
    buildPromptWithAttachments,
    buildUserDisplaySegments,
    handleUserResend,
    openWorkspaceFileReference,
    pickChatContextFiles,
    postActiveEditorAttachmentToChat,
    saveChatUploadedBlob,
    sendUserMessageToCli
} from './chatMessaging';
import { handleAskUserAnswers } from './cliEventHandlers';
import {
    findModelDisplayName,
    handleModelsApplyPair,
    isSelectableModel,
    readEffectiveCompactionModelSelection,
    readEffectiveTaskFlowModelSelection,
    saveTaskFlowModelSelection,
    selectChatModel
} from './modelSelection';
import { cancelRouteProcess, chatCliCancelState, chatRouteState, chatSessionRouteById, routes } from './routeState';

/** webviewMessages 需要但仍留在 extension.ts 的协作函数集合。 */
export interface WebviewMessagesDeps {
    /** 打开 LLS CCAI 任务流统一菜单。 */
    openLlsCcaiTaskMenu: () => Promise<void>;
    /** 处理任务流恢复提示的用户选择。 */
    handleTaskFlowRestoreChoice: (choice: 'continue' | 'clear' | 'dismiss') => Promise<void>;
    /** 必要时向 Webview 推送任务流恢复提示。 */
    maybePostTaskFlowRestorePrompt: () => Promise<void>;
    /** 向 Webview 推送浏览器工具自动放行状态。 */
    postBrowserAutoApproveState: () => Promise<void>;
    /** 开启浏览器工具自动放行。 */
    enableBrowserAutoApprove: () => Promise<void>;
    /** 提交后启动 Relay 命中等待计时器。 */
    armHttpExpectation: (prompt: string) => void;
    /** 清除 Relay 命中等待计时器。 */
    clearHttpExpectation: (reason: string) => void;
    /** 取消自愈流程排队中的静默重发任务。 */
    cancelPendingResend: (reason: string) => void;
    /** 取消任务流自动续跑调度，参数为取消原因。 */
    cancelAutoContinue: (reason: string) => void;
}

/** 已注入的协作函数集合，未装配前访问会抛错。 */
let deps: WebviewMessagesDeps | undefined;

/**
 * 会改变当前会话或重启 CLI 的 Webview 消息串行队列。
 *
 * VS Code 不会等待上一条 onDidReceiveMessage 的 Promise；切换会话尚在读取历史、
 * 写 sessionId 和重启 CLI 时，紧接着的发送可能先落到旧进程。队列保证这些操作
 * 严格按 Webview 到达顺序完成，同时不阻塞取消、日志和 AskUserQuestion 回答。
 */
let orderedMessageQueue: Promise<void> = Promise.resolve();

/** 装配 webviewMessages 依赖，必须在 activate 早期调用一次。 */
export function configureWebviewMessages(value: WebviewMessagesDeps): void {
    deps = value;
}

/** 读取已装配的依赖，未装配时抛出明确错误便于定位装配顺序问题。 */
function requireDeps(): WebviewMessagesDeps {
    if (!deps) throw new Error('webviewMessages 尚未装配');
    return deps;
}


/** 切换当前 Chat 路由并通知 Webview。 */
export async function switchChatRoute(route: ChatRoute, reason: string): Promise<void> {
    if (chatRouteState.active === route) return;
    chatRouteState.active = route;
    Logger.info(`[chat-route] switched to ${route}: reason=${reason}`);
    await getChatViewHost()?.postMessage({ type: 'route/changed', route });
}

/**
 * 处理 Chat Webview 消息，并将会话/CLI 状态变更操作按到达顺序串行执行。
 *
 * `user/cancel` 与 `askUser/answers` 必须即时处理，不能排在长操作后面；日志也无需
 * 参与状态队列。其余消息进入同一队列，确保 `session/resume` 完成 CLI 重启之后，
 * 紧接着的 `user/send` 才会写入新会话对应的进程。
 *
 * @param message WebviewToExtension 协议消息。
 */
export function handleChatWebviewMessage(message: WebviewToExtension): Promise<void> {
    if (message.type === 'user/cancel' || message.type === 'askUser/answers' || message.type === 'log') {
        return dispatchChatWebviewMessage(message);
    }
    const run = orderedMessageQueue.then(() => dispatchChatWebviewMessage(message));
    // 单条消息失败只交给对应调用方，队列继续服务后续消息。
    orderedMessageQueue = run.catch(() => undefined);
    return run;
}

/**
 * 实际分发一条 Chat Webview 消息。
 *
 * @param message WebviewToExtension 协议消息。
 */
async function dispatchChatWebviewMessage(message: WebviewToExtension): Promise<void> {
    switch (message.type) {
        case 'webview/ready':
            await postChatUiLanguage();
            await getChatViewHost()?.postMessage({
                type: 'session/init',
                messages: chatSessionState.messages,
                cliPath: getChatCliConfigService()!.getConfig().cliPath ?? ''
            });
            await postChatModelOptions();
            await postChatTaskFlowModelOptions();
            await postModelsSnapshot();
            await getChatViewHost()?.postMessage({ type: 'route/changed', route: chatRouteState.active });
            await postChatPermissionMode();
            await postChatCacheTtl();
            await postChatSubagentsEnabled();
            await postChatTaskFlowStatus();
            await postActiveEditorAttachmentToChat();
            await requireDeps().maybePostTaskFlowRestorePrompt();
            await requireDeps().postBrowserAutoApproveState();
            return;
        case 'user/send':
            {
                const prompt = buildPromptWithAttachments(message.text, message.attachments);
                await appendLocalChatMessage('user', prompt, await buildUserDisplaySegments(prompt, message.attachments));
                requireDeps().armHttpExpectation(prompt);
                await sendUserMessageToCli(prompt);
            }
            return;
        case 'file/pick':
            await pickChatContextFiles();
            return;
        case 'file/uploadBlob':
            await saveChatUploadedBlob(message);
            return;
        case 'model/select':
            await selectChatModel(message.providerId, message.modelId);
            return;
        case 'permissionMode/select':
            await selectChatPermissionMode(message.mode);
            return;
        case 'subagents/select':
            await selectChatSubagentsEnabled(message.enabled);
            return;
        case 'cacheTtl/select':
            await selectChatCacheTtl(message.ttl);
            return;
        case 'taskFlow/model/select':
            await selectChatTaskFlowModel(message.modelId);
            return;
        case 'config/open':
            await vscode.commands.executeCommand(COMMANDS.openConfigPanel);
            return;
        case 'taskFlow/open':
            await requireDeps().openLlsCcaiTaskMenu();
            return;
        case 'browser/enableAutoApprove':
            await requireDeps().enableBrowserAutoApprove();
            return;
        case 'taskFlow/restoreChoice':
            await requireDeps().handleTaskFlowRestoreChoice(message.choice);
            return;
        case 'cli/selectPath':
            await selectChatCli();
            await postChatUiLanguage();
            await getChatViewHost()?.postMessage({
                type: 'session/init',
                messages: chatSessionState.messages,
                cliPath: getChatCliConfigService()!.getConfig().cliPath ?? ''
            });
            return;
        case 'cli/restart':
            await restartChatRelayAndCli();
            return;
        case 'askUser/answers':
            handleAskUserAnswers(message);
            return;
        case 'route/select':
            await handleRouteSelect(message.route);
            return;
        case 'models/applyPair':
            await handleModelsApplyPair(message.normal, message.taskFlow, message.compaction);
            return;
        case 'user/cancel':
            chatCliCancelState.requested = true;
            requireDeps().clearHttpExpectation('user_cancel');
            requireDeps().cancelPendingResend('user_cancel');
            cancelRouteProcess(chatRouteState.active);
            await appendAssistantSegments([{ kind: 'markdown', text: '\n（已请求取消当前输出）\n' }], true);
            return;
        case 'user/resend':
            await handleUserResend(message.id, message.text);
            return;
        case 'session/clear':
            chatSessionState.messages = [];
            chatSessionState.activeAssistantMessageId = undefined;
            requireDeps().clearHttpExpectation('session_clear');
            requireDeps().cancelPendingResend('session_clear');
            await clearPersistedChatSession();
            // 同步抹掉 Claude CLI 端的 session 上下文：
            //   1) 删除 .LLSOAI/chat-session.json 中保存的 sessionId，下次启动 CLI
            //      就不会再 --resume 旧会话，CC 那边历史也随之失效；
            //   2) 后台重启 CLI，让用户下一条消息直接进入全新空上下文。
            //
            // 注意：这里只清 Chat/CLI 上下文，不清 LLS CCAI 任务流；右上角清空
            // 会话应保留当前 workflow，用户仍可通过任务流菜单单独清空任务流。
            try {
                const cwd = getChatCliConfigService()?.getConfig().cwd;
                if (cwd) {
                    await getChatCliSessionStore()?.clearSessionId(cwd, 'normal');
                    routes.normal.sessionId = '';
                    routes.taskFlow.sessionId = '';
                    chatSessionRouteById.clear();
                    Logger.info(`[session/clear] 已删除 normal CLI sessionId 文件：cwd=${cwd}`);
                }
            } catch (err) {
                Logger.warn('[session/clear] 删除 CLI sessionId 失败：' + (err instanceof Error ? err.message : String(err)));
            }
            requireDeps().cancelAutoContinue('session/clear');
            try {
                await restartChatCliPair({ silent: true });
                Logger.info('[session/clear] Chat CLI pair 已后台重启为全新空上下文');
            } catch (err) {
                Logger.warn('[session/clear] Chat CLI pair 重启失败：' + (err instanceof Error ? err.message : String(err)));
            }
            await postChatUiLanguage();
            await getChatViewHost()?.postMessage({
                type: 'session/init',
                messages: chatSessionState.messages,
                cliPath: getChatCliConfigService()!.getConfig().cliPath ?? ''
            });
            return;
        case 'session/set-title': {
            const cwd = getChatCliConfigService()?.getConfig().cwd;
            if (!cwd) {
                Logger.warn('[session/set-title] 无 cwd，跳过写回');
                return;
            }
            const targetId = (message.sessionId || routes.normal.sessionId || '').trim();
            if (!targetId) {
                Logger.warn('[session/set-title] 无可用 sessionId，跳过写回');
                return;
            }
            await writeSessionCustomTitle(cwd, targetId, message.title || '');
            return;
        }
        case 'session/resume': {
            const targetSessionId = message.sessionId;
            Logger.info(`[session/resume] 切换到历史会话：sessionId=${targetSessionId}`);
            chatSessionState.messages = [];
            chatSessionState.activeAssistantMessageId = undefined;
            requireDeps().clearHttpExpectation('session_resume');
            requireDeps().cancelPendingResend('session_resume');

            // 先尝试从 JSONL 加载历史消息
            let historyMessages: ChatMessage[] = [];
            let resumeTitle = '';
            try {
                const resumeCwd = getChatCliConfigService()?.getConfig().cwd
                    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                    ?? process.cwd();
                const jsonlPath = path.join(resolveClaudeProjectDir(resumeCwd), `${targetSessionId}.jsonl`);
                Logger.info(`[session/resume] 解析历史 JSONL：cwd=${resumeCwd} path=${jsonlPath}`);
                historyMessages = await parseSessionJsonl(jsonlPath);
                resumeTitle = await extractSessionTitle(jsonlPath);
                Logger.info(`[session/resume] 已加载历史消息：${historyMessages.length} 条，标题="${resumeTitle}"`);
            } catch (e) {
                Logger.warn('[session/resume] 加载历史消息失败：' + (e instanceof Error ? e.message : String(e)));
            }

            chatSessionState.messages = historyMessages;
            // 立即渲染历史消息到 webview
            Logger.info(`[session/resume] 推送 session/init 到 webview：messages=${chatSessionState.messages.length} host=${getChatViewHost() ? 'ready' : 'null'}`);
            await getChatViewHost()?.postMessage({
                type: 'session/init',
                messages: chatSessionState.messages,
                cliPath: getChatCliConfigService()!.getConfig().cliPath ?? ''
            });
            await getChatViewHost()?.postMessage({
                type: 'session/title',
                title: resumeTitle,
                sessionId: targetSessionId ?? ''
            });

            try {
                const cwd = getChatCliConfigService()?.getConfig().cwd;
                if (cwd && targetSessionId) {
                    await getChatCliSessionStore()?.writeSessionId(cwd, targetSessionId, 'normal');
                    routes.normal.sessionId = '';
                    routes.taskFlow.sessionId = '';
                    chatSessionRouteById.clear();
                    Logger.info(`[session/resume] 已写入目标 sessionId，准备重启 CLI`);
                    await restartChatCliPair({ silent: true });
                }
            } catch (err) {
                Logger.warn('[session/resume] 切换历史会话失败：' + (err instanceof Error ? err.message : String(err)));
                await showChatToast('error', '切换历史会话失败：' + (err instanceof Error ? err.message : String(err)));
            }
            return;
        }
        case 'file/open':
            await openWorkspaceFileReference(message.path, message.line, message.endLine);
            return;
        case 'tokenBudget/compactNow': {
            const sessionId = currentChatCliSessionIdSync();
            Logger.info(`[tokenBudget] 收到 Chat 压缩会话请求：sessionId=${sessionId || '(none)'}`);
            const started = sessionId ? getTokenBudgetServiceRef()?.compactNow(sessionId) : false;
            Logger.info(`[tokenBudget] Chat 压缩会话请求处理结果：started=${started ? 'true' : 'false'}`);
            if (!started) {
                await getChatViewHost()?.postMessage({
                    type: 'compaction/failed',
                    sessionId: sessionId ?? '',
                    error: '当前上下文暂时无法压缩：请先发送至少一轮消息，或等待当前响应结束。'
                });
                await showChatToast('warn', '当前上下文暂时无法压缩：请先发送至少一轮消息，或等待当前响应结束。');
            }
            return;
        }
        case 'log':
            Logger[message.level](`[Chat Webview] ${message.message}`);
            if (message.message.startsWith('[boot]')) {
                Logger.info('收到 Chat Webview boot 日志，兜底刷新默认上下文文件');
                await postActiveEditorAttachmentToChat();
            }
            return;
        case 'sessions/list': {
            try {
                const cwd = getChatCliConfigService()?.getConfig().cwd
                    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                    ?? process.cwd();
                const projectDir = resolveClaudeProjectDir(cwd);
                const BUF_SIZE = 65536;
                const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                let entries: string[];
                try { entries = await fs.readdir(projectDir); } catch { entries = []; }
                const items: SessionListItem[] = [];
                await Promise.all(entries.map(async (name) => {
                    if (!name.endsWith('.jsonl')) return;
                    const sid = name.slice(0, -6);
                    if (!UUID_RE.test(sid)) return;
                    const fp = path.join(projectDir, name);
                    try {
                        const fh = await fs.open(fp, 'r');
                        try {
                            const st = await fh.stat();
                            const buf = Buffer.allocUnsafe(BUF_SIZE);
                            const r1 = await fh.read(buf, 0, BUF_SIZE, 0);
                            if (r1.bytesRead === 0) return;
                            const head = buf.toString('utf8', 0, r1.bytesRead);
                            const firstLine = head.slice(0, head.indexOf('\n'));
                            if (firstLine.includes('"isSidechain":true')) return;
                            let tail = head;
                            const tailStart = Math.max(0, st.size - BUF_SIZE);
                            if (tailStart > 0) {
                                const r2 = await fh.read(buf, 0, BUF_SIZE, tailStart);
                                tail = buf.toString('utf8', 0, r2.bytesRead);
                            }
                            const extract = (text: string, field: string): string | undefined => {
                                const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
                                return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim() : undefined;
                            };
                            const extractFirstUserText = (text: string): string | undefined => {
                                const userIdx = text.indexOf('"role":"user"');
                                if (userIdx < 0) return undefined;
                                const m = text.slice(userIdx).match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                                return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim() : undefined;
                            };
                            const summary =
                                extract(tail, 'customTitle') ?? extract(head, 'customTitle') ??
                                extract(tail, 'aiTitle') ?? extract(head, 'aiTitle') ??
                                extract(tail, 'lastPrompt') ?? extract(tail, 'summary') ??
                                extract(head, 'summary') ??
                                extractFirstUserText(head);
                            if (!summary) return;
                            const gitBranchM = (tail.length > head.length ? tail : head + tail)
                                .match(/"gitBranch"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                            items.push({
                                sessionId: sid,
                                summary,
                                gitBranch: gitBranchM?.[1],
                                lastModified: st.mtime.getTime(),
                                fileSize: st.size,
                            });
                        } finally { await fh.close(); }
                    } catch { /* skip */ }
                }));
                items.sort((a, b) => b.lastModified - a.lastModified);
                await getChatViewHost()?.postMessage({ type: 'sessions/list/result', sessions: items });
            } catch { /* ignore */ }
            return;
        }
        default:
            return;
    }
}

/**
 * 读取配置页中可选模型并推送到 Chat Webview。
 */
export async function postChatModelOptions(): Promise<void> {
    const manager = getConfigManager();
    if (!manager) return;
    const current = manager.getCurrentModel();
    const models: ChatModelOption[] = [];
    for (const provider of manager.listProviders()) {
        for (const model of provider.models) {
            if (!isSelectableModel(provider, model)) continue;
            models.push({
                providerId: provider.id,
                providerName: provider.name,
                modelId: model.modelId,
                displayName: model.displayName || model.modelId,
                selected: current?.providerId === provider.id && current.modelId === model.modelId
            });
        }
    }
    await getChatViewHost()?.postMessage({ type: 'model/options', models, current });
}

/**
 * 把任务流模型标识解析为 ChatRoutedModelSelection 结构，供 Webview 渲染。
 *
 * `modelId` 形如 `providerId/modelId`；未配置时 enabled=false、modelId 为空串，
 * Webview 据此展示「未配置（跟随主模型）」。
 *
 * @param rawModelId 工作区配置里的任务流模型标识。
 * @returns 解析后的选择状态。
 */
function toTaskFlowSelection(rawModelId: string): ChatRoutedModelSelection {
    const modelId = (rawModelId || '').trim();
    if (!modelId) return { enabled: false, modelId: '' };
    return { enabled: true, modelId };
}

/**
 * 读取任务流模型下拉框可选项，并推送当前工作区配置解析出的选择。
 */
export async function postChatTaskFlowModelOptions(): Promise<void> {
    const manager = getConfigManager();
    if (!manager) return;
    const current = toTaskFlowSelection(readEffectiveTaskFlowModelSelection());
    const models: ChatModelOption[] = [];
    for (const provider of manager.listProviders()) {
        for (const model of provider.models) {
            if (!isSelectableModel(provider, model)) continue;
            models.push({
                providerId: provider.id,
                providerName: provider.name,
                modelId: model.modelId,
                displayName: model.displayName || model.modelId,
                selected: current.enabled && `${provider.id}/${model.modelId}` === current.modelId
            });
        }
    }
    await getChatViewHost()?.postMessage({ type: 'taskFlow/model/options', models, current });
}

/**
 * 从 Chat 输入框下方任务流下拉框切换任务流模型（仅写入工作区配置）。
 *
 * @param modelId 形如 `providerId/modelId`；空字符串表示清除配置、回退主模型。
 */
export async function selectChatTaskFlowModel(modelId: string): Promise<void> {
    await saveTaskFlowModelSelection(modelId);
    await postChatTaskFlowModelOptions();
    const effective = readEffectiveTaskFlowModelSelection();
    if (!effective) {
        Logger.info('Chat 输入框清除任务流模型配置，后续任务流回退主模型');
        await showChatToast('success', '任务流模型已清除，将跟随主模型');
        return;
    }
    Logger.info(`Chat 输入框切换任务流模型：${findModelDisplayName(effective)}`);
    await showChatToast('success', `任务流模型已切换为：${findModelDisplayName(effective)}`);
}

/**
 * 一次性推送普通 + 任务流 + 压缩三栏模型可选项与当前选择，用于「模型选择弹窗」。
 *
 * 与 `postChatModelOptions` / `postChatTaskFlowModelOptions` 共用底层 provider/model
 * 数据源，但合并为一条 `models/snapshot` 消息，避免弹窗打开时刷新闪动。
 */
export async function postModelsSnapshot(): Promise<void> {
    const manager = getConfigManager();
    if (!manager) return;
    const currentNormal = manager.getCurrentModel() ?? null;
    const currentTaskFlow = toTaskFlowSelection(readEffectiveTaskFlowModelSelection());
    const currentCompaction = readEffectiveCompactionModelSelection();
    const normalModels: ChatModelOption[] = [];
    const taskFlowModels: ChatModelOption[] = [];
    const compactionModels: ChatModelOption[] = [];
    for (const provider of manager.listProviders()) {
        for (const model of provider.models) {
            if (!isSelectableModel(provider, model)) continue;
            const baseOption: ChatModelOption = {
                providerId: provider.id,
                providerName: provider.name,
                modelId: model.modelId,
                displayName: model.displayName || model.modelId,
                selected: false
            };
            normalModels.push({
                ...baseOption,
                selected: currentNormal?.providerId === provider.id && currentNormal.modelId === model.modelId
            });
            taskFlowModels.push({
                ...baseOption,
                selected: currentTaskFlow.enabled && `${provider.id}/${model.modelId}` === currentTaskFlow.modelId
            });
            compactionModels.push({
                ...baseOption,
                selected: currentCompaction.enabled && currentCompaction.modelId === model.modelId
            });
        }
    }
    await getChatViewHost()?.postMessage({
        type: 'models/snapshot',
        normalModels,
        taskFlowModels,
        compactionModels,
        currentNormal: currentNormal ? { providerId: currentNormal.providerId, modelId: currentNormal.modelId } : null,
        currentTaskFlow,
        currentCompaction
    });
}

/**
 * 处理 webview 路由徽章 / 顶部按钮发回的手动路由切换。
 *
 * taskFlow 复用 normal CLI 进程，切换只改变 `chatRouteState.active`，下一条用户
 * 消息即按该路由解析出的任务流模型发起（未配置时回退主模型）。
 *
 * @param route 用户希望切换到的路由。
 */
export async function handleRouteSelect(route: ChatRoute): Promise<void> {
    await switchChatRoute(route, 'user-route-select');
}

/**
 * 读取当前 Chat CLI 权限模式并推送到 Chat Webview。
 */
export async function postChatPermissionMode(): Promise<void> {
    const mode = normalizeQuickPermissionMode(getChatCliConfigService()?.getConfig().permissionMode);
    await getChatViewHost()?.postMessage({ type: 'permissionMode/current', mode });
}

/** 将持久化子智能体状态回推给输入框开关。 */
export async function postChatSubagentsEnabled(): Promise<void> {
    const manager = getConfigManager();
    if (!manager) return;
    await getChatViewHost()?.postMessage({ type: 'subagents/current', enabled: manager.getChatSubagentsEnabled() });
}

/** 保存子智能体开关并回推真实状态；失败时恢复显示，不重启 CLI。 */
export async function selectChatSubagentsEnabled(enabled: boolean): Promise<void> {
    const manager = getConfigManager();
    if (!manager) throw new Error('配置管理器尚未初始化');
    try {
        await manager.setChatSubagentsEnabled(enabled);
    } catch (error) {
        await showChatToast('error', `子智能体开关保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await postChatSubagentsEnabled();
    }
}

/** 读取缓存时长并回填模型选择弹窗。 */
export async function postChatCacheTtl(): Promise<void> {
    const manager = getConfigManager();
    if (!manager) return;
    await getChatViewHost()?.postMessage({ type: 'cacheTtl/current', ttl: manager.getChatCacheTtl() });
}

/**
 * 读取当前 LLS CCAI / CC 任务流快照并推送到 Chat Webview。
 *
 * Webview 会根据该状态在聊天上方显示或隐藏 Todo 状态卡片；任务流创建、更新、
 * 清空以及缺失工具标记变化都会触发该函数，从而保证界面与服务状态一致。
 */
export async function postChatTaskFlowStatus(): Promise<void> {
    const taskService = getLlsTaskService();
    if (!taskService) return;
    const snapshot = taskService.getSnapshot() as LlsTaskSnapshotPayload;
    const viewHost = getChatViewHost();
    const delivered = await viewHost?.postMessage({ type: 'taskFlow/status', snapshot });
    if (!delivered && snapshot.workflow && viewHost && getChatCliConfigService() && !viewHost.hasResolvedView()) {
        await viewHost.open(chatSessionState.messages, getChatCliConfigService()!.getConfig().cliPath);
    }
}

/**
 * 读取当前解析后的 UI 语言并推送给 Chat Webview。
 *
 * Chat 前端会用该消息更新静态文案、动态工具卡片、usage footer 与空状态等
 * 本地渲染内容；这里只发送语言，不重复发送 session/init，避免聊天区滚动闪跳。
 */
export async function postChatUiLanguage(): Promise<void> {
    const manager = getConfigManager();
    if (!manager) return;
    await getChatViewHost()?.postMessage({ type: 'i18n/update', language: manager.getResolvedUiLanguage() as ChatUiLanguage });
}

/**
 * 将配置中的 Claude CLI 权限模式压缩为聊天输入框快捷选项。
 *
 * 快捷下拉框只展示 `acceptEdits` 与 `bypassPermissions`；如果用户在 settings.json
 * 中手写了 default/auto/dontAsk/plan 等其它值，这里统一按 acceptEdits 展示，避免
 * 快捷入口暴露过多高级策略。
 *
 * @param mode 当前配置中的权限模式。
 * @returns 可显示在 Chat 输入框里的快捷权限模式。
 */
export function normalizeQuickPermissionMode(mode: string | undefined): ChatQuickPermissionMode {
    return mode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
}

/**
 * 从 Chat 输入框切换 Claude CLI 权限模式，写入配置并自动重启长连接。
 *
 * @param mode 用户在快捷下拉框中选择的权限模式。
 */
export async function selectChatPermissionMode(mode: ChatQuickPermissionMode): Promise<void> {
    if (!getChatCliConfigService()) throw new Error('Chat CLI 配置服务尚未初始化');
    await getChatCliConfigService()!.updatePermissionMode(mode);
    await postChatPermissionMode();
    Logger.info(`Chat 输入框切换权限模式：${mode}，将通过 --permission-mode 重启 CLI`);
    await restartChatCli({ silent: true });
    await showChatToast('success', `权限模式已切换为：${mode}`);
}

/**
 * 保存模型选择弹窗里的缓存时长选择。
 *
 * 仅写入 globalState 并回推当前值给 Webview；缓存时长在每次请求时由 relay 实时读取，
 * 无需重启 CLI 或重载窗口即可生效。
 *
 * @param ttl 缓存时长选择：`'default'` 不改写、`'5m'` 归一化为 5 分钟、`'1h'` 归一化为 1 小时。
 */
export async function selectChatCacheTtl(ttl: ChatCacheTtl): Promise<void> {
    const manager = getConfigManager();
    if (!manager) throw new Error('配置管理器尚未初始化');
    await manager.setChatCacheTtl(ttl);
    await postChatCacheTtl();
    Logger.info(`Chat 模型弹窗切换缓存时长：${ttl}`);
}

/**
 * 在内置 Chat Webview 内展示提示，不使用 VS Code 系统通知。
 *
 * @param level 提示级别。
 * @param text 提示文本。
 */
export async function showChatToast(level: 'info' | 'success' | 'warn' | 'error', text: string): Promise<void> {
    await getChatViewHost()?.postMessage({ type: 'toast', level, text });
}
