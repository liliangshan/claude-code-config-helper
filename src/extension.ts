/** @file 扩展入口：接入内置 Chat Webview、任务流服务与配置视图。 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';

import { StreamJsonCliAdapter, type ParsedCliEvent, type ToolPermissionRequestEvent } from './chat/cli/cliAdapter';
import { createBrowserToolRelayHandler, BROWSER_TOOL_RELAY_PORT_ENV } from './browserTools/httpBridge';
import { BROWSER_MCP_SERVER_NAME } from './browserTools/tools';
import { ChatCliConfigService } from './chat/cli/cliConfig';
import type { ChatCliConfig } from './chat/cli/types';
import { CliProcess } from './chat/cli/cliProcess';
import { CliResolver } from './chat/cli/cliResolver';
import { ChatCliSessionStore } from './chat/cli/sessionStore';
import { ChatViewHost } from './chat/chatViewHost';
import {
    startsWithExpertPrefix,
    stripExpertPrefix
} from './expertMode/expertTriggers';
import { resolvePlanDoneRoutingAction } from './chat/routing/planReviewWorkflow';
import { parsePlanReviewToken } from './chat/routing/planReviewHandoff';
import type { ChatComposerAttachment, ChatMessage, ChatModelOption, ChatQuickPermissionMode, ChatRoutedModelSelection, ChatRoute, ChatSegment, ChatUiLanguage, LlsTaskSnapshotPayload, WebviewToExtension, SessionListItem } from './chat/protocol';
import { ConfigManager } from './configManager';
import {
    CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY,
    CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY,
    CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY,
    CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY,
    CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY,
    CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY,
    CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY,
    CHAT_EXPERT_MODE_PROJECT_MODEL_KEY,
    CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY,
    CHAT_PLAN_MODE_GLOBAL_MODEL_KEY,
    CHAT_PLAN_MODE_PROJECT_ENABLED_KEY,
    CHAT_PLAN_MODE_PROJECT_MODEL_KEY,
    CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY,
    CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY,
    CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY,
    CHAT_REVIEW_MODE_PROJECT_MODEL_KEY,
    CHAT_SECONDARY_VIEW_ID,
    COMMANDS,
    CONFIG_NAMESPACE,
    PROVIDERS_VIEW_ID
} from './constants';
import type { ChatCacheTtl } from './constants';
import { readCompactionConfigFromVscode, readPlanConfigFromVscode, readReviewConfigFromVscode, readExpertSubturnOptions } from './expertMode/expertConfig';
import { EditorAutoOpener, extractFilePathFromToolInput } from './editorAutoOpen';
import { ExpertSubturnService } from './expertMode/expertSubturnService';
import { Logger } from './logger';
import { AutoContinueScheduler } from './llsTask/autoContinue';
import { getLlsCcaiTaskTexts } from './llsTask/messages';
import { pasteToClaudeCode } from './llsTask/paster';
import { LlsTaskService } from './llsTask/service';
import { TaskFlowStore } from './llsTask/store';
import type { LlsTaskItem } from './llsTask/types';
import { createVscodeToolRelayHandler, VSCODE_TOOL_RELAY_PORT_ENV } from './vscodeTools/httpBridge';
import { VSCODE_MCP_SERVER_NAME } from './vscodeTools/tools';
import { AnthropicProxyAdapter } from './relay/anthropicProxy';
import { DebugRecorder } from './relay/debugRecorder';
import { OpenAIChatProxyAdapter } from './relay/openaiChatProxy';
import { OpenAIResponsesProxyAdapter } from './relay/openaiResponsesProxy';
import { createRelayRouter } from './relay/router';
import { RelayServer } from './relay/server';
import { TokenBudgetService, type CompactionState } from './relay/tokenBudget/service';
import type { UpstreamTimeoutKind } from './relay/upstreamTimeouts';
import type { UsageSink } from './relay/usageReporter';
import { SettingsWriter } from './settingsWriter';
import type { ResolvedAppLanguage, ProviderConfigWithoutSecrets, ModelConfig } from './types';
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

/** 恢复出未完成任务流后，待 Chat 首次 ready 时弹一次恢复对话框的标志。 */
let pendingRestorePrompt = false;

/** 模块级本地 HTTP 中转服务实例，一个扩展宿主/工作区使用一个随机空闲端口。 */
let relayServer: RelayServer | undefined;

/** 模块级 ExpertSubturnService 实例（按需专家方案）。 */
let expertSubturnService: ExpertSubturnService | undefined;

/** 模块级 Chat CLI 配置服务实例。 */
let chatCliConfigService: ChatCliConfigService | undefined;

/** 模块级 Chat CLI 路径解析器实例。 */
let cliResolver: CliResolver | undefined;

/**
 * 模块级 Chat CLI 长连接进程实例（普通任务模型 / dispatcher）。
 *
 * 双 CLI 路由方案下，dispatcher 承担轻量工程操作（编译、打包、git、PR、上下文压缩），
 * 遇到复杂任务必须以 `@llsExpert` 文本切路由触发 expertCliProcess。
 */
let normalCliProcess: CliProcess | undefined;

/**
 * 模块级 Chat CLI 长连接进程实例（专家任务模型）。
 *
 * 仅在 `expertMode.enabled === true` 且选中了具体专家模型时启动；
 * 由 `activeRoute` 切到 `'expert'` 后承接真正的复杂任务。未配置时为 undefined，
 * 用户主动以 `@llsExpert` 触发时会被识别为「专家未配置」并提示。
 */
let expertCliProcess: CliProcess | undefined;

/** 模块级 Chat CLI 长连接进程实例（方案任务模型，按需启动）。 */
let planCliProcess: CliProcess | undefined;

/** 模块级 Chat CLI 长连接进程实例（审查任务模型，按需启动）。 */
let reviewCliProcess: CliProcess | undefined;

/** 模块级 Chat CLI session_id 项目持久化存储。 */
let chatCliSessionStore: ChatCliSessionStore | undefined;

/**
 * 模块级 Chat CLI stream-json 协议适配器实例（normal CLI 对应）。
 *
 * 由 `rebuildNormalAdapter` 在每次 normal CLI 启动 / 重启后重建；
 * 其上的 ParsedCliEvent 流是 `@llsExpert` 自动路由检测的输入源。
 */
let normalStreamJsonAdapter: StreamJsonCliAdapter | undefined;

/**
 * 模块级 Chat CLI stream-json 协议适配器实例（expert CLI 对应）。
 *
 * 由 `rebuildExpertAdapter` 在 expert CLI 启动 / 重启后重建；
 * 其上的事件不参与 `@llsExpert` 路由检测，避免循环触发。
 */
let expertStreamJsonAdapter: StreamJsonCliAdapter | undefined;

/** 模块级 Chat CLI stream-json 协议适配器实例（plan CLI 对应）。 */
let planStreamJsonAdapter: StreamJsonCliAdapter | undefined;

/** 模块级 Chat CLI stream-json 协议适配器实例（review CLI 对应）。 */
let reviewStreamJsonAdapter: StreamJsonCliAdapter | undefined;

/** normal CLI 适配器事件订阅。 */
let streamJsonCliAdapterSubscription: vscode.Disposable | undefined;

/** expert CLI 适配器事件订阅。 */
let expertStreamJsonAdapterSubscription: vscode.Disposable | undefined;

/** plan CLI 适配器事件订阅。 */
let planStreamJsonAdapterSubscription: vscode.Disposable | undefined;

/** review CLI 适配器事件订阅。 */
let reviewStreamJsonAdapterSubscription: vscode.Disposable | undefined;

/** normal CLI 进程状态订阅。 */
let normalCliStatusSubscription: vscode.Disposable | undefined;

/** normal CLI 进程退出订阅。 */
let normalCliExitSubscription: vscode.Disposable | undefined;

/** expert CLI 进程状态订阅。 */
let expertCliStatusSubscription: vscode.Disposable | undefined;

/** expert CLI 进程退出订阅。 */
let expertCliExitSubscription: vscode.Disposable | undefined;

/** plan CLI 进程状态订阅。 */
let planCliStatusSubscription: vscode.Disposable | undefined;

/** plan CLI 进程退出订阅。 */
let planCliExitSubscription: vscode.Disposable | undefined;

/** review CLI 进程状态订阅。 */
let reviewCliStatusSubscription: vscode.Disposable | undefined;

/** review CLI 进程退出订阅。 */
let reviewCliExitSubscription: vscode.Disposable | undefined;

/** plan CLI 按需启动配置缓存。 */
let planLaunchConfigCache: ChatCliConfig | undefined;

/** review CLI 按需启动配置缓存。 */
let reviewLaunchConfigCache: ChatCliConfig | undefined;

/** plan CLI 闲置释放计时器。 */
let planIdleDisposeTimer: NodeJS.Timeout | undefined;

/** review CLI 闲置释放计时器。 */
let reviewIdleDisposeTimer: NodeJS.Timeout | undefined;

/** plan/review workflow 结束后保留进程的闲置窗口。 */
const PLAN_REVIEW_IDLE_DISPOSE_MS = 10 * 60 * 1000;

/** 模块级 Chat WebviewPanel 宿主实例。 */
let chatViewHost: ChatViewHost | undefined;

/** 模块级 TokenBudgetService 实例，用于 CLI usage segment 回填 contextWindow。 */
let tokenBudgetServiceRef: TokenBudgetService | undefined;

/** 模块级 Chat 内存消息列表，任务 4 阶段用于 Webview reload 恢复。 */
let chatMessages: ChatMessage[] = [];

/** Chat 会话 workspaceState 持久化键。 */
const CHAT_SESSION_STATE_KEY = 'claudeRouter.chat.session.v1';

/** Chat 会话隐私提示是否已经展示的 workspaceState 键。 */
const CHAT_SESSION_PRIVACY_NOTICE_KEY = 'claudeRouter.chat.sessionPrivacyNotice.v1';

/** 最多持久化的 Chat 消息数量，避免 workspaceState 过大。 */
const MAX_PERSISTED_CHAT_MESSAGES = 80;

/**
 * 内存中保留的 Chat 消息上限。
 *
 * 之前只对持久化做 80 条截断，但内存里的 `chatMessages` 数组从未裁剪——长会话
 * 中 segments 越累越多，导致 {@link appendAssistantSegments} 中按 id 查找 segment
 * 的 O(n) 扫描逐渐变慢。这里设置一个略大于持久化窗口的内存窗口（160 条），
 * 保留比持久化更长的最近上下文以兼顾"用户向上翻看"的体验，同时确保内存有界。
 *
 * 注：裁剪只发生在新增消息之后，且必须同步处理 {@link activeAssistantMessageId}
 * 是否被裁掉的情况，避免后续 segment patch 找不到目标消息。
 */
const MAX_IN_MEMORY_CHAT_MESSAGES = 160;

/**
 * 按窗口大小裁剪内存 `chatMessages` 数组。
 *
 * 仅在数组长度超出 {@link MAX_IN_MEMORY_CHAT_MESSAGES} 时生效；裁掉的是数组
 * 前段（最早的消息），并同步检查 {@link activeAssistantMessageId} 是否落在被裁
 * 区间——若是则一并清空，避免后续 {@link getActiveAssistantMessageForPatch}
 * 在内存里找不到对应消息时无谓地兜底创建新区域。
 */
function trimInMemoryChatMessages(): void {
    if (chatMessages.length <= MAX_IN_MEMORY_CHAT_MESSAGES) return;
    const dropCount = chatMessages.length - MAX_IN_MEMORY_CHAT_MESSAGES;
    const dropped = chatMessages.splice(0, dropCount);
    if (activeAssistantMessageId && dropped.some((item) => item.id === activeAssistantMessageId)) {
        Logger.info(`内存 chatMessages 裁剪丢弃了当前活动 assistant 消息：id=${activeAssistantMessageId}`);
        activeAssistantMessageId = undefined;
    }
    Logger.info(`内存 chatMessages 已裁剪：dropped=${dropCount}, remaining=${chatMessages.length}`);
}

/** Webview 粘贴/拖放二进制文件写入的临时目录名。 */
const CHAT_UPLOAD_TEMP_DIR = 'lls-ccai-chat-uploads';

/** 单个 Webview 上传文件允许的最大大小，避免异常剪贴板内容撑爆扩展进程。 */
const MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Chat 会话持久化防抖定时器。 */
let chatSessionPersistTimer: NodeJS.Timeout | undefined;

/** 当前正在接收流式输出的 assistant 消息 ID。 */
let activeAssistantMessageId: string | undefined;

/** 最近一次 Chat CLI 是否由用户主动取消，用于避免误报异常退出。 */
let chatCliCancelRequested = false;

/**
 * expert CLI 是否正在执行任务（已发起 user 消息且尚未收到本轮 done/error）。
 *
 * 自动交棒后置为 true；expert 本轮结束后置为 false。下一条用户消息抵达时如果
 * expert 已闲置，则把 activeRoute 自动回退到 normal，避免长期锁定在专家。
 */
let expertBusy = false;
let planBusy = false;
let reviewBusy = false;

/** normal CLI 是否正在执行任务（已发起 user 消息且尚未收到本轮 done/error）。 */
let normalBusy = false;
let normalRelayActiveCount = 0;
let expertRelayActiveCount = 0;
let planRelayActiveCount = 0;
let reviewRelayActiveCount = 0;

/** 按 CLI 来源累计当前一轮 assistant 文本，用于 done 时记录最终回复与检测专家交棒。 */
const assistantTurnTextBySource: Record<ChatRoute, string> = { normal: '', expert: '', plan: '', review: '' };

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
const HEAL_RESEND_DELAY_MS = 2_000;

/** 上游转发卡死后自动续发的固定英文提示。 */
const UPSTREAM_TIMEOUT_CONTINUE_PROMPT = 'Continue';

/** 上游超时自动续发最小间隔，避免多个请求同时超时时重复发送。 */
const UPSTREAM_TIMEOUT_CONTINUE_COOLDOWN_MS = 30_000;

/** 最近一次上游超时自动续发时间戳。 */
let lastUpstreamTimeoutContinueAt = 0;

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
 * 启动时把 Claude Code 初始权限模式设置为 `bypassPermissions`。
 *
 * - 将 `claudeCode.initialPermissionMode` 写入 Workspace 配置，使新启动的 CLI
 *   直接跳过工具调用的人工确认环节，避免每次新会话都要再次授权。
 * - 失败时只记录日志，不抛出，避免阻断扩展激活流程。
 *
 * 注意：函数名与日志输出保持与实际写入值（`bypassPermissions`）一致，
 * 避免历史上"名为 acceptEdits 实写 bypassPermissions"的误导。
 */
async function applyClaudeCodeInitialPermissionMode(): Promise<void> {
    try {
        await vscode.workspace.getConfiguration('claudeCode')
            .update('initialPermissionMode', 'bypassPermissions', vscode.ConfigurationTarget.Workspace);
        Logger.info('Claude Code initialPermissionMode 已设置为 bypassPermissions');
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
        return existing;
    }
    return relayServer.start();
}

/**
 * 获取（或惰性创建）模块级 ExpertSubturnService 单例。
 *
 * 该服务在第一次需要时按需创建，并把 Relay 端口、专家模型 id 与 sub-turn 配置
 * 作为闭包依赖项注入。后续 dispose 在 deactivate 中统一处理。
 */
function getOrCreateExpertSubturnService(): ExpertSubturnService {
    if (!expertSubturnService) {
        expertSubturnService = new ExpertSubturnService({
            getRelayPort: () => relayServer?.getActualPort(),
            getExpertModel: () => readEffectiveExpertModelSelection().modelId,
            getOptions: () => readExpertSubturnOptions(),
            getAuthToken: () => 'claude-code-relay'
        });
    }
    return expertSubturnService;
}

/**
 * 处理用户级 @llsExpert / /expert 前缀触发的专家 sub-turn。
 *
 * 按需专家方案下，用户主动触发的专家请求不再走常驻 expert CLI，而是直接调用
 * {@link ExpertSubturnService.run}：
 *
 * - 失败 / 专家未配置：渲染一段错误说明，并提示用户回到 normal 路由继续。
 * - 成功：根据 `chat.expert.userTriggerMode` 决定是否回写主 CLI（tool_result 模式）
 *   或直接以 assistant segments 展示给用户（direct 模式）。
 *
 * @param question 已剥除前缀的纯净问题文本。
 * @param options.hidden 是否抑制 assistant 区域创建（保持沉默执行）。
 */
async function runUserTriggeredExpertSubturn(
    question: string,
    options: { hidden?: boolean }
): Promise<void> {
    await ensureRelayServerStarted();
    const service = getOrCreateExpertSubturnService();
    const triggerMode = readExpertSubturnOptions().userTriggerMode;
    const result = await service.run({ question });

    if (!result.ok) {
        if (!options.hidden) {
            await appendAssistantSegments(
                [{ kind: 'error', text: `\n专家请求失败（${result.failureReason ?? 'error'}）：${result.text}\n` }],
                true
            );
        }
        return;
    }

    if (triggerMode === 'tool_result' && normalStreamJsonAdapter) {
        // tool_result 模式：把专家回答以 user role 的 tool_result 注入主 CLI，
        // 让主模型自行整合并续写最终答复。
        const toolUseId = `expert-user-${Date.now()}`;
        await normalStreamJsonAdapter.sendUserMessage(
            `[expert advisory] ${result.text}`
        );
        void toolUseId;
        return;
    }

    if (!options.hidden) {
        await appendAssistantSegments(
            [{ kind: 'markdown', text: result.text }],
            true
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
 * 按「项目 > 全局 > 关闭」规则读取方案模型下拉框当前值。
 */
function readEffectiveCompactionModelSelection(): ChatRoutedModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
    if (globalEnabled === false) return { enabled: false, modelId: '' };
    if (globalEnabled === true && globalModel.length > 0) return { enabled: true, modelId: globalModel };
    if (globalModel.length > 0) return { enabled: true, modelId: globalModel };
    return { enabled: false, modelId: '' };
}

function readEffectivePlanModelSelection(): ChatRoutedModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_PLAN_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_PLAN_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_PLAN_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
    if (globalEnabled === false) return { enabled: false, modelId: '' };
    if (globalEnabled === true && globalModel.length > 0) return { enabled: true, modelId: globalModel };
    if (globalModel.length > 0) return { enabled: true, modelId: globalModel };
    return { enabled: false, modelId: '' };
}

/**
 * 按「项目 > 全局 > 关闭」规则读取审查模型下拉框当前值。
 */
function readEffectiveReviewModelSelection(): ChatRoutedModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_REVIEW_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
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
 * 保存方案模型下拉框选择，并同步写入项目配置与全局配置。
 *
 * @param modelId 方案模型 ID；空字符串表示关闭方案。
 */
async function savePlanModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_PLAN_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_PLAN_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_PLAN_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
    configManager?.notifyChanged();
}

async function saveCompactionModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
    configManager?.notifyChanged();
}

/**
 * 保存审查模型下拉框选择，并同步写入项目配置与全局配置。
 *
 * @param modelId 审查模型 ID；空字符串表示关闭审查。
 */
async function saveReviewModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_REVIEW_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
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
        autoContinueScheduler?.resetMissingToolCounter('清空已完成任务流');
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
        autoContinueScheduler?.resetMissingToolCounter('用户清空运行中任务流');
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

/**
 * Chat 首次 ready 时，按需弹一次任务流恢复对话框。
 *
 * 仅当 {@link pendingRestorePrompt} 为真且当前确有未完成任务流时下发
 * taskFlow/restorePrompt；下发后立即清标志，保证整个会话只弹一次。
 */
async function maybePostTaskFlowRestorePrompt(): Promise<void> {
    if (!pendingRestorePrompt) return;
    pendingRestorePrompt = false;
    const service = llsTaskService;
    if (!service || !service.hasActiveWorkflow()) return;
    const workflow = service.getSnapshot().workflow;
    if (!workflow) return;
    const completed = workflow.tasks.filter((task) => task.status === 'completed').length;
    await chatViewHost?.postMessage({
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
async function handleTaskFlowRestoreChoice(choice: 'continue' | 'clear' | 'dismiss'): Promise<void> {
    if (choice === 'continue') {
        if (!llsTaskService) return;
        try {
            autoContinueScheduler?.cancel('用户从恢复对话框继续任务流');
            const prompt = llsTaskService.buildContinuePrompt();
            await appendUserMessageAndSend(prompt);
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            Logger.error(`[LlsTask] 恢复继续任务流失败：${text}`);
            await chatViewHost?.postMessage({ type: 'toast', level: 'error', text });
        }
        return;
    }
    if (choice === 'clear') {
        autoContinueScheduler?.resetMissingToolCounter('用户从恢复对话框清除任务流');
        clearLlsCcaiTask();
    }
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
            text: message.text,
            pending: !!message.pending,
            route: message.route === 'expert' || message.route === 'normal' || message.route === 'plan' || message.route === 'review' ? message.route : undefined,
            modelLabel: typeof message.modelLabel === 'string' && message.modelLabel.trim() ? message.modelLabel : undefined,
            createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now()
        }));
}

/**
 * 读取 Claude Code 原始 JSONL 会话文件并转换为 ChatMessage 数组。
 *
 * 只处理 user / assistant 类型的记录；忽略 isSidechain=true 记录和纯 tool_result 的 user 消息。
 */
async function parseSessionJsonl(jsonlPath: string): Promise<ChatMessage[]> {
    let raw: string;
    try {
        raw = await fs.readFile(jsonlPath, 'utf8');
    } catch (e) {
        Logger.warn(`[parseSessionJsonl] 读取文件失败：path=${jsonlPath} err=${e instanceof Error ? e.message : String(e)}`);
        return [];
    }

    const lines = raw.split('\n');
    const messages: ChatMessage[] = [];
    let skippedSidechain = 0;
    let skippedType = 0;
    let skippedNoContent = 0;
    let skippedEmptyUser = 0;
    let skippedEmptyAssistant = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(trimmed); } catch { continue; }

        if (rec['isSidechain']) { skippedSidechain++; continue; }
        const recType = rec['type'] as string;
        if (recType !== 'user' && recType !== 'assistant') { skippedType++; continue; }

        const msg = rec['message'] as {
            role?: string;
            content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }>;
            model?: string;
        } | undefined;
        if (!msg || !Array.isArray(msg.content)) { skippedNoContent++; continue; }

        const ts = typeof rec['timestamp'] === 'string' ? new Date(rec['timestamp'] as string).getTime() : Date.now();
        const uuid = typeof rec['uuid'] === 'string' ? rec['uuid'] as string : `hist_${Date.now()}_${messages.length}`;

        if (recType === 'user') {
            const textItems = msg.content.filter(c => c.type === 'text' && c.text);
            if (textItems.length === 0) { skippedEmptyUser++; continue; }
            const text = textItems.map(c => c.text!).join('\n');
            messages.push({ id: uuid, role: 'user', segments: [{ kind: 'text', text }], text, createdAt: ts });
        } else {
            const segments: ChatSegment[] = [];
            for (const c of msg.content) {
                if (c.type === 'text' && c.text) {
                    segments.push({ kind: 'markdown', text: c.text });
                } else if (c.type === 'tool_use' && c.name) {
                    const inputStr = c.input ? JSON.stringify(c.input, null, 2) : '';
                    segments.push({
                        id: c.id,
                        kind: 'tool',
                        tool: { name: c.name, status: 'success', summary: c.name, detail: inputStr, input: c.input }
                    });
                }
            }
            if (segments.length === 0) { skippedEmptyAssistant++; continue; }
            messages.push({ id: uuid, role: 'assistant', segments, modelLabel: msg.model, createdAt: ts });
        }
    }

    Logger.info(`[parseSessionJsonl] path=${jsonlPath} totalLines=${lines.length} parsed=${messages.length} skip{sidechain=${skippedSidechain},type=${skippedType},noContent=${skippedNoContent},emptyUser=${skippedEmptyUser},emptyAssistant=${skippedEmptyAssistant}}`);
    return messages.slice(-MAX_IN_MEMORY_CHAT_MESSAGES);
}

/**
 * 推导 Claude Code 会话存储目录：`<configDir>/projects/<encodedCwd>`。
 *
 * 编码规则与 Claude Code 官方一致：把 cwd 中所有非 [a-zA-Z0-9] 字符替换为
 * `-`。该规则同时覆盖 POSIX 的 `/`、`.` 与 Windows 的 `:`、`\`，因此跨平台
 * 都能命中官方生成的目录名。注意不要做长度截断——官方不截断，截断会导致
 * 深路径（尤其 Windows 长路径）算出错误目录名。
 *
 * @param cwd 工作区目录绝对路径。
 * @returns 该工作区对应的 projects 子目录绝对路径。
 */
function resolveClaudeProjectDir(cwd: string): string {
    const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
    const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(configDir, 'projects', encodedCwd);
}

/**
 * 从 JSONL 会话文件中提取会话标题。
 *
 * 优先级：customTitle > aiTitle > lastPrompt > summary。
 * 仅读取文件首尾各 64KB，避免大文件全量读入。
 *
 * @param jsonlPath JSONL 会话文件绝对路径。
 * @returns 会话标题；未找到时返回空字符串。
 */
async function extractSessionTitle(jsonlPath: string): Promise<string> {
    const BUF_SIZE = 65536;
    try {
        const fh = await fs.open(jsonlPath, 'r');
        try {
            const st = await fh.stat();
            const buf = Buffer.allocUnsafe(BUF_SIZE);
            const r1 = await fh.read(buf, 0, BUF_SIZE, 0);
            if (r1.bytesRead === 0) return '';
            const head = buf.toString('utf8', 0, r1.bytesRead);
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
            return (
                extract(tail, 'customTitle') ?? extract(head, 'customTitle') ??
                extract(tail, 'aiTitle') ?? extract(head, 'aiTitle') ??
                extract(tail, 'lastPrompt') ?? extract(tail, 'summary') ??
                extract(head, 'summary') ?? ''
            );
        } finally { await fh.close(); }
    } catch {
        return '';
    }
}

/**
 * 提取指定 session 的标题并推送到 Chat Webview 顶部。
 *
 * 新会话尚未生成 aiTitle 时标题为空，Webview 端会回退到默认标题。
 *
 * @param cwd 工作区目录，用于推导 projectKey。
 * @param sessionId 目标会话 ID。
 */
async function pushSessionTitleToWebview(cwd: string, sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
        const jsonlPath = path.join(resolveClaudeProjectDir(cwd), `${sessionId}.jsonl`);
        const title = await extractSessionTitle(jsonlPath);
        await chatViewHost?.postMessage({ type: 'session/title', title, sessionId });
    } catch (e) {
        Logger.warn('[session/title] 推送会话标题失败：' + (e instanceof Error ? e.message : String(e)));
    }
}

/**
 * 把用户内联编辑的会话标题写回 JSONL，并刷新 Webview 顶部标题。
 *
 * 标题以独立的 `{type:"custom-title", customTitle, sessionId}` 元记录持久化：
 * 文件中已存在该记录时原地替换，否则追加到文件末尾。`customTitle` 在
 * extractSessionTitle 中优先级最高，因此写回后会立即成为展示标题。传入空标题
 * 表示清除自定义标题：删除已有 custom-title 记录，回退到自动派生标题。
 *
 * @param cwd 工作区目录，用于推导 projectKey。
 * @param sessionId 目标会话 ID。
 * @param title 新标题；空字符串表示清除自定义标题。
 */
async function writeSessionCustomTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    if (!sessionId) return;
    const jsonlPath = path.join(resolveClaudeProjectDir(cwd), `${sessionId}.jsonl`);
    let raw: string;
    try {
        raw = await fs.readFile(jsonlPath, 'utf8');
    } catch (e) {
        Logger.warn('[session/set-title] 读取会话文件失败：' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    const trimmedTitle = (title || '').trim();
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    // 过滤掉已有 custom-title 记录，稍后按需重新追加，确保最终只保留一条。
    const kept: string[] = [];
    for (const line of lines) {
        if (!line.trim()) { kept.push(line); continue; }
        let isCustomTitle = false;
        try { isCustomTitle = (JSON.parse(line) as { type?: string }).type === 'custom-title'; } catch { isCustomTitle = false; }
        if (!isCustomTitle) kept.push(line);
    }
    // 去掉尾部空行，避免重复追加后留下多余空白。
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    if (trimmedTitle) {
        kept.push(JSON.stringify({ type: 'custom-title', customTitle: trimmedTitle, sessionId }));
    }
    try {
        await fs.writeFile(jsonlPath, kept.join(eol) + eol, 'utf8');
    } catch (e) {
        Logger.warn('[session/set-title] 写回会话文件失败：' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    await pushSessionTitleToWebview(cwd, sessionId);
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
    if (!cliResolver || !chatCliConfigService || !normalCliProcess) return;
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
    if (!normalCliProcess || !chatCliConfigService) return;
    chatCliCancelRequested = false;
    await startChatCliFromCurrentConfig({ forceRestart: true });
    if (!options.silent) {
        await showChatToast('success', 'Chat CLI 长连接已重启。');
    }
}

async function restartChatRelayAndCli(options: { silent?: boolean } = {}): Promise<void> {
    if (!normalCliProcess || !chatCliConfigService || !relayServer) return;
    chatCliCancelRequested = false;
    clearHttpExpectation('manual_restart');
    cancelPendingResend('manual_restart');

    const oldPort = relayServer.getActualPort();
    void appendAssistantSegments(
        [{
            kind: 'markdown',
            text: `\n> 正在停止本地中转 HTTP 服务${typeof oldPort === 'number' ? `（旧端口 ${oldPort}）` : ''}…\n`
        }],
        false
    );
    try {
        await relayServer.stop();
        Logger.info(`手动重启：Relay 已停止${typeof oldPort === 'number' ? `（旧端口 ${oldPort}）` : ''}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`手动重启：Relay 停止失败：${message}`);
        void appendAssistantSegments(
            [{ kind: 'error', text: `\n本地中转 HTTP 服务停止失败：${message}\n` }],
            false
        );
        throw err;
    }

    void appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在停止 Claude CLI 子进程…\n' }],
        false
    );
    try {
        await stopChatCliPair();
        Logger.info('手动重启：Chat CLI pair 已停止');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`手动重启：Chat CLI 停止失败：${message}`);
        void appendAssistantSegments(
            [{ kind: 'error', text: `\nClaude CLI 停止失败：${message}\n` }],
            false
        );
        throw err;
    }

    void appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在启动本地中转 HTTP 服务…\n' }],
        false
    );
    try {
        const newPort = await ensureRelayServerStarted();
        Logger.info(`手动重启：Relay 已启动，新端口=${newPort}`);
        void appendAssistantSegments(
            [{ kind: 'markdown', text: `\n> 本地中转 HTTP 服务已启动：http://127.0.0.1:${newPort}\n` }],
            false
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`手动重启：Relay 启动失败：${message}`);
        void appendAssistantSegments(
            [{ kind: 'error', text: `\n本地中转 HTTP 服务启动失败：${message}\n` }],
            false
        );
        throw err;
    }

    void appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在启动 Claude CLI 子进程…\n' }],
        false
    );
    try {
        await startChatCliFromCurrentConfig({ forceRestart: true });
        Logger.info('手动重启：Chat CLI 已启动完成');
        void appendAssistantSegments(
            [{ kind: 'markdown', text: '\n> Claude CLI 已重启完成\n' }],
            false
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`手动重启：Chat CLI 启动失败：${message}`);
        void appendAssistantSegments(
            [{ kind: 'error', text: `\nClaude CLI 启动失败：${message}\n` }],
            false
        );
        throw err;
    }

    if (!options.silent) {
        await showChatToast('success', '本地中转与 Chat CLI 已重启。');
    }
}

/**
 * 确保 Chat CLI 路径可用且长连接进程处于运行状态。
 *
 * @throws 用户取消选择、路径无效或启动失败时抛出错误。
 */
async function ensureChatCliStarted(): Promise<void> {
    if (!cliResolver || !chatCliConfigService || !normalCliProcess) {
        throw new Error('Chat CLI 组件尚未初始化');
    }
    const cliPath = await cliResolver.resolveOrPrompt();
    if (!cliPath) throw new Error('用户取消了 Claude CLI 路径选择');
    await startChatCliFromCurrentConfig();
}

/**
 * 同步返回当前已知的 CLI session_id（不发起任何异步读取）。
 *
 * Relay usageSink 在每次响应结束时会被同步调用，需要立即拿到当前 sessionId 才能
 * 把 usage 报到对应的 TokenBudgetService 桶里。此处实现策略：
 *   1) 优先读模块级缓存 lastKnownChatCliSessionId（CLI session/init 事件写入）；
 *   2) 退化时返回空串——由调用方自己跳过登记。
 *
 * @returns sessionId 字符串；未知时返回空串。
 */
function currentChatCliSessionIdSync(): string {
    return getSessionIdForRoute(activeRoute);
}

/** 模块级缓存：最近一次 normal CLI session/init 拿到的 session_id，供 usageSink 同步读取。 */
let lastKnownChatCliSessionId = '';

/** 模块级缓存：最近一次 expert CLI session/init 拿到的 session_id，供 usageSink 同步读取。 */
let lastKnownExpertChatCliSessionId = '';

/** 模块级缓存：最近一次 plan CLI session/init 拿到的 session_id，供 usageSink 同步读取。 */
let lastKnownPlanChatCliSessionId = '';

/** 模块级缓存：最近一次 review CLI session/init 拿到的 session_id，供 usageSink 同步读取。 */
let lastKnownReviewChatCliSessionId = '';

function isAnyRouteBusy(): boolean {
    return normalBusy || expertBusy || planBusy || reviewBusy;
}

function setRelayRouteBusy(route: ChatRoute, busy: boolean, reason: string): void {
    let activeCount: number;
    let currentBusy: boolean;
    if (route === 'expert') {
        expertRelayActiveCount = Math.max(0, expertRelayActiveCount + (busy ? 1 : -1));
        expertBusy = expertRelayActiveCount > 0;
        activeCount = expertRelayActiveCount;
        currentBusy = expertBusy;
    } else if (route === 'plan') {
        planRelayActiveCount = Math.max(0, planRelayActiveCount + (busy ? 1 : -1));
        planBusy = planRelayActiveCount > 0;
        activeCount = planRelayActiveCount;
        currentBusy = planBusy;
    } else if (route === 'review') {
        reviewRelayActiveCount = Math.max(0, reviewRelayActiveCount + (busy ? 1 : -1));
        reviewBusy = reviewRelayActiveCount > 0;
        activeCount = reviewRelayActiveCount;
        currentBusy = reviewBusy;
    } else {
        normalRelayActiveCount = Math.max(0, normalRelayActiveCount + (busy ? 1 : -1));
        normalBusy = normalRelayActiveCount > 0;
        activeCount = normalRelayActiveCount;
        currentBusy = normalBusy;
    }
    Logger.info(`Chat CLI 执行状态(${route})：${currentBusy ? '执行中' : '空闲'}，reason=${reason}, active=${activeCount}`);
    void chatViewHost?.postMessage({ type: 'chat/running', running: isAnyRouteBusy(), route });
}

function getCliProcessForRoute(route: ChatRoute): CliProcess | undefined {
    switch (route) {
        case 'expert': return expertCliProcess;
        case 'plan': return planCliProcess;
        case 'review': return reviewCliProcess;
        case 'normal':
        default: return normalCliProcess;
    }
}

function getStreamAdapterForRoute(route: ChatRoute): StreamJsonCliAdapter | undefined {
    switch (route) {
        case 'expert': return expertStreamJsonAdapter;
        case 'plan': return planStreamJsonAdapter;
        case 'review': return reviewStreamJsonAdapter;
        case 'normal':
        default: return normalStreamJsonAdapter;
    }
}

function getSessionIdForRoute(route: ChatRoute): string {
    switch (route) {
        case 'expert': return lastKnownExpertChatCliSessionId;
        case 'plan': return lastKnownPlanChatCliSessionId;
        case 'review': return lastKnownReviewChatCliSessionId;
        case 'normal':
        default: return lastKnownChatCliSessionId;
    }
}

function isRouteBusy(route: ChatRoute): boolean {
    switch (route) {
        case 'expert': return expertBusy;
        case 'plan': return planBusy;
        case 'review': return reviewBusy;
        case 'normal':
        default: return normalBusy;
    }
}

function resetRouteBusy(route: ChatRoute): void {
    if (route === 'expert') {
        expertRelayActiveCount = 0;
        expertBusy = false;
    } else if (route === 'plan') {
        planRelayActiveCount = 0;
        planBusy = false;
    } else if (route === 'review') {
        reviewRelayActiveCount = 0;
        reviewBusy = false;
    } else {
        normalRelayActiveCount = 0;
        normalBusy = false;
    }
    void chatViewHost?.postMessage({ type: 'chat/running', running: isAnyRouteBusy(), route });
}

function resetAllRouteBusy(): void {
    resetRouteBusy('normal');
    resetRouteBusy('expert');
    resetRouteBusy('plan');
    resetRouteBusy('review');
}

function cancelRouteProcess(route: ChatRoute): void {
    getCliProcessForRoute(route)?.cancel();
    resetRouteBusy(route);
}

/** session_id 到 CLI 路由的内存映射，用于 token budget 压缩时选中正确 resetter。 */
const chatSessionRouteById = new Map<string, ChatRoute>();

/** 需要静默吞掉的内部 CLI 响应轮数，按路由分别统计。 */
const hiddenCliResponseTurnsByRoute: Record<ChatRoute, number> = { normal: 0, expert: 0, plan: 0, review: 0 };

/** 当前用户消息应发送到的 Chat CLI 路由。 */
let activeRoute: ChatRoute = 'normal';

/** plan/review 自动编排状态。 */
interface PlanReviewWorkflowState {
    /** 当前是否存在正在进行的 plan/review workflow。 */
    active: boolean;
    /** 用户最初要求规划/设计的任务。 */
    originalUserTask: string;
    /** 最近一次 plan CLI 输出。 */
    latestPlanText: string;
    /** 最近一次 review CLI 输出。 */
    latestReviewText: string;
    /** 已执行的修订次数。 */
    revisionCount: number;
    /** 自动修订最大次数。 */
    maxRevisions: number;
}

/** 当前 plan/review 自动编排状态。 */
let planReviewWorkflowState: PlanReviewWorkflowState | undefined;

/** plan/review 自动修订最大轮次。 */
const PLAN_REVIEW_MAX_REVISIONS = 3;

// 按需专家方案下，用户级 @llsExpert / /expert 触发前缀的识别 / 剥除函数集中在
// src/expertMode/expertTriggers.ts；这里仅复用导入。

function formatLogPreview(text: string, limit = 1000): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function getSegmentLogText(segment: ChatSegment): string {
    if (segment.kind === 'usage' || segment.kind === 'tool' || segment.kind === 'permission' || segment.kind === 'task' || segment.kind === 'image') {
        return '';
    }
    return typeof segment.text === 'string'
        ? segment.text
        : typeof segment.sourceText === 'string'
            ? segment.sourceText
            : '';
}

function findModelDisplayName(modelId: string): string {
    if (!configManager || !modelId) return modelId;
    for (const provider of configManager.listProviders()) {
        const model = provider.models.find((item) => item.modelId === modelId || `${provider.id}/${item.modelId}` === modelId);
        if (model) return model.displayName || model.modelId;
    }
    return modelId;
}

function getModelLabelForRoute(route: ChatRoute): string {
    if (!configManager) return '';
    if (route === 'normal') {
        const current = configManager.getCurrentModel();
        return current ? findModelDisplayName(`${current.providerId}/${current.modelId}`) : '';
    }
    if (route === 'expert') {
        const current = readEffectiveExpertModelSelection();
        return current.enabled ? findModelDisplayName(current.modelId) : '';
    }
    if (route === 'plan') {
        const current = readEffectivePlanModelSelection();
        return current.enabled ? findModelDisplayName(current.modelId) : '';
    }
    const current = readEffectiveReviewModelSelection();
    return current.enabled ? findModelDisplayName(current.modelId) : '';
}

/** 切换当前 Chat 路由并通知 Webview。 */
async function switchChatRoute(route: ChatRoute, reason: string): Promise<void> {
    if (activeRoute === route) return;
    activeRoute = route;
    Logger.info(`[chat-route] switched to ${route}: reason=${reason}`);
    await chatViewHost?.postMessage({ type: 'route/changed', route });
}

/** normal CLI 输出包含 @llsExpert 时把下一条用户消息切到 expert。 */
async function switchRouteToExpert(reason: string): Promise<void> {
    await switchChatRoute('expert', reason);
}

/**
 * 从 dispatcher 文本中提取 `@llsExpert` 标记后面的正文。
 *
 * 取标记后的剩余字符串，trim 后作为要交棒给专家的指令；标记前的内容（normal 模型
 * 自己的铺垫语）一并丢弃，避免把 dispatcher 的解释作为专家输入。
 */
function extractHandoffInstruction(text: string): string {
    const match = text.match(/@llsExpert\b\s*/i);
    if (!match || match.index === undefined) return '';
    return text.slice(match.index + match[0].length).trim();
}

async function handleFinalAssistantText(source: ChatRoute, finalText: string): Promise<boolean> {
    if (!finalText) return false;
    Logger.info(`模型最终回复(${source})：${formatLogPreview(finalText)}`);
    if (source === 'normal') {
        const expertHandled = await watchNormalForExpertHandoff(finalText);
        const planHandled = await watchNormalForPlanHandoff(finalText);
        return expertHandled || planHandled;
    }
    if (source === 'plan') {
        await handlePlanDone(finalText);
        return false;
    }
    if (source === 'review') {
        await handleReviewDone(finalText);
        return false;
    }
    return false;
}

/** 从 normal CLI 最终回复文本中检测专家移交标记，命中则自动交棒到 expert CLI。 */
async function watchNormalForExpertHandoff(text: string): Promise<boolean> {
    // 按需专家方案下 dispatcher 输出的文本标记已废弃，专家完全由 ask_expert MCP 工具触发。
    // 该函数保留为 no-op，仅为减小本次改造的爆炸半径；后续可在删除 watchNormalForExpertHandoff 调用点后移除。
    void text;
    return false;

    const instruction = extractHandoffInstruction(text);
    cancelRouteProcess('normal');

    await switchRouteToExpert('normal-replied-handoff');

    if (!instruction) {
        await showChatToast('warn', '检测到 @llsExpert 移交标记，但未抓取到指令文本，已切换路由，等待你的下一条消息。');
        return true;
    }
    if (!getStreamAdapterForRoute('expert')) {
        await appendAssistantSegments([
            { kind: 'error', text: '\n检测到 @llsExpert 移交标记，但未配置专家模型，无法继续。\n' }
        ], true);
        await switchChatRoute('normal', 'expert-not-configured');
        return true;
    }

    Logger.info(`检测到 @llsExpert，自动交棒给 expert Chat CLI：instructionLength=${instruction.length}`);
    await showChatToast('info', '已检测到 @llsExpert，正在把任务交给专家模型…');
    try {
        await sendUserMessageToCli(instruction, { hidden: true, forceRoute: 'expert' });
    } catch (err) {
        Logger.error('自动交棒到专家 CLI 失败', err);
    }
    return true;
}

/** 从 normal CLI 最终回复文本中检测 plan/review 编排标记。 */
async function watchNormalForPlanHandoff(text: string): Promise<boolean> {
    const match = parsePlanReviewToken(text);
    if (!match) return false;
    if (match.token === '@llsPlanTask') {
        await handleNormalPlanTask(match.tail);
        return true;
    }
    if (match.token === '@llsPlanReview') {
        await handleNormalPlanReview();
        return true;
    }
    if (match.token === '@llsPlanRevise') {
        await handleNormalPlanRevise(match.tail);
        return true;
    }
    if (match.token === '@llsPlanDone') {
        await handleNormalPlanDone();
        return true;
    }
    if (match.token === '@llsPlanApproved') {
        finishPlanReviewWorkflow('normal-plan-approved');
        await switchChatRoute('normal', 'plan-approved');
        return false;
    }
    return false;
}

/** 处理 normal 发起的 plan 任务移交。 */
async function handleNormalPlanTask(instruction: string): Promise<void> {
    cancelRouteProcess('normal');
    if (!instruction) {
        await showChatToast('warn', '检测到 @llsPlanTask，但未抓取到方案任务描述。');
        return;
    }
    planReviewWorkflowState = {
        active: true,
        originalUserTask: instruction,
        latestPlanText: '',
        latestReviewText: '',
        revisionCount: 0,
        maxRevisions: PLAN_REVIEW_MAX_REVISIONS
    };
    try {
        await ensurePlanCliStarted();
        await switchChatRoute('plan', 'normal-plan-handoff');
        await sendUserMessageToCli(instruction, { hidden: true, forceRoute: 'plan' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`启动 plan CLI 或发送方案任务失败：${message}`);
        finishPlanReviewWorkflow('plan-lazy-start-failed');
        await switchChatRoute('normal', 'plan-lazy-start-failed');
        await appendAssistantSegments([{ kind: 'error', text: `\n方案模型不可用：${message}\n` }], true);
    }
}

/** 处理 normal 认为方案已完成：审查模型存在时先强制进入 review。 */
async function handleNormalPlanDone(): Promise<void> {
    const state = planReviewWorkflowState;
    if (resolvePlanDoneRoutingAction(state, readEffectiveReviewModelSelection().enabled) === 'review') {
        Logger.info('检测到 @llsPlanDone 且审查模型已配置，直接交给 review CLI 审查方案文档');
        await handleNormalPlanReview();
        return;
    }
    finishPlanReviewWorkflow('normal-plan-done');
    await switchChatRoute('normal', 'plan-done');
}

/** 处理 normal 要求 review 审查最近方案。 */
async function handleNormalPlanReview(): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active || !state.latestPlanText) {
        await appendAssistantSegments([{ kind: 'error', text: '\n没有可审查的方案输出。\n' }], true);
        return;
    }
    try {
        await ensureReviewCliStarted();
        const prompt = buildReviewPrompt(state);
        await switchChatRoute('review', 'normal-review-handoff');
        await sendUserMessageToCli(prompt, { hidden: true, forceRoute: 'review' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.warn(`review CLI 不可用，结束方案流程：${message}`);
        await sendPlanReviewCallbackToNormal([
            'The review model is unavailable, so finish the plan workflow without review.',
            '',
            `<plan_output>\n${state.latestPlanText}\n</plan_output>`,
            '',
            'Reply with @llsPlanDone followed by a concise user-facing summary.'
        ].join('\n'));
    }
}

/** 处理 normal 要求 plan 根据 review 意见修订。 */
async function handleNormalPlanRevise(feedback: string): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active || !state.latestPlanText) {
        await appendAssistantSegments([{ kind: 'error', text: '\n没有可修订的方案输出。\n' }], true);
        return;
    }
    if (state.revisionCount >= state.maxRevisions) {
        finishPlanReviewWorkflow('max-revisions');
        await switchChatRoute('normal', 'plan-max-revisions');
        await appendAssistantSegments([{ kind: 'markdown', text: '\n方案审查修订次数已达上限，请确认是否继续下一轮修订。\n' }], true);
        return;
    }
    state.revisionCount += 1;
    try {
        await ensurePlanCliStarted();
        await switchChatRoute('plan', 'normal-plan-revise');
        await sendUserMessageToCli(buildPlanRevisionPrompt(state, feedback), { hidden: true, forceRoute: 'plan' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`发送方案修订任务失败：${message}`);
        finishPlanReviewWorkflow('plan-revise-failed');
        await switchChatRoute('normal', 'plan-revise-failed');
        await appendAssistantSegments([{ kind: 'error', text: `\n方案模型修订不可用：${message}\n` }], true);
    }
}

/** 处理 plan CLI 完成本轮方案输出。 */
async function handlePlanDone(finalText: string): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active) return;
    state.latestPlanText = finalText;
    await sendPlanReviewCallbackToNormal([
        'The plan model has completed the following plan for the user\'s request.',
        '',
        `<original_user_task>\n${state.originalUserTask}\n</original_user_task>`,
        '',
        `<plan_output>\n${finalText}\n</plan_output>`,
        '',
        'Decide the next orchestration step:',
        '- If review is enabled, reply only with @llsPlanReview.',
        '- If review is disabled, reply with @llsPlanDone followed by a concise user-facing summary.',
        '- Do not implement the plan.'
    ].join('\n'));
}

/** 处理 review CLI 完成本轮审查输出。 */
async function handleReviewDone(finalText: string): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active) return;
    state.latestReviewText = finalText;
    await sendPlanReviewCallbackToNormal([
        'The review model has reviewed the latest plan.',
        '',
        `<plan_output>\n${state.latestPlanText}\n</plan_output>`,
        '',
        `<review_output>\n${finalText}\n</review_output>`,
        '',
        'Decide the next orchestration step:',
        `- If the review verdict is CHANGES_REQUESTED and revisionCount (${state.revisionCount}) < maxRevisions (${state.maxRevisions}), reply only with @llsPlanRevise followed by the required changes.`,
        '- If the review verdict is APPROVED, reply with @llsPlanApproved followed by a concise user-facing summary.',
        '- If revisionCount has reached maxRevisions, stop the loop and ask the user whether to continue.'
    ].join('\n'));
}

/** 构造 review CLI 审查 prompt。 */
function buildReviewPrompt(state: PlanReviewWorkflowState): string {
    return [
        'Review the following plan for the user\'s original request.',
        '',
        `<original_user_task>\n${state.originalUserTask}\n</original_user_task>`,
        '',
        `<plan_output>\n${state.latestPlanText}\n</plan_output>`
    ].join('\n');
}

/** 构造 plan CLI 修订 prompt。 */
function buildPlanRevisionPrompt(state: PlanReviewWorkflowState, feedback: string): string {
    return [
        'Revise the previous plan according to the review feedback.',
        '',
        `<original_user_task>\n${state.originalUserTask}\n</original_user_task>`,
        '',
        `<previous_plan>\n${state.latestPlanText}\n</previous_plan>`,
        '',
        `<review_feedback>\n${feedback || state.latestReviewText}\n</review_feedback>`,
        '',
        'Return only the revised plan content.'
    ].join('\n');
}

/** 把 plan/review 完成结果回调给 normal 编排器。 */
async function sendPlanReviewCallbackToNormal(prompt: string): Promise<void> {
    await switchChatRoute('normal', 'plan-review-callback');
    await sendUserMessageToCli(prompt, { hidden: true, suppressResponse: true, forceRoute: 'normal' });
}

/** 结束 plan/review workflow 并安排闲置回收。 */
function finishPlanReviewWorkflow(reason: string): void {
    planReviewWorkflowState = undefined;
    schedulePlanReviewIdleDispose(reason);
}

/** 根据旧 sessionId 找到触发 token 压缩的 CLI 路由。 */
function resolveRouteForSessionId(sessionId: string | undefined): ChatRoute {
    if (!sessionId) return activeRoute;
    return chatSessionRouteById.get(sessionId) ?? activeRoute;
}

/**
 * 按当前配置启动 Chat CLI 长连接进程（双 CLI 路由：normal + expert）。
 *
 * 内部委托 {@link startChatCliPair}：normal CLI 总是启动，expert CLI 仅在
 * `expertMode.enabled === true` 且选中了具体专家模型时启动；专家未配置时
 * 会显式 dispose 旧 expert 实例与适配器，避免遗留旧的环境变量。
 *
 * 保留本函数名是为了让 token budget 自愈、selectChatCli 等老调用点维持原 API；
 * 新增代码请直接调用 {@link startChatCliPair}。
 *
 * @throws 配置无效或子进程启动失败时抛出错误。
 */
async function startChatCliFromCurrentConfig(options: { forceRestart?: boolean } = {}): Promise<void> {
    await startChatCliPair(options);
}

/**
 * 同时启动 normal / expert 两条 Chat CLI 长连接，并重建对应的 stream-json 适配器。
 *
 * 关键差异：
 * - normal CLI 总是启动；其 `--append-system-prompt` 来自
 *   {@link ChatCliConfigService.getDualConfigsWithRelayEnv} 的 dispatcher 默认文案
 *   或用户配置 `chat.dispatcher.appendSystemPrompt` 覆盖值。
 * - expert CLI 仅在 expertMode.enabled === true 且选中具体模型时启动；未配置时
 *   会显式 stop / dispose 旧 expert 实例，避免上一次启动残留。
 * - 两条 CLI 使用各自的 sessionStore kind（'normal' / 'expert'），互不覆盖；
 *   token budget 自动压缩按 sessionId 分桶，自然不串流。
 *
 * @param options.forceRestart 为 true 时即使配置未变也强制重启。
 * @throws Chat CLI 组件未初始化时抛出错误。
 */
async function startChatCliPair(options: { forceRestart?: boolean } = {}): Promise<void> {
    if (!chatCliConfigService || !normalCliProcess) {
        throw new Error('Chat CLI 组件尚未初始化');
    }
    const relayPort = await ensureRelayServerStarted();
    const { normal, expert, plan, review } = await chatCliConfigService.getRoutedConfigsWithRelayEnv(relayPort);
    await syncClaudeCliModelSettingsSafely();

    // ── normal CLI ─────────────────────────────────────────────────────
    const normalPersistedSessionId = await chatCliSessionStore?.readSessionId(normal.cwd, 'normal');
    const normalLaunchConfig = { ...normal, resumeSessionId: normalPersistedSessionId };
    if (!options.forceRestart && normalCliProcess.isRunningWithConfig(normalLaunchConfig)) {
        Logger.info(`复用现有 normal Chat CLI 进程（model=${normalLaunchConfig.model}）`);
        rebuildNormalAdapter();
    } else {
        Logger.info('启动 normal Chat CLI：' + JSON.stringify({
            cwd: normalLaunchConfig.cwd,
            cliPath: normalLaunchConfig.cliPath,
            model: normalLaunchConfig.model,
            hasPersistedSession: !!normalPersistedSessionId,
            willResumePersistedSession: !!normalLaunchConfig.resumeSessionId,
            anthropicBaseUrl: normalLaunchConfig.cliEnv.ANTHROPIC_BASE_URL || '',
            hasAnthropicAuthToken: !!normalLaunchConfig.cliEnv.ANTHROPIC_AUTH_TOKEN,
            hasAnthropicApiKey: !!normalLaunchConfig.cliEnv.ANTHROPIC_API_KEY,
            hasCustomHeaders: !!normalLaunchConfig.cliEnv.ANTHROPIC_CUSTOM_HEADERS,
            skipAuthLogin: normalLaunchConfig.cliEnv.CLAUDE_CODE_SKIP_AUTH_LOGIN || '',
            skipModelValidation: normalLaunchConfig.cliEnv.CLAUDE_CODE_SKIP_MODEL_VALIDATION || '',
            forceRestart: !!options.forceRestart
        }));
        chatCliCancelRequested = false;
        logBrowserMcpInjection(normalLaunchConfig);
        logVscodeMcpInjection(normalLaunchConfig);
        logMcpToolsBeforeCliStart();
        await normalCliProcess.start(normalLaunchConfig);
        rebuildNormalAdapter();
    }
    await chatViewHost?.postMessage({ type: 'cli/status', status: 'running', detail: normal.cliPath });

    // ── expert CLI ─────────────────────────────────────────────────────
    // 按需专家方案：不再常驻 expert CLI。无论配置如何，均确保旧 expert CLI 已释放。
    // 专家由 ExpertSubturnService 在主模型调用 ask_expert MCP 工具时按需经 Relay 执行。
    void expert;
    await disposeExpertCli('按需专家方案：expert CLI 已停用');
    if (!plan) {
        planLaunchConfigCache = undefined;
        await disposePlanCli('未配置方案任务模型');
    } else {
        planLaunchConfigCache = { ...plan, resumeSessionId: undefined };
        if (planCliProcess && !planCliProcess.isRunningWithConfig(planLaunchConfigCache)) {
            await disposePlanCli('方案任务模型配置已变更');
        }
    }
    if (!review) {
        reviewLaunchConfigCache = undefined;
        await disposeReviewCli('未配置审查任务模型');
    } else {
        reviewLaunchConfigCache = { ...review, resumeSessionId: undefined };
        if (reviewCliProcess && !reviewCliProcess.isRunningWithConfig(reviewLaunchConfigCache)) {
            await disposeReviewCli('审查任务模型配置已变更');
        }
    }
}

/**
 * 显式停止并释放 plan CLI 实例与适配器。
 *
 * @param reason 仅用于日志诊断的原因描述。
 */
async function disposePlanCli(reason: string): Promise<void> {
    resetRouteBusy('plan');
    clearPlanIdleDisposeTimer();
    if (!planCliProcess && !planStreamJsonAdapter) return;
    Logger.info(`释放 plan Chat CLI：reason=${reason}`);
    planCliStatusSubscription?.dispose();
    planCliStatusSubscription = undefined;
    planCliExitSubscription?.dispose();
    planCliExitSubscription = undefined;
    planStreamJsonAdapterSubscription?.dispose();
    planStreamJsonAdapterSubscription = undefined;
    planStreamJsonAdapter?.dispose();
    planStreamJsonAdapter = undefined;
    if (planCliProcess) {
        try {
            await planCliProcess.stop();
        } catch (err) {
            Logger.warn('停止 plan Chat CLI 失败：' + (err instanceof Error ? err.message : String(err)));
        }
        planCliProcess.dispose();
        planCliProcess = undefined;
    }
}

/**
 * 显式停止并释放 review CLI 实例与适配器。
 *
 * @param reason 仅用于日志诊断的原因描述。
 */
async function disposeReviewCli(reason: string): Promise<void> {
    resetRouteBusy('review');
    clearReviewIdleDisposeTimer();
    if (!reviewCliProcess && !reviewStreamJsonAdapter) return;
    Logger.info(`释放 review Chat CLI：reason=${reason}`);
    reviewCliStatusSubscription?.dispose();
    reviewCliStatusSubscription = undefined;
    reviewCliExitSubscription?.dispose();
    reviewCliExitSubscription = undefined;
    reviewStreamJsonAdapterSubscription?.dispose();
    reviewStreamJsonAdapterSubscription = undefined;
    reviewStreamJsonAdapter?.dispose();
    reviewStreamJsonAdapter = undefined;
    if (reviewCliProcess) {
        try {
            await reviewCliProcess.stop();
        } catch (err) {
            Logger.warn('停止 review Chat CLI 失败：' + (err instanceof Error ? err.message : String(err)));
        }
        reviewCliProcess.dispose();
        reviewCliProcess = undefined;
    }
}

/** 清除 plan CLI 闲置释放计时器。 */
function clearPlanIdleDisposeTimer(): void {
    if (!planIdleDisposeTimer) return;
    clearTimeout(planIdleDisposeTimer);
    planIdleDisposeTimer = undefined;
}

/** 清除 review CLI 闲置释放计时器。 */
function clearReviewIdleDisposeTimer(): void {
    if (!reviewIdleDisposeTimer) return;
    clearTimeout(reviewIdleDisposeTimer);
    reviewIdleDisposeTimer = undefined;
}

/** 安排 plan/review CLI 在闲置窗口后释放。 */
function schedulePlanReviewIdleDispose(reason: string): void {
    clearPlanIdleDisposeTimer();
    clearReviewIdleDisposeTimer();
    planIdleDisposeTimer = setTimeout(() => {
        planIdleDisposeTimer = undefined;
        void disposePlanCli(`idle-timeout:${reason}`);
    }, PLAN_REVIEW_IDLE_DISPOSE_MS);
    planIdleDisposeTimer.unref?.();
    reviewIdleDisposeTimer = setTimeout(() => {
        reviewIdleDisposeTimer = undefined;
        void disposeReviewCli(`idle-timeout:${reason}`);
    }, PLAN_REVIEW_IDLE_DISPOSE_MS);
    reviewIdleDisposeTimer.unref?.();
}

/** 确保 plan CLI 已按当前缓存配置启动。 */
async function ensurePlanCliStarted(): Promise<void> {
    clearPlanIdleDisposeTimer();
    if (!planLaunchConfigCache) {
        await startChatCliPair();
    }
    if (!planLaunchConfigCache) {
        throw new Error('未配置方案任务模型');
    }
    if (!planCliProcess) {
        planCliProcess = new CliProcess();
        bindPlanCliStatusHandlers();
    }
    const launchConfig = { ...planLaunchConfigCache, resumeSessionId: undefined };
    if (planCliProcess.isRunningWithConfig(launchConfig)) {
        rebuildPlanAdapter();
        return;
    }
    Logger.info('按需启动 plan Chat CLI：' + JSON.stringify({
        cwd: launchConfig.cwd,
        cliPath: launchConfig.cliPath,
        model: launchConfig.model
    }));
    await planCliProcess.start(launchConfig);
    rebuildPlanAdapter();
}

/** 确保 review CLI 已按当前缓存配置启动。 */
async function ensureReviewCliStarted(): Promise<void> {
    clearReviewIdleDisposeTimer();
    if (!reviewLaunchConfigCache) {
        await startChatCliPair();
    }
    if (!reviewLaunchConfigCache) {
        throw new Error('未配置审查任务模型');
    }
    if (!reviewCliProcess) {
        reviewCliProcess = new CliProcess();
        bindReviewCliStatusHandlers();
    }
    const launchConfig = { ...reviewLaunchConfigCache, resumeSessionId: undefined };
    if (reviewCliProcess.isRunningWithConfig(launchConfig)) {
        rebuildReviewAdapter();
        return;
    }
    Logger.info('按需启动 review Chat CLI：' + JSON.stringify({
        cwd: launchConfig.cwd,
        cliPath: launchConfig.cliPath,
        model: launchConfig.model
    }));
    await reviewCliProcess.start(launchConfig);
    rebuildReviewAdapter();
}

/**
 * 显式停止并释放 expert CLI 实例与适配器。
 *
 * 在「专家模型从已选切到关闭」「pair 重启时检测到 expertMode 关闭」等场景调用，
 * 避免旧 expert 子进程占用资源、遗留旧的 ANTHROPIC_MODEL 环境变量。
 *
 * @param reason 仅用于日志诊断的原因描述。
 */
async function disposeExpertCli(reason: string): Promise<void> {
    resetRouteBusy('expert');
    if (!expertCliProcess && !expertStreamJsonAdapter) return;
    Logger.info(`释放 expert Chat CLI：reason=${reason}`);
    expertCliStatusSubscription?.dispose();
    expertCliStatusSubscription = undefined;
    expertCliExitSubscription?.dispose();
    expertCliExitSubscription = undefined;
    expertStreamJsonAdapterSubscription?.dispose();
    expertStreamJsonAdapterSubscription = undefined;
    expertStreamJsonAdapter?.dispose();
    expertStreamJsonAdapter = undefined;
    if (expertCliProcess) {
        try {
            await expertCliProcess.stop();
        } catch (err) {
            Logger.warn('停止 expert Chat CLI 失败：' + (err instanceof Error ? err.message : String(err)));
        }
        expertCliProcess.dispose();
        expertCliProcess = undefined;
    }
}

/**
 * 同步重启 normal + expert 两条 Chat CLI（pair 视角）。
 *
 * 用于「模型选择保存」「Relay 端口变化」等需要让两条 CLI 同时拿到最新启动参数
 * 的场景；调用方应优先使用本函数而不是单独调用 startChatCliPair，让重启语义
 * 在调用点更清晰。
 *
 * @param options.silent 是否抑制成功 toast。
 */
async function restartChatCliPair(options: { silent?: boolean } = {}): Promise<void> {
    if (!normalCliProcess || !chatCliConfigService) return;
    chatCliCancelRequested = false;
    resetAllRouteBusy();
    await startChatCliPair({ forceRestart: true });
    if (!options.silent) {
        await showChatToast('success', 'Chat CLI 长连接已重启。');
    }
}

/**
 * 同时停止 normal + expert 两条 Chat CLI（pair 视角）。
 *
 * 与 `dispose` 的区别：仅终止子进程，保留模块级实例引用与订阅，便于后续
 * 重新调用 {@link startChatCliPair}。
 */
async function stopChatCliPair(): Promise<void> {
    resetAllRouteBusy();
    if (normalCliProcess) {
        try {
            await normalCliProcess.stop();
        } catch (err) {
            Logger.warn('停止 normal Chat CLI 失败：' + (err instanceof Error ? err.message : String(err)));
        }
    }
    await disposeExpertCli('stopChatCliPair');
    await disposePlanCli('stopChatCliPair');
    await disposeReviewCli('stopChatCliPair');
}

/**
 * 重建 normal CLI 的 stream-json 适配器并订阅 ParsedCliEvent。
 *
 * 双 CLI 路由方案下，normal CLI 的输出会经过 `@llsExpert` 路由检测
 * （由 `handleParsedCliEvent(event, 'normal')` 内部处理）。每次 normal CLI
 * 启动 / 重启时本函数会被调用，确保订阅指向最新子进程。
 */
function rebuildNormalAdapter(): void {
    if (!normalCliProcess) throw new Error('Chat CLI 进程尚未初始化');
    streamJsonCliAdapterSubscription?.dispose();
    normalStreamJsonAdapter?.dispose();
    normalStreamJsonAdapter = new StreamJsonCliAdapter(normalCliProcess, (resultText) => {
        notifyPermissionDeniedToUser(resultText);
    });
    streamJsonCliAdapterSubscription = normalStreamJsonAdapter.onParsedEvent((event) => {
        void handleParsedCliEvent(event, 'normal').catch((err: unknown) => {
            Logger.error('处理 normal CLI 流式事件失败', err);
        });
    });
}

/**
 * 重建 expert CLI 的 stream-json 适配器并订阅 ParsedCliEvent。
 *
 * expert CLI 的事件不参与 `@llsExpert` 路由检测，避免循环触发；其它处理
 * 流程（segments / done / error / session/init）与 normal 一致。
 */
function rebuildExpertAdapter(): void {
    if (!expertCliProcess) throw new Error('Expert Chat CLI 进程尚未初始化');
    expertStreamJsonAdapterSubscription?.dispose();
    expertStreamJsonAdapter?.dispose();
    expertStreamJsonAdapter = new StreamJsonCliAdapter(expertCliProcess, (resultText) => {
        notifyPermissionDeniedToUser(resultText);
    });
    expertStreamJsonAdapterSubscription = expertStreamJsonAdapter.onParsedEvent((event) => {
        void handleParsedCliEvent(event, 'expert').catch((err: unknown) => {
            Logger.error('处理 expert CLI 流式事件失败', err);
        });
    });
}

/** 重建 plan CLI 的 stream-json 适配器并订阅 ParsedCliEvent。 */
function rebuildPlanAdapter(): void {
    if (!planCliProcess) throw new Error('Plan Chat CLI 进程尚未初始化');
    planStreamJsonAdapterSubscription?.dispose();
    planStreamJsonAdapter?.dispose();
    planStreamJsonAdapter = new StreamJsonCliAdapter(planCliProcess, (resultText) => {
        notifyPermissionDeniedToUser(resultText);
    });
    planStreamJsonAdapterSubscription = planStreamJsonAdapter.onParsedEvent((event) => {
        void handleParsedCliEvent(event, 'plan').catch((err: unknown) => {
            Logger.error('处理 plan CLI 流式事件失败', err);
        });
    });
}

/** 重建 review CLI 的 stream-json 适配器并订阅 ParsedCliEvent。 */
function rebuildReviewAdapter(): void {
    if (!reviewCliProcess) throw new Error('Review Chat CLI 进程尚未初始化');
    reviewStreamJsonAdapterSubscription?.dispose();
    reviewStreamJsonAdapter?.dispose();
    reviewStreamJsonAdapter = new StreamJsonCliAdapter(reviewCliProcess, (resultText) => {
        notifyPermissionDeniedToUser(resultText);
    });
    reviewStreamJsonAdapterSubscription = reviewStreamJsonAdapter.onParsedEvent((event) => {
        void handleParsedCliEvent(event, 'review').catch((err: unknown) => {
            Logger.error('处理 review CLI 流式事件失败', err);
        });
    });
}

function logBrowserMcpInjection(config: ChatCliConfig): void {
    const server = config.mcpServers?.[BROWSER_MCP_SERVER_NAME];
    if (!server) {
        Logger.info('Browser MCP 注入状态：disabled');
        return;
    }
    Logger.info('Browser MCP 注入状态：' + JSON.stringify({
        serverName: BROWSER_MCP_SERVER_NAME,
        type: server.type,
        command: server.command || '',
        argsCount: Array.isArray(server.args) ? server.args.length : 0,
        hasEntrypointScript: Array.isArray(server.args) && server.args[0] === '-e' && typeof server.args[1] === 'string' && server.args[1].includes('browserMcpServer'),
        relayPort: server.env?.[BROWSER_TOOL_RELAY_PORT_ENV] || '',
        toolPrefix: `mcp__${BROWSER_MCP_SERVER_NAME}__`
    }));
}

function logVscodeMcpInjection(config: ChatCliConfig): void {
    const server = config.mcpServers?.[VSCODE_MCP_SERVER_NAME];
    if (!server) {
        Logger.info('VS Code MCP 注入状态：disabled');
        return;
    }
    Logger.info('VS Code MCP 注入状态：' + JSON.stringify({
        serverName: VSCODE_MCP_SERVER_NAME,
        type: server.type,
        command: server.command || '',
        argsCount: Array.isArray(server.args) ? server.args.length : 0,
        hasEntrypointScript: Array.isArray(server.args) && server.args[0] === '-e' && typeof server.args[1] === 'string' && server.args[1].includes('vscodeMcpServer'),
        relayPort: server.env?.[VSCODE_TOOL_RELAY_PORT_ENV] || '',
        toolPrefix: `mcp__${VSCODE_MCP_SERVER_NAME}__`
    }));
}

async function promptEnableBrowserChatToolsIfNeeded(): Promise<void> {
    // 不再使用任何阻塞式弹窗（会卡住激活/加载）。浏览器相关设置统一由 Chat 输入框
    // 下方「CC 任务流」按钮后的内联提示驱动：用户点击后一次性开启所需设置。
    await postBrowserAutoApproveState();
}

const TOOL_AUTO_APPROVE_KEY = 'chat.tools.global.autoApprove';
const BROWSER_ENABLE_CHAT_TOOLS_KEY = 'workbench.browser.enableChatTools';
const VS_CODE_DESKTOP_UI_KIND = 1;

/** 是否应在 Chat 中提供「免去浏览器确认」提示：仅要求 VS Code ≥ 1.110 且为桌面端。 */
function isBrowserToolsSupported(): boolean {
    if (!isVsCodeAtLeast(1, 110)) return false;
    return vscode.env.uiKind === VS_CODE_DESKTOP_UI_KIND;
}

/** 浏览器自动放行所需的两项设置是否都已开启。 */
function isBrowserFullyAutoApproved(): boolean {
    const root = vscode.workspace.getConfiguration();
    const autoApprove = root.get<boolean>(TOOL_AUTO_APPROVE_KEY, false) === true;
    const enableChatTools = root.get<boolean>(BROWSER_ENABLE_CHAT_TOOLS_KEY, false) === true;
    return autoApprove && enableChatTools;
}

/**
 * 向 Chat Webview 推送浏览器工具自动放行状态，驱动 CC 任务流后的「免去浏览器确认」提示按钮显隐。
 *
 * 不再使用阻塞式弹窗（会卡住激活/加载）；改为前端在任务流按钮旁内联提示，用户点击后再开启。
 */
async function postBrowserAutoApproveState(): Promise<void> {
    await chatViewHost?.postMessage({
        type: 'browser/autoApproveState',
        supported: isBrowserToolsSupported(),
        enabled: isBrowserFullyAutoApproved()
    });
}

/**
 * 应前端「免去浏览器确认」提示点击，一次性开启浏览器工具所需的两项 VS Code 设置并回推最新状态。
 *
 * - workbench.browser.enableChatTools：开启内置浏览器工具；
 * - chat.tools.global.autoApprove：免去每次「Open Browser Page?」确认（会放行所有 agent 工具，
 *   含写文件、跑命令），因此仅在用户主动点击提示时才写入。
 */
async function enableBrowserAutoApprove(): Promise<void> {
    const root = vscode.workspace.getConfiguration();
    await root.update(BROWSER_ENABLE_CHAT_TOOLS_KEY, true, vscode.ConfigurationTarget.Global);
    await root.update(TOOL_AUTO_APPROVE_KEY, true, vscode.ConfigurationTarget.Global);
    Logger.info('已开启浏览器工具自动放行（来自 Chat 提示点击）：enableChatTools=true, chat.tools.global.autoApprove=true');
    await postBrowserAutoApproveState();
}

function isVsCodeAtLeast(major: number, minor: number): boolean {
    const parts = vscode.version.split('.').map((part) => Number.parseInt(part, 10));
    const currentMajor = Number.isFinite(parts[0]) ? parts[0] : 0;
    const currentMinor = Number.isFinite(parts[1]) ? parts[1] : 0;
    return currentMajor > major || (currentMajor === major && currentMinor >= minor);
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
 * @param source 事件来源 CLI；`'normal'` 时会在 segments 文本上做 `@llsExpert`
 *   路由检测（由任务 5 在切路由时使用），`'expert'` 仅做正常渲染、不做任何路由检测，
 *   避免循环触发。
 */
async function handleParsedCliEvent(event: ParsedCliEvent, source: ChatRoute = 'normal'): Promise<void> {
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
            await showChatToast('error', event.detail ? `${event.message}：${event.detail}` : event.message);
            return;
        case 'session/init':
            await chatCliSessionStore?.writeSessionId(event.cwd, event.sessionId, source);
            chatSessionRouteById.set(event.sessionId, source);
            if (source === 'normal') {
                lastKnownChatCliSessionId = event.sessionId;
                void pushSessionTitleToWebview(event.cwd, event.sessionId);
            } else if (source === 'expert') {
                lastKnownExpertChatCliSessionId = event.sessionId;
            } else if (source === 'plan') {
                lastKnownPlanChatCliSessionId = event.sessionId;
            } else {
                lastKnownReviewChatCliSessionId = event.sessionId;
            }
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

function handleCliCompactStatus(
    event: Extract<ParsedCliEvent, { type: 'compact/status' }>,
    source: ChatRoute
): void {
    const sessionId = event.sessionId || getSessionIdForRoute(source);
    if (event.status === 'compacting') {
        void chatViewHost?.postMessage({
            type: 'compaction/started',
            sessionId,
            beforeTokens: 0
        });
        return;
    }
    if (event.compactResult === 'success') {
        tokenBudgetServiceRef?.finishNativeCompaction(sessionId, true);
        void chatViewHost?.postMessage({
            type: 'compaction/finished',
            oldSessionId: sessionId,
            newSessionId: sessionId,
            beforeTokens: 0,
            afterTokens: 0,
            summary: ''
        });
        return;
    }
    tokenBudgetServiceRef?.finishNativeCompaction(sessionId, false, event.compactResult || 'compact failed');
    void chatViewHost?.postMessage({
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
 * @param event 适配器解析出的工具授权请求事件。
 */
async function handleToolPermissionRequest(event: ToolPermissionRequestEvent, source: ChatRoute): Promise<void> {
    const adapter = getStreamAdapterForRoute(source);
    if (!adapter) {
        Logger.warn(`收到 ${source} 工具授权请求但 stream-json 适配器不存在：requestId=${event.requestId}`);
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
            await postChatPlanModelOptions();
            await postChatReviewModelOptions();
            await postModelsSnapshot();
            await chatViewHost?.postMessage({ type: 'route/changed', route: activeRoute });
            await postChatPermissionMode();
            await postChatCacheTtl();
            await postChatTaskFlowStatus();
            await postActiveEditorAttachmentToChat();
            await maybePostTaskFlowRestorePrompt();
            await postBrowserAutoApproveState();
            return;
        case 'user/send':
            {
                const rawText = message.text;
                const forceExpert = startsWithExpertPrefix(rawText);
                if (!forceExpert && activeRoute === 'expert' && !isRouteBusy('expert')) {
                    await switchChatRoute('normal', 'expert-idle-fallback');
                }
                const bodyText = forceExpert ? stripExpertPrefix(rawText) : rawText;
                const prompt = buildPromptWithAttachments(bodyText, message.attachments);
                await appendLocalChatMessage('user', prompt, await buildUserDisplaySegments(prompt, message.attachments));
                armHttpExpectation(prompt);
                await sendUserMessageToCli(prompt, { forceExpert });
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
        case 'cacheTtl/select':
            await selectChatCacheTtl(message.ttl);
            return;
        case 'expert/model/select':
            await selectChatExpertModel(message.modelId);
            return;
        case 'plan/model/select':
            await selectChatPlanModel(message.modelId);
            return;
        case 'review/model/select':
            await selectChatReviewModel(message.modelId);
            return;
        case 'taskFlow/open':
            await openLlsCcaiTaskMenu();
            return;
        case 'browser/enableAutoApprove':
            await enableBrowserAutoApprove();
            return;
        case 'taskFlow/restoreChoice':
            await handleTaskFlowRestoreChoice(message.choice);
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
            await restartChatRelayAndCli();
            return;
        case 'route/select':
            await handleRouteSelect(message.route);
            return;
        case 'models/applyPair':
            await handleModelsApplyPair(message.normal, message.expert, message.plan, message.review, message.compaction);
            return;
        case 'user/cancel':
            chatCliCancelRequested = true;
            clearHttpExpectation('user_cancel');
            cancelPendingResend('user_cancel');
            cancelRouteProcess(activeRoute);
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
            // 同步抹掉 Claude CLI 端的 session 上下文：
            //   1) 删除 .LLSOAI/chat-session.json 中保存的 sessionId，下次启动 CLI
            //      就不会再 --resume 旧会话，CC 那边历史也随之失效；
            //   2) 后台重启 CLI，让用户下一条消息直接进入全新空上下文。
            //
            // 注意：这里只清 Chat/CLI 上下文，不清 LLS CCAI 任务流；右上角清空
            // 会话应保留当前 workflow，用户仍可通过任务流菜单单独清空任务流。
            try {
                const cwd = chatCliConfigService?.getConfig().cwd;
                if (cwd) {
                    await chatCliSessionStore?.clearSessionId(cwd, 'normal');
                    await chatCliSessionStore?.clearSessionId(cwd, 'expert');
                    await chatCliSessionStore?.clearSessionId(cwd, 'plan');
                    await chatCliSessionStore?.clearSessionId(cwd, 'review');
                    lastKnownChatCliSessionId = '';
                    lastKnownExpertChatCliSessionId = '';
                    lastKnownPlanChatCliSessionId = '';
                    lastKnownReviewChatCliSessionId = '';
                    chatSessionRouteById.clear();
                    Logger.info(`[session/clear] 已删除 normal/expert/plan/review CLI sessionId 文件：cwd=${cwd}`);
                    await disposePlanCli('session/clear');
                    await disposeReviewCli('session/clear');
                }
            } catch (err) {
                Logger.warn('[session/clear] 删除 CLI sessionId 失败：' + (err instanceof Error ? err.message : String(err)));
            }
            autoContinueScheduler?.cancel('session/clear');
            try {
                await restartChatCliPair({ silent: true });
                Logger.info('[session/clear] Chat CLI pair 已后台重启为全新空上下文');
            } catch (err) {
                Logger.warn('[session/clear] Chat CLI pair 重启失败：' + (err instanceof Error ? err.message : String(err)));
            }
            await postChatUiLanguage();
            await chatViewHost?.postMessage({
                type: 'session/init',
                messages: chatMessages,
                cliPath: chatCliConfigService?.getConfig().cliPath ?? ''
            });
            return;
        case 'session/set-title': {
            const cwd = chatCliConfigService?.getConfig().cwd;
            if (!cwd) {
                Logger.warn('[session/set-title] 无 cwd，跳过写回');
                return;
            }
            const targetId = (message.sessionId || lastKnownChatCliSessionId || '').trim();
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
            chatMessages = [];
            activeAssistantMessageId = undefined;
            clearHttpExpectation('session_resume');
            cancelPendingResend('session_resume');

            // 先尝试从 JSONL 加载历史消息
            let historyMessages: ChatMessage[] = [];
            let resumeTitle = '';
            try {
                const resumeCwd = chatCliConfigService?.getConfig().cwd
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

            chatMessages = historyMessages;
            // 立即渲染历史消息到 webview
            Logger.info(`[session/resume] 推送 session/init 到 webview：messages=${chatMessages.length} host=${chatViewHost ? 'ready' : 'null'}`);
            await chatViewHost?.postMessage({
                type: 'session/init',
                messages: chatMessages,
                cliPath: chatCliConfigService?.getConfig().cliPath ?? ''
            });
            await chatViewHost?.postMessage({
                type: 'session/title',
                title: resumeTitle,
                sessionId: targetSessionId ?? ''
            });

            try {
                const cwd = chatCliConfigService?.getConfig().cwd;
                if (cwd && targetSessionId) {
                    await chatCliSessionStore?.writeSessionId(cwd, targetSessionId, 'normal');
                    await chatCliSessionStore?.clearSessionId(cwd, 'expert');
                    await chatCliSessionStore?.clearSessionId(cwd, 'plan');
                    await chatCliSessionStore?.clearSessionId(cwd, 'review');
                    lastKnownChatCliSessionId = '';
                    lastKnownExpertChatCliSessionId = '';
                    lastKnownPlanChatCliSessionId = '';
                    lastKnownReviewChatCliSessionId = '';
                    chatSessionRouteById.clear();
                    await disposePlanCli('session/resume');
                    await disposeReviewCli('session/resume');
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
            const started = sessionId ? tokenBudgetServiceRef?.compactNow(sessionId) : false;
            Logger.info(`[tokenBudget] Chat 压缩会话请求处理结果：started=${started ? 'true' : 'false'}`);
            if (!started) {
                await chatViewHost?.postMessage({
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
                const cwd = chatCliConfigService?.getConfig().cwd
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
                await chatViewHost?.postMessage({ type: 'sessions/list/result', sessions: items });
            } catch { /* ignore */ }
            return;
        }
        default:
            return;
    }
}

/**
 * 判断指定 provider 下的模型是否可在 Chat 模型选择中出现。
 *
 * 同时校验三项：provider 已启用、模型未被显式禁用（enabled !== false）、
 * 模型未被排除在用户可选范围外（isUserSelectable !== false）。任一不满足
 * 即视为不可选，统一供 Chat 模型列表与快照过滤使用。
 *
 * @param provider 不含密钥的提供商配置。
 * @param model 模型配置。
 * @returns 模型可被用户选择则返回 true，否则返回 false。
 */
function isSelectableModel(provider: ProviderConfigWithoutSecrets, model: ModelConfig): boolean {
    if (!provider.enabled) return false;
    if (model.enabled === false) return false;
    if (model.isUserSelectable === false) return false;
    return true;
}

/**
 * 校验「模型选择弹窗」一次性提交的子项是否仍可被选中。
 *
 * 在普通 / 专家 / 方案 / 审查任一档位提交前调用。当传入空选择时直接放行
 * （表示用户主动关闭该子模型）；当传入非空选择时要求 provider 与 model
 * 仍存在且通过 {@link isSelectableModel} 校验，否则抛出含中文档位标签的错误。
 *
 * @param label 用于错误提示的子模型标签，如「普通」「专家」。
 * @param selection 待校验的 providerId/modelId；null 表示该档位关闭。
 */
function assertSelectableSubModel(
    label: string,
    selection: { providerId: string; modelId: string } | null
): void {
    if (!selection) return;
    if (!configManager) throw new Error('配置管理器尚未初始化');
    const provider = configManager.getProvider(selection.providerId);
    const model = provider?.models.find((item) => item.modelId === selection.modelId);
    if (!provider || !model) {
        throw new Error(`${label}模型不存在：${selection.providerId}/${selection.modelId}`);
    }
    if (!isSelectableModel(provider, model)) {
        throw new Error(`${label}模型已被禁用，无法选择：${provider.name}/${model.displayName || model.modelId}`);
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
        for (const model of provider.models) {
            if (!isSelectableModel(provider, model)) continue;
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
 * 读取方案模型下拉框可选项，并推送当前按「项目 > 全局 > 关闭」解析的选择。
 */
async function postChatPlanModelOptions(): Promise<void> {
    if (!configManager) return;
    const current = readEffectivePlanModelSelection();
    const models: ChatModelOption[] = [];
    for (const provider of configManager.listProviders()) {
        for (const model of provider.models) {
            if (!isSelectableModel(provider, model)) continue;
            models.push({
                providerId: provider.id,
                providerName: provider.name,
                modelId: model.modelId,
                displayName: model.displayName || model.modelId,
                selected: current.enabled && current.modelId === model.modelId
            });
        }
    }
    await chatViewHost?.postMessage({ type: 'plan/model/options', models, current });
}

/**
 * 读取审查模型下拉框可选项，并推送当前按「项目 > 全局 > 关闭」解析的选择。
 */
async function postChatReviewModelOptions(): Promise<void> {
    if (!configManager) return;
    const current = readEffectiveReviewModelSelection();
    const models: ChatModelOption[] = [];
    for (const provider of configManager.listProviders()) {
        for (const model of provider.models) {
            if (!isSelectableModel(provider, model)) continue;
            models.push({
                providerId: provider.id,
                providerName: provider.name,
                modelId: model.modelId,
                displayName: model.displayName || model.modelId,
                selected: current.enabled && current.modelId === model.modelId
            });
        }
    }
    await chatViewHost?.postMessage({ type: 'review/model/options', models, current });
}

/**
 * 一次性推送普通 + 专家两栏模型可选项与当前选择，用于「模型选择弹窗」。
 *
 * 与 `postChatModelOptions` / `postChatExpertModelOptions` 共用底层 provider/model
 * 数据源，但合并为一条 `models/snapshot` 消息，避免弹窗打开时刷新闪动。
 */
async function postModelsSnapshot(): Promise<void> {
    if (!configManager) return;
    const currentNormal = configManager.getCurrentModel() ?? null;
    const currentExpert = readEffectiveExpertModelSelection();
    const currentPlan = readEffectivePlanModelSelection();
    const currentReview = readEffectiveReviewModelSelection();
    const currentCompaction = readEffectiveCompactionModelSelection();
    const normalModels: ChatModelOption[] = [];
    const expertModels: ChatModelOption[] = [];
    const planModels: ChatModelOption[] = [];
    const reviewModels: ChatModelOption[] = [];
    const compactionModels: ChatModelOption[] = [];
    for (const provider of configManager.listProviders()) {
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
            expertModels.push({
                ...baseOption,
                selected: currentExpert.enabled && currentExpert.modelId === model.modelId
            });
            planModels.push({
                ...baseOption,
                selected: currentPlan.enabled && currentPlan.modelId === model.modelId
            });
            reviewModels.push({
                ...baseOption,
                selected: currentReview.enabled && currentReview.modelId === model.modelId
            });
            compactionModels.push({
                ...baseOption,
                selected: currentCompaction.enabled && currentCompaction.modelId === model.modelId
            });
        }
    }
    await chatViewHost?.postMessage({
        type: 'models/snapshot',
        normalModels,
        expertModels,
        planModels,
        reviewModels,
        compactionModels,
        currentNormal: currentNormal ? { providerId: currentNormal.providerId, modelId: currentNormal.modelId } : null,
        currentExpert,
        currentPlan,
        currentReview,
        currentCompaction
    });
}

/**
 * 处理 webview 路由徽章 / 顶部按钮发回的手动路由切换。
 *
 * 第一版仅支持手动切回 `'normal'`：清除 normal 输出可能存在的 @llsExpert
 * 标记带来的副作用，让下一条用户消息回到普通 CLI；切到 `'expert'` 时也走
 * 同一条路径，便于用户主动锁定专家。
 *
 * @param route 用户希望切换到的路由。
 */
async function handleRouteSelect(route: ChatRoute): Promise<void> {
    if (route === 'expert' && !getStreamAdapterForRoute('expert')) {
        await showChatToast('warn', '未配置专家任务模型，无法切换到专家路由。');
        return;
    }
    await switchChatRoute(route, 'user-route-select');
}

/**
 * 处理「模型选择弹窗」一次性提交的普通 + 专家选择。
 *
 * 串行执行普通模型保存、专家模型保存与 Chat CLI pair 重启，最后再推送一次
 * snapshot，避免双下拉时代两次 select 各触发一次重启的冗余。
 *
 * @param normal 普通任务模型；null 表示未选。
 * @param expert 专家任务模型；null 表示「关闭专家」。
 */
async function handleModelsApplyPair(
    normal: { providerId: string; modelId: string } | null,
    expert: { providerId: string; modelId: string } | null,
    plan: { providerId: string; modelId: string } | null,
    review: { providerId: string; modelId: string } | null,
    compaction: { providerId: string; modelId: string } | null
): Promise<void> {
    if (!configManager) throw new Error('配置管理器尚未初始化');
    assertSelectableSubModel('普通', normal);
    assertSelectableSubModel('专家', expert);
    assertSelectableSubModel('方案', plan);
    assertSelectableSubModel('审查', review);
    assertSelectableSubModel('压缩', compaction);
    if (normal) {
        const provider = configManager.getProvider(normal.providerId);
        const model = provider?.models.find((item) => item.modelId === normal.modelId);
        if (!provider || !model) {
            throw new Error(`模型不存在：${normal.providerId}/${normal.modelId}`);
        }
        await configManager.setCurrentModel({ providerId: normal.providerId, modelId: normal.modelId });
    }
    const expertModelId = expert ? `${expert.providerId}/${expert.modelId}` : '';
    await saveExpertModelSelection(expertModelId);
    const planModelId = plan ? `${plan.providerId}/${plan.modelId}` : '';
    await savePlanModelSelection(planModelId);
    const reviewModelId = review ? `${review.providerId}/${review.modelId}` : '';
    await saveReviewModelSelection(reviewModelId);
    const compactionModelId = compaction ? `${compaction.providerId}/${compaction.modelId}` : '';
    await saveCompactionModelSelection(compactionModelId);
    await postChatModelOptions();
    await postChatExpertModelOptions();
    await postChatPlanModelOptions();
    await postChatReviewModelOptions();
    await postModelsSnapshot();
    await restartChatCliPair({ silent: true });
    await showChatToast('success', '模型已应用，Chat CLI 已重启。');
}

/**
 * 读取当前 Chat CLI 权限模式并推送到 Chat Webview。
 */
async function postChatPermissionMode(): Promise<void> {
    const mode = normalizeQuickPermissionMode(chatCliConfigService?.getConfig().permissionMode);
    await chatViewHost?.postMessage({ type: 'permissionMode/current', mode });
}

/**
 * 读取当前缓存时长选择并推送到 Chat Webview，用于回填模型选择弹窗里的下拉框。
 */
async function postChatCacheTtl(): Promise<void> {
    if (!configManager) return;
    await chatViewHost?.postMessage({ type: 'cacheTtl/current', ttl: configManager.getChatCacheTtl() });
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
    if (!isSelectableModel(provider, model)) {
        throw new Error(`模型已被禁用，无法选择：${provider.name}/${model.displayName || model.modelId}`);
    }
    await configManager.setCurrentModel({ providerId, modelId });
    await postChatModelOptions();
    Logger.info(`Chat 输入框切换模型：${provider.name}/${model.displayName || model.modelId}，将重启 Chat CLI pair`);
    await restartChatCliPair({ silent: true });
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
        await restartChatCliPair({ silent: true });
        await showChatToast('success', '专家已关闭');
        return;
    }
    Logger.info(`Chat 输入框切换专家模型：${current.modelId}，已同步保存项目与全局配置`);
    await restartChatCliPair({ silent: true });
    await showChatToast('success', `专家模型已切换为：${current.modelId}`);
}

/**
 * 从 Chat 输入框方案模型下拉框切换方案模型，并同步保存项目与全局配置。
 *
 * @param modelId 方案模型 ID；空字符串表示关闭方案。
 */
async function selectChatPlanModel(modelId: string): Promise<void> {
    await savePlanModelSelection(modelId);
    await postChatPlanModelOptions();
    const current = readEffectivePlanModelSelection();
    if (!current.enabled) {
        Logger.info('Chat 输入框关闭方案模式，已同步保存项目与全局配置');
        await restartChatCliPair({ silent: true });
        await showChatToast('success', '方案已关闭');
        return;
    }
    Logger.info(`Chat 输入框切换方案模型：${current.modelId}，已同步保存项目与全局配置`);
    await restartChatCliPair({ silent: true });
    await showChatToast('success', `方案模型已切换为：${current.modelId}`);
}

/**
 * 从 Chat 输入框审查模型下拉框切换审查模型，并同步保存项目与全局配置。
 *
 * @param modelId 审查模型 ID；空字符串表示关闭审查。
 */
async function selectChatReviewModel(modelId: string): Promise<void> {
    await saveReviewModelSelection(modelId);
    await postChatReviewModelOptions();
    const current = readEffectiveReviewModelSelection();
    if (!current.enabled) {
        Logger.info('Chat 输入框关闭审查模式，已同步保存项目与全局配置');
        await restartChatCliPair({ silent: true });
        await showChatToast('success', '审查已关闭');
        return;
    }
    Logger.info(`Chat 输入框切换审查模型：${current.modelId}，已同步保存项目与全局配置`);
    await restartChatCliPair({ silent: true });
    await showChatToast('success', `审查模型已切换为：${current.modelId}`);
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
 * 保存模型选择弹窗里的缓存时长选择。
 *
 * 仅写入 globalState 并回推当前值给 Webview；缓存时长在每次请求时由 relay 实时读取，
 * 无需重启 CLI 或重载窗口即可生效。
 *
 * @param ttl 缓存时长选择：`'default'` 不改写、`'5m'` 归一化为 5 分钟、`'1h'` 归一化为 1 小时。
 */
async function selectChatCacheTtl(ttl: ChatCacheTtl): Promise<void> {
    if (!configManager) throw new Error('配置管理器尚未初始化');
    await configManager.setChatCacheTtl(ttl);
    await postChatCacheTtl();
    Logger.info(`Chat 模型弹窗切换缓存时长：${ttl}`);
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
 * 重入保护：若当前正处于自愈流程（`isHealingRelayAndCli === true`），说明
 * 之前还存在一个由 {@link scheduleHealResend} 排队的 60s 静默重发计时器。
 * 此时用户重新发送消息已经覆盖了旧 prompt 的意图，先调用
 * {@link cancelPendingResend} 取消旧重发并释放互斥锁，避免到点后旧 prompt
 * 被静默重新发送一次造成双重提交。
 *
 * @param prompt 本次提交的完整 prompt 文本，超时后用于自动重发。
 */
function armHttpExpectation(prompt: string): void {
    if (isHealingRelayAndCli) {
        Logger.info('armHttpExpectation 检测到自愈进行中，取消旧的待重发任务避免重复发送');
        cancelPendingResend('user-resend-supersedes');
    }
    clearHttpExpectation('rearm');
    pendingHttpExpectationPrompt = prompt;
    pendingHttpExpectationStartedAt = Date.now();
    Logger.info(`Relay 看门狗已启动（等待 Relay 命中）：timeout=${HTTP_EXPECTATION_TIMEOUT_MS}ms, promptLength=${prompt.length}`);
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
        Logger.info(`Relay 看门狗已清除：reason=${reason}, elapsed=${elapsed}ms`);
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
        Logger.warn('Relay 看门狗超时，但已有自愈流程在执行，本次忽略');
        return;
    }
    const prompt = pendingHttpExpectationPrompt;
    pendingHttpExpectationPrompt = undefined;
    pendingHttpExpectationStartedAt = undefined;
    if (!prompt) {
        Logger.warn('Relay 看门狗超时，但未保留 prompt，跳过自愈');
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
    void appendAssistantSegments(
        [{
            kind: 'error',
            text: `\n本地中转 ${expectationSeconds} 秒内未收到请求，正在自动重启 Relay 与 CLI，重启完成后 ${Math.round(HEAL_RESEND_DELAY_MS / 1000)} 秒再重发上一条消息…\n`
        }],
        false
    );
    void showChatToast('warn', `本地中转 ${expectationSeconds} 秒未响应，正在自动恢复…`);
    if (relayServer) {
        const oldPort = relayServer.getActualPort();
        Logger.warn(`自愈：准备重启 Relay，oldPort=${oldPort ?? 'unknown'}`);
        void appendAssistantSegments(
            [{
                kind: 'markdown',
                text: `\n> 正在停止本地中转 HTTP 服务${typeof oldPort === 'number' ? `（旧端口 ${oldPort}）` : ''}…\n`
            }],
            false
        );
        try {
            const newPort = await relayServer.restart();
            Logger.info(`Relay 已自愈重启，新端口=${newPort}`);
            void appendAssistantSegments(
                [{
                    kind: 'markdown',
                    text: `\n> 本地中转 HTTP 服务已启动：http://127.0.0.1:${newPort}\n`
                }],
                false
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Relay 自愈重启失败：${message}`);
            void appendAssistantSegments(
                [{ kind: 'error', text: `\n本地中转 HTTP 服务重启失败：${message}\n` }],
                false
            );
            throw err;
        }
    }
    void appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在重启 Claude CLI 子进程…\n' }],
        false
    );
    try {
        Logger.warn('自愈：准备重启 Claude CLI');
        await restartChatCli({ silent: true });
        Logger.info('自愈：Claude CLI 已重启完成');
        void appendAssistantSegments(
            [{ kind: 'markdown', text: '\n> Claude CLI 已重启完成\n' }],
            false
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`CLI 自愈重启失败：${message}`);
        void appendAssistantSegments(
            [{ kind: 'error', text: `\nClaude CLI 重启失败：${message}\n` }],
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
async function sendUserMessageToCli(text: string, options: { hidden?: boolean; suppressResponse?: boolean; forceExpert?: boolean; forceRoute?: ChatRoute } = {}): Promise<void> {
    chatCliCancelRequested = false;
    activeAssistantMessageId = undefined;

    let route = options.forceRoute ?? activeRoute;
    let outgoingText = text;
    const trimmed = text.trim();
    if (options.forceExpert || startsWithExpertPrefix(trimmed)) {
        route = 'expert';
        outgoingText = startsWithExpertPrefix(trimmed) ? stripExpertPrefix(text) : text;
        await switchChatRoute('expert', 'user-prefix');
    } else if (options.forceRoute) {
        await switchChatRoute(options.forceRoute, 'force-route');
    }

    const hidden = options.hidden === true;
    const suppressResponse = options.suppressResponse === true;
    if (suppressResponse) hiddenCliResponseTurnsByRoute[route] += 1;

    Logger.info(`用户发送内容(${route}, hidden=${hidden})：${formatLogPreview(outgoingText)}`);

    if (!hidden) {
        const assistantMessage = await createActiveAssistantMessage(route);
        Logger.info(`Chat 已创建 ${route} assistant 输出区域：id=${assistantMessage.id}`);
    }
    try {
        await ensureChatCliStarted();
        if (route === 'plan') {
            await ensurePlanCliStarted();
        } else if (route === 'review') {
            await ensureReviewCliStarted();
        }
        if (route === 'expert') {
            // 按需专家方案：用户级 @llsExpert / /expert 不再走常驻 expert CLI，
            // 改为直接调用 ExpertSubturnService 跑一次无历史 sub-turn。
            await runUserTriggeredExpertSubturn(outgoingText, { hidden });
            activeRoute = 'normal';
            await chatViewHost?.postMessage({ type: 'route/changed', route: 'normal' });
            return;
        }
        const adapter = getStreamAdapterForRoute(route);
        if (!adapter) {
            throw new Error(`${route} Chat CLI adapter 未就绪`);
        }
        if (route !== 'normal') {
            Logger.info(`发送消息到 ${route} Chat CLI：length=${outgoingText.length}, hidden=${hidden}, forceRoute=${options.forceRoute ?? ''}`);
        }
        await adapter.sendUserMessage(outgoingText);
    } catch (err) {
        if (suppressResponse) hiddenCliResponseTurnsByRoute[route] = Math.max(0, hiddenCliResponseTurnsByRoute[route] - 1);
        const message = err instanceof Error ? err.message : String(err);
        if (!hidden) {
            await appendAssistantSegments([{ kind: 'error', text: `\n发送到 CLI 失败：${message}\n` }], true);
        }
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
 * 向 CLI 发送内部消息，不在内置 Chat 中追加用户气泡。
 *
 * @param text 内部消息文本。
 */
async function sendHiddenUserMessageToCli(text: string, route: ChatRoute = activeRoute): Promise<void> {
    const previousRoute = activeRoute;
    activeRoute = route;
    try {
        await ensureChatCliStarted();
        await sendUserMessageToCli(text, { hidden: true });
    } finally {
        activeRoute = previousRoute;
    }
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
function registerChatCliStatusHandlers(context?: vscode.ExtensionContext): void {
    bindNormalCliStatusHandlers();
    bindExpertCliStatusHandlers();
    bindPlanCliStatusHandlers();
    bindReviewCliStatusHandlers();
    if (context) {
        context.subscriptions.push({
            dispose: () => {
                normalCliStatusSubscription?.dispose();
                normalCliStatusSubscription = undefined;
                normalCliExitSubscription?.dispose();
                normalCliExitSubscription = undefined;
                expertCliStatusSubscription?.dispose();
                expertCliStatusSubscription = undefined;
                expertCliExitSubscription?.dispose();
                expertCliExitSubscription = undefined;
                planCliStatusSubscription?.dispose();
                planCliStatusSubscription = undefined;
                planCliExitSubscription?.dispose();
                planCliExitSubscription = undefined;
                reviewCliStatusSubscription?.dispose();
                reviewCliStatusSubscription = undefined;
                reviewCliExitSubscription?.dispose();
                reviewCliExitSubscription = undefined;
            }
        });
    }
}

/**
 * 订阅 normal CLI 进程状态变化。
 */
function bindNormalCliStatusHandlers(): void {
    if (!normalCliProcess || normalCliStatusSubscription || normalCliExitSubscription) return;
    normalCliStatusSubscription = normalCliProcess.onStatus((status) => {
        void chatViewHost?.postMessage({ type: 'cli/status', status: mapCliStatusForWebview(status) });
    });
    normalCliExitSubscription = normalCliProcess.onExit((event) => {
        void handleChatCliExit(event, 'normal').catch((err: unknown) => {
            Logger.error('处理 normal Chat CLI 退出事件失败', err);
        });
    });
}

/**
 * 订阅 expert CLI 进程状态变化。
 */
function bindExpertCliStatusHandlers(): void {
    if (!expertCliProcess || expertCliStatusSubscription || expertCliExitSubscription) return;
    expertCliStatusSubscription = expertCliProcess.onStatus((status) => {
        Logger.info(`expert Chat CLI 状态变化：${status}`);
    });
    expertCliExitSubscription = expertCliProcess.onExit((event) => {
        void handleChatCliExit(event, 'expert').catch((err: unknown) => {
            Logger.error('处理 expert Chat CLI 退出事件失败', err);
        });
    });
}

/**
 * 订阅 plan CLI 进程状态变化。
 */
function bindPlanCliStatusHandlers(): void {
    if (!planCliProcess || planCliStatusSubscription || planCliExitSubscription) return;
    planCliStatusSubscription = planCliProcess.onStatus((status) => {
        Logger.info(`plan Chat CLI 状态变化：${status}`);
    });
    planCliExitSubscription = planCliProcess.onExit((event) => {
        void handleChatCliExit(event, 'plan').catch((err: unknown) => {
            Logger.error('处理 plan Chat CLI 退出事件失败', err);
        });
    });
}

/**
 * 订阅 review CLI 进程状态变化。
 */
function bindReviewCliStatusHandlers(): void {
    if (!reviewCliProcess || reviewCliStatusSubscription || reviewCliExitSubscription) return;
    reviewCliStatusSubscription = reviewCliProcess.onStatus((status) => {
        Logger.info(`review Chat CLI 状态变化：${status}`);
    });
    reviewCliExitSubscription = reviewCliProcess.onExit((event) => {
        void handleChatCliExit(event, 'review').catch((err: unknown) => {
            Logger.error('处理 review Chat CLI 退出事件失败', err);
        });
    });
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
 * 注：扩展不再维护宿主侧的「预期退出计数」，预期退出由
 * {@link CliProcess.expectedExitPids} 单源簿记，命中预期退出时 `CliProcess`
 * 已经在 `bindChildEvents` 内部 return，根本不会进到本 handler。
 *
 * @param event CLI 退出事件。
 */
async function handleChatCliExit(
    event: { code: number | null; signal: NodeJS.Signals | null },
    source: ChatRoute = 'normal'
): Promise<void> {
    const detail = `source=${source}, code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}`;
    clearHttpExpectation(`${source}_cli_exit`);
    cancelPendingResend(`${source}_cli_exit`);
    if (source === 'normal') {
        await chatViewHost?.postMessage({ type: 'cli/status', status: event.code === 0 ? 'exited' : 'error', detail });
    }
    if (chatCliCancelRequested && source === 'normal') {
        chatCliCancelRequested = false;
        await finishActiveAssistantMessage();
        return;
    }
    if (event.code === 0) return;
    const restart = '重启 CLI';
    const choice = await vscode.window.showErrorMessage(`${source} Chat CLI 异常退出：${detail}`, restart);
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
async function appendLocalChatMessage(role: ChatMessage['role'], text: string, segments?: ChatSegment[], route: ChatRoute = activeRoute): Promise<void> {
    const message: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        // 同时保存原始 text，方便 user 消息重发与前端 fallback 渲染。
        text,
        segments: segments ?? [{ kind: 'markdown', text }],
        route,
        createdAt: Date.now()
    };
    chatMessages.push(message);
    trimInMemoryChatMessages();
    schedulePersistChatSession();
    await chatViewHost?.postMessage({ type: 'message/append', message });
}

/**
 * 上游首字节或流空闲超时后，结束当前 pending 气泡并自动发送英文 Continue。
 *
 * @param kind 超时类型。
 */
async function handleUpstreamTimeoutAutoContinue(kind: UpstreamTimeoutKind): Promise<void> {
    const now = Date.now();
    if (now - lastUpstreamTimeoutContinueAt < UPSTREAM_TIMEOUT_CONTINUE_COOLDOWN_MS) {
        Logger.warn(`上游超时自动 Continue 已在冷却中，忽略：kind=${kind}`);
        return;
    }
    lastUpstreamTimeoutContinueAt = now;
    Logger.warn(`检测到上游${kind === 'first_byte' ? '首字节' : '流空闲'}超时，自动发送 Continue`);
    clearHttpExpectation(`upstream_${kind}_timeout`);
    await finishActiveAssistantMessage();
    armHttpExpectation(UPSTREAM_TIMEOUT_CONTINUE_PROMPT);
    await appendUserMessageAndSend(UPSTREAM_TIMEOUT_CONTINUE_PROMPT);
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

    // 仅中断正在执行的请求；空闲 CLI 不发 SIGINT，避免重发时把常驻进程打退出。
    chatCliCancelRequested = true;
    clearHttpExpectation('user_resend');
    cancelPendingResend('user_resend');
    if (isRouteBusy('normal')) {
        cancelRouteProcess('normal');
    }
    if (isRouteBusy('expert')) {
        cancelRouteProcess('expert');
    }
    if (isRouteBusy('plan')) {
        cancelRouteProcess('plan');
    }
    if (isRouteBusy('review')) {
        cancelRouteProcess('review');
    }

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
    const visibleSegments = segments.filter((segment) => !isHiddenChatToolSegment(segment));
    if (visibleSegments.length === 0 && !done) return;
    const message = await getActiveAssistantMessageForPatch();
    // 按 segment.id 去重合并：相同 id 的片段视为对同一 segment 的多次更新（典型场景为工具卡片）
    // —— 此时应原地替换已有 segment，而不是追加新条目，以避免重复渲染。
    for (const incoming of visibleSegments) {
        syncTokenBudgetContextWindowFromUsage(incoming, message);
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
    // 这里只发送本次 incoming segments（append: true），交由 ChatViewHost 微批合并：
    // 同一 message id 的多次 patch 会在 ~4ms 窗口内 concat 成单条 message/patch
    // 投递给 webview，避免流式高峰期对 postMessage 通道造成抖动。
    await chatViewHost?.postMessage({
        type: 'message/patch',
        id: message.id,
        segments: visibleSegments,
        pending: message.pending,
        append: true
    });
}

function isHiddenChatToolSegment(segment: ChatSegment): boolean {
    if (segment.kind !== 'tool') return false;
    const name = segment.tool?.name || segment.text || '';
    return name === 'Agent' || name === 'Task' || name === 'EnterPlanMode' || name === 'ExitPlanMode';
}

/**
 * 从 CLI result 的 usage segment 中回填 modelUsage.contextWindow。
 *
 * 上游 OpenAI-compatible 服务有时返回 usage.input_tokens=0，但 CLI result.modelUsage
 * 仍会携带准确 contextWindow。这里把 contextWindow 同步给 TokenBudgetService，
 * 让 token-meter 从「29k/166k」修正为「29k/200k」，同时不改变 estimator 的 used。
 *
 * @param segment 本次到达的 ChatSegment。
 */
function syncTokenBudgetContextWindowFromUsage(segment: ChatSegment, message: ChatMessage): void {
    if (segment.kind !== 'usage') return;
    const sessionId = currentChatCliSessionIdSync();
    if (!sessionId) return;
    const contextWindow = segment.usage?.contextWindow;
    const outputTokens = estimateAssistantOutputTokensForMeter(segment, message);
    tokenBudgetServiceRef?.updateCliUsage(sessionId, contextWindow, outputTokens);
}

/**
 * 估算 token-meter 中应计入的本轮 assistant 回复 token。
 *
 * 优先使用 CLI result.modelUsage.outputTokens；若上游返回 0，则从当前 assistant
 * message 已聚合的 text/markdown/code 内容做本地粗估，避免请求结束后 used 仍只
 * 显示 input，不包含刚生成的回复。
 *
 * @param usageSegment 本轮 usage segment。
 * @param message      当前 assistant 消息。
 * @returns output token 数或 undefined。
 */
function estimateAssistantOutputTokensForMeter(usageSegment: ChatSegment, message: ChatMessage): number | undefined {
    const fromUsage = usageSegment.usage?.outputTokens;
    if (typeof fromUsage === 'number' && Number.isFinite(fromUsage) && fromUsage > 0) return fromUsage;
    const text = message.segments
        .filter((segment) => segment.kind === 'text' || segment.kind === 'markdown' || segment.kind === 'code')
        .map((segment) => segment.text || '')
        .join('\n');
    if (!text.trim()) return undefined;
    return Math.max(1, Math.ceil(text.length / 3.5));
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
async function createActiveAssistantMessage(route: ChatRoute = activeRoute): Promise<ChatMessage> {
    const message = buildAssistantMessage(route);
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
function buildAssistantMessage(route: ChatRoute = activeRoute): ChatMessage {
    return {
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        segments: [],
        pending: true,
        route,
        modelLabel: getModelLabelForRoute(route),
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
    normalCliProcess = new CliProcess();
    chatCliSessionStore = new ChatCliSessionStore();
    chatViewHost = new ChatViewHost(context);
    llsTaskService = new LlsTaskService(configManager, new TaskFlowStore());
    // 从磁盘恢复上次未完成的任务流；失败已被 store 内部吞掉，绝不阻塞激活。
    // 恢复出未完成 workflow 时置 pendingRestorePrompt，待 Chat 首次 ready 弹对话框。
    try {
        pendingRestorePrompt = await llsTaskService.restore();
    } catch (err) {
        Logger.warn(`[LlsTask] 任务流恢复失败：${err instanceof Error ? err.message : String(err)}`);
    }
    autoContinueScheduler = new AutoContinueScheduler(llsTaskService);
    // 注入 submitter：续推时直接走内置 Chat → CLI 链路，绕开剪贴板 /
    // claude-vscode.focus / 系统级模拟回车。同时让续推提示词作为一条 user
    // 消息在 Chat UI 上正常显示，避免"无声续推"。
    AutoContinueScheduler.setSubmitter(async (text) => {
        await appendUserMessageAndSend(text);
    });
    // 任务流续推前不再强制压缩/清空上下文：之前这里会注入 beforeSubmit 触发
    // compactNowAndWait，由 Relay 把整段对话替换成一句占位 summary（等于清空续推前
    // 上下文）。现按需求移除该前置压缩，续推时保留完整上下文；正常的 token 预算
    // 压缩仍由 TokenBudgetService 在阈值触达时独立执行，且其 summary 会保留对话要点。
    // 不注入 beforeSubmit（保持 undefined），runIfCurrent 即跳过前置压缩。
    configViewProvider = new ConfigWebviewViewProvider(context, configManager);
    settingsWriter = new SettingsWriter();
    relayServer = new RelayServer({ desiredPort: 0 });
    const debugRecorder = new DebugRecorder();
    // 装配 TokenBudgetService：记录 token 预算，并在阈值触达时让 normal CLI 执行原生 /compact。
    const tokenBudgetService = new TokenBudgetService({
        configManager,
        commandSender: async (command: string) => {
            await sendHiddenUserMessageToCli(command, 'normal');
        },
        notifier: {
            notifyCompactionState: (state: CompactionState) => {
                // 把 CompactionState 转换为 chatViewHost 协议消息推送到 webview。
                if (state.kind === 'started') {
                    void chatViewHost?.postMessage({
                        type: 'compaction/started',
                        sessionId: state.sessionId,
                        beforeTokens: state.beforeTokens
                    });
                } else if (state.kind === 'finished') {
                    void chatViewHost?.postMessage({
                        type: 'compaction/finished',
                        oldSessionId: state.oldSessionId,
                        newSessionId: state.newSessionId,
                        beforeTokens: state.beforeTokens,
                        afterTokens: state.afterTokens,
                        summary: state.summary
                    });
                } else {
                    void chatViewHost?.postMessage({
                        type: 'compaction/failed',
                        sessionId: state.sessionId,
                        error: state.error
                    });
                }
            }
        }
    });
    tokenBudgetServiceRef = tokenBudgetService;
    context.subscriptions.push({
        dispose: () => { void tokenBudgetService.dispose(); }
    });
    // 把每次 token 用量变更推送给 webview，让 bypass 下拉右侧的 token-meter
    // 渲染「used / limit · pct%」。订阅本身在扩展生命周期内一直保持。
    context.subscriptions.push(tokenBudgetService.onDidChangeUsage((snapshot) => {
        void chatViewHost?.postMessage({
            type: 'tokenBudget/usage',
            sessionId: snapshot.sessionId,
            used: snapshot.current.totalInputForBudget + snapshot.current.outputTokens,
            limit: snapshot.contextLimit,
            threshold: snapshot.threshold,
            source: snapshot.lastSource
        });
    }));
    // 三个 proxy 共用的 usageSink 工厂：把 UsageReporter 抽到的 Anthropic 形态 usage
    // 直接喂给 TokenBudgetService.afterRecv。providerId 由 adapter 装配时显式传入
    // （上游 usage 里没有 providerId，只有 model 字段无法可靠反查 provider）。
    // requestBodyAtSend 由 service 在 beforeSend 阶段自行缓存
    // （lastRequestBodyBySession），sink 这里给空串即可。
    const buildUsageSink = (providerId: string): UsageSink => (report) => {
        const sessionId = currentChatCliSessionIdSync();
        if (!sessionId) return;
        tokenBudgetService.afterRecv({
            sessionId,
            providerId,
            modelId: report.model ?? '',
            usage: report,
            requestBodyAtSend: ''
        });
    };
    // 注：token 使用量统计也会被 CLI 自己在最终 `result` 事件中携带；这里 relay
    // 侧的统计与 CLI 侧统计并存，分别服务"token 预算/自动压缩"与"Chat UI 显示"。
    // adapter 在 handle() 里拿到 ctx.provider.id 后会调用 tokenBudget.beforeSend
    // 登记 sessionId↔providerId 映射；sink 触发时用 sessionId 查映射拿到正确的
    // providerId。为简化第一版，先按 adapter 实例与 provider 静态绑定方式
    // 透传——由 adapter handle() 中调用 buildUsageSink 时显式传入 provider.id。
    const usageSinkRef: { sink: UsageSink } = {
        sink: (report) => {
            const sessionId = currentChatCliSessionIdSync();
            if (!sessionId) return;
            const snapshot = tokenBudgetService.getSnapshot(sessionId);
            const providerId = snapshot?.providerId ?? '';
            if (!providerId) return;
            tokenBudgetService.afterRecv({
                sessionId,
                providerId,
                modelId: report.model ?? snapshot?.modelId ?? '',
                usage: report,
                requestBodyAtSend: ''
            });
        }
    };
    void buildUsageSink; // 保留工厂以便未来按 provider 实例化；当前用 sessionId 反查更稳。
    const editorAutoOpener = new EditorAutoOpener();
    const observeFileTool = (toolName: string, input: unknown): void => {
        const filePath = extractFilePathFromToolInput(toolName, input);
        if (!filePath) return;
        void editorAutoOpener.observeToolUse({ toolName, filePath });
    };
    const browserToolRelayHandler = createBrowserToolRelayHandler();
    const vscodeToolRelayHandler = createVscodeToolRelayHandler();
    const chatRelayHandler = createRelayRouter({
        configManager,
        llsTaskService,
        autoContinueScheduler,
        adapters: [
            new AnthropicProxyAdapter(
                debugRecorder,
                { configManager, llsTaskService, autoContinueScheduler },
                (report) => usageSinkRef.sink(report),
                tokenBudgetService,
                observeFileTool
            ),
            new OpenAIChatProxyAdapter(
                debugRecorder,
                { configManager, llsTaskService, autoContinueScheduler },
                (report) => usageSinkRef.sink(report),
                tokenBudgetService,
                observeFileTool
            ),
            new OpenAIResponsesProxyAdapter(
                debugRecorder,
                { configManager, llsTaskService, autoContinueScheduler },
                (report) => usageSinkRef.sink(report),
                tokenBudgetService,
                observeFileTool
            )
        ],
        onUpstreamTimeout: (kind) => {
            void handleUpstreamTimeoutAutoContinue(kind).catch((err: unknown) => {
                Logger.error(`上游超时自动 Continue 失败：${err instanceof Error ? err.message : String(err)}`);
            });
        },
        onUpstreamRequestStart: ({ route }) => {
            setRelayRouteBusy(route, true, 'relay_request_start');
        },
        onUpstreamRequestEnd: ({ route }) => {
            setRelayRouteBusy(route, false, 'relay_request_end');
        }
    });
    relayServer.setHandler(async (req, res) => {
        if (await browserToolRelayHandler(req, res)) return;
        if (await vscodeToolRelayHandler(req, res)) return;
        await chatRelayHandler(req, res);
    });

    relayServer.setOnHit(() => clearHttpExpectation('relay_hit'));
    void cleanupLegacyRelaySettingsSafely();

    context.subscriptions.push(configManager);
    context.subscriptions.push(normalCliProcess);
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
            void postChatPlanModelOptions().catch((err: unknown) => {
                Logger.warn(`刷新 Chat 方案模型列表失败：${err instanceof Error ? err.message : String(err)}`);
            });
            void postChatReviewModelOptions().catch((err: unknown) => {
                Logger.warn(`刷新 Chat 审查模型列表失败：${err instanceof Error ? err.message : String(err)}`);
            });
            void postModelsSnapshot().catch((err: unknown) => {
                Logger.warn(`刷新 Chat 模型选择快照失败：${err instanceof Error ? err.message : String(err)}`);
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
            if (
                event.affectsConfiguration(TOOL_AUTO_APPROVE_KEY) ||
                event.affectsConfiguration('workbench.browser.enableChatTools')
            ) {
                void postBrowserAutoApproveState().catch((err: unknown) => {
                    Logger.warn(`刷新浏览器自动放行状态失败：${err instanceof Error ? err.message : String(err)}`);
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

    await promptEnableBrowserChatToolsIfNeeded();

    // 当前活动编辑器选区变化时，按 Claude Code 方式同步行号/选区上下文。
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor !== vscode.window.activeTextEditor) return;
            const uri = event.textEditor.document.uri;
            if (uri.scheme === 'comment' || uri.scheme === 'output') return;
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
                await restartChatRelayAndCli();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                Logger.error(`重启本地中转与 Chat CLI 失败：${message}`);
                await vscode.window.showErrorMessage(`重启本地中转与 Chat CLI 失败：${message}`);
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
    clearPlanIdleDisposeTimer();
    clearReviewIdleDisposeTimer();
    relayServer?.dispose();
    relayServer = undefined;
    streamJsonCliAdapterSubscription?.dispose();
    streamJsonCliAdapterSubscription = undefined;
    normalStreamJsonAdapter?.dispose();
    normalStreamJsonAdapter = undefined;
    expertStreamJsonAdapterSubscription?.dispose();
    expertStreamJsonAdapterSubscription = undefined;
    expertStreamJsonAdapter?.dispose();
    expertStreamJsonAdapter = undefined;
    planStreamJsonAdapterSubscription?.dispose();
    planStreamJsonAdapterSubscription = undefined;
    planStreamJsonAdapter?.dispose();
    planStreamJsonAdapter = undefined;
    reviewStreamJsonAdapterSubscription?.dispose();
    reviewStreamJsonAdapterSubscription = undefined;
    reviewStreamJsonAdapter?.dispose();
    reviewStreamJsonAdapter = undefined;
    expertCliProcess?.dispose();
    expertCliProcess = undefined;
    planCliProcess?.dispose();
    planCliProcess = undefined;
    reviewCliProcess?.dispose();
    reviewCliProcess = undefined;
    normalCliProcess?.dispose();
    normalCliProcess = undefined;
    chatViewHost?.dispose();
    chatViewHost = undefined;
    cliResolver = undefined;
    chatCliConfigService = undefined;
    configViewProvider?.dispose();
    configViewProvider = undefined;
    llsTaskService?.dispose();
    llsTaskService = undefined;
    configManager?.dispose();
    configManager = undefined;
    extensionContext = undefined;
    settingsWriter = undefined;
}
