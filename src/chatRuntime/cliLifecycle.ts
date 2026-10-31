/**
 * Chat CLI 的生命周期管理：启动、重启、停止与适配器重建。
 *
 * 拆分自 extension.ts。依赖方向：本模块位于 routeState 之上、webviewMessages 之下。
 * 对上层模块（会话消息、CLI 事件处理、自愈、激活期装配）的调用一律通过
 * {@link configureCliLifecycle} 注入的回调完成，避免形成循环 import。
 */
import * as vscode from 'vscode';
import { issueImageCapability } from '../imageTools/entry';
import { isCliUpdateInProgress } from '../setup/gate';
import { StreamJsonCliAdapter, type ParsedCliEvent } from '../chat/cli/cliAdapter';
import { getRecoveryAdapterIdentity, bindRecoveryAdapter, requestRecoveryController } from './selfHealing';
import type { RecoveryContext, RecoveryIdentity } from './requestRecovery';
import { ChatCliConfigService } from '../chat/cli/cliConfig';
import { clearCliVersionCache } from '../chat/cli/nativeCompactionProbe';
import { notifyNativeCompactionUnsupported } from './nativeCompactionNotice';
import { CliProcess } from '../chat/cli/cliProcess';
import { CliResolver } from '../chat/cli/cliResolver';
import { ChatCliSessionStore } from '../chat/cli/sessionStore';
import type { ChatCliConfig } from '../chat/cli/types';
import type { ChatRoute, ChatSegment } from '../chat/protocol';
import { Logger } from '../logger';
import { AUTO_COMPACT_SETTING_KEY, type NativeCompactionPolicy } from '../nativeCompactionPolicy';
import { getLlsCcaiTaskTexts } from '../llsTask/messages';
import { getChatViewHost, getConfigManager, getLlsTaskService, getRelayServer } from '../runtime';
import {
    chatCliCancelState,
    chatRouteState,
    getSessionIdForRoute,
    isAnyRouteBusy,
    pendingAskUserRequests,
    resetAllRouteBusy,
    routes
} from './routeState';

/** cliLifecycle 对尚未拆出的上层模块的依赖，由 activate 在装配期注入。 */
export interface CliLifecycleDeps {
    /** 启动（或复用）本地中转 HTTP 服务并返回实际端口。 */
    ensureRelayServerStarted: () => Promise<number>;
    /** 把当前模型选择同步写入 Claude CLI settings.json，失败只记日志。 */
    syncClaudeCliModelSettingsSafely: () => Promise<void>;
    /** 向 Chat 追加一段 assistant 内容。 */
    appendAssistantSegments: (segments: ChatSegment[], done: boolean) => Promise<void>;
    /** 结束当前活动的 assistant 消息。 */
    finishActiveAssistantMessage: () => Promise<void>;
    /** 在 Chat 中弹出一条 toast。 */
    showChatToast: (level: 'success' | 'warn' | 'error', text: string) => Promise<void>;
    /** 清除待响应的 HTTP 期望。 */
    clearHttpExpectation: (reason: string) => void;
    /** 取消待执行的自愈重发。 */
    cancelPendingResend: (reason: string) => void;
    /** 处理适配器解析出的 CLI 事件。 */
    handleParsedCliEvent: (event: ParsedCliEvent, source: ChatRoute, identity?: RecoveryIdentity) => Promise<void>;
    /** CLI 结果文本命中权限拒绝时提示用户。 */
    notifyPermissionDeniedToUser: (resultText: string) => void;
    /** 记录三条 MCP 桥的注入状态。 */
    logMcpInjection: (config: ChatCliConfig) => void;
    /** 读取压缩在途状态和释放旧 CLI 锁，避免反向依赖 chatSession。 */
    getCompactionService?: () => import('../relay/tokenBudget/service').TokenBudgetService | undefined;
}

/** 注入的上层依赖，activate 期间必须先调用 {@link configureCliLifecycle} 赋值。 */
let deps: CliLifecycleDeps | undefined;

/** Chat CLI 路径解析器实例。 */
let cliResolver: CliResolver | undefined;

/** Chat CLI 配置服务实例。 */
let chatCliConfigService: ChatCliConfigService | undefined;

/** Chat CLI session_id 项目持久化存储。 */
let chatCliSessionStore: ChatCliSessionStore | undefined;

/**
 * CLI 启动/重启串行队列。
 *
 * Webview 消息、模型切换和自愈都可能同时请求重启；若并发执行，两次 start()
 * 会互相清理刚创建的新进程。队列保证任意时刻只有一个启动流程在改写进程与 adapter。
 */
let cliStartQueue: Promise<void> = Promise.resolve();

/** 已应用策略与待重启状态；仅当前 CLI 实例生效，配置不强杀活动工具链。 */
let appliedNativePolicy: NativeCompactionPolicy | undefined;
let appliedNativeModel = '';
let appliedCliPath = '';
let pendingNativePolicy = false;
let nativeRefreshTimer: NodeJS.Timeout | undefined;

/** 回填已应用策略和下次重启状态，不输出用户完整环境。 */
export async function postNativeCompactionState(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('claudeCodeConfigHelper').get<boolean>(AUTO_COMPACT_SETTING_KEY, false) === true;
    await getChatViewHost()?.postMessage({
        type: 'autoCompact/current', enabled, pending: pendingNativePolicy, policy: appliedNativePolicy
    });
}

/** 通知不等待用户操作；重新选择只保存路径，由安全空闲重启流程应用。 */
function showNativeCompactionNotice(config: ChatCliConfig): void {
    void notifyNativeCompactionUnsupported(config.nativeCompaction, config.cliPath, {
        language: getConfigManager()?.getResolvedUiLanguage() ?? 'en',
        warn: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
        retry: () => { clearCliVersionCache(); scheduleNativeCompactionRefresh(); },
        select: async () => {
            const selected = await cliResolver?.selectCliPath();
            if (selected) { clearCliVersionCache(); scheduleNativeCompactionRefresh(); }
        }
    }).catch(error => Logger.warn(`显示原生压缩兼容提示失败：${String(error)}`));
}

/** 判断当前实例能否安全应用环境变更；HTTP 工具间隙不算整轮空闲。 */
function canApplyNativePolicy(): boolean {
    const recoveryState = requestRecoveryController.getSnapshot()?.state;
    return !isCliUpdateInProgress() && !isAnyRouteBusy() && !pendingAskUserRequests.size
        && !['native_retry', 'waiting_recovery', 'recovering'].includes(recoveryState || '')
        && !deps?.getCompactionService?.()?.isCompactionInFlight(getSessionIdForRoute('normal'));
}

/**
 * 配置变化后延迟合并刷新；普通模型切换仍复用已有的显式重启流程。
 * @returns 安排完成，不等待或中止当前任务。
 */
export function scheduleNativeCompactionRefresh(): void {
    if (nativeRefreshTimer) clearTimeout(nativeRefreshTimer);
    nativeRefreshTimer = setTimeout(() => {
        nativeRefreshTimer = undefined;
        void refreshNativeCompactionPolicy().catch(error => Logger.warn(`原生压缩策略应用失败：${String(error)}`));
    }, 200);
}

/** 读取新策略，忙碌时待应用，空闲时以原会话重启；不启动尚未运行的 CLI。 */
async function refreshNativeCompactionPolicy(): Promise<void> {
    const port = getRelayServer()?.getActualPort();
    if (!chatCliConfigService || !routes.normal.process?.isRunning() || !port) {
        await postNativeCompactionState();
        return;
    }
    const config = await chatCliConfigService.getConfigWithRelayEnv(port);
    pendingNativePolicy = JSON.stringify(config.nativeCompaction) !== JSON.stringify(appliedNativePolicy)
        || (config.model || '') !== appliedNativeModel || config.cliPath !== appliedCliPath;
    await postNativeCompactionState();
    await applyPendingNativeCompactionPolicy();
}

/** 在整轮 result 或恢复结束的安全点应用待重启配置，队列内再次检查忙碌状态。 */
export async function applyPendingNativeCompactionPolicy(): Promise<void> {
    if (!pendingNativePolicy || !canApplyNativePolicy()) return;
    const run = cliStartQueue.then(async () => {
        if (!pendingNativePolicy || !canApplyNativePolicy()) return;
        await performStartChatCliPair({ forceRestart: false });
    });
    cliStartQueue = run.catch(() => undefined);
    await run;
}


/** 注入上层依赖；必须在任何其它导出函数之前调用。 */
export function configureCliLifecycle(value: CliLifecycleDeps): void {
    deps = value;
}

/** 读取已注入的依赖，未装配时直接抛错以暴露装配顺序问题。 */
function requireDeps(): CliLifecycleDeps {
    if (!deps) throw new Error('cliLifecycle 尚未装配');
    return deps;
}

/** 创建 CLI 配置服务、路径解析器、session 存储与 normal CLI 进程实例。 */
export function createCliLifecycleServices(configService: ChatCliConfigService): void {
    chatCliConfigService = configService;
    cliResolver = new CliResolver(configService);
    chatCliSessionStore = new ChatCliSessionStore();
    routes.normal.process = new CliProcess();
}

/** 取 Chat CLI 配置服务实例，未装配时返回 undefined。 */
export function getChatCliConfigService(): ChatCliConfigService | undefined {
    return chatCliConfigService;
}

/** 取 Chat CLI 路径解析器实例，未装配时返回 undefined。 */
export function getCliResolver(): CliResolver | undefined {
    return cliResolver;
}

/** 取 Chat CLI session 存储实例，未装配时返回 undefined。 */
export function getChatCliSessionStore(): ChatCliSessionStore | undefined {
    return chatCliSessionStore;
}

/** 释放本模块持有的服务引用（deactivate 调用）。 */
export function disposeCliLifecycleServices(): void {
    if (nativeRefreshTimer) clearTimeout(nativeRefreshTimer);
    nativeRefreshTimer = undefined;
    appliedNativePolicy = undefined;
    appliedNativeModel = '';
    appliedCliPath = '';
    pendingNativePolicy = false;
    cliResolver = undefined;
    chatCliConfigService = undefined;
    chatCliSessionStore = undefined;
}

/**
 * 让用户选择或更换内置 Chat 使用的 Claude CLI 路径。
 *
 * 选择成功后会写入配置并立即按 stream-json 长连接参数启动 CLI，
 * 方便用户尽早发现路径或权限问题。
 */
export async function selectChatCli(): Promise<void> {
    if (!cliResolver || !chatCliConfigService || !routes.normal.process) return;
    const cliPath = await cliResolver.selectCliPath();
    if (!cliPath) return;
    await startChatCliFromCurrentConfig();
    await requireDeps().showChatToast('success', `已选择并启动 Claude CLI：${cliPath}`);
}

/**
 * 重启内置 Chat 的 CLI 长连接进程。
 *
 * 如果进程尚未启动，则按当前配置和路径选择逻辑启动一个新进程。
 */
export async function restartChatCli(options: { silent?: boolean } = {}): Promise<void> {
    deps?.cancelPendingResend('manual_cli_restart');
    if (!routes.normal.process || !chatCliConfigService) return;
    chatCliCancelState.requested = false;
    resetAllRouteBusy();
    await startChatCliFromCurrentConfig({ forceRestart: true });
    if (!options.silent) {
        await requireDeps().showChatToast('success', 'Chat CLI 长连接已重启。');
    }
}

/**
 * 确保 Chat CLI 路径可用且长连接进程处于运行状态。
 *
 * @throws 用户取消选择、路径无效或启动失败时抛出错误。
 */
export async function ensureChatCliStarted(): Promise<void> {
    if (!cliResolver || !chatCliConfigService || !routes.normal.process) {
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
 * 把 usage 报到对应的 TokenBudgetService 桶里。
 *
 * @returns sessionId 字符串；未知时返回空串。
 */
export function currentChatCliSessionIdSync(): string {
    return getSessionIdForRoute(chatRouteState.active);
}

export async function restartChatRelayAndCli(options: { silent?: boolean } = {}): Promise<void> {
    const relayServer = getRelayServer();
    if (!routes.normal.process || !chatCliConfigService || !relayServer) return;
    chatCliCancelState.requested = false;
    requireDeps().clearHttpExpectation('manual_restart');
    requireDeps().cancelPendingResend('manual_restart');

    const oldPort = relayServer.getActualPort();
    void requireDeps().appendAssistantSegments(
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
        void requireDeps().appendAssistantSegments(
            [{ kind: 'error', text: `\n本地中转 HTTP 服务停止失败：${message}\n` }],
            false
        );
        throw err;
    }

    void requireDeps().appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在停止 Claude CLI 子进程…\n' }],
        false
    );
    try {
        await stopChatCliPair();
        Logger.info('手动重启：Chat CLI pair 已停止');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`手动重启：Chat CLI 停止失败：${message}`);
        void requireDeps().appendAssistantSegments(
            [{ kind: 'error', text: `\nClaude CLI 停止失败：${message}\n` }],
            false
        );
        throw err;
    }

    void requireDeps().appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在启动本地中转 HTTP 服务…\n' }],
        false
    );
    try {
        const newPort = await requireDeps().ensureRelayServerStarted();
        Logger.info(`手动重启：Relay 已启动，新端口=${newPort}`);
        void requireDeps().appendAssistantSegments(
            [{ kind: 'markdown', text: `\n> 本地中转 HTTP 服务已启动：http://127.0.0.1:${newPort}\n` }],
            false
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`手动重启：Relay 启动失败：${message}`);
        void requireDeps().appendAssistantSegments(
            [{ kind: 'error', text: `\n本地中转 HTTP 服务启动失败：${message}\n` }],
            false
        );
        throw err;
    }

    void requireDeps().appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在启动 Claude CLI 子进程…\n' }],
        false
    );
    try {
        await startChatCliFromCurrentConfig({ forceRestart: true });
        Logger.info('手动重启：Chat CLI 已启动完成');
        void requireDeps().appendAssistantSegments(
            [{ kind: 'markdown', text: '\n> Claude CLI 已重启完成\n' }],
            false
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`手动重启：Chat CLI 启动失败：${message}`);
        void requireDeps().appendAssistantSegments(
            [{ kind: 'error', text: `\nClaude CLI 启动失败：${message}\n` }],
            false
        );
        throw err;
    }

    if (!options.silent) {
        await requireDeps().showChatToast('success', '本地中转与 Chat CLI 已重启。');
    }
}

/**
 * 按当前配置启动 Chat CLI 长连接进程。
 *
 * 内部委托 {@link startChatCliPair}。保留本函数名是为了让 token budget 自愈、
 * selectChatCli 等老调用点维持原 API；新增代码请直接调用 {@link startChatCliPair}。
 *
 * @throws 配置无效或子进程启动失败时抛出错误。
 */
export async function startChatCliFromCurrentConfig(options: { forceRestart?: boolean } = {}): Promise<void> {
    await startChatCliPair(options);
}

/**
 * 启动 normal Chat CLI 长连接并重建对应的 stream-json 适配器。
 *
 * 任务流模型复用 normal CLI（仅切换模型后重启），因此这里只维护 normal 一路。
 * 其 `--append-system-prompt` 来自 {@link ChatCliConfigService.getRoutedConfigsWithRelayEnv}
 * 的 dispatcher 默认文案或用户配置 `chat.dispatcher.appendSystemPrompt` 覆盖值。
 *
 * @param options.forceRestart 为 true 时即使配置未变也强制重启。
 * @throws Chat CLI 组件未初始化时抛出错误。
 */
export async function startChatCliPair(options: { forceRestart?: boolean } = {}): Promise<void> {
    if (!await (await import('../setup/gate')).requireSetup()) throw new Error('请先完成扩展安装引导 / Complete extension setup first');
    const run = cliStartQueue.then(() => {
        if (isCliUpdateInProgress()) throw new Error('CLI update in progress');
        return performStartChatCliPair(options);
    });
    // 失败只交给本次调用方；队列自身恢复为空闲态，避免一次失败毒化后续启动。
    cliStartQueue = run.catch(() => undefined);
    return run;
}

/** Stop and detach the previous main CLI before replacing its displayed transcript or saved session identity. */
export async function stopSidebarForHistorySwitch(): Promise<void> {
    const action = cliStartQueue.then(async () => {
        if (!routes.normal.process) return;
        chatCliCancelState.requested = true;
        requireDeps().cancelPendingResend('session_resume');
        requireDeps().clearHttpExpectation('session_resume');
        routes.normal.adapterSubscription?.dispose(); routes.normal.adapterSubscription = undefined;
        routes.normal.adapter?.dispose(); routes.normal.adapter = undefined;
        pendingAskUserRequests.clear();
        await routes.normal.process.stop();
        resetAllRouteBusy();
        await requireDeps().finishActiveAssistantMessage();
    });
    cliStartQueue = action.catch(() => undefined);
    await action;
}

/** Drain previously admitted startup and stop the sidebar without permitting automatic task replay.
 * @returns Whether a live sidebar was stopped and must be restored by the update coordinator.
 * @throws If the old process cannot be confirmed stopped; the caller must not replace it.
 */
export async function prepareSidebarCliUpdate(): Promise<boolean> {
    await cliStartQueue;
    if (!routes.normal.process?.isRunning()) return false;
    chatCliCancelState.requested = true;
    requireDeps().cancelPendingResend('CLI update');
    requireDeps().clearHttpExpectation('CLI update');
    routes.normal.adapterSubscription?.dispose();
    routes.normal.adapter?.dispose(); routes.normal.adapter = undefined;
    pendingAskUserRequests.clear();
    await routes.normal.process.stop();
    resetAllRouteBusy();
    await requireDeps().finishActiveAssistantMessage();
    return true;
}

/** Restart an already-owned sidebar process after a user-approved managed CLI update.
 * The caller blocks new admissions and has already validated the replacement executable.
 */
export async function restartSidebarAfterCliUpdate(): Promise<void> {
    chatCliCancelState.requested = false;
    const run = cliStartQueue.then(() => performStartChatCliPair({ forceRestart: true }));
    cliStartQueue = run.catch(() => undefined);
    await run;
}

/**
 * 实际执行一次 normal CLI 启动与 adapter 重建。
 *
 * 只允许由 {@link startChatCliPair} 的串行队列调用，避免并发 start() 互相终止
 * 对方刚创建的子进程。
 *
 * @param options.forceRestart 为 true 时即使配置未变也强制重启。
 */
async function performStartChatCliPair(options: { forceRestart?: boolean }): Promise<void> {
    if (!chatCliConfigService || !routes.normal.process) {
        throw new Error('Chat CLI 组件尚未初始化');
    }
    const relayPort = await requireDeps().ensureRelayServerStarted();
    const { normal } = await chatCliConfigService.getRoutedConfigsWithRelayEnv(relayPort);
    await requireDeps().syncClaudeCliModelSettingsSafely();

    // ── normal CLI ─────────────────────────────────────────────────────
    if (!options.forceRestart && routes.normal.process.isRunning() && !canApplyNativePolicy()) {
        pendingNativePolicy = JSON.stringify(normal.nativeCompaction) !== JSON.stringify(appliedNativePolicy)
            || (normal.model || '') !== appliedNativeModel || normal.cliPath !== appliedCliPath;
        await postNativeCompactionState();
        return;
    }
    const normalPersistedSessionId = getSessionIdForRoute('normal')
        || await chatCliSessionStore?.readSessionId(normal.cwd, 'normal');
    const normalLaunchConfig = { ...normal, resumeSessionId: normalPersistedSessionId };
    if (!options.forceRestart && routes.normal.process.isRunningWithConfig(normalLaunchConfig)) {
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
        chatCliCancelState.requested = false;
        requireDeps().logMcpInjection(normalLaunchConfig);
        // await 读取配置/会话期间可能有新任务到达，spawn 前最后检查一次。
        if (!options.forceRestart && routes.normal.process.isRunning() && !canApplyNativePolicy()) {
            pendingNativePolicy = true;
            await postNativeCompactionState();
            return;
        }
        deps?.getCompactionService?.()?.releaseCliCompactions(getSessionIdForRoute('normal'), 'CLI restarted');
        const imageBridge = normalLaunchConfig.mcpServers?.llsccaiImage;
        if (imageBridge) imageBridge.env = { ...imageBridge.env, LLS_IMAGE_TOOL_CAPABILITY: issueImageCapability('main', normalLaunchConfig.cwd ?? '') };
        await routes.normal.process.start(normalLaunchConfig);
        rebuildNormalAdapter();
    }
    appliedNativePolicy = normal.nativeCompaction;
    appliedNativeModel = normal.model || '';
    appliedCliPath = normal.cliPath;
    pendingNativePolicy = false;
    showNativeCompactionNotice(normal);
    await postNativeCompactionState();
    await getChatViewHost()?.postMessage({ type: 'cli/status', status: 'running', detail: normal.cliPath });
}

/**
 * 重启 Chat CLI。
 *
 * 用于「模型选择保存」「Relay 端口变化」等需要让 CLI 拿到最新启动参数的场景。
 *
 * @param options.silent 是否抑制成功 toast。
 */
/** 恢复前先终止旧进程，明确指定原会话；每次 await 后检查取消。 */
export async function recoverCliForRequest(context: Readonly<RecoveryContext>, signal: AbortSignal, restartRelay: boolean): Promise<void> {
    const run = cliStartQueue.then(() => performRecoveryCliStart(context, signal, restartRelay));
    cliStartQueue = run.catch(() => undefined);
    await run;
}

/** 与普通启动共用串行队列，防止恢复重启覆盖用户新启动。 */
async function performRecoveryCliStart(context: Readonly<RecoveryContext>, signal: AbortSignal, restartRelay: boolean): Promise<void> {
    signal.throwIfAborted();
    const process = routes.normal.process;
    const service = chatCliConfigService;
    if (!process || !service || !context.sessionId || getSessionIdForRoute('normal') !== context.sessionId) throw new Error('Original recovery session unavailable');
    routes.normal.adapterSubscription?.dispose();
    routes.normal.adapter?.dispose();
    await process.stop();
    signal.throwIfAborted();
    if (restartRelay) {
        const relay = getRelayServer();
        if (!relay) throw new Error('Relay unavailable');
        await relay.restart();
        signal.throwIfAborted();
    }
    const port = await requireDeps().ensureRelayServerStarted();
    signal.throwIfAborted();
    const configs = await service.getRoutedConfigsWithRelayEnv(port);
    signal.throwIfAborted();
    if (getSessionIdForRoute('normal') !== context.sessionId) throw new Error('Recovery session changed');
    deps?.getCompactionService?.()?.releaseCliCompactions(context.sessionId, 'CLI recovery restart');
    resetAllRouteBusy();
    const imageBridge = configs.normal.mcpServers?.llsccaiImage;
    if (imageBridge) imageBridge.env = { ...imageBridge.env, LLS_IMAGE_TOOL_CAPABILITY: issueImageCapability('main', configs.normal.cwd ?? '') };
    await process.start({ ...configs.normal, resumeSessionId: context.sessionId });
    appliedNativePolicy = configs.normal.nativeCompaction;
    appliedNativeModel = configs.normal.model || '';
    appliedCliPath = configs.normal.cliPath;
    pendingNativePolicy = false;
    showNativeCompactionNotice(configs.normal);
    await postNativeCompactionState();
    signal.throwIfAborted();
    rebuildNormalAdapter();
}

export async function restartChatCliPair(options: { silent?: boolean } = {}): Promise<void> {
    deps?.cancelPendingResend('manual_pair_restart');
    if (!routes.normal.process || !chatCliConfigService) return;
    chatCliCancelState.requested = false;
    resetAllRouteBusy();
    await startChatCliPair({ forceRestart: true });
    if (!options.silent) {
        await requireDeps().showChatToast('success', 'Chat CLI 长连接已重启。');
    }
}

/**
 * 停止 Chat CLI。
 *
 * 与 `dispose` 的区别：仅终止子进程，保留模块级实例引用与订阅，便于后续
 * 重新调用 {@link startChatCliPair}。
 */
export async function stopChatCliPair(): Promise<void> {
    requireDeps().cancelPendingResend('stop_cli');
    deps?.getCompactionService?.()?.releaseCliCompactions(getSessionIdForRoute('normal'), 'CLI stopped');
    resetAllRouteBusy();
    // CLI 即将停止，等待中的 AskUserQuestion 弹窗请求全部作废，防止残留死等条目。
    pendingAskUserRequests.clear();
    if (routes.normal.process) {
        try {
            await routes.normal.process.stop();
        } catch (err) {
            Logger.warn('停止 normal Chat CLI 失败：' + (err instanceof Error ? err.message : String(err)));
        }
    }
}

/**
 * 重建 normal CLI 的 stream-json 适配器并订阅 ParsedCliEvent。每次 normal CLI
 * 启动 / 重启时本函数会被调用，确保订阅指向最新子进程。
 */
export function rebuildNormalAdapter(): void {
    if (!routes.normal.process) throw new Error('Chat CLI 进程尚未初始化');
    routes.normal.adapterSubscription?.dispose();
    routes.normal.adapter?.dispose();
    routes.normal.adapter = new StreamJsonCliAdapter(routes.normal.process, (resultText) => {
        requireDeps().notifyPermissionDeniedToUser(resultText);
    });
    const adapter = routes.normal.adapter;
    routes.normal.adapterSubscription = adapter.onParsedEvent((event) => {
        // 旧 adapter 的异步/迟到事件不能复位新进程的压缩状态。
        if (routes.normal.adapter !== adapter) return;
        let identity = getRecoveryAdapterIdentity(adapter);
        if (identity && event.type === 'session/init' && !identity.sessionId) {
            const bound = requestRecoveryController.bindSession(identity, event.sessionId);
            if (bound) { bindRecoveryAdapter(adapter, bound); identity = bound; }
        }
        void requireDeps().handleParsedCliEvent(event, 'normal', identity).catch((err: unknown) => {
            Logger.error('处理 normal CLI 流式事件失败', err);
        });
    });
}

/**
 * 订阅 Chat CLI 进程状态变化并把异常状态同步到 Webview。
 *
 * @param context 扩展上下文，用于注册 Disposable。
 */
export function registerChatCliStatusHandlers(context?: vscode.ExtensionContext): void {
    bindNormalCliStatusHandlers();
    if (context) {
        context.subscriptions.push({
            dispose: () => {
                routes.normal.statusSubscription?.dispose();
                routes.normal.statusSubscription = undefined;
                routes.normal.exitSubscription?.dispose();
                routes.normal.exitSubscription = undefined;
            }
        });
    }
}

/**
 * 订阅 normal CLI 进程状态变化。
 */
export function bindNormalCliStatusHandlers(): void {
    if (!routes.normal.process || routes.normal.statusSubscription || routes.normal.exitSubscription) return;
    routes.normal.statusSubscription = routes.normal.process.onStatus((status) => {
        void getChatViewHost()?.postMessage({ type: 'cli/status', status: mapCliStatusForWebview(status) });
    });
    routes.normal.exitSubscription = routes.normal.process.onExit((event) => {
        void handleChatCliExit(event, 'normal').catch((err: unknown) => {
            Logger.error('处理 normal Chat CLI 退出事件失败', err);
        });
    });
}

/**
 * 把 CliProcess 内部状态映射为 Webview 协议状态。
 *
 * @param status CLI 内部状态。
 * @returns Webview 可展示状态。
 */
export function mapCliStatusForWebview(status: ReturnType<CliProcess['getStatus']>): 'idle' | 'running' | 'exited' | 'error' {
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
export async function handleChatCliExit(
    event: { code: number | null; signal: NodeJS.Signals | null },
    source: ChatRoute = 'normal'
): Promise<void> {
    deps?.getCompactionService?.()?.releaseCliCompactions(getSessionIdForRoute(source), 'CLI exited');
    resetAllRouteBusy();
    const detail = `source=${source}, code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}`;
    const recoveryIdentity = routes.normal.adapter && getRecoveryAdapterIdentity(routes.normal.adapter);
    requireDeps().clearHttpExpectation(`${source}_cli_exit`);
    if (chatCliCancelState.requested) requireDeps().cancelPendingResend(`${source}_cli_exit`);
    else if (recoveryIdentity) requestRecoveryController.onCliTurnFinished(recoveryIdentity, true, { code: 'cli_exited' });
    if (source === 'normal') {
        await getChatViewHost()?.postMessage({ type: 'cli/status', status: event.code === 0 ? 'exited' : 'error', detail });
    }
    if (chatCliCancelState.requested && source === 'normal') {
        chatCliCancelState.requested = false;
        await requireDeps().finishActiveAssistantMessage();
        return;
    }
    if (event.code === 0) return;

    const texts = getLlsCcaiTaskTexts(getConfigManager()?.getResolvedUiLanguage() ?? 'en');
    const message = texts.cliExitedTitle.replace('{source}', source).replace('{detail}', detail);

    // 异常退出没有可靠网络故障分类；不因任务流存在而绕过恢复策略重启。

    const choice = await vscode.window.showErrorMessage(message, texts.cliRestartAction);
    if (choice === texts.cliRestartAction) {
        await restartChatCli();
    }
}
