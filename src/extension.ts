/** @file 扩展入口：接入内置 Chat Webview、任务流服务与配置视图。 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

import { StreamJsonCliAdapter, type ParsedCliEvent, type ToolPermissionRequestEvent } from './chat/cli/cliAdapter';
import { ChatCliConfigService } from './chat/cli/cliConfig';
import { CliProcess } from './chat/cli/cliProcess';
import { CliResolver } from './chat/cli/cliResolver';
import { ChatCliSessionStore } from './chat/cli/sessionStore';
import { ChatViewHost } from './chat/chatViewHost';
import type { ChatComposerAttachment, ChatMessage, ChatModelOption, ChatQuickPermissionMode, ChatSegment, ChatUiLanguage, LlsTaskSnapshotPayload, WebviewToExtension } from './chat/protocol';
import { ConfigManager } from './configManager';
import {
    CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY,
    CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY,
    CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY,
    CHAT_EXPERT_MODE_PROJECT_MODEL_KEY,
    CHAT_SECONDARY_VIEW_ID,
    COMMANDS,
    CONFIG_NAMESPACE,
    PROVIDERS_VIEW_ID
} from './constants';
import { Logger } from './logger';
import { AutoContinueScheduler } from './llsTask/autoContinue';
import { getLlsCcaiTaskTexts } from './llsTask/messages';
import { pasteToClaudeCode } from './llsTask/paster';
import { LlsTaskService } from './llsTask/service';
import type { LlsTaskItem } from './llsTask/types';
import { AnthropicProxyAdapter } from './relay/anthropicProxy';
import { DebugRecorder } from './relay/debugRecorder';
import { OpenAIChatProxyAdapter } from './relay/openaiChatProxy';
import { OpenAIResponsesProxyAdapter } from './relay/openaiResponsesProxy';
import { createRelayRouter } from './relay/router';
import { RelayServer } from './relay/server';
import { ExpertRunnerService } from './expertMode/expertRunnerService';
import { SettingsWriter } from './settingsWriter';
import type { ResolvedAppLanguage } from './types';
import { ConfigWebviewViewProvider } from './views/configView';
import { SharedOpenApiCopilotSettingsPanel } from './views/sharedSettingsView';

/** 模块级配置管理器实例，便于 deactivate 兜底释放。 */
let configManager: ConfigManager | undefined;

/** 模块级扩展上下文实例，用于 Chat 会话 workspaceState 持久化。 */
let extensionContext: vscode.ExtensionContext | undefined;

/** 模块级侧栏配置视图 Provider，便于命令聚焦与 deactivate 兜底释放。 */
let configViewProvider: ConfigWebviewViewProvider | undefined;

/** 模块级 LLS CCAI 任务流服务实例。 */
let llsTaskService: LlsTaskService | undefined;

/** 模块级自动续推调度器实例。 */
let autoContinueScheduler: AutoContinueScheduler | undefined;

/** 模块级本地 HTTP 中转服务实例，一个扩展宿主/工作区使用一个随机空闲端口。 */
let relayServer: RelayServer | undefined;

/**
 * 模块级 ExpertRunnerService 实例引用。
 *
 * 由 activate 阶段在 RelayRouter 装配时同步创建，并保存到此处，便于
 * {@link syncExpertRelayEnvIfPossible} 在 Relay 启动后读取它的 authToken
 * 同步给 ChatCliConfigService。deactivate 时不需要单独释放（其内部不持
 * 有长期资源）。
 */
let expertRunnerServiceRef: ExpertRunnerService | undefined;

/** 模块级 Chat CLI 配置服务实例。 */
let chatCliConfigService: ChatCliConfigService | undefined;

/** 模块级 Chat CLI 路径解析器实例。 */
let cliResolver: CliResolver | undefined;

/** 模块级 Chat CLI 长连接进程实例。 */
let cliProcess: CliProcess | undefined;

/** 模块级 Chat CLI session_id 项目持久化存储。 */
let chatCliSessionStore: ChatCliSessionStore | undefined;

/** 模块级 Chat CLI stream-json 协议适配器实例。 */
let streamJsonCliAdapter: StreamJsonCliAdapter | undefined;

/** 模块级 Chat CLI 适配器事件订阅。 */
let streamJsonCliAdapterSubscription: vscode.Disposable | undefined;

/** 模块级 Chat WebviewPanel 宿主实例。 */
let chatViewHost: ChatViewHost | undefined;

/** 模块级 Chat 内存消息列表，任务 4 阶段用于 Webview reload 恢复。 */
let chatMessages: ChatMessage[] = [];

/** Chat 会话 workspaceState 持久化键。 */
const CHAT_SESSION_STATE_KEY = 'claudeRouter.chat.session.v1';

/** Chat 会话隐私提示是否已经展示的 workspaceState 键。 */
const CHAT_SESSION_PRIVACY_NOTICE_KEY = 'claudeRouter.chat.sessionPrivacyNotice.v1';

/** 最多持久化的 Chat 消息数量，避免 workspaceState 过大。 */
const MAX_PERSISTED_CHAT_MESSAGES = 80;

/** Webview 粘贴/拖放二进制文件写入的临时目录名。 */
const CHAT_UPLOAD_TEMP_DIR = 'lls-ccai-chat-uploads';

/** 单个 Webview 上传文件允许的最大大小，避免异常剪贴板内容撑爆扩展进程。 */
const MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Chat 会话持久化防抖定时器。 */
let chatSessionPersistTimer: NodeJS.Timeout | undefined;

/** 当前正在接收流式输出的 assistant 消息 ID。 */
let activeAssistantMessageId: string | undefined;

/** 最近一次主对话 ask_expert 工具调用的上下文，用于专家实时事件挂载。 */
let pendingExpertToolContext: { parentMessageId: string; callId: string; toolSegmentId: string } | undefined;

/** 最近一次 Chat CLI 是否由用户主动取消，用于避免误报异常退出。 */
let chatCliCancelRequested = false;

/** 由扩展主动重启/替换进程产生的预期退出次数，用于避免误报异常退出。 */
let expectedChatCliExitCount = 0;

/** 最近一次有效的 Chat 当前编辑器上下文，焦点进入 Webview 时用于保留默认文件。 */
let lastChatEditorAttachment: ChatComposerAttachment | undefined;

/** 当前编辑器/选区刷新版本号，用于丢弃乱序完成的过期异步结果。 */
let chatEditorSelectionVersion = 0;

/**
 * 用户主动提交消息后等待 Relay 命中的全局计时器。
 *
 * 计时窗口内 RelayServer 收到 `POST /v1/messages` 即清除；超时则触发自愈：
 * 重启 HTTP Relay → 重启 Claude CLI → 自动重发最近一次 prompt。
 */
let pendingHttpExpectationTimer: NodeJS.Timeout | undefined;

/** 等待命中的最近一次 prompt，用于自愈后自动重发。 */
let pendingHttpExpectationPrompt: string | undefined;

/** 等待命中的开始时间戳，便于日志诊断耗时。 */
let pendingHttpExpectationStartedAt: number | undefined;

/** 自愈流程互斥锁，避免并发重启 Relay/CLI。 */
let isHealingRelayAndCli = false;

/** 自愈重启后等待 CLI 完全就绪、再内部重发上次消息的延时计时器。 */
let pendingResendTimer: NodeJS.Timeout | undefined;

/** 用户消息提交后等待 Relay 命中的超时阈值（毫秒）。 */
const HTTP_EXPECTATION_TIMEOUT_MS = 20_000;

/** 自愈重启后到内部重发之间的等待时长（毫秒），给 CLI 充足启动时间。 */
const HEAL_RESEND_DELAY_MS = 20_000;

/** workspaceState 中保存的 Chat 会话结构。 */
interface PersistedChatSession {
    /** 数据结构版本号。 */
    version: 1;
    /** 最近一次保存时间戳。 */
    updatedAt: number;
    /** 已保存的 Chat 消息。 */
    messages: ChatMessage[];
}

/** 模块级 Claude Code settings.json 写入器。 */
let settingsWriter: SettingsWriter | undefined;

/**
 * 启动时把 Claude Code 初始权限模式设置为 acceptEdits
 */
async function applyClaudeCodeInitialPermissionMode(): Promise<void> {
    try {
        await vscode.workspace.getConfiguration('claudeCode')
            .update('initialPermissionMode', 'bypassPermissions', vscode.ConfigurationTarget.Workspace);
        Logger.info('Claude Code initialPermissionMode 已设置为 acceptEdits');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`设置 Claude Code initialPermissionMode 失败：${message}`);
    }
}

/**
 * 清理历史 Relay settings.json 托管环境变量。
 *
 * 内部对失败做兜底，避免历史迁移异常打断扩展主流程。
 */
async function cleanupLegacyRelaySettingsSafely(): Promise<void> {
    if (!configManager || !settingsWriter) return;
    try {
        await settingsWriter.cleanupLegacyRelaySettings(configManager.getCurrentModel());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`清理历史 Relay settings.json 失败：${message}`);
    }
}

/**
 * 把当前模型同步写入 Claude CLI 全局 settings。
 *
 * 该文件位于用户目录 `~/.claude/settings.json`，是原生 Claude CLI 的配置入口。
 * 写入失败只记录日志，不阻断 Chat CLI 的启动流程。
 */
async function syncClaudeCliModelSettingsSafely(): Promise<void> {
    if (!configManager || !settingsWriter) return;
    try {
        await settingsWriter.applyClaudeCliModel(configManager.getCurrentModel());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`同步 Claude CLI settings.json 模型失败：${message}`);
    }
}

/**
 * 确保本地 HTTP 中转服务已启动。
 *
 * 服务监听 `127.0.0.1` 的随机空闲端口，供 Claude CLI 通过 ANTHROPIC_BASE_URL
 * 访问；一个 VS Code 扩展宿主对应一个端口即可，不再接管固定端口。
 *
 * @returns 实际监听的本地端口。
 */
async function ensureRelayServerStarted(): Promise<number> {
    if (!relayServer) throw new Error('本地中转服务尚未初始化');
    const existing = relayServer.getActualPort();
    if (existing) {
        syncExpertRelayEnvIfPossible(existing);
        return existing;
    }
    const port = await relayServer.start();
    syncExpertRelayEnvIfPossible(port);
    return port;
}

/**
 * 把当前 Relay 实际端口 + 鉴权 token 同步到 `ChatCliConfigService`。
 *
 * 这是「专家模式回环链路」拼接的关键一步：只有当 ChatCliConfigService
 * 持有相同的 baseUrl + token，下一次 `getConfig()` 才会把它们写入
 * expertMcpServer 子进程的 env，让其能反向 fetch 回 `/__expert/run`。
 *
 * 任何环节缺失（chatCliConfigService 未初始化、expertRunnerService 未创建）
 * 都静默忽略——专家模式只是「增强」，不应阻断主对话。
 *
 * @param port Relay 实际监听端口。
 */
function syncExpertRelayEnvIfPossible(port: number): void {
    try {
        if (!chatCliConfigService || !expertRunnerServiceRef) return;
        const baseUrl = `http://127.0.0.1:${port}`;
        chatCliConfigService.setExpertRelayEnv(baseUrl, expertRunnerServiceRef.getAuthToken());
    } catch (err) {
        Logger.warn(
            `同步专家 Relay 环境变量失败：${err instanceof Error ? err.message : String(err)}`
        );
    }
}

/**
 * 构造点击 CC任务流 状态栏后写入剪贴板的默认文本。
 *
 * @returns 需要粘贴到 Claude Code 聊天框的任务流提示词。
 */
function buildTaskFlowPrompt(): string {
    return '@lls-task 请根据当前任务流继续推进：先检查未完成项，再给出下一步执行计划。';
}

/** Chat 底部专家模型下拉框的解析结果。 */
interface EffectiveExpertModelSelection {
    /** 是否启用专家；false 表示关闭专家。 */
    enabled: boolean;
    /** 生效专家模型 ID，关闭或未配置时为空字符串。 */
    modelId: string;
}

/** 从配置 inspect 结果中读取工作区层级值。 */
function getInspectedWorkspaceValue<T>(inspect: { workspaceFolderValue?: T; workspaceValue?: T } | undefined): T | undefined {
    return inspect?.workspaceFolderValue ?? inspect?.workspaceValue;
}

/** 从配置 inspect 结果中读取全局层级值。 */
function getInspectedGlobalValue<T>(inspect: { globalValue?: T } | undefined): T | undefined {
    return inspect?.globalValue;
}

/**
 * 按「项目 > 全局 > 关闭」规则读取专家模型下拉框当前值。
 *
 * 项目显式关闭时直接关闭；项目没有非关闭配置时读取全局；全局也没有时关闭。
 */
function readEffectiveExpertModelSelection(): EffectiveExpertModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_EXPERT_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
    if (globalEnabled === false) return { enabled: false, modelId: '' };
    if (globalEnabled === true && globalModel.length > 0) return { enabled: true, modelId: globalModel };
    if (globalModel.length > 0) return { enabled: true, modelId: globalModel };
    return { enabled: false, modelId: '' };
}

/**
 * 保存专家模型下拉框选择，并同步写入项目配置与全局配置。
 *
 * @param modelId 专家模型 ID；空字符串表示关闭专家。
 */
async function saveExpertModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_EXPERT_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
    configManager?.notifyChanged();
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
async function openLlsCcaiTaskMenu(): Promise<void> {
    if (!configManager || !llsTaskService) return;
    const texts = getLlsCcaiTaskTexts(configManager.getResolvedUiLanguage());
    const snapshot = llsTaskService.getSnapshot();

    // 1) 无任务流：直接填入启动提示词。
    if (!snapshot.workflow) {
        await fillBuiltInChatComposer(texts.startPrompt, true);
        return;
    }

    // 2) 已完成任务流：静默清空 + 填入启动提示词，不再弹确认。
    if (llsTaskService.isWorkflowCompleted()) {
        autoContinueScheduler?.cancel('点击 CC 任务流：自动清空已完成任务流');
        llsTaskService.clear();
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
        await fillBuiltInChatComposer(llsTaskService.buildContinuePrompt(), true);
    } else if (choice === clearLabel) {
        autoContinueScheduler?.cancel('用户从任务流菜单清空运行中任务流');
        llsTaskService.clear();
        await fillBuiltInChatComposer(texts.startPrompt, true);
    }
}

/**
 * 显示当前 LLS CCAI 任务流进度 QuickPick。
 */
async function showLlsCcaiTaskProgress(): Promise<void> {
    if (!llsTaskService) return;
    const workflow = llsTaskService.getSnapshot().workflow;
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
async function continueLlsCcaiTask(): Promise<void> {
    if (!llsTaskService) return;
    autoContinueScheduler?.cancel('用户手动继续任务流');
    await fillBuiltInChatComposer(llsTaskService.buildContinuePrompt(), true);
}

/** 任务流提示词发送选项。 */
interface TaskFlowPromptSendOptions {
    /** 是否直接提交到目标聊天入口。 */
    autoSubmit: boolean;
}

/**
 * 根据 taskFlow.target 配置把任务流提示词路由到内置 Chat 或旧 Claude Code 输入框。
 *
 * @param prompt 任务流提示词。
 * @param options 发送选项。
 */
async function sendTaskFlowPrompt(prompt: string, options: TaskFlowPromptSendOptions): Promise<void> {
    if (configManager?.getTaskFlowTarget() === 'builtinChat') {
        if (await trySendTaskFlowPromptToBuiltInChat(prompt, options)) return;
        Logger.warn('taskFlow.target=builtinChat 但内置 Chat 不可用，降级到 externalClaudeCode');
    }
    if (options.autoSubmit) {
        await pasteTaskFlowToExternalClaudeCode(prompt);
        return;
    }
    await pasteToClaudeCode(prompt, { autoSubmit: false });
}

/**
 * 尝试把任务流提示词发送或填充到内置 Chat。
 *
 * @param prompt 任务流提示词。
 * @param options 发送选项。
 * @returns 成功使用内置 Chat 时返回 true；需要降级时返回 false。
 */
async function trySendTaskFlowPromptToBuiltInChat(prompt: string, options: TaskFlowPromptSendOptions): Promise<boolean> {
    try {
        if (options.autoSubmit) {
            await appendUserMessageAndSend(prompt);
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
function clearLlsCcaiTask(): void {
    autoContinueScheduler?.cancel('用户清空当前任务流');
    llsTaskService?.clear();
}

/**
 * 打开内置 Chat 入口并确保 CLI 长连接已启动。
 *
 * 当前任务 3 只完成 CLI 选择与启动层，WebviewPanel 会在任务 4 接入；
 * 因此这里启动成功后先用信息提示告知用户 CLI 已就绪。
 */
async function openBuiltInChat(): Promise<void> {
    await ensureChatCliStarted();
    if (!chatViewHost || !chatCliConfigService) {
        throw new Error('Chat Webview 组件尚未初始化');
    }
    await showChatSessionPrivacyNoticeIfNeeded();
    await chatViewHost.open(chatMessages, chatCliConfigService.getConfig().cliPath);
}

/**
 * 启动后在已配置 CLI 路径时自动展开内置 Chat。
 *
 * 不主动弹出路径选择框；只有用户已经保存过 CLI 路径时才会尝试启动并打开面板。
 * 启动失败只记录日志，避免扩展激活阶段用错误弹窗打断用户。
 */
async function autoOpenBuiltInChatIfCliConfigured(): Promise<void> {
    const cliPath = chatCliConfigService?.getConfig().cliPath;
    if (!cliPath) return;
    try {
        await openBuiltInChat();
    } catch (err) {
        Logger.error('启动时自动展开内置 Chat 失败', err);
    }
}

/**
 * 从 workspaceState 恢复上一轮 Chat 会话。
 *
 * 仅恢复当前工作区内保存的消息，pending 消息会被标记为已结束，避免重载后误显示仍在生成。
 */
function restorePersistedChatSession(): void {
    const persisted = extensionContext?.workspaceState.get<PersistedChatSession>(CHAT_SESSION_STATE_KEY);
    if (!persisted || persisted.version !== 1 || !Array.isArray(persisted.messages)) {
        chatMessages = [];
        return;
    }
    chatMessages = sanitizePersistedChatMessages(persisted.messages).map((message) => ({
        ...message,
        pending: false
    }));
    activeAssistantMessageId = undefined;
    Logger.info(`已恢复 Chat 会话消息：${chatMessages.length} 条`);
}

/**
 * 规范化 workspaceState 中恢复出的 Chat 消息。
 *
 * @param messages 从持久化状态读取出的消息数组。
 * @returns 校验并裁剪后的消息数组。
 */
function sanitizePersistedChatMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages
        .filter((message) => !!message && typeof message.id === 'string' && Array.isArray(message.segments))
        .slice(-MAX_PERSISTED_CHAT_MESSAGES)
        .map((message) => ({
            id: message.id,
            role: message.role,
            segments: message.segments,
            pending: !!message.pending,
            createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now()
        }));
}

/**
 * 计划保存 Chat 会话到 workspaceState。
 *
 * 使用短防抖减少流式输出期间的频繁写入；真正写入由 {@link flushPersistedChatSession} 完成。
 */
function schedulePersistChatSession(): void {
    if (!extensionContext) return;
    if (chatSessionPersistTimer) clearTimeout(chatSessionPersistTimer);
    chatSessionPersistTimer = setTimeout(() => {
        void flushPersistedChatSession();
    }, 250);
}

/**
 * 立即把当前 Chat 会话写入 workspaceState。
 */
async function flushPersistedChatSession(): Promise<void> {
    if (chatSessionPersistTimer) clearTimeout(chatSessionPersistTimer);
    chatSessionPersistTimer = undefined;
    if (!extensionContext) return;
    const payload: PersistedChatSession = {
        version: 1,
        updatedAt: Date.now(),
        messages: chatMessages.slice(-MAX_PERSISTED_CHAT_MESSAGES)
    };
    await extensionContext.workspaceState.update(CHAT_SESSION_STATE_KEY, payload);
}

/**
 * 清空 workspaceState 中保存的 Chat 会话。
 */
async function clearPersistedChatSession(): Promise<void> {
    if (chatSessionPersistTimer) clearTimeout(chatSessionPersistTimer);
    chatSessionPersistTimer = undefined;
    await extensionContext?.workspaceState.update(CHAT_SESSION_STATE_KEY, undefined);
}

/**
 * 首次打开内置 Chat 时展示会话恢复隐私提示。
 *
 * 提示只在当前工作区展示一次，说明消息会保存在 workspaceState 中，用户可通过清空会话删除。
 */
async function showChatSessionPrivacyNoticeIfNeeded(): Promise<void> {
    if (!extensionContext) return;
    const shown = extensionContext.workspaceState.get<boolean>(CHAT_SESSION_PRIVACY_NOTICE_KEY, false);
    if (shown) return;
    await extensionContext.workspaceState.update(CHAT_SESSION_PRIVACY_NOTICE_KEY, true);
    await vscode.window.showInformationMessage(
        '内置 Chat 会在当前工作区恢复最近会话消息；如不希望保留，可点击 Chat 面板里的清空会话。'
    );
}

/**
 * 让用户选择或更换内置 Chat 使用的 Claude CLI 路径。
 *
 * 选择成功后会写入配置并立即按 stream-json 长连接参数启动 CLI，
 * 方便用户尽早发现路径或权限问题。
 */
async function selectChatCli(): Promise<void> {
    if (!cliResolver || !chatCliConfigService || !cliProcess) return;
    const cliPath = await cliResolver.selectCliPath();
    if (!cliPath) return;
    await startChatCliFromCurrentConfig();
    await showChatToast('success', `已选择并启动 Claude CLI：${cliPath}`);
}

/**
 * 重启内置 Chat 的 CLI 长连接进程。
 *
 * 如果进程尚未启动，则按当前配置和路径选择逻辑启动一个新进程。
 */
async function restartChatCli(options: { silent?: boolean } = {}): Promise<void> {
    if (!cliProcess || !chatCliConfigService) return;
    chatCliCancelRequested = false;
    await startChatCliFromCurrentConfig({ forceRestart: true });
    if (!options.silent) {
        await showChatToast('success', 'Chat CLI 长连接已重启。');
    }
}

/**
 * 确保 Chat CLI 路径可用且长连接进程处于运行状态。
 *
 * @throws 用户取消选择、路径无效或启动失败时抛出错误。
 */
async function ensureChatCliStarted(): Promise<void> {
    if (!cliResolver || !chatCliConfigService || !cliProcess) {
        throw new Error('Chat CLI 组件尚未初始化');
    }
    const cliPath = await cliResolver.resolveOrPrompt();
    if (!cliPath) throw new Error('用户取消了 Claude CLI 路径选择');
    await startChatCliFromCurrentConfig();
}

/**
 * 按当前配置启动 Chat CLI 长连接进程。
 *
 * @throws 配置无效或子进程启动失败时抛出错误。
 */
async function startChatCliFromCurrentConfig(options: { forceRestart?: boolean } = {}): Promise<void> {
    if (!chatCliConfigService || !cliProcess) {
        throw new Error('Chat CLI 组件尚未初始化');
    }
    const relayPort = await ensureRelayServerStarted();
    const config = await chatCliConfigService.getConfigWithRelayEnv(relayPort);
    await syncClaudeCliModelSettingsSafely();
    let persistedSessionId = await chatCliSessionStore?.readSessionId(config.cwd);
    // 重启 / 重载场景下，CLI 端 session 仍可恢复（保留历史上下文），但扩展端
    // LlsTaskService.snapshot 是纯内存态，已随上一进程退出而清空。若直接 --resume
    // 旧 session，模型会以为 workflow 还在跑而不再调用 create_llsccai_task_workflow
    // 工具，导致任务流卡死（症状：模型只回 "Workflow created" 文本，
    // taskFlow/status tasks=0 始终不变）。
    // 这里在每次启动 CLI 前对齐：如果扩展内存里没有 active workflow，主动丢掉旧 session
    // 文件，让本次以全新 session 开始。
    if (persistedSessionId && llsTaskService && !llsTaskService.hasActiveWorkflow()) {
        try {
            await chatCliSessionStore?.clearSessionId(config.cwd);
            Logger.info('Chat CLI 旧 session 与扩展内存不一致（workflow 已丢失），已清理：sessionId=' + persistedSessionId);
        } catch (err: unknown) {
            Logger.warn('Chat CLI 旧 session 清理失败：' + (err instanceof Error ? err.message : String(err)));
        }
        persistedSessionId = undefined;
    }
    const launchConfig = { ...config, resumeSessionId: persistedSessionId };
    Logger.info('准备启动 Chat CLI 配置：' + JSON.stringify({
        cwd: launchConfig.cwd,
        cliPath: launchConfig.cliPath,
        model: launchConfig.model,
        hasPersistedSession: !!persistedSessionId,
        willResumePersistedSession: !!launchConfig.resumeSessionId,
        anthropicBaseUrl: launchConfig.cliEnv.ANTHROPIC_BASE_URL || '',
        hasAnthropicAuthToken: !!launchConfig.cliEnv.ANTHROPIC_AUTH_TOKEN,
        hasAnthropicApiKey: !!launchConfig.cliEnv.ANTHROPIC_API_KEY,
        hasCustomHeaders: !!launchConfig.cliEnv.ANTHROPIC_CUSTOM_HEADERS,
        skipAuthLogin: launchConfig.cliEnv.CLAUDE_CODE_SKIP_AUTH_LOGIN || '',
        skipModelValidation: launchConfig.cliEnv.CLAUDE_CODE_SKIP_MODEL_VALIDATION || ''
    }));
    if (!options.forceRestart && cliProcess.isRunningWithConfig(launchConfig)) {
        ensureStreamJsonCliAdapter();
        await chatViewHost?.postMessage({ type: 'cli/status', status: 'running', detail: config.cliPath });
        return;
    }
    chatCliCancelRequested = false;
    if (cliProcess.isRunning()) expectedChatCliExitCount += 1;
    logMcpToolsBeforeCliStart();
    await cliProcess.start(launchConfig);
    ensureStreamJsonCliAdapter();
    await chatViewHost?.postMessage({ type: 'cli/status', status: 'running', detail: config.cliPath });
}

/**
 * 在启动 Chat CLI 之前枚举当前 VS Code 注册的 MCP 工具数量并写入日志。
 *
 * VS Code 稳定 API `vscode.lm.tools` 返回 `LanguageModelToolInformation[]`，
 * 字段包括 `name / description / inputSchema / tags`。MCP 注册的工具通常带有
 * `mcp` 标签或名称以 `mcp_` 前缀开头（不同 VS Code 版本/扩展可能略有差异），
 * 这里把两种识别条件都纳入；为避免输出日志过长，不再打印工具明细。
 *
 * 本函数仅记录日志，不阻塞 CLI 启动，所有异常都会被吞掉并降级为一条 warn。
 */
function logMcpToolsBeforeCliStart(): void {
    try {
        const lm = (vscode as unknown as { lm?: { tools?: ReadonlyArray<vscode.LanguageModelToolInformation> } }).lm;
        const allTools = lm?.tools;
        if (!allTools || !Array.isArray(allTools)) {
            Logger.warn('启动 Chat CLI 前枚举 MCP 工具：vscode.lm.tools 不可用');
            return;
        }
        const mcpTools = allTools.filter((tool) => {
            const tags = Array.isArray(tool.tags) ? tool.tags.map((tag: unknown) => String(tag).toLowerCase()) : [];
            if (tags.includes('mcp')) return true;
            if (typeof tool.name === 'string' && tool.name.toLowerCase().startsWith('mcp_')) return true;
            return false;
        });
        Logger.info(`启动 Chat CLI 前枚举到 MCP 工具：count=${mcpTools.length}/${allTools.length}`);
    } catch (error) {
        Logger.warn('启动 Chat CLI 前枚举 MCP 工具失败：' + (error instanceof Error ? error.message : String(error)));
    }
}

/**
 * 确保 stream-json CLI 适配器已创建并订阅解析事件。
 *
 * 同时注入 `onPermissionDenied` 回调：当模型工具调用被 Claude CLI 权限策略
 * 拦截时（典型场景：非交互模式下 Bash 写文件被默认策略 deny），向用户弹出
 * 一次性的 VS Code 警告通知，并提供"打开设置"快捷入口跳转到
 * `claudeCodeConfigHelper.chat.permissionMode` 配置项。
 */
function ensureStreamJsonCliAdapter(): void {
    if (!cliProcess) throw new Error('Chat CLI 进程尚未初始化');
    streamJsonCliAdapterSubscription?.dispose();
    streamJsonCliAdapter?.dispose();
    streamJsonCliAdapter = new StreamJsonCliAdapter(cliProcess, (resultText) => {
        notifyPermissionDeniedToUser(resultText);
    });
    streamJsonCliAdapterSubscription = streamJsonCliAdapter.onParsedEvent((event) => {
        void handleParsedCliEvent(event).catch((err: unknown) => {
            Logger.error('处理 CLI 流式事件失败', err);
        });
    });
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
function notifyPermissionDeniedToUser(resultText: string): void {
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
 */
async function handleParsedCliEvent(event: ParsedCliEvent): Promise<void> {
    switch (event.type) {
        case 'segments':
            await appendAssistantSegments(event.segments, event.done ?? false);
            return;
        case 'done':
            await finishActiveAssistantMessage();
            return;
        case 'error':
            await finishActiveAssistantMessage();
            Logger.error(`Chat CLI 事件错误：${event.message}${event.detail ? ` :: ${event.detail}` : ''}`);
            await showChatToast('error', event.detail ? `${event.message}：${event.detail}` : event.message);
            return;
        case 'session/init':
            await chatCliSessionStore?.writeSessionId(event.cwd, event.sessionId);
            Logger.info(`已保存 Chat CLI session_id 到 ${event.cwd}/.LLSOAI`);
            return;
        case 'tool/permissionRequest':
            await handleToolPermissionRequest(event);
            return;
        default:
            return;
    }
}

/**
 * 处理 Claude CLI stdio 工具授权请求。
 *
 * 当前实现先使用 VS Code 模态确认框打通官方 `can_use_tool` 授权闭环：CLI 发出
 * `control_request` 后，本函数向用户展示工具名与关键参数；用户选择允许/拒绝后，
 * 再通过 `StreamJsonCliAdapter.respondToToolPermission` 写回 `control_response`。
 * 这样 Bash 等需要授权的工具在非交互 stream-json 模式下也能继续执行。
 *
 * @param event 适配器解析出的工具授权请求事件。
 */
async function handleToolPermissionRequest(event: ToolPermissionRequestEvent): Promise<void> {
    const adapter = streamJsonCliAdapter;
    if (!adapter) {
        Logger.warn(`收到工具授权请求但 stream-json 适配器不存在：requestId=${event.requestId}`);
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
        await showChatToast('success', `已允许 ${event.toolName} 本次执行`);
        return;
    }
    adapter.respondToToolPermission(event.requestId, {
        behavior: 'deny',
        message: '用户拒绝了本次工具调用。',
        interrupt: false
    });
    await showChatToast('warn', `已拒绝 ${event.toolName} 本次执行`);
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
function buildToolPermissionPromptMessage(event: ToolPermissionRequestEvent): string {
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
function formatToolPermissionInput(input: unknown): string {
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
 * 处理 Chat Webview 发回扩展宿主的基础消息。
 *
 * 任务 4 阶段只实现 ready、发送回显、选择 CLI 和重启 CLI；真正写入 CLI stdin
 * 会在任务 5 的消息协议联通中接入。
 *
 * @param message WebviewToExtension 协议消息。
 */
async function handleChatWebviewMessage(message: WebviewToExtension): Promise<void> {
    switch (message.type) {
        case 'webview/ready':
            await postChatUiLanguage();
            await chatViewHost?.postMessage({
                type: 'session/init',
                messages: chatMessages,
                cliPath: chatCliConfigService?.getConfig().cliPath ?? ''
            });
            await postChatModelOptions();
            await postChatExpertModelOptions();
            await postChatPermissionMode();
            await postChatTaskFlowStatus();
            await postActiveEditorAttachmentToChat();
            return;
        case 'user/send':
            Logger.info(`收到 Chat Webview 发送请求：textLength=${message.text.length}, attachments=${message.attachments?.length ?? 0}`);
            {
                const prompt = buildPromptWithAttachments(message.text, message.attachments);
                await appendLocalChatMessage('user', prompt, await buildUserDisplaySegments(prompt, message.attachments));
                armHttpExpectation(prompt);
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
        case 'expert/model/select':
            await selectChatExpertModel(message.modelId);
            return;
        case 'taskFlow/open':
            await openLlsCcaiTaskMenu();
            return;
        case 'cli/selectPath':
            await selectChatCli();
            await postChatUiLanguage();
            await chatViewHost?.postMessage({
                type: 'session/init',
                messages: chatMessages,
                cliPath: chatCliConfigService?.getConfig().cliPath ?? ''
            });
            return;
        case 'cli/restart':
            await restartChatCli();
            return;
        case 'user/cancel':
            chatCliCancelRequested = true;
            clearHttpExpectation('user_cancel');
            cancelPendingResend('user_cancel');
            cliProcess?.cancel();
            await appendAssistantSegments([{ kind: 'markdown', text: '\n（已请求取消当前输出）\n' }], true);
            return;
        case 'user/resend':
            await handleUserResend(message.id, message.text);
            return;
        case 'session/clear':
            chatMessages = [];
            activeAssistantMessageId = undefined;
            clearHttpExpectation('session_clear');
            cancelPendingResend('session_clear');
            await clearPersistedChatSession();
            await postChatUiLanguage();
            await chatViewHost?.postMessage({
                type: 'session/init',
                messages: chatMessages,
                cliPath: chatCliConfigService?.getConfig().cliPath ?? ''
            });
            return;
        case 'file/open':
            await openWorkspaceFileReference(message.path, message.line, message.endLine);
            return;
        case 'log':
            Logger[message.level](`[Chat Webview] ${message.message}`);
            if (message.message.startsWith('[boot]')) {
                Logger.info('收到 Chat Webview boot 日志，兜底刷新默认上下文文件');
                await postActiveEditorAttachmentToChat();
            }
            return;
        default:
            return;
    }
}

/**
 * 读取配置页中可选模型并推送到 Chat Webview。
 */
async function postChatModelOptions(): Promise<void> {
    if (!configManager) return;
    const current = configManager.getCurrentModel();
    const models: ChatModelOption[] = [];
    for (const provider of configManager.listProviders()) {
        if (!provider.enabled) continue;
        for (const model of provider.models) {
            if (model.isUserSelectable === false) continue;
            models.push({
                providerId: provider.id,
                providerName: provider.name,
                modelId: model.modelId,
                displayName: model.displayName || model.modelId,
                selected: current?.providerId === provider.id && current.modelId === model.modelId
            });
        }
    }
    await chatViewHost?.postMessage({ type: 'model/options', models, current });
}

/**
 * 读取专家模型下拉框可选项，并推送当前按「项目 > 全局 > 关闭」解析的选择。
 */
async function postChatExpertModelOptions(): Promise<void> {
    if (!configManager) return;
    const current = readEffectiveExpertModelSelection();
    const models: ChatModelOption[] = [];
    for (const provider of configManager.listProviders()) {
        if (!provider.enabled) continue;
        for (const model of provider.models) {
            if (model.isUserSelectable === false) continue;
            models.push({
                providerId: provider.id,
                providerName: provider.name,
                modelId: model.modelId,
                displayName: model.displayName || model.modelId,
                selected: current.enabled && current.modelId === model.modelId
            });
        }
    }
    await chatViewHost?.postMessage({ type: 'expert/model/options', models, current });
}

/**
 * 读取当前 Chat CLI 权限模式并推送到 Chat Webview。
 */
async function postChatPermissionMode(): Promise<void> {
    const mode = normalizeQuickPermissionMode(chatCliConfigService?.getConfig().permissionMode);
    await chatViewHost?.postMessage({ type: 'permissionMode/current', mode });
}

/**
 * 读取当前 LLS CCAI / CC 任务流快照并推送到 Chat Webview。
 *
 * Webview 会根据该状态在聊天上方显示或隐藏 Todo 状态卡片；任务流创建、更新、
 * 清空以及缺失工具标记变化都会触发该函数，从而保证界面与服务状态一致。
 */
async function postChatTaskFlowStatus(): Promise<void> {
    if (!llsTaskService) return;
    const snapshot = llsTaskService.getSnapshot() as LlsTaskSnapshotPayload;
    const delivered = await chatViewHost?.postMessage({ type: 'taskFlow/status', snapshot });
    if (!delivered && snapshot.workflow && chatViewHost && chatCliConfigService && !chatViewHost.hasResolvedView()) {
        await chatViewHost.open(chatMessages, chatCliConfigService.getConfig().cliPath);
    }
}

/**
 * 读取当前解析后的 UI 语言并推送给 Chat Webview。
 *
 * Chat 前端会用该消息更新静态文案、动态工具卡片、usage footer 与空状态等
 * 本地渲染内容；这里只发送语言，不重复发送 session/init，避免聊天区滚动闪跳。
 */
async function postChatUiLanguage(): Promise<void> {
    if (!configManager) return;
    await chatViewHost?.postMessage({ type: 'i18n/update', language: configManager.getResolvedUiLanguage() as ChatUiLanguage });
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
function normalizeQuickPermissionMode(mode: string | undefined): ChatQuickPermissionMode {
    return mode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
}

/**
 * 从 Chat 输入框切换当前模型，写入 Claude CLI 配置并自动重启长连接。
 *
 * @param providerId 提供商 ID。
 * @param modelId 模型 ID。
 */
async function selectChatModel(providerId: string, modelId: string): Promise<void> {
    if (!configManager) throw new Error('配置管理器尚未初始化');
    const provider = configManager.getProvider(providerId);
    const model = provider?.models.find((item) => item.modelId === modelId);
    if (!provider || !model) throw new Error(`模型不存在：${providerId}/${modelId}`);
    await configManager.setCurrentModel({ providerId, modelId });
    await postChatModelOptions();
    Logger.info(`Chat 输入框切换模型：${provider.name}/${model.displayName || model.modelId}，将通过 --model 重启 CLI`);
    await restartChatCli({ silent: true });
    await showChatToast('success', `模型已切换为：${provider.name}/${model.displayName || model.modelId}`);
}

/**
 * 从 Chat 输入框下方专家下拉框切换专家模型，并同步保存项目与全局配置。
 *
 * @param modelId 专家模型 ID；空字符串表示关闭专家。
 */
async function selectChatExpertModel(modelId: string): Promise<void> {
    await saveExpertModelSelection(modelId);
    await postChatExpertModelOptions();
    const current = readEffectiveExpertModelSelection();
    if (!current.enabled) {
        Logger.info('Chat 输入框关闭专家模式，已同步保存项目与全局配置');
        await restartChatCli({ silent: true });
        await showChatToast('success', '专家已关闭');
        return;
    }
    Logger.info(`Chat 输入框切换专家模型：${current.modelId}，已同步保存项目与全局配置`);
    await restartChatCli({ silent: true });
    await showChatToast('success', `专家模型已切换为：${current.modelId}`);
}

/**
 * 从 Chat 输入框切换 Claude CLI 权限模式，写入配置并自动重启长连接。
 *
 * @param mode 用户在快捷下拉框中选择的权限模式。
 */
async function selectChatPermissionMode(mode: ChatQuickPermissionMode): Promise<void> {
    if (!chatCliConfigService) throw new Error('Chat CLI 配置服务尚未初始化');
    await chatCliConfigService.updatePermissionMode(mode);
    await postChatPermissionMode();
    Logger.info(`Chat 输入框切换权限模式：${mode}，将通过 --permission-mode 重启 CLI`);
    await restartChatCli({ silent: true });
    await showChatToast('success', `权限模式已切换为：${mode}`);
}

/**
 * 在内置 Chat Webview 内展示提示，不使用 VS Code 系统通知。
 *
 * @param level 提示级别。
 * @param text 提示文本。
 */
async function showChatToast(level: 'info' | 'success' | 'warn' | 'error', text: string): Promise<void> {
    await chatViewHost?.postMessage({ type: 'toast', level, text });
}

/**
 * 打开 VS Code 文件选择器并把选中文件以 @path 形式填充到输入框。
 */
async function pickChatContextFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: '添加到 Chat 上下文'
    });
    if (!uris || uris.length === 0) return;
    await chatViewHost?.postMessage({
        type: 'composer/addAttachments',
        attachments: uris.map((uri) => ({ path: uri.fsPath, name: path.basename(uri.fsPath) })),
        focus: true
    });
}

/**
 * 保存 Webview 粘贴/拖放上传的二进制文件，并把真实临时文件路径回填到输入框附件。
 *
 * @param message file/uploadBlob 协议消息。
 */
async function saveChatUploadedBlob(message: Extract<WebviewToExtension, { type: 'file/uploadBlob' }>): Promise<void> {
    try {
        const safeName = sanitizeUploadFileName(message.name, message.mime);
        const size = Number.isFinite(message.size) ? message.size : 0;
        if (size < 0 || size > MAX_CHAT_UPLOAD_BYTES) throw new Error(`文件过大：${size} bytes`);
        const bytes = Buffer.from(message.base64 || '', 'base64');
        if (bytes.byteLength > MAX_CHAT_UPLOAD_BYTES) throw new Error(`文件过大：${bytes.byteLength} bytes`);
        const tempRoot = vscode.Uri.file(path.join(os.tmpdir(), CHAT_UPLOAD_TEMP_DIR));
        await vscode.workspace.fs.createDirectory(tempRoot);
        const target = vscode.Uri.joinPath(tempRoot, `${Date.now()}-${safeName}`);
        await vscode.workspace.fs.writeFile(target, bytes);
        await chatViewHost?.postMessage({
            type: 'composer/replaceAttachment',
            clientId: message.clientId,
            attachment: { path: target.fsPath, name: message.displayName || safeName },
            focus: true
        });
        await showChatToast('success', `已添加图片：${safeName}`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        Logger.error(`保存 Chat 上传文件失败：${detail}`);
        await showChatToast('error', `保存粘贴图片失败：${detail}`);
    }
}

/**
 * 清理 Webview 上传文件名，防止路径穿越并在缺少扩展名时按 MIME 补齐。
 *
 * @param name Webview 传入的文件名。
 * @param mime 文件 MIME 类型。
 * @returns 可安全拼接到临时目录中的文件名。
 */
function sanitizeUploadFileName(name: string, mime: string): string {
    const extensionByMime: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/tiff': '.tiff'
    };
    const fallbackExtension = extensionByMime[mime.toLowerCase()] ?? '.bin';
    const fallbackName = `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-')}${fallbackExtension}`;
    const baseName = path.basename(String(name || fallbackName)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim();
    const safeName = baseName || fallbackName;
    if (path.extname(safeName)) return safeName;
    return `${safeName}${fallbackExtension}`;
}

/**
 * 将当前活动编辑器中的本地文件和选区作为 Chat 默认上下文附件发送给 Webview。
 *
 * 逻辑参考 Claude Code：优先使用 activeTextEditor；当焦点进入 Webview 导致 activeTextEditor 为空、
 * 但仍有可见编辑器时，保留上一次上下文，避免默认文件被误清空。
 */
async function postActiveEditorAttachmentToChat(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const version = ++chatEditorSelectionVersion;
    if (!editor) {
        if (vscode.window.visibleTextEditors.length > 0 && lastChatEditorAttachment) {
            await chatViewHost?.postMessage({ type: 'composer/defaultAttachment', attachment: lastChatEditorAttachment });
            return;
        }
        lastChatEditorAttachment = undefined;
        await chatViewHost?.postMessage({ type: 'composer/defaultAttachment' });
        return;
    }
    if (!uri || uri.scheme === 'comment' || uri.scheme === 'output' || uri.scheme !== 'file') {
        if (lastChatEditorAttachment && vscode.window.visibleTextEditors.length > 0) {
            await chatViewHost?.postMessage({ type: 'composer/defaultAttachment', attachment: lastChatEditorAttachment });
            return;
        }
        lastChatEditorAttachment = undefined;
        await chatViewHost?.postMessage({ type: 'composer/defaultAttachment' });
        return;
    }
    const attachment = buildEditorAttachment(editor);
    if (version !== chatEditorSelectionVersion) {
        return;
    }
    lastChatEditorAttachment = attachment;
    await chatViewHost?.postMessage({ type: 'composer/defaultAttachment', attachment });
}

/**
 * 将 VS Code Selection 序列化为日志友好的普通对象。
 *
 * @param selection VS Code 当前选区。
 * @returns 适合 JSON.stringify 的选区对象。
 */
function serializeSelection(selection: vscode.Selection): Record<string, unknown> {
    return {
        start: { line: selection.start.line, character: selection.start.character },
        end: { line: selection.end.line, character: selection.end.character },
        isEmpty: selection.isEmpty,
        isReversed: selection.isReversed
    };
}

/**
 * 从活动编辑器构造 Claude Code 风格的当前文件/选区上下文。
 *
 * @param editor 当前活动文本编辑器。
 * @returns 带文件路径、光标行或选区信息的默认上下文附件。
 */
function buildEditorAttachment(editor: vscode.TextEditor): ChatComposerAttachment {
    const selection = editor.selection;
    const attachment: ChatComposerAttachment = {
        path: editor.document.uri.fsPath,
        name: path.basename(editor.document.uri.fsPath),
        startLine: selection.start.line + 1,
        endLine: selection.isEmpty ? selection.start.line + 1 : selection.end.line + 1
    };
    if (!selection.isEmpty) {
        attachment.startColumn = selection.start.character;
        attachment.endColumn = selection.end.character;
        attachment.selectedText = editor.document.getText(selection);
    }
    return attachment;
}

/**
 * 将输入文本和附件合并为发送给 CLI 的提示词。
 *
 * @param text 用户输入的自然语言内容。
 * @param attachments 输入框附带的上下文文件。
 * @returns 包含 @file 引用的完整提示词。
 */
function buildPromptWithAttachments(text: string, attachments?: ChatComposerAttachment[]): string {
    const uniqueKeys = new Set<string>();
    const uniqueAttachments: ChatComposerAttachment[] = [];
    for (const item of attachments ?? []) {
        if (!item?.path) continue;
        const key = formatAttachmentForPrompt(item);
        if (uniqueKeys.has(key)) continue;
        uniqueKeys.add(key);
        uniqueAttachments.push(item);
    }
    const attachmentText = uniqueAttachments.map((item) => `@${formatAttachmentForPrompt(item)}`).join(' ');
    return [attachmentText, text.trim()].filter(Boolean).join('\n\n');
}

/**
 * 为用户本地消息构造展示片段，图片附件会额外转为可直接渲染的 data URL。
 *
 * 发送给 Claude CLI 的真实 prompt 仍保持 `@file` 文本引用；本函数只影响 Webview
 * 本地回显，让用户确认自己刚刚发出的截图/图片确实被提取到了。
 *
 * @param prompt 已合成的发送给 CLI 的 prompt 文本。
 * @param attachments 用户随消息发送的附件。
 * @returns 可用于 ChatMessage 的片段列表。
 */
async function buildUserDisplaySegments(prompt: string, attachments?: ChatComposerAttachment[]): Promise<ChatSegment[]> {
    const segments: ChatSegment[] = [{ kind: 'markdown', text: prompt }];
    for (const attachment of attachments ?? []) {
        const image = await buildImageSegmentFromAttachment(attachment);
        if (image) segments.push(image);
    }
    return segments;
}

/**
 * 从单个附件读取图片并构造 image 片段。
 *
 * @param attachment 用户输入框附件。
 * @returns 图片可读时返回 image 片段；非图片或读取失败时返回 undefined。
 */
async function buildImageSegmentFromAttachment(attachment: ChatComposerAttachment): Promise<ChatSegment | undefined> {
    if (!attachment?.path) return undefined;
    const mediaType = getImageMediaTypeFromPath(attachment.path);
    if (!mediaType) return undefined;
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(attachment.path));
        const base64 = Buffer.from(bytes).toString('base64');
        return {
            kind: 'image',
            imageUrl: `data:${mediaType};base64,${base64}`,
            mediaType,
            alt: attachment.name || path.basename(attachment.path),
            filePath: attachment.path
        };
    } catch (err) {
        Logger.warn(`读取 Chat 图片附件失败：${attachment.path} :: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

/**
 * 根据文件扩展名推断图片 MIME 类型。
 *
 * @param filePath 图片文件路径。
 * @returns 支持的图片 MIME；非图片扩展名返回 undefined。
 */
function getImageMediaTypeFromPath(filePath: string): string | undefined {
    switch (path.extname(filePath).toLowerCase()) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        case '.bmp':
            return 'image/bmp';
        case '.tif':
        case '.tiff':
            return 'image/tiff';
        default:
            return undefined;
    }
}

/**
 * 将附件格式化为 Claude Code 风格的 @file#line 引用。
 *
 * @param attachment Chat 输入框上下文附件。
 * @returns 适合放入 prompt 的文件引用路径。
 */
function formatAttachmentForPrompt(attachment: ChatComposerAttachment): string {
    const filePath = formatPathForPrompt(attachment.path);
    if (attachment.startLine && attachment.endLine && attachment.startLine !== attachment.endLine) {
        return `${filePath}#${attachment.startLine}-${attachment.endLine}`;
    }
    if (attachment.startLine) return `${filePath}#${attachment.startLine}`;
    return filePath;
}

/**
 * 尽量把文件路径格式化为 workspace 相对路径，保持提示词简洁。
 *
 * @param filePath 待格式化的绝对路径或文件名。
 * @returns 适合放入 prompt 的路径文本。
 */
function formatPathForPrompt(filePath: string): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
        const relative = path.relative(folder.uri.fsPath, filePath);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    }
    return filePath;
}

/**
 * 打开 Webview 文件引用指向的 workspace 内文件。
 *
 * @param filePath Webview 传回的相对或绝对文件路径。
 * @param line 可选 1-based 起始行号。
 * @param endLine 可选 1-based 结束行号。
 */
async function openWorkspaceFileReference(filePath: string, line?: number, endLine?: number): Promise<void> {
    const uri = await resolveWorkspaceFileUri(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const selection = typeof line === 'number' && line > 0
        ? new vscode.Range(line - 1, 0, Math.max((endLine ?? line) - 1, line - 1), 0)
        : undefined;
    await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
        selection
    });
}

/**
 * 将 Webview 传入的文件路径解析为 workspace allowlist 内 URI。
 *
 * @param filePath Webview 传回的不可信路径。
 * @returns 通过校验且存在的文件 URI。
 * @throws 路径危险、无 workspace、越界或文件不存在时抛出错误。
 */
async function resolveWorkspaceFileUri(filePath: string): Promise<vscode.Uri> {
    if (!filePath || /^(?:javascript|command|data):/i.test(filePath)) {
        throw new Error('拒绝打开不安全的文件路径');
    }
    const normalizedInput = filePath.replace(/\\/g, path.sep);
    const folders = vscode.workspace.workspaceFolders;
    const candidates = buildWorkspaceFileCandidates(normalizedInput, folders);
    if (!folders || folders.length === 0) {
        throw new Error('当前没有 workspace，无法校验文件引用');
    }
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        for (const inputCandidate of candidates) {
            const candidate = path.isAbsolute(inputCandidate)
                ? inputCandidate
                : path.resolve(root, inputCandidate);
            if (!isPathInside(candidate, root)) continue;
            const uri = vscode.Uri.file(candidate);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.File) return uri;
            } catch {
                // 尝试下一个 workspace folder。
            }
        }
    }
    throw new Error(`文件不存在或不在 workspace 内：${filePath}`);
}

/**
 * 构造 Webview 文件引用的候选路径列表。
 *
 * 某些模型或 Markdown 解析链路会把 macOS/Linux 绝对路径 `/Users/a/b.ts`
 * 误写成 `Users/a/b.ts`，少了开头的根斜杠。这里会在安全校验前补充一个
 * `/${input}` 候选；后续仍会经过 workspace allowlist 判断，避免因为自动补斜杠
 * 打开工作区外文件。
 *
 * 同时，如果当前 workspace 根路径去掉开头 `/` 后正好是输入路径前缀，也会生成
 * 对应的绝对候选，解决 `Users/.../workspace/src/a.ts` 这类缺斜杠引用。
 *
 * @param normalizedInput 已把反斜杠归一化后的用户输入路径。
 * @param folders 当前 workspace folders，可能为空。
 * @returns 去重后的候选路径列表，第一项始终是原始归一化输入。
 */
function buildWorkspaceFileCandidates(
    normalizedInput: string,
    folders: readonly vscode.WorkspaceFolder[] | undefined
): string[] {
    const candidates: string[] = [normalizedInput];
    const addCandidate = (candidate: string): void => {
        if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    };
    if (!path.isAbsolute(normalizedInput) && !normalizedInput.startsWith(`.${path.sep}`)) {
        addCandidate(`${path.sep}${normalizedInput}`);
    }
    for (const folder of folders ?? []) {
        let rootWithoutLeadingSlash = folder.uri.fsPath;
        while (rootWithoutLeadingSlash.startsWith(path.sep)) {
            rootWithoutLeadingSlash = rootWithoutLeadingSlash.slice(path.sep.length);
        }
        if (rootWithoutLeadingSlash && normalizedInput.startsWith(rootWithoutLeadingSlash)) {
            addCandidate(`${path.sep}${normalizedInput}`);
        }
    }
    return candidates;
}

/**
 * 判断目标路径是否位于 workspace 根目录内。
 *
 * @param target 待判断绝对路径。
 * @param root workspace 根目录绝对路径。
 * @returns target 在 root 内或等于 root 时返回 true。
 */
function isPathInside(target: string, root: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 登记一次"等待 Relay 命中"全局计时器。
 *
 * 用户主动 `user/send` 提交消息后调用：若 20 秒内 RelayServer 未收到 `POST
 * /v1/messages` 请求（命中后会清除该计时器），则视为 HTTP 卡死，进入自愈流程
 * （{@link healRelayAndCli}）。后续提交或自愈再次启动时会先清除上一次计时器。
 *
 * @param prompt 本次提交的完整 prompt 文本，超时后用于自动重发。
 */
function armHttpExpectation(prompt: string): void {
    clearHttpExpectation('rearm');
    pendingHttpExpectationPrompt = prompt;
    pendingHttpExpectationStartedAt = Date.now();
    Logger.info(`Relay 命中看门狗已启动：timeout=${HTTP_EXPECTATION_TIMEOUT_MS}ms, promptLength=${prompt.length}`);
    pendingHttpExpectationTimer = setTimeout(() => {
        pendingHttpExpectationTimer = undefined;
        void onHttpExpectationTimeout();
    }, HTTP_EXPECTATION_TIMEOUT_MS);
}

/**
 * 清除"等待 Relay 命中"全局计时器。
 *
 * 在以下情况下调用：RelayServer 命中、用户取消、会话清空、CLI 退出、重新登记
 * 计时器、扩展 deactivate。多次调用幂等。
 *
 * @param reason 触发清除的原因，仅用于日志诊断。
 */
function clearHttpExpectation(reason: string): void {
    if (pendingHttpExpectationTimer) {
        clearTimeout(pendingHttpExpectationTimer);
        pendingHttpExpectationTimer = undefined;
        const elapsed = pendingHttpExpectationStartedAt ? Date.now() - pendingHttpExpectationStartedAt : -1;
        Logger.info(`Relay 命中看门狗已清除：reason=${reason}, elapsed=${elapsed}ms`);
    }
    pendingHttpExpectationPrompt = undefined;
    pendingHttpExpectationStartedAt = undefined;
}

/**
 * 看门狗超时回调：触发"重启 HTTP Relay → 重启 CLI → 延时 60s 内部重发"自愈流程。
 *
 * 通过 {@link isHealingRelayAndCli} 互斥，避免并发触发；自愈期间不会再次启动
 * 看门狗，重启完成后由 {@link scheduleHealResend} 延时重发，重发时再调用
 * {@link armHttpExpectation} 重新计时。
 */
async function onHttpExpectationTimeout(): Promise<void> {
    if (isHealingRelayAndCli) {
        Logger.warn('Relay 命中看门狗超时，但已有自愈流程在执行，本次忽略');
        return;
    }
    const prompt = pendingHttpExpectationPrompt;
    pendingHttpExpectationPrompt = undefined;
    pendingHttpExpectationStartedAt = undefined;
    if (!prompt) {
        Logger.warn('Relay 命中看门狗超时，但未保留 prompt，跳过自愈');
        return;
    }
    isHealingRelayAndCli = true;
    try {
        await healRelayAndCli(prompt);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`Relay/CLI 自愈流程失败：${message}`);
        await appendAssistantSegments(
            [{ kind: 'error', text: `\n自动恢复失败：${message}\n` }],
            true
        );
        isHealingRelayAndCli = false;
    }
    // 注意：成功路径下不在这里释放锁。
    // 锁会在 scheduleHealResend → 内部重发完成时释放，避免重启刚完成又被新的超时
    // 抢占触发第二轮自愈。
}

/**
 * 执行 HTTP Relay 与 Claude CLI 的自愈流程（不包含重发）。
 *
 * 顺序：写入一条 Chat 提示 → 重启 RelayServer（可能换端口）→ 重启 CLI 子进程
 * （新端口随 ANTHROPIC_BASE_URL 注入）→ 安排 60 秒后内部重发。重启异常会上抛
 * 给调用方处理；安排好延时重发后立即返回，等待计时器到期。
 *
 * @param prompt 需要重发的 prompt 文本。
 */
async function healRelayAndCli(prompt: string): Promise<void> {
    const expectationSeconds = Math.round(HTTP_EXPECTATION_TIMEOUT_MS / 1000);
    Logger.warn(`Relay ${expectationSeconds} 秒未命中，开始自愈：promptLength=${prompt.length}`);
    await appendAssistantSegments(
        [{
            kind: 'error',
            text: `\n本地中转 ${expectationSeconds} 秒内未收到请求，正在自动重启 Relay 与 CLI，重启完成后 ${Math.round(HEAL_RESEND_DELAY_MS / 1000)} 秒再重发上一条消息…\n`
        }],
        false
    );
    await showChatToast('warn', `本地中转 ${expectationSeconds} 秒未响应，正在自动恢复…`);
    if (relayServer) {
        const oldPort = relayServer.getActualPort();
        await appendAssistantSegments(
            [{
                kind: 'markdown',
                text: `\n> 🛑 正在停止本地中转 HTTP 服务${typeof oldPort === 'number' ? `（旧端口 ${oldPort}）` : ''}…\n`
            }],
            false
        );
        try {
            const newPort = await relayServer.restart();
            Logger.info(`Relay 已自愈重启，新端口=${newPort}`);
            await appendAssistantSegments(
                [{
                    kind: 'markdown',
                    text: `\n> ✅ 本地中转 HTTP 服务已启动：http://127.0.0.1:${newPort}\n`
                }],
                false
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Relay 自愈重启失败：${message}`);
            await appendAssistantSegments(
                [{ kind: 'error', text: `\n❌ 本地中转 HTTP 服务重启失败：${message}\n` }],
                false
            );
            throw err;
        }
    }
    await appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 🔄 正在重启 Claude CLI 子进程…\n' }],
        false
    );
    try {
        await restartChatCli({ silent: true });
        await appendAssistantSegments(
            [{ kind: 'markdown', text: '\n> ✅ Claude CLI 已重启完成\n' }],
            false
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`CLI 自愈重启失败：${message}`);
        await appendAssistantSegments(
            [{ kind: 'error', text: `\n❌ Claude CLI 重启失败：${message}\n` }],
            false
        );
        throw err;
    }
    scheduleHealResend(prompt);
}

/**
 * 安排自愈重启后的延时内部重发。
 *
 * 给 CLI 充足启动时间（默认 60 秒），到期后调用 {@link armHttpExpectation} 重新
 * 计时并发送上次 prompt。重发成功（无论命中与否，看门狗都会重新负责）或重发
 * 异常都会释放 {@link isHealingRelayAndCli} 互斥锁。
 *
 * 用户在等待期间触发取消/会话清空时会通过 {@link cancelPendingResend} 清掉本
 * 计时器，避免再发出过期消息。
 *
 * @param prompt 需要内部重发的 prompt 文本。
 */
function scheduleHealResend(prompt: string): void {
    cancelPendingResend('rearm');
    Logger.info(`已安排自愈重发：delay=${HEAL_RESEND_DELAY_MS}ms`);
    pendingResendTimer = setTimeout(async () => {
        pendingResendTimer = undefined;
        try {
            Logger.info('自愈重启完成，开始内部重发最近一次用户消息');
            armHttpExpectation(prompt);
            await sendUserMessageToCli(prompt);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`自愈重发失败：${message}`);
            await appendAssistantSegments(
                [{ kind: 'error', text: `\n自动恢复后重发失败：${message}\n` }],
                true
            );
        } finally {
            isHealingRelayAndCli = false;
        }
    }, HEAL_RESEND_DELAY_MS);
}

/**
 * 取消尚未触发的自愈重发计时器，并释放自愈互斥锁。
 *
 * 用户取消、会话清空、CLI 退出、扩展 deactivate 时调用，防止过期消息被自动
 * 重发出去。
 *
 * @param reason 触发取消的原因，仅用于日志诊断。
 */
function cancelPendingResend(reason: string): void {
    if (pendingResendTimer) {
        clearTimeout(pendingResendTimer);
        pendingResendTimer = undefined;
        isHealingRelayAndCli = false;
        Logger.info(`自愈重发已取消：reason=${reason}`);
    }
}

/**
 * 通过 stream-json CLI 适配器发送用户消息。
 *
 * @param text 用户输入文本。
 */
async function sendUserMessageToCli(text: string): Promise<void> {
    Logger.info(`准备发送 Chat 消息到 CLI：length=${text.length}`);
    chatCliCancelRequested = false;
    activeAssistantMessageId = undefined;
    const assistantMessage = await createActiveAssistantMessage();
    Logger.info(`Chat 已创建 assistant 输出区域：id=${assistantMessage.id}`);
    try {
        await ensureChatCliStarted();
        ensureStreamJsonCliAdapter();
        await streamJsonCliAdapter?.sendUserMessage(text);
        Logger.info('Chat 消息已提交到 stream-json 适配器');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appendAssistantSegments([{ kind: 'error', text: `\n发送到 CLI 失败：${message}\n` }], true);
        throw err;
    }
}

/**
 * 向内置 Chat 追加用户消息并立即发送到 CLI。
 *
 * @param text 用户消息文本。
 */
async function appendUserMessageAndSend(text: string): Promise<void> {
    await openBuiltInChat();
    await appendLocalChatMessage('user', text);
    await sendUserMessageToCli(text);
}

/**
 * 将文本填充到内置 Chat 输入框，供用户编辑后手动发送。
 *
 * @param text 需要填充的文本。
 * @param focus 是否聚焦输入框。
 */
async function fillBuiltInChatComposer(text: string, focus: boolean): Promise<void> {
    await openBuiltInChat();
    await chatViewHost?.postMessage({ type: 'composer/fill', text, focus });
}

/**
 * 订阅 Chat CLI 进程状态变化并把异常状态同步到 Webview。
 *
 * @param context 扩展上下文，用于注册 Disposable。
 */
function registerChatCliStatusHandlers(context: vscode.ExtensionContext): void {
    if (!cliProcess) return;
    context.subscriptions.push(cliProcess.onStatus((status) => {
        void chatViewHost?.postMessage({ type: 'cli/status', status: mapCliStatusForWebview(status) });
    }));
    context.subscriptions.push(cliProcess.onExit((event) => {
        void handleChatCliExit(event).catch((err: unknown) => {
            Logger.error('处理 Chat CLI 退出事件失败', err);
        });
    }));
}

/**
 * 把 CliProcess 内部状态映射为 Webview 协议状态。
 *
 * @param status CLI 内部状态。
 * @returns Webview 可展示状态。
 */
function mapCliStatusForWebview(status: ReturnType<CliProcess['getStatus']>): 'idle' | 'running' | 'exited' | 'error' {
    if (status === 'starting') return 'running';
    return status;
}

/**
 * 处理 Chat CLI 退出：主动取消只更新状态，异常退出则提示并提供一键重启。
 *
 * @param event CLI 退出事件。
 */
async function handleChatCliExit(event: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    const detail = `code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}`;
    if (expectedChatCliExitCount > 0) {
        expectedChatCliExitCount -= 1;
        Logger.info(`忽略主动重启触发的 Chat CLI 退出：${detail}`);
        return;
    }
    clearHttpExpectation('cli_exit');
    cancelPendingResend('cli_exit');
    await chatViewHost?.postMessage({ type: 'cli/status', status: event.code === 0 ? 'exited' : 'error', detail });
    if (chatCliCancelRequested) {
        chatCliCancelRequested = false;
        await finishActiveAssistantMessage();
        return;
    }
    if (event.code === 0) return;
    const restart = '重启 CLI';
    const choice = await vscode.window.showErrorMessage(`Chat CLI 异常退出：${detail}`, restart);
    if (choice === restart) {
        await restartChatCli();
    }
}

/**
 * 添加一条本地内存 Chat 消息并推送到 Webview。
 *
 * @param role 消息角色。
 * @param text 消息文本。
 */
async function appendLocalChatMessage(role: ChatMessage['role'], text: string, segments?: ChatSegment[]): Promise<void> {
    const message: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        // 同时保存原始 text，方便 user 消息重发与前端 fallback 渲染。
        text,
        segments: segments ?? [{ kind: 'markdown', text }],
        createdAt: Date.now()
    };
    chatMessages.push(message);
    schedulePersistChatSession();
    await chatViewHost?.postMessage({ type: 'message/append', message });
}

/**
 * 处理 Webview 的 user/resend 请求。
 *
 * 行为：
 *
 * 1. 在 `chatMessages` 中按 id 定位目标 user 消息；
 * 2. **连同该消息一起**截断到该索引之前，移除其后所有 assistant / user / tool
 *    上下文；
 * 3. 取消当前正在进行的 CLI 请求与自愈重发，并清理 HTTP 预期；
 * 4. 通过 `session/init` 让 Webview 全量重绘到截断后的状态；
 * 5. 用目标消息保存的原始文本作为新一轮 user 消息重新发送（走标准
 *    {@link appendUserMessageAndSend} 链路）。
 *
 * 若目标消息不存在、不是 user 角色或缺少原始文本，则直接放弃并提示。
 *
 * @param id 待重发的消息 id。
 * @param editedText Webview 重发编辑框提交的覆盖文本；为空时使用原消息文本。
 */
async function handleUserResend(id: string, editedText?: string): Promise<void> {
    const index = chatMessages.findIndex((item) => item.id === id);
    if (index < 0) {
        Logger.warn(`收到 user/resend 但目标消息不存在：id=${id}`);
        return;
    }
    const target = chatMessages[index];
    if (target.role !== 'user') {
        Logger.warn(`收到 user/resend 但目标消息不是 user 角色：id=${id}, role=${target.role}`);
        return;
    }
    const promptText = typeof editedText === 'string' && editedText.trim()
        ? editedText
        : typeof target.text === 'string'
            ? target.text
            : extractPlainTextFromSegments(target.segments);
    if (!promptText) {
        Logger.warn(`收到 user/resend 但目标消息缺少原始文本：id=${id}`);
        await chatViewHost?.postMessage({
            type: 'toast',
            level: 'warn',
            text: '无法重发：该消息缺少原始文本'
        });
        return;
    }

    Logger.info(`处理 user/resend：id=${id}, index=${index}, totalBefore=${chatMessages.length}, promptLength=${promptText.length}`);

    // 中断当前正在进行的请求。
    chatCliCancelRequested = true;
    clearHttpExpectation('user_resend');
    cancelPendingResend('user_resend');
    cliProcess?.cancel();

    // 截断：连同目标 user 消息一起删除。
    chatMessages = chatMessages.slice(0, index);
    activeAssistantMessageId = undefined;
    schedulePersistChatSession();
    // 走"局部截断"通知前端只移除该消息及其之后的 DOM 节点，避免
    // 走 session/init 全量重绘导致 scrollTop 先归零再被随后的 append 强拉
    // 到底部，从而产生肉眼可见的"先到顶再到底"闪烁。
    //
    // fromIndex 与 webview 在 appendMessage 时写入的 dataset.index 一一对应：
    // 这里传入的就是被删 user 消息原来的下标，webview 据此找到节点并删除自身
    // 与之后的所有兄弟节点。
    await chatViewHost?.postMessage({
        type: 'messages/truncate',
        fromIndex: index
    });

    // 重发：等价于用户在输入框里又敲了一遍同样的内容回车。
    armHttpExpectation(promptText);
    await appendUserMessageAndSend(promptText);
}

/**
 * 从 ChatSegment 列表里提取纯文本，用于 user 消息缺少 `text` 字段时的兜底。
 *
 * 只关心可能承载 user 输入的 `text` / `markdown` 类型片段；其它类型按 `sourceText`
 * → `text` 顺序回退。
 *
 * @param segments 消息片段数组。
 * @returns 拼接后的纯文本；无可用文本时返回空串。
 */
function extractPlainTextFromSegments(segments: ChatSegment[] | undefined): string {
    if (!Array.isArray(segments) || segments.length === 0) return '';
    const parts: string[] = [];
    for (const segment of segments) {
        if (!segment) continue;
        const text = typeof segment.text === 'string' ? segment.text : typeof segment.sourceText === 'string' ? segment.sourceText : '';
        if (text) parts.push(text);
    }
    return parts.join('\n');
}

/**
 * 追加 assistant 流式片段；若尚无 assistant 消息则先创建 pending 消息。
 *
 * 调用本函数即视为一段 CLI 解析事件被宿主接受并准备投递到 Webview。为方便排查
 * "CLI 已输出但聊天区不渲染" 类问题，进入和发送 postMessage 时均会在 info 级别
 * 打印日志，便于在 OutputChannel 中追踪。
 *
 * 注：token 使用量统计由 CLI 在其最终 `result` 事件中自带，经 stream-json 适配
 * 器解析为 `kind:'usage'` ChatSegment 与 done 同帧到达；本函数无需特殊处理，
 * 按普通 segment 走 patch 即可，统计行天然跟随最后一条消息渲染。
 *
 * @param segments 需要追加的消息片段。
 * @param done 是否标记当前 assistant 消息完成。
 */
async function appendAssistantSegments(segments: ChatSegment[], done: boolean): Promise<void> {
    if (segments.length === 0 && !done) return;
    Logger.info(
        `appendAssistantSegments：incoming=${segments.length}, done=${done}, kinds=${segments.map((s) => s.kind).join(',') || '<none>'}`
    );
    const message = await getActiveAssistantMessageForPatch();
    // 按 segment.id 去重合并：相同 id 的片段视为对同一 segment 的多次更新（典型场景为工具卡片）
    // —— 此时应原地替换已有 segment，而不是追加新条目，以避免重复渲染。
    for (const incoming of segments) {
        rememberExpertToolContext(message.id, incoming);
        if (incoming.id) {
            const existingIndex = message.segments.findIndex((item) => item.id === incoming.id);
            if (existingIndex >= 0) {
                message.segments[existingIndex] = incoming;
                continue;
            }
        }
        message.segments.push(incoming);
    }
    if (done) message.pending = false;
    schedulePersistChatSession();
    Logger.info(
        `appendAssistantSegments → postMessage：id=${message.id}, segments=${segments.length}, pending=${message.pending}`
    );
    await chatViewHost?.postMessage({
        type: 'message/patch',
        id: message.id,
        segments,
        pending: message.pending,
        append: true
    });
}

/**
 * 记录主模型刚发起的 ask_expert 工具卡片上下文。
 *
 * Relay 收到 `/__expert/run` 时，MCP 工具参数里未必包含 parentMessageId/callId；
 * 因此扩展宿主需要在看到主 CLI 的工具卡片 segment 时保存一次上下文，随后由
 * expertHandler 注入给 ExpertRunnerService，确保专家事件能实时挂到正确位置。
 *
 * @param parentMessageId 当前 assistant 消息 id。
 * @param segment 本次 patch 到达的 ChatSegment。
 */
function rememberExpertToolContext(parentMessageId: string, segment: ChatSegment): void {
    const tool = segment.tool;
    if (!segment.id || segment.kind !== 'tool' || !tool) return;
    if (tool.name !== 'mcp__llsExpert__ask_expert' && tool.name !== 'ask_expert') return;
    const callId = segment.id.startsWith('tool:') ? segment.id.slice('tool:'.length) : segment.id;
    pendingExpertToolContext = {
        parentMessageId,
        callId,
        toolSegmentId: segment.id
    };
}

/**
 * 标记当前 assistant 流式消息完成。
 */
async function finishActiveAssistantMessage(): Promise<void> {
    if (!activeAssistantMessageId) return;
    const message = chatMessages.find((item) => item.id === activeAssistantMessageId);
    if (!message) return;
    message.pending = false;
    schedulePersistChatSession();
    await chatViewHost?.postMessage({
        type: 'message/patch',
        id: message.id,
        segments: [],
        pending: false,
        append: true
    });
    activeAssistantMessageId = undefined;
}

/**
 * 创建新的流式 assistant 消息，并把其 ID 保存为当前 CLI 输出目标。
 *
 * @returns 新创建的活动 assistant 消息。
 */
async function createActiveAssistantMessage(): Promise<ChatMessage> {
    const message = buildAssistantMessage();
    chatMessages.push(message);
    activeAssistantMessageId = message.id;
    schedulePersistChatSession();
    await chatViewHost?.postMessage({ type: 'message/append', message });
    return message;
}

/**
 * 获取当前 CLI 输出目标 assistant 消息，丢失时兜底重新创建。
 *
 * 正常情况下该 ID 在点击发送时由 {@link createActiveAssistantMessage} 写入，
 * 后续所有 CLI stdout 解析结果都只 patch 到这个 ID 对应的显示区域。
 *
 * @returns 当前活动 assistant 消息。
 */
async function getActiveAssistantMessageForPatch(): Promise<ChatMessage> {
    if (activeAssistantMessageId) {
        const existing = chatMessages.find((item) => item.id === activeAssistantMessageId);
        if (existing) return existing;
    }
    Logger.warn('Chat assistant 输出目标 ID 丢失，已兜底创建新的 assistant 区域');
    return createActiveAssistantMessage();
}

/**
 * 构造带随机 ID 的 pending assistant 消息对象。
 *
 * @returns 新的 assistant 消息。
 */
function buildAssistantMessage(): ChatMessage {
    return {
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        segments: [],
        pending: true,
        createdAt: Date.now()
    };
}

/**
 * 根据任务状态返回 QuickPick 图标。
 *
 * @param task 任务项。
 * @returns 状态图标。
 */
function getTaskStatusIcon(task: LlsTaskItem): string {
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

/**
 * 等待指定毫秒数。
 *
 * @param ms 等待时长，单位毫秒。
 * @returns 等待完成后的 Promise。
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把任务流提示词复制到剪贴板，聚焦 Claude Code 输入框，并自动执行粘贴。
 *
 * Claude Code 的输入框在 webview 内，VS Code 命令层没有发送入口，因此
 * 粘贴完成后改用「系统级模拟回车」来触发发送（macOS：osascript / AppleScript）。
 */
async function pasteTaskFlowToClaude(): Promise<void> {
    const prompt = buildTaskFlowPrompt();
    await sendTaskFlowPrompt(prompt, { autoSubmit: true });
}

/**
 * 保留的外部 Claude Code 输入框旁路实现。
 *
 * 仅在 taskFlow.target=externalClaudeCode 或内置 Chat 不可用降级时使用。
 * 后续任务 11/稳定期再删除剪贴板、focus 和系统级回车依赖。
 */
async function pasteTaskFlowToExternalClaudeCode(prompt: string): Promise<void> {
    Logger.info('[TaskFlow] 写剪贴板，长度=' + prompt.length);
    await vscode.env.clipboard.writeText(prompt);

    Logger.info('[TaskFlow] 调用 claude-vscode.focus 聚焦输入框');
    try {
        await vscode.commands.executeCommand('claude-vscode.focus');
    } catch (err) {
        Logger.error('[TaskFlow] claude-vscode.focus 调用失败：' + asMessage(err));
    }

    await delay(500);

    Logger.info('[TaskFlow] 调用 editor.action.clipboardPasteAction 粘贴');
    try {
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    } catch (err) {
        Logger.error('[TaskFlow] 粘贴命令调用失败：' + asMessage(err));
    }

    // 等输入框完成粘贴渲染。
    await delay(300);

    // 用系统级模拟回车触发发送（webview 输入框 VS Code 命令层无法触发）。
    await simulateEnterKeyAtSystemLevel();
}

/**
 * 把错误对象转成字符串消息，便于日志输出。
 *
 * @param err 任意错误。
 */
function asMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * 在操作系统层面模拟一次回车按键，用于让 Claude Code 的 webview 输入框真正发送。
 *
 * - macOS：通过 `osascript` 调用 System Events 的 `key code 36`（Return）。
 *   首次执行需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权 VS Code。
 * - Windows：通过 PowerShell 的 `System.Windows.Forms.SendKeys` 向前台窗口发送 `{ENTER}`，
 *   无需额外授权。
 * - 其它平台：暂不实现，仅写日志返回。
 */
async function simulateEnterKeyAtSystemLevel(): Promise<void> {
    if (process.platform === 'darwin') {
        await simulateEnterOnMac();
        return;
    }
    if (process.platform === 'win32') {
        await simulateEnterOnWindows();
        return;
    }
    Logger.info('[TaskFlow] 当前平台暂不支持系统级模拟回车，platform=' + process.platform);
}

/**
 * macOS 平台：使用 osascript 模拟一次回车键。
 *
 * 首次调用会触发系统辅助功能授权弹窗，授权后即可直接生效。
 */
async function simulateEnterOnMac(): Promise<void> {
    try {
        const { spawn } = await import('child_process');
        const script = 'tell application "System Events" to key code 36';
        Logger.info('[TaskFlow] macOS：调用 osascript 模拟回车 (key code 36)');
        await new Promise<void>((resolve, reject) => {
            const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error('osascript 退出码=' + code));
                }
            });
        });
        Logger.info('[TaskFlow] macOS：osascript 模拟回车完成');
    } catch (err) {
        Logger.error('[TaskFlow] macOS：系统级模拟回车失败：' + asMessage(err));
    }
}

/**
 * Windows 平台：使用 PowerShell SendKeys 模拟一次回车键。
 *
 * 通过加载 System.Windows.Forms 程序集后调用 `SendKeys::SendWait("{ENTER}")`，
 * 该方法把按键发送到当前前台窗口，无需额外授权。
 */
async function simulateEnterOnWindows(): Promise<void> {
    try {
        const { spawn } = await import('child_process');
        const script = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")';
        Logger.info('[TaskFlow] Windows：调用 PowerShell SendKeys 模拟回车 ({ENTER})');
        await new Promise<void>((resolve, reject) => {
            const child = spawn(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', script],
                { stdio: 'ignore', windowsHide: true }
            );
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error('powershell 退出码=' + code));
                }
            });
        });
        Logger.info('[TaskFlow] Windows：PowerShell SendKeys 模拟回车完成');
    } catch (err) {
        Logger.error('[TaskFlow] Windows：系统级模拟回车失败：' + asMessage(err));
    }
}

/**
 * 在 Claude Code 输入框中执行一次"测试模拟回车"流程。
 *
 * 用于在全局设置面板里验证当前平台是否能成功触发自动发送：
 * 1. 把测试文本写入剪贴板；
 * 2. 聚焦 Claude Code 输入框；
 * 3. 粘贴；
 * 4. 调用系统级模拟回车。
 *
 * 全过程不会修改任何用户配置；执行完成后会以信息提示提醒用户去 Claude Code 面板查看效果。
 */
async function runSimulateEnterTest(): Promise<void> {
    const testPrompt = 'CC任务流：模拟回车测试 (' + new Date().toISOString() + ')';
    Logger.info('[TaskFlow][Test] 开始模拟回车测试，文本=' + testPrompt);

    await vscode.env.clipboard.writeText(testPrompt);

    try {
        await vscode.commands.executeCommand('claude-vscode.focus');
    } catch (err) {
        Logger.error('[TaskFlow][Test] claude-vscode.focus 调用失败：' + asMessage(err));
    }

    await delay(500);

    try {
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    } catch (err) {
        Logger.error('[TaskFlow][Test] 粘贴命令调用失败：' + asMessage(err));
    }

    await delay(300);
    await simulateEnterKeyAtSystemLevel();

    await showSimulateEnterResultHint();
}

/**
 * 模拟回车测试结束后展示的弹窗文案集合，按 UI 语言取值。
 */
interface SimulateEnterHintTexts {
    /** macOS 平台提示信息（包含未自动发送时的引导）。 */
    macHint: string;
    /** macOS 平台弹窗上"打开辅助功能设置"按钮文字。 */
    macOpenAccessibilityButton: string;
    /** 其它平台（Windows / Linux）的通用提示信息。 */
    genericHint: string;
}

/**
 * 模拟回车测试弹窗文案字典，未补全语言回落英文。
 */
const SIMULATE_ENTER_HINT_TEXTS: Record<ResolvedAppLanguage, SimulateEnterHintTexts> = {
    en: {
        macHint: 'Simulated Enter test executed. If the message was not sent automatically, open "System Settings → Privacy & Security → Accessibility" and enable "Allow Visual Studio Code to control your computer", then try again.',
        macOpenAccessibilityButton: 'Open Accessibility Settings',
        genericHint: 'Simulated Enter test executed. Please check whether the Claude Code input box was sent automatically (see the "LLS CCAI" output channel for details).'
    },
    'zh-cn': {
        macHint: '已尝试"模拟回车"测试。如果未自动发送，请到「系统设置 → 隐私与安全性 → 辅助功能」中把 Visual Studio Code 的"允许控制电脑"权限打开后重试。',
        macOpenAccessibilityButton: '打开辅助功能设置',
        genericHint: '已尝试"模拟回车"测试，请查看 Claude Code 输入框是否已自动发送（若未发送，请检查输出面板「LLS CCAI」中的日志）。'
    },
    'zh-tw': {
        macHint: '已嘗試「模擬回車」測試。若未自動發送，請到「系統設定 → 隱私權與安全性 → 輔助使用」中啟用 Visual Studio Code 的「允許控制電腦」權限後重試。',
        macOpenAccessibilityButton: '開啟輔助使用設定',
        genericHint: '已嘗試「模擬回車」測試，請查看 Claude Code 輸入框是否已自動發送（若未發送，請檢查輸出面板「LLS CCAI」中的日誌）。'
    },
    ko: {
        macHint: '"엔터 키 시뮬레이션" 테스트를 실행했습니다. 자동으로 전송되지 않은 경우 "시스템 설정 → 개인 정보 보호 및 보안 → 손쉬운 사용"에서 Visual Studio Code의 "컴퓨터 제어 허용" 권한을 활성화한 후 다시 시도하세요.',
        macOpenAccessibilityButton: '손쉬운 사용 설정 열기',
        genericHint: '"엔터 키 시뮬레이션" 테스트를 실행했습니다. Claude Code 입력창이 자동으로 전송되었는지 확인하세요 (자세한 내용은 "LLS CCAI" 출력 채널 참조).'
    },
    ja: {
        macHint: '「Enter キーの模擬送信」テストを実行しました。自動送信されなかった場合は「システム設定 → プライバシーとセキュリティ → アクセシビリティ」で Visual Studio Code の「コンピュータの制御を許可」を有効にしてから再度お試しください。',
        macOpenAccessibilityButton: 'アクセシビリティ設定を開く',
        genericHint: '「Enter キーの模擬送信」テストを実行しました。Claude Code の入力欄が自動送信されたかご確認ください（詳細は出力パネル「LLS CCAI」をご覧ください）。'
    },
    fr: {
        macHint: 'Test "Entrée simulée" exécuté. Si le message n\'a pas été envoyé automatiquement, ouvrez « Réglages système → Confidentialité et sécurité → Accessibilité » et activez « Autoriser Visual Studio Code à contrôler votre ordinateur », puis réessayez.',
        macOpenAccessibilityButton: 'Ouvrir les réglages d\'accessibilité',
        genericHint: 'Test "Entrée simulée" exécuté. Vérifiez si la zone de saisie de Claude Code a été envoyée automatiquement (voir le canal de sortie « LLS CCAI » pour plus de détails).'
    },
    de: {
        macHint: 'Test "Simulierte Eingabetaste" ausgeführt. Wenn die Nachricht nicht automatisch gesendet wurde, öffnen Sie „Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen" und aktivieren Sie „Visual Studio Code darf den Computer steuern", und versuchen Sie es erneut.',
        macOpenAccessibilityButton: 'Bedienungshilfen-Einstellungen öffnen',
        genericHint: 'Test "Simulierte Eingabetaste" ausgeführt. Bitte prüfen Sie, ob das Claude-Code-Eingabefeld automatisch gesendet wurde (siehe Ausgabekanal „LLS CCAI" für Details).'
    }
};

/**
 * 根据当前 UI 语言读取模拟回车测试弹窗的本地化文案。
 *
 * 如果当前 configManager 还未就绪，或语言不在字典中，回落到英文。
 */
function getSimulateEnterHintTexts(): SimulateEnterHintTexts {
    const language: ResolvedAppLanguage = configManager?.getResolvedUiLanguage() ?? 'en';
    return SIMULATE_ENTER_HINT_TEXTS[language] ?? SIMULATE_ENTER_HINT_TEXTS.en;
}

/**
 * 在模拟回车测试结束后给出"未自动发送时如何处理"的提示。
 *
 * - macOS：提示用户去「系统设置 → 隐私与安全性 → 辅助功能」勾选 VS Code，
 *   并提供「打开辅助功能设置」按钮，点击后会用系统 URL 直接跳到该面板。
 * - Windows：无需授权，只给一句通用提示。
 * - 其它平台：只给一句通用提示。
 *
 * 所有提示文本会根据当前 UI 语言设置（claudeCodeConfigHelper.language）本地化。
 */
async function showSimulateEnterResultHint(): Promise<void> {
    const texts = getSimulateEnterHintTexts();

    if (process.platform === 'darwin') {
        const action = await vscode.window.showInformationMessage(
            texts.macHint,
            texts.macOpenAccessibilityButton
        );
        if (action === texts.macOpenAccessibilityButton) {
            try {
                await vscode.env.openExternal(
                    vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
                );
            } catch (err) {
                Logger.error('[TaskFlow][Test] 打开辅助功能设置失败：' + asMessage(err));
            }
        }
        return;
    }

    void vscode.window.showInformationMessage(texts.genericHint);
}

/**
 * VS Code 扩展激活函数。
 *
 * 激活后会初始化设置页、任务流服务、本地 HTTP 中转服务、settings.json 写入闭环与命令入口。
 *
 * @param context 扩展上下文，由 VS Code 注入。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    Logger.init(context);
    Logger.info('LLS CCAI 已激活');
    extensionContext = context;
    restorePersistedChatSession();
    await applyClaudeCodeInitialPermissionMode();
    configManager = new ConfigManager(context);
    chatCliConfigService = new ChatCliConfigService(configManager);
    cliResolver = new CliResolver(chatCliConfigService);
    cliProcess = new CliProcess();
    chatCliSessionStore = new ChatCliSessionStore();
    chatViewHost = new ChatViewHost(context);
    llsTaskService = new LlsTaskService(configManager);
    autoContinueScheduler = new AutoContinueScheduler(llsTaskService);
    // 注入 submitter：续推时直接走内置 Chat → CLI 链路，绕开剪贴板 /
    // claude-vscode.focus / 系统级模拟回车。同时让续推提示词作为一条 user
    // 消息在 Chat UI 上正常显示，避免"无声续推"。
    AutoContinueScheduler.setSubmitter(async (text) => {
        await appendUserMessageAndSend(text);
    });
    configViewProvider = new ConfigWebviewViewProvider(context, configManager);
    settingsWriter = new SettingsWriter();
    relayServer = new RelayServer({ desiredPort: 0 });
    const debugRecorder = new DebugRecorder();
    // 装配「专家模式」组合根：ExpertRunnerService 持有 chatCliConfigService +
    // chatViewHost，对外暴露 run() 给 relay 路由调用；并产出一次性鉴权 token
    // 同步注入到 ChatCliConfigService（写到 expertMcpServer 子进程的 env）和
    // RelayRouter（用于 `/__expert/run` 入口校验）。
    const expertRunnerService = new ExpertRunnerService(chatCliConfigService, chatViewHost);
    expertRunnerServiceRef = expertRunnerService;
    // 注：token 使用量统计由 CLI 自己在最终 `result` 事件中携带（usage / modelUsage），
    // 经 stream-json 适配器解析为 `kind:'usage'` ChatSegment 与最后一条消息同帧到达，
    // 因此 Relay 侧不再单独上报 usage，三个 proxy 的 usageSink 参数保持 undefined。
    relayServer.setHandler(createRelayRouter({
        configManager,
        llsTaskService,
        autoContinueScheduler,
        adapters: [
            new AnthropicProxyAdapter(debugRecorder, { configManager, llsTaskService, autoContinueScheduler }),
            new OpenAIChatProxyAdapter(debugRecorder, { configManager, llsTaskService, autoContinueScheduler }),
            new OpenAIResponsesProxyAdapter(debugRecorder, { configManager, llsTaskService, autoContinueScheduler })
        ],
        expertHandler: {
            authToken: expertRunnerService.getAuthToken(),
            run: (body, signal) =>
                expertRunnerService.run({
                    args: {
                        question: body.question,
                        context: body.context,
                        goal: body.goal,
                        constraints: body.constraints,
                        toolSegmentId: body.toolSegmentId
                    },
                    parentMessageId: body.parentMessageId ?? pendingExpertToolContext?.parentMessageId,
                    callId: body.callId ?? pendingExpertToolContext?.callId,
                    toolSegmentId: body.toolSegmentId ?? pendingExpertToolContext?.toolSegmentId,
                    signal
                })
        }
    }));
    relayServer.setOnHit(() => clearHttpExpectation('relay_hit'));
    void cleanupLegacyRelaySettingsSafely();

    context.subscriptions.push(configManager);
    context.subscriptions.push(cliProcess);
    context.subscriptions.push(chatViewHost);
    context.subscriptions.push(llsTaskService);
    context.subscriptions.push(llsTaskService.onDidChange(() => {
        void postChatTaskFlowStatus();
    }));
    context.subscriptions.push(relayServer);
    context.subscriptions.push(
        configViewProvider,
        vscode.window.registerWebviewViewProvider(PROVIDERS_VIEW_ID, configViewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.window.registerWebviewViewProvider(CHAT_SECONDARY_VIEW_ID, chatViewHost, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    registerChatCliStatusHandlers(context);

    // ConfigManager 变化：刷新配置视图，并清理历史 Relay 托管设置。
    context.subscriptions.push(
        configManager.onDidChange(() => {
            void cleanupLegacyRelaySettingsSafely();
            void syncClaudeCliModelSettingsSafely();
            void postChatModelOptions().catch((err: unknown) => {
                Logger.warn(`刷新 Chat 模型列表失败：${err instanceof Error ? err.message : String(err)}`);
            });
            void postChatExpertModelOptions().catch((err: unknown) => {
                Logger.warn(`刷新 Chat 专家模型列表失败：${err instanceof Error ? err.message : String(err)}`);
            });
        })
    );

    // LLS CCAI 独立 UI 语言配置变化：通知配置页刷新，不读取或写入 openapicopilot.language。
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration('claudeCodeConfigHelper.language') ||
                event.affectsConfiguration('claudeCodeConfigHelper.chat.cliPath') ||
                event.affectsConfiguration('claudeCodeConfigHelper.chat.permissionMode')
            ) {
                configManager?.notifyChanged();
                if (event.affectsConfiguration('claudeCodeConfigHelper.language')) {
                    void postChatUiLanguage().catch((err: unknown) => {
                        Logger.warn(`刷新 Chat 界面语言失败：${err instanceof Error ? err.message : String(err)}`);
                    });
                }
                void postChatPermissionMode().catch((err: unknown) => {
                    Logger.warn(`刷新 Chat 权限模式失败：${err instanceof Error ? err.message : String(err)}`);
                });
            }
        })
    );

    // Chat Webview 发回扩展宿主的基础消息。
    context.subscriptions.push(
        chatViewHost.onDidReceiveMessage((message) => {
            if (message.type === 'webview/ready') {
                Logger.show();
                Logger.info('收到 Chat Webview ready，准备刷新默认上下文文件');
            }
            void handleChatWebviewMessage(message).catch((err: unknown) => {
                const text = err instanceof Error ? err.message : String(err);
                Logger.error(`处理 Chat Webview 消息失败：${text}`);
                void chatViewHost?.postMessage({ type: 'message/error', error: text });
            });
        })
    );

    // Webview 可能在监听器注册前已经发送 ready，注册完成后再延迟刷新一次作为兜底。
    setTimeout(() => {
        Logger.info('Chat 默认上下文文件延迟兜底刷新');
        void postActiveEditorAttachmentToChat().catch((err: unknown) => {
            Logger.warn(`延迟刷新 Chat 默认上下文文件失败：${err instanceof Error ? err.message : String(err)}`);
        });
    }, 300);

    // 当前活动编辑器变化时，刷新 Chat 输入框默认上下文文件。
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((_editor) => {
            void postActiveEditorAttachmentToChat().catch((err: unknown) => {
                Logger.warn(`刷新 Chat 默认上下文文件失败：${err instanceof Error ? err.message : String(err)}`);
            });
        })
    );

    // 当前活动编辑器选区变化时，按 Claude Code 方式同步行号/选区上下文。
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor !== vscode.window.activeTextEditor) return;
            const uri = event.textEditor.document.uri;
            if (uri.scheme === 'comment' || uri.scheme === 'output') return;
            Logger.info(`检测到活动编辑器选区变化：${uri.toString()} ${JSON.stringify(serializeSelection(event.textEditor.selection))}`);
            void postActiveEditorAttachmentToChat().catch((err: unknown) => {
                Logger.warn(`刷新 Chat 默认选区上下文失败：${err instanceof Error ? err.message : String(err)}`);
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.openConfigPanel, async () => {
            await configViewProvider?.focus();
        }),
        vscode.commands.registerCommand(COMMANDS.openSettingsJson, async () => {
            await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }),
        vscode.commands.registerCommand(COMMANDS.openGlobalSharedSettings, () => {
            if (!configManager) return;
            SharedOpenApiCopilotSettingsPanel.show(context, configManager, 'global');
        }),
        vscode.commands.registerCommand(COMMANDS.openWorkspaceSharedSettings, () => {
            if (!configManager) return;
            SharedOpenApiCopilotSettingsPanel.show(context, configManager, 'workspace');
        }),
        vscode.commands.registerCommand(COMMANDS.reloadWindow, async () => {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }),
        vscode.commands.registerCommand(COMMANDS.chatOpen, async () => {
            try {
                await openBuiltInChat();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                Logger.error(`打开内置 Chat 失败：${message}`);
                await vscode.window.showErrorMessage(`打开内置 Chat 失败：${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.chatSelectCli, async () => {
            try {
                await selectChatCli();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                Logger.error(`选择 Chat CLI 失败：${message}`);
                await vscode.window.showErrorMessage(`选择 Chat CLI 失败：${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.chatRestart, async () => {
            try {
                await restartChatCli();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                Logger.error(`重启 Chat CLI 失败：${message}`);
                await vscode.window.showErrorMessage(`重启 Chat CLI 失败：${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.refreshProviders, () => undefined),
        vscode.commands.registerCommand(COMMANDS.newProvider, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.editProviderItem, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.deleteProviderItem, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.setCurrentModel, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.clearCurrentModel, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.pasteTaskFlowToClaude, async () => {
            try {
                await pasteTaskFlowToClaude();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await vscode.window.showErrorMessage(`粘贴任务流到 Claude Code 失败：${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskOpenMenu, async () => {
            await openLlsCcaiTaskMenu();
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskShowProgress, async () => {
            await showLlsCcaiTaskProgress();
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskContinue, async () => {
            await continueLlsCcaiTask();
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskClear, () => {
            clearLlsCcaiTask();
        }),
        vscode.commands.registerCommand(COMMANDS.testSimulateEnter, async () => {
            try {
                await runSimulateEnterTest();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await vscode.window.showErrorMessage(`模拟回车测试失败：${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.exportConfig, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.importConfig, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel))
    );

    void autoOpenBuiltInChatIfCliConfigured();

}

/**
 * VS Code 扩展停用函数。
 *
 * 停用时释放 Chat、任务流服务、Webview Provider 与 ConfigManager。
 */
export function deactivate(): void {
    void flushPersistedChatSession();
    clearHttpExpectation('deactivate');
    cancelPendingResend('deactivate');
    autoContinueScheduler?.cancel('扩展停用');
    autoContinueScheduler = undefined;
    relayServer?.dispose();
    relayServer = undefined;
    streamJsonCliAdapterSubscription?.dispose();
    streamJsonCliAdapterSubscription = undefined;
    streamJsonCliAdapter?.dispose();
    streamJsonCliAdapter = undefined;
    cliProcess?.dispose();
    cliProcess = undefined;
    chatViewHost?.dispose();
    chatViewHost = undefined;
    cliResolver = undefined;
    chatCliConfigService = undefined;
    expertRunnerServiceRef = undefined;
    configViewProvider?.dispose();
    configViewProvider = undefined;
    llsTaskService?.dispose();
    llsTaskService = undefined;
    configManager?.dispose();
    configManager = undefined;
    extensionContext = undefined;
    settingsWriter = undefined;
}
