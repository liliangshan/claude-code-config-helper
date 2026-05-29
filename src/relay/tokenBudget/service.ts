/**
 * @file TokenBudgetService —— token 预算与自动压缩协调器。
 *
 * 入口职责：
 * 1. `beforeSend`：请求即将发往上游前调用，只做估算与登记，不改写 body；
 * 2. `afterRecv`：UsageReporter sink 触发时调用，用上游 usage 权威值覆盖
 *    current，写盘，并在阈值触达时异步启动"自动压缩 → 切新 session"流程；
 * 3. `getSnapshot` / `onDidChangeUsage` / `onCompactionStateChanged`：暴露给
 *    状态栏 / Webview 的只读视图。
 *
 * 详细设计见 .LLSOAI/token-budget.md（v2，2026-05-25）。
 */

import * as vscode from 'vscode';

import { Logger } from '../../logger';
import type { ConfigManager } from '../../configManager';
import type { UsageReport } from '../usageReporter';
import { estimateAnthropicInputTokens } from './estimator';
import {
    createEmptySession,
    TokenCountStore,
    type SessionUsage,
    type UsageHistoryEntry
} from './store';

/** 默认上下文上限（无配置、无静态表命中时的兜底）。 */
const DEFAULT_CONTEXT_LIMIT = 166_000;

/** 阈值 = contextLimit - 此常量。 */
const THRESHOLD_RESERVE = 50_000;

/** 自动压缩防抖窗口（毫秒）。 */
const COMPACT_DEBOUNCE_MS = 60_000;

/** 压缩状态最长允许在途时间（毫秒），超过后视为上次压缩已丢失事件。 */
const COMPACT_STALE_MS = 5 * 60_000;

/** 发送给 Claude CLI 的原生上下文压缩指令。 */
export const CLAUDE_COMPACT_COMMAND = '/compact';
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'claude-opus-4-7': 200_000,
    'claude-sonnet-4-6': 200_000,
    'claude-haiku-4-5': 200_000,
    'claude-haiku-4-5-20251001': 200_000,
    'claude-3-5-sonnet': 200_000,
    'claude-3-5-haiku': 200_000,
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    'gpt-4-turbo': 128_000
};

/** 请求侧登记的入参。 */
export interface BeforeSendInput {
    /** CLI session_id。 */
    sessionId: string;
    /** 提供商 id。 */
    providerId: string;
    /** 模型 id（不带 providerId 前缀）。 */
    modelId: string;
    /** Anthropic 形态的请求体文本（已注入任务流工具）。 */
    anthropicBody: string;
}

/** 响应侧 usage 上报的入参。 */
export interface AfterRecvInput {
    /** CLI session_id。 */
    sessionId: string;
    /** 提供商 id。 */
    providerId: string;
    /** 模型 id。 */
    modelId: string;
    /** Anthropic usage 字段（已被 UsageReporter 归一化）。 */
    usage: UsageReport;
    /** 本轮上行 Anthropic 形态请求体；afterRecv 触发压缩时作为 messages 输入。 */
    requestBodyAtSend: string;
}

/** 自动压缩状态机事件。 */
export type CompactionState =
    | { kind: 'started'; sessionId: string; beforeTokens: number }
    | { kind: 'finished'; sessionId: string; oldSessionId: string; newSessionId: string; beforeTokens: number; afterTokens: number; summary: string }
    | { kind: 'failed'; sessionId: string; error: string };

/** 等待 CLI 原生压缩完成时的结果。 */
export type CompactionWaitResult = 'success' | 'failed' | 'timeout' | 'skipped';

/** Webview 推送通道契约（最小子集，避免循环依赖整个 ChatViewHost）。 */
export interface CompactionNotifier {
    /**
     * 通知 webview 自动压缩状态变化。
     *
     * @param state 状态机事件。
     */
    notifyCompactionState(state: CompactionState): void;
}

/** TokenBudgetService 构造依赖。 */
export interface TokenBudgetServiceDeps {
    /** 配置管理器；用于读取 provider/model 的 contextLength。 */
    configManager: ConfigManager;
    /** 用于请求 CLI 执行原生 /compact。 */
    commandSender?: (command: string) => Promise<void>;
    /** webview 推送通道；未注入时仅写日志，不发事件。 */
    notifier?: CompactionNotifier;
}

/**
 * Token 预算与自动压缩协调器。
 *
 * 单例（每个扩展宿主进程一个），在 activate() 时构造并 push 到 subscriptions
 * 以保证 dispose 时 flush 落盘。
 */
export class TokenBudgetService implements vscode.Disposable {
    /** 持久化层。 */
    private readonly store = new TokenCountStore();

    /** 已加载标记。 */
    private loaded = false;

    /** usage 变更事件。 */
    private readonly usageEmitter = new vscode.EventEmitter<SessionUsage>();

    /** 压缩状态机事件。 */
    private readonly compactionEmitter = new vscode.EventEmitter<CompactionState>();

    /** usage 变更事件订阅入口。 */
    public readonly onDidChangeUsage = this.usageEmitter.event;

    /** 压缩状态机事件订阅入口。 */
    public readonly onCompactionStateChanged = this.compactionEmitter.event;

    /** 记录每轮请求最近一次的 anthropicBody。 */
    private readonly lastRequestBodyBySession = new Map<string, string>();

    /**
     * 创建服务实例。
     *
     * @param deps 注入依赖。
     */
    public constructor(private readonly deps: TokenBudgetServiceDeps) {}

    /**
     * 手动触发当前 session 的上下文压缩。
     *
     * 由 webview token-meter 悬浮按钮调用。不检查阈值，只检查：session 存在、
     * 不在压缩中、存在最近一次请求体、依赖已注入。
     *
     * @param sessionId CLI session_id。
     * @returns 是否成功启动压缩流程。
     */
    public compactNow(sessionId: string): boolean {
        Logger.info(`[tokenBudget] 手动压缩请求：session=${sessionId || '(none)'}`);
        if (!sessionId) return false;
        void this.ensureLoaded();
        const session = this.store.getSession(sessionId);
        if (!session) {
            Logger.warn(`[tokenBudget] 手动压缩失败：session=${sessionId} 不存在`);
            return false;
        }
        if (session.compact.inProgress) {
            Logger.warn(`[tokenBudget] 手动压缩复位在途状态并重新发送：session=${sessionId}`);
            this.resetCompactionState(session, 'manual compact retry');
        }
        if (!this.deps.commandSender) {
            Logger.warn('[tokenBudget] 手动压缩失败：commandSender 未注入');
            return false;
        }
        this.markCompactionCommandPending(session);
        void this.sendCompactionCommand(session.sessionId);
        return true;
    }

    /**
     * 手动触发压缩并等待 CLI 回报压缩结果。
     *
     * @param sessionId CLI session_id。
     * @param options 等待配置。
     * @returns 压缩等待结果。
     */
    public compactNowAndWait(sessionId: string, options: { timeoutMs: number }): Promise<CompactionWaitResult> {
        if (!this.compactNow(sessionId)) return Promise.resolve('skipped');
        return new Promise<CompactionWaitResult>((resolve) => {
            let settled = false;
            let subscription: vscode.Disposable | undefined;
            const finish = (result: CompactionWaitResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                subscription?.dispose();
                resolve(result);
            };
            const timer = setTimeout(() => finish('timeout'), Math.max(1, options.timeoutMs));
            subscription = this.onCompactionStateChanged((state) => {
                if (state.sessionId !== sessionId) return;
                if (state.kind === 'finished') finish('success');
                if (state.kind === 'failed') finish('failed');
            });
        });
    }

    public finishNativeCompaction(sessionId: string, success: boolean, error?: string): void {
        if (!sessionId) return;
        void this.ensureLoaded();
        const session = this.store.getSession(sessionId);
        if (!session) return;
        session.compact.inProgress = false;
        session.compact.lastOutcome = success ? 'success' : 'failed';
        session.compact.lastError = success ? null : (error || 'compact failed');
        session.compact.lastAfterTokens = session.current.totalInputForBudget;
        this.store.saveSession(session);
        this.usageEmitter.fire(session);
    }

    /**
     * 用 CLI result.modelUsage 回填本轮输出 token。
     *
     * 注意：CLI 上游报告的 `contextWindow` 不再用来覆盖 session.contextLimit。
     * 上下文上限以 {@link resolveContextLimit}（用户配置 → 静态表 → DEFAULT）
     * 为唯一来源，避免上游错误地报 1M 等值把用户的 200k 配置覆盖掉。
     *
     * @param sessionId     CLI session_id。
     * @param contextLimit  历史参数，已忽略；保留签名以兼容调用方。
     * @param outputTokens  可选本轮输出 token；上游返回 0 时调用方可传本地估算值。
     */
    public updateCliUsage(sessionId: string, contextLimit?: number, outputTokens?: number): void {
        if (!sessionId) return;
        void this.ensureLoaded();
        const session = this.store.getSession(sessionId);
        if (!session) return;
        if (typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0) {
            Logger.info(
                `[tokenBudget] 忽略 CLI contextWindow=${contextLimit}：`
                + `保留 ${session.providerId}/${session.modelId} 当前 contextLimit=${session.contextLimit}`
            );
        }
        let changed = false;
        if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0) {
            session.current.outputTokens = Math.floor(outputTokens);
            changed = true;
        }
        if (!changed) return;
        this.store.saveSession(session);
        this.usageEmitter.fire(session);
    }

    /**
     * 取某 session 的当前快照（用于状态栏 / Webview）。
     *
     * @param sessionId 会话 id。
     * @returns SessionUsage 或 undefined。
     */
    public getSnapshot(sessionId: string): SessionUsage | undefined {
        return this.store.getSession(sessionId);
    }

    /**
     * 请求侧入口：估算 token 并登记。**不改写 body**。
     *
     * @param input 入参。
     */
    public beforeSend(input: BeforeSendInput): void {
        void this.ensureLoaded();
        if (!input.sessionId) return;
        try {
            const estimated = estimateAnthropicInputTokens(input.anthropicBody);
            const session = this.ensureSession(input.sessionId, input.providerId, input.modelId);
            const previous = session.current.totalInputForBudget;
            session.current.inputTokens = estimated;
            session.current.totalInputForBudget = estimated;
            session.lastSource = session.lastSource === 'api' ? 'api' : 'estimated';
            this.store.saveSession(session);
            this.appendHistory(session.sessionId, {
                ts: new Date().toISOString(),
                phase: 'request',
                source: 'estimated',
                deltaInput: Math.max(0, estimated - previous)
            });
            this.lastRequestBodyBySession.set(input.sessionId, input.anthropicBody);
            this.usageEmitter.fire(session);
            if (this.shouldTriggerCompaction(session)) {
                this.triggerCompactionCommand(session);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget] beforeSend 异常：${message}`);
        }
    }

    /**
     * 响应侧入口：用上游 usage 权威值覆盖 current，并按需触发自动压缩。
     *
     * @param input 入参。
     */
    public afterRecv(input: AfterRecvInput): void {
        void this.ensureLoaded();
        if (!input.sessionId) return;
        try {
            const session = this.ensureSession(input.sessionId, input.providerId, input.modelId);
            this.applyUsage(session, input.usage);
            this.store.saveSession(session);
            this.appendHistory(session.sessionId, {
                ts: new Date().toISOString(),
                phase: 'response',
                source: 'api',
                inputTokens: session.current.inputTokens,
                outputTokens: session.current.outputTokens
            });
            this.usageEmitter.fire(session);

            if (this.shouldTriggerCompaction(session)) {
                this.triggerCompactionCommand(session);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget] afterRecv 异常：${message}`);
        }
    }

    /**
     * Disposable 接口实现：清场并 flush 落盘。
     */
    public async dispose(): Promise<void> {
        this.usageEmitter.dispose();
        this.compactionEmitter.dispose();
        await this.store.dispose();
    }

    /**
     * 把 UsageReport 应用到 session.current（覆盖式）。
     *
     * @param session 当前会话桶。
     * @param usage   归一化后的 UsageReport。
     */
    private applyUsage(session: SessionUsage, usage: UsageReport): void {
        // 有些 OpenAI-compatible 上游会返回 usage.input_tokens=0（日志里已出现），
        // 这不是有效统计值。此时保留 beforeSend estimator 写入的 inputTokens，避免
        // UI 从「29k/200k」被错误覆盖为「0/200k」。
        if (typeof usage.inputTokens === 'number' && usage.inputTokens > 0) {
            session.current.inputTokens = usage.inputTokens;
        }
        if (typeof usage.outputTokens === 'number' && usage.outputTokens > 0) {
            session.current.outputTokens = usage.outputTokens;
        }
        if (typeof usage.cacheCreationInputTokens === 'number' && usage.cacheCreationInputTokens > 0) {
            session.current.cacheCreationInputTokens = usage.cacheCreationInputTokens;
        }
        if (typeof usage.cacheReadInputTokens === 'number' && usage.cacheReadInputTokens > 0) {
            session.current.cacheReadInputTokens = usage.cacheReadInputTokens;
        }
        session.current.totalInputForBudget =
            session.current.inputTokens + session.current.cacheCreationInputTokens;
        session.lastSource = usage.inputTokens && usage.inputTokens > 0 ? 'api' : session.lastSource;
    }

    /**
     * 判定本轮 afterRecv 是否应当触发自动压缩。
     *
     * @param session 当前会话桶。
     * @returns 满足全部触发条件则返回 true。
     */
    private shouldTriggerCompaction(session: SessionUsage): boolean {
        if (this.resetStaleCompactionIfNeeded(session)) return true;
        if (session.current.totalInputForBudget < session.threshold) return false;
        if (session.compact.inProgress) return false;
        if (session.compact.lastTriggeredAt) {
            const last = Date.parse(session.compact.lastTriggeredAt);
            if (Number.isFinite(last) && Date.now() - last < COMPACT_DEBOUNCE_MS) return false;
        }
        if (!this.deps.commandSender) {
            Logger.warn('[tokenBudget] 触发条件已满足但 commandSender 未注入，跳过自动压缩。');
            return false;
        }
        return true;
    }

    private triggerCompactionCommand(session: SessionUsage): void {
        this.markCompactionCommandPending(session);
        void this.sendCompactionCommand(session.sessionId);
    }

    /**
     * 标记压缩指令已经发出，避免阈值阶段重复发送内部命令。
     *
     * @param session 当前会话桶。
     */
    private markCompactionCommandPending(session: SessionUsage): void {
        session.compact.inProgress = true;
        session.compact.lastTriggeredAt = new Date().toISOString();
        session.compact.lastTriggeredAtInput = session.current.totalInputForBudget;
        this.store.saveSession(session);
    }

    /**
     * 向 CLI 发送压缩指令，让下一轮请求携带完整上下文后由 relay 拦截处理。
     *
     * @param sessionId 当前会话 id；发送失败时用于复位 inProgress。
     */
    private async sendCompactionCommand(sessionId: string): Promise<void> {
        try {
            Logger.info(`[tokenBudget] 正在向 Chat CLI 发送压缩指令：${CLAUDE_COMPACT_COMMAND}`);
            await this.deps.commandSender?.(CLAUDE_COMPACT_COMMAND);
            Logger.info('[tokenBudget] 压缩指令已发送到 Chat CLI');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget] 发送压缩指令失败：${message}`);
            const session = this.store.getSession(sessionId);
            if (session) {
                session.compact.inProgress = false;
                session.compact.lastOutcome = 'failed';
                session.compact.lastError = message;
                this.store.saveSession(session);
            }
            const failedState: CompactionState = { kind: 'failed', sessionId, error: message };
            this.compactionEmitter.fire(failedState);
            this.deps.notifier?.notifyCompactionState(failedState);
        }
    }

    private resetStaleCompactionIfNeeded(session: SessionUsage): boolean {
        if (!session.compact.inProgress || !session.compact.lastTriggeredAt) return false;
        const triggeredAt = Date.parse(session.compact.lastTriggeredAt);
        if (!Number.isFinite(triggeredAt) || Date.now() - triggeredAt < COMPACT_STALE_MS) return false;
        this.resetCompactionState(session, 'previous compact timed out without status event');
        const failedState: CompactionState = {
            kind: 'failed',
            sessionId: session.sessionId,
            error: session.compact.lastError || 'previous compact timed out without status event'
        };
        this.compactionEmitter.fire(failedState);
        this.deps.notifier?.notifyCompactionState(failedState);
        return true;
    }

    private resetCompactionState(session: SessionUsage, error: string): void {
        session.compact.inProgress = false;
        session.compact.lastOutcome = 'failed';
        session.compact.lastError = error;
        this.store.saveSession(session);
        this.usageEmitter.fire(session);
    }

    /**
     * 保证某 sessionId 存在对应桶；不存在则按当前模型创建。
     * @param sessionId   会话 id。
     * @param providerId  提供商 id。
     * @param modelId     模型 id。
     * @param options     可选：archivedFrom 表示该桶是从旧 session 压缩切换而来。
     * @returns 命中或新建的 SessionUsage。
     */
    private ensureSession(
        sessionId: string,
        providerId: string,
        modelId: string,
        options: { archivedFrom?: string } = {}
    ): SessionUsage {
        const existing = this.store.getSession(sessionId);
        if (existing) {
            const limit = this.resolveContextLimit(providerId, modelId);
            existing.contextLimit = limit;
            existing.threshold = Math.max(0, limit - THRESHOLD_RESERVE);
            existing.providerId = providerId;
            existing.modelId = modelId;
            existing.modelKey = `${providerId}/${modelId}`;
            return existing;
        }
        const created = createEmptySession(
            sessionId,
            providerId,
            modelId,
            this.resolveContextLimit(providerId, modelId)
        );
        if (options.archivedFrom) {
            created.compact.archivedSessionIds.unshift(options.archivedFrom);
        }
        this.store.saveSession(created);
        return created;
    }

    /**
     * 按 fallback 链解析模型上下文上限：
     *  1) providerModel.contextLength（用户配置面板手填"上下文长度"）；
     *  2) MODEL_CONTEXT_LIMITS 静态表；
     *  3) DEFAULT_CONTEXT_LIMIT。
     *
     * @param providerId 提供商 id。
     * @param modelId    模型 id。
     * @returns 上下文上限。
     */
    private resolveContextLimit(providerId: string, modelId: string): number {
        const provider = this.deps.configManager.getProvider(providerId);
        const model = provider?.models.find((m) => m.modelId === modelId);
        const configured = readConfiguredContextWindow(model);
        if (configured && configured > 0) {
            Logger.info(`[tokenBudget] contextLimit 命中用户配置：${providerId}/${modelId}=${configured}`);
            return configured;
        }
        const staticLimit = MODEL_CONTEXT_LIMITS[modelId];
        if (typeof staticLimit === 'number' && staticLimit > 0) {
            Logger.warn(`[tokenBudget] contextLimit 走静态表（用户未配置 contextLength）：${providerId}/${modelId}=${staticLimit}`);
            return staticLimit;
        }
        Logger.warn(
            `[tokenBudget] contextLimit 兜底为 DEFAULT=${DEFAULT_CONTEXT_LIMIT}：`
            + `provider=${providerId} model=${modelId} `
            + `providerFound=${!!provider} modelFound=${!!model} `
            + `modelKeys=${provider ? provider.models.map((m) => m.modelId).join(',') : '<none>'}`
        );
        return DEFAULT_CONTEXT_LIMIT;
    }

    /**
     * 内部 history 追加封装，集中容错。
     *
     * @param sessionId 会话 id。
     * @param entry     历史条目。
     */
    private appendHistory(sessionId: string, entry: UsageHistoryEntry): void {
        try {
            this.store.appendHistory(sessionId, entry);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget] history 追加失败：${message}`);
        }
    }

    /**
     * 首次按需加载持久化文件。
     */
    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        try {
            await this.store.load();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget] 加载持久化文件失败：${message}`);
        }
    }
}

/**
 * 读取 ModelConfig 上的上下文长度配置（取 contextLength）。
 *
 * 用户在配置面板填的"上下文长度"就是模型 token 上限；TokenBudgetService 用它
 * 计算阈值 `threshold = contextLength - 50000`。未填或非法时返回 undefined，
 * 调用方走静态表或 DEFAULT_CONTEXT_LIMIT 兜底。
 *
 * @param model ModelConfig 实例（或 undefined）。
 * @returns 配置值或 undefined。
 */
function readConfiguredContextWindow(model: unknown): number | undefined {
    if (!model || typeof model !== 'object') return undefined;
    const value = (model as { contextLength?: unknown }).contextLength;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    return undefined;
}
