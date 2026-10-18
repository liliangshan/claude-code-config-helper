/** @file 上下文计量与 CLI 原生/手动压缩状态协调；不再排队自动发送 /compact。 */

import * as vscode from 'vscode';

import { Logger } from '../../logger';
import { estimateCompactionThreshold, resolveContextWindow } from '../../nativeCompactionPolicy';
import type { ConfigManager } from '../../configManager';
import type { UsageReport } from '../usageReporter';
import { estimateAnthropicInputTokens } from './estimator';
import {
    createEmptySession,
    TokenCountStore,
    type SessionUsage,
    type UsageHistoryEntry
} from './store';

/** 发送给 Claude CLI 的手动上下文压缩指令。 */
export const CLAUDE_COMPACT_COMMAND = '/compact';

/** 压缩在途标记的最长有效期，明显属于旧实例的标记立即复位。 */
const COMPACTION_IN_FLIGHT_STALE_MS = 30 * 60_000;

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
    /**
     * 本轮是否为 CLI 原生压缩（摘要）请求。
     *
     * 压缩请求体携带整段待摘要对话，估算值必然超阈值；若参与阈值判定就会在
     * 压缩进行中再发一条 `/compact`。为 true 时只登记 usage，不做触发判定，
     * 并顺带把压缩在途标记置上，堵住同一时间窗内的其他触发源。
     */
    compactCommandTriggered?: boolean;
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
    /** 本次响应对应的请求是否为压缩摘要请求；为 true 时只计量，不做阈值触发。 */
    compactCommandTriggered?: boolean;
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

    /** 本服务实例实际登记的在途会话，不信任磁盘中遗留的布尔标记。 */
    private readonly activeCompactions = new Set<string>();
    /** 已收到原生开始事件的会话，去重 status 和 Relay 摘要请求。 */
    private readonly startedCompactions = new Set<string>();

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
        if (this.isCompactionInFlight(sessionId)) {
            Logger.info(`[tokenBudget] 压缩已在途，跳过重复手动请求：session=${sessionId}`);
            return false;
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
        if (this.isCompactionInFlight(sessionId)) return this.waitForCompactionEvent(sessionId, options.timeoutMs);
        const waiting = this.waitForCompactionEvent(sessionId, options.timeoutMs);
        if (!this.compactNow(sessionId)) {
            this.compactionEmitter.fire({ kind: 'failed', sessionId, error: 'manual compact unavailable' });
            return Promise.resolve('skipped');
        }
        return waiting;
    }

    /** 判断某 session 是否有本实例实际提交或原生开始的压缩在途。
     *
     * 在途标记超过 {@link COMPACTION_IN_FLIGHT_STALE_MS} 仍未结束时视为状态失真
     * （例如压缩结果事件丢失），复位并返回 false，避免发送链路被永久卡住。
     *
     * @param sessionId CLI session_id。
     * @returns 压缩在途时返回 true。
     */
    public isCompactionInFlight(sessionId: string): boolean {
        if (!sessionId) return false;
        void this.ensureLoaded();
        const session = this.store.getSession(sessionId);
        if (!session || !session.compact.inProgress) return false;
        if (!this.activeCompactions.has(sessionId)) {
            this.resetCompactionState(session, 'previous CLI instance ended');
            return false;
        }
        const startedAt = session.compact.lastTriggeredAt ? Date.parse(session.compact.lastTriggeredAt) : NaN;
        if (Number.isFinite(startedAt) && Date.now() - startedAt > COMPACTION_IN_FLIGHT_STALE_MS) {
            Logger.warn(`[tokenBudget] 压缩在途标记已超时失真，复位：session=${sessionId}`);
            this.resetCompactionState(session, 'in-flight marker stale');
            return false;
        }
        return true;
    }

    /**
     * 等待某 session 的在途压缩结束；没有在途压缩时立即返回 'skipped'。
     *
     * 供发送链路在压缩期间暂缓发送新消息：压缩完成后再发，避免摘要请求与
     * 普通请求并发，也避免压缩后新消息被当作旧上下文的一部分。
     *
     * @param sessionId CLI session_id。
     * @param timeoutMs 最长等待毫秒数。
     * @returns 等待结果。
     */
    public waitForCompactionSettled(sessionId: string, timeoutMs: number): Promise<CompactionWaitResult> {
        if (!this.isCompactionInFlight(sessionId)) return Promise.resolve('skipped');
        return this.waitForCompactionEvent(sessionId, timeoutMs);
    }

    /**
     * 订阅压缩状态事件直到 finished / failed 或超时。
     *
     * @param sessionId 目标 session_id。
     * @param timeoutMs 超时毫秒数。
     * @returns 等待结果。
     */
    private waitForCompactionEvent(sessionId: string, timeoutMs: number): Promise<CompactionWaitResult> {
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
            const timer = setTimeout(() => finish('timeout'), Math.max(1, timeoutMs));
            subscription = this.onCompactionStateChanged((state) => {
                if (state.sessionId !== sessionId) return;
                if (state.kind === 'finished') finish('success');
                if (state.kind === 'failed') finish('failed');
            });
        });
    }

    /**
     * 登记「某处已经在压缩」，让压缩完成前的重复触发保持静默。
     *
     * 触发源不止本服务的手动压缩：用户手敲 `/compact`、CLI 自身的自动压缩都不会
     * 经过 {@link compactNow}，若不登记则 `inProgress` 始终为空，同一段上下文会被压两次。
     *
     * @param sessionId CLI session_id。
     */
    public noteExternalCompaction(sessionId: string): void {
        if (!sessionId) return;
        void this.ensureLoaded();
        const session = this.store.getSession(sessionId) || this.ensureMainCompactionSession(sessionId);
        if (!session) return;
        if (this.startedCompactions.has(sessionId)) return;
        Logger.info(`[tokenBudget] 外部压缩已在途，登记防抖：session=${sessionId}`);
        this.noteCompactionInFlight(session);
    }

    /**
     * 结束 CLI 原生压缩：复位在途状态并广播结果。
     *
     * @param sessionId CLI session_id。
     * @param success   压缩是否成功。
     * @param error     失败原因。
     */
    public finishNativeCompaction(sessionId: string, success: boolean, error?: string): void {
        if (!sessionId) return;
        void this.ensureLoaded();
        const session = this.store.getSession(sessionId);
        if (!session || !this.activeCompactions.delete(sessionId)) return;
        this.startedCompactions.delete(sessionId);
        session.compact.inProgress = false;
        session.compact.lastOutcome = success ? 'success' : 'failed';
        session.compact.lastError = success ? null : (error || 'compact failed');
        session.compact.lastAfterTokens = null;
        this.store.saveSession(session);
        this.usageEmitter.fire(session);
        // 原生成功事件尚不包含新用量，不用旧输入伪装成压缩后计量。
        const state: CompactionState = success
            ? { kind: 'finished', sessionId, oldSessionId: sessionId, newSessionId: sessionId, beforeTokens: 0, afterTokens: 0, summary: '' }
            : { kind: 'failed', sessionId, error: error || 'compact failed' };
        this.compactionEmitter.fire(state);
        this.deps.notifier?.notifyCompactionState(state);
    }

    /**
     * 进程退出、取消或重启时释放其在途锁，不清理历史或会话文件。
     * @param sessionId 原 CLI 会话；空值时释放本实例全部在途会话。
     * @param reason 失败类别。
     */
    public releaseCliCompactions(sessionId: string, reason: string): void {
        for (const id of sessionId ? [sessionId] : [...this.activeCompactions]) {
            const session = this.store.getSession(id);
            if (session?.compact.inProgress) this.resetCompactionState(session, reason);
        }
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
            if (input.compactCommandTriggered) {
                // 摘要模型的容量和大输入只写独立历史，不污染主会话窗口或计量。
                const session = this.store.getSession(input.sessionId) || this.ensureMainCompactionSession(input.sessionId);
                if (session) this.noteCompactionInFlight(session);
                return;
            }
            const estimated = estimateAnthropicInputTokens(input.anthropicBody);
            const session = this.ensureSession(input.sessionId, input.providerId, input.modelId);
            const previous = session.current.totalInputForBudget;
            // 首次尚无上游统计时用估算值兜底；已有已确认统计后，新请求阶段完整保留
            // 上一份快照，等本次 usage 到达后再原子覆盖，避免计量条清空或混合两轮字段。
            if (session.lastSource !== 'api') {
                session.current.inputTokens = estimated;
                session.current.totalInputForBudget = estimated;
                session.lastSource = 'estimated';
            }
            this.store.saveSession(session);
            this.appendHistory(session.sessionId, {
                ts: new Date().toISOString(),
                phase: 'request',
                source: 'estimated',
                deltaInput: Math.max(0, estimated - previous)
            });
            this.usageEmitter.fire(session);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget] beforeSend 异常：${message}`);
        }
    }

    /**
     * 响应侧入口：用上游 usage 权威值覆盖 current。
     *
     * 只登记普通请求用量；自动触发完全交给 CLI，摘要用量不覆盖主窗口。
     *
     * @param input 入参。
     */
    public afterRecv(input: AfterRecvInput): void {
        void this.ensureLoaded();
        if (!input.sessionId || input.compactCommandTriggered) return;
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
        // 这不是有效统计值。此时只保留本轮 beforeSend estimator 的 inputTokens；其余
        // 字段必须按本次响应原子覆盖，避免上一轮 cache-write 串入当前快照。
        if (typeof usage.inputTokens === 'number' && usage.inputTokens > 0) {
            session.current.inputTokens = usage.inputTokens;
        }
        session.current.outputTokens = typeof usage.outputTokens === 'number' && usage.outputTokens >= 0
            ? usage.outputTokens
            : 0;
        session.current.cacheCreationInputTokens =
            typeof usage.cacheCreationInputTokens === 'number' && usage.cacheCreationInputTokens >= 0
                ? usage.cacheCreationInputTokens
                : 0;
        session.current.cacheReadInputTokens =
            typeof usage.cacheReadInputTokens === 'number' && usage.cacheReadInputTokens >= 0
                ? usage.cacheReadInputTokens
                : 0;
        // Anthropic 将当前输入拆成普通输入、缓存写入和缓存读取三部分；三者都占用
        // 当前上下文窗口，因此计量条必须全部计入。
        session.current.totalInputForBudget =
            session.current.inputTokens
            + session.current.cacheCreationInputTokens
            + session.current.cacheReadInputTokens;
        session.lastSource = usage.inputTokens && usage.inputTokens > 0 ? 'api' : session.lastSource;
    }

    /**
     * 只登记压缩在途状态，不发送任何指令。
     *
     * 用于「压缩已由别处发起」的场景（CLI 原生压缩、用户手敲 `/compact`、
     * 正在转发的摘要请求），让 inProgress 判定对这些触发源同样生效。
     *
     * @param session 当前会话桶。
     */
    private noteCompactionInFlight(session: SessionUsage): void {
        if (this.startedCompactions.has(session.sessionId)) return;
        this.startedCompactions.add(session.sessionId);
        this.markCompactionCommandPending(session);
        // CLI 开始事件或 Relay 摘要请求才代表压缩已执行，不能在指令排队时提前显示。
        const state: CompactionState = {
            kind: 'started',
            sessionId: session.sessionId,
            beforeTokens: session.current.totalInputForBudget
        };
        this.compactionEmitter.fire(state);
        this.deps.notifier?.notifyCompactionState(state);
    }

    /**
     * 标记压缩指令已经发出，避免阈值阶段重复发送内部命令。
     *
     * @param session 当前会话桶。
     */
    private markCompactionCommandPending(session: SessionUsage): void {
        if (!this.activeCompactions.has(session.sessionId)) session.compact.triggerCount += 1;
        this.activeCompactions.add(session.sessionId);
        session.compact.inProgress = true;
        session.compact.lastTriggeredAt = new Date().toISOString();
        session.compact.lastTriggeredAtInput = session.current.totalInputForBudget;
        // 新一轮压缩开始，清掉上一轮遗留的结果与错误，避免旧的 stale 记录误导排查。
        session.compact.lastOutcome = null;
        session.compact.lastError = null;
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
            if (session) this.resetCompactionState(session, message);
        }
    }

    /** 复位压缩状态，同时恢复界面并释放等待该会话压缩结果的发送者。 */
    private resetCompactionState(session: SessionUsage, error: string): void {
        this.activeCompactions.delete(session.sessionId);
        this.startedCompactions.delete(session.sessionId);
        session.compact.inProgress = false;
        session.compact.lastOutcome = 'failed';
        session.compact.lastError = error;
        this.store.saveSession(session);
        this.usageEmitter.fire(session);
        const state: CompactionState = { kind: 'failed', sessionId: session.sessionId, error };
        this.compactionEmitter.fire(state);
        this.deps.notifier?.notifyCompactionState(state);
    }

    /**
     * resume 后原生压缩可能早于普通请求；只按当前主模型建立桶。
     * @param sessionId 原生会话。
     * @returns 主模型桶，不使用摘要模型的容量。
     */
    private ensureMainCompactionSession(sessionId: string): SessionUsage | undefined {
        const current = this.deps.configManager.getCurrentModel?.();
        return current ? this.ensureSession(sessionId, current.providerId, current.modelId) : undefined;
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
            existing.threshold = estimateCompactionThreshold(limit);
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
    /** 最近一次上下文配置解析结果；相同模型和配置不重复刷日志。 */
    private lastContextLimitLog = '';

    /** 仅在模型、上限或来源变化时输出配置解析日志。 */
    private logContextLimit(message: string, warning = false): void {
        if (this.lastContextLimitLog === message) return;
        this.lastContextLimitLog = message;
        if (warning) Logger.warn(message);
        else Logger.info(message);
    }

    /**
     * 读取主模型配置并使用共享解析器，不重复维护静态表。
     * @param providerId 提供商 id。
     * @param modelId 模型 id。
     * @returns 配置、静态表或默认窗口。
     */
    private resolveContextLimit(providerId: string, modelId: string): number {
        const provider = this.deps.configManager.getProvider(providerId);
        const model = provider?.models.find((m) => m.modelId === modelId);
        const window = resolveContextWindow(modelId, model?.contextLength);
        this.logContextLimit(`[tokenBudget] contextLimit=${window.contextLimit} source=${window.source} model=${providerId}/${modelId}`);
        return window.contextLimit;
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
