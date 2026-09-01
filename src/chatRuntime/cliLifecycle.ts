/**
 * Chat CLI 的生命周期管理：启动、重启、停止与适配器重建。
 *
 * 拆分自 extension.ts。依赖方向：本模块位于 routeState 之上、webviewMessages 之下。
 * 对上层模块（会话消息、CLI 事件处理、自愈、激活期装配）的调用一律通过
 * {@link configureCliLifecycle} 注入的回调完成，避免形成循环 import。
 */
import * as vscode from 'vscode';
import { StreamJsonCliAdapter, type ParsedCliEvent } from '../chat/cli/cliAdapter';
import { ChatCliConfigService } from '../chat/cli/cliConfig';
import { CliProcess } from '../chat/cli/cliProcess';
import { CliResolver } from '../chat/cli/cliResolver';
import { ChatCliSessionStore } from '../chat/cli/sessionStore';
import type { ChatCliConfig } from '../chat/cli/types';
import type { ChatRoute, ChatSegment } from '../chat/protocol';
import { Logger } from '../logger';
import { getChatViewHost, getRelayServer } from '../runtime';
import {
    chatCliCancelState,
    chatRouteState,
    getSessionIdForRoute,
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
    handleParsedCliEvent: (event: ParsedCliEvent, source: ChatRoute) => Promise<void>;
    /** CLI 结果文本命中权限拒绝时提示用户。 */
    notifyPermissionDeniedToUser: (resultText: string) => void;
    /** 记录三条 MCP 桥的注入状态。 */
    logMcpInjection: (config: ChatCliConfig) => void;
}

/** 注入的上层依赖，activate 期间必须先调用 {@link configureCliLifecycle} 赋值。 */
let deps: CliLifecycleDeps | undefined;

/** Chat CLI 路径解析器实例。 */
let cliResolver: CliResolver | undefined;

/** Chat CLI 配置服务实例。 */
let chatCliConfigService: ChatCliConfigService | undefined;

/** Chat CLI session_id 项目持久化存储。 */
let chatCliSessionStore: ChatCliSessionStore | undefined;

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
    if (!routes.normal.process || !chatCliConfigService) return;
    chatCliCancelState.requested = false;
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
    if (!chatCliConfigService || !routes.normal.process) {
        throw new Error('Chat CLI 组件尚未初始化');
    }
    const relayPort = await requireDeps().ensureRelayServerStarted();
    const { normal } = await chatCliConfigService.getRoutedConfigsWithRelayEnv(relayPort);
    await requireDeps().syncClaudeCliModelSettingsSafely();

    // ── normal CLI ─────────────────────────────────────────────────────
    const normalPersistedSessionId = await chatCliSessionStore?.readSessionId(normal.cwd, 'normal');
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
        await routes.normal.process.start(normalLaunchConfig);
        rebuildNormalAdapter();
    }
    await getChatViewHost()?.postMessage({ type: 'cli/status', status: 'running', detail: normal.cliPath });
}

/**
 * 重启 Chat CLI。
 *
 * 用于「模型选择保存」「Relay 端口变化」等需要让 CLI 拿到最新启动参数的场景。
 *
 * @param options.silent 是否抑制成功 toast。
 */
export async function restartChatCliPair(options: { silent?: boolean } = {}): Promise<void> {
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
    routes.normal.adapterSubscription = routes.normal.adapter.onParsedEvent((event) => {
        void requireDeps().handleParsedCliEvent(event, 'normal').catch((err: unknown) => {
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
    const detail = `source=${source}, code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}`;
    requireDeps().clearHttpExpectation(`${source}_cli_exit`);
    requireDeps().cancelPendingResend(`${source}_cli_exit`);
    if (source === 'normal') {
        await getChatViewHost()?.postMessage({ type: 'cli/status', status: event.code === 0 ? 'exited' : 'error', detail });
    }
    if (chatCliCancelState.requested && source === 'normal') {
        chatCliCancelState.requested = false;
        await requireDeps().finishActiveAssistantMessage();
        return;
    }
    if (event.code === 0) return;
    const restart = '重启 CLI';
    const choice = await vscode.window.showErrorMessage(`${source} Chat CLI 异常退出：${detail}`, restart);
    if (choice === restart) {
        await restartChatCli();
    }
}
