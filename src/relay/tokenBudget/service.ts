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
import type { ProviderConfig } from '../../types';
import type { UsageReport } from '../usageReporter';
import { CompactionClient } from './compactor';
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

/** 手动压缩卡住后的自动复位超时（毫秒）。 */
const COMPACT_IN_PROGRESS_STALE_MS = 120_000;

/** relay 拦截的上下文压缩指令。 */
export const LLSCCAI_SUMM_COMMAND = '@llsccai-summ';

/** 触发压缩指令后给当前 CLI 的即时响应。 */
export const LLSCCAI_SUMM_ACK_TEXT = '已开始压缩上下文，完成后会自动切换到压缩后的新会话。';

/** 摘要成功后等待 CLI 消费即时响应的延迟。 */
const COMPACTION_RESET_DELAY_MS = 1000;

/** 模型上下文上限静态表（fallback 链第二级）。 */
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

/** lastSummary 字段截断长度。 */
const SUMMARY_PERSIST_MAX = 500;

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
    | {
          kind: 'finished';
          sessionId: string;
          oldSessionId: string;
          newSessionId: string;
          beforeTokens: number;
          afterTokens: number;
          summary: string;
      }
    | { kind: 'failed'; sessionId: string; error: string };

/** 复用"清空上下文 + 重启 CLI"链路的接口契约。 */
export interface SessionResetter {
    /**
     * 执行 session 重置：删除 .LLSOAI/chat-session.json + 重启 CLI。
     *
     * 部分 CLI 实现需要先收到一条 user 消息才会触发 init 事件并写入新
     * sessionId，因此此接口允许返回空 newSessionId，由调用方在 seed
     * 注入完成后再通过 {@link awaitNewSessionId} 等待落盘。
     *
     * @returns 新 CLI session id；尚未落盘时返回空字符串。
     */
    reset(): Promise<{ newSessionId: string }>;

    /**
     * seed 注入触发 CLI init 之后，再次等待新 sessionId 落盘。
     *
     * @param previousSessionId 旧的 sessionId，用于规避读到尚未替换的旧值。
     * @returns 新 CLI session id；超时抛错。
     */
    awaitNewSessionId?(previousSessionId: string): Promise<string>;
}

/** 注入"假对话对"到新 session 的能力契约。 */
export interface SeedInjector {
    /**
     * 把摘要内容作为首条 user 消息注入新 session，等到 assistant 回复后 resolve。
     *
     * 复用 extension.ts 中 `appendUserMessageAndSend` 的语义，保证消息正常显示。
     *
     * @param text 待注入的 user 消息文本（含 `<CONTEXT>...</CONTEXT>` 与提示语）。
     */
    sendUserMessage(text: string): Promise<void>;
}

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
    /** 用于发起压缩请求的客户端。 */
    compactionClient?: CompactionClient;
    /** 用于请求 CLI 带完整上下文发送压缩指令；未注入时自动压缩直接走本地请求体。 */
    commandSender?: (command: string) => Promise<void>;
    /** 用于切 session 的 resetter；未注入时压缩流程会失败收尾。 */
    sessionResetter?: SessionResetter;
    /** 用于把摘要发为新 session 首条消息；未注入时压缩流程会失败收尾。 */
    seedInjector?: SeedInjector;
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

    /** 记录每轮请求最近一次的 anthropicBody，afterRecv 触发压缩时拿来做摘要输入。 */
    private readonly lastRequestBodyBySession = new Map<string, string>();

    private readonly activeCompactionSessions = new Set<string>();

    private readonly completedCompactionSessions = new Set<string>();

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
            Logger.warn(`[tokenBudget] 手动压缩强制复位旧状态：session=${sessionId}`);
            this.forceResetCompactionForManual(session);
        }
        if (!this.deps.compactionClient || !this.deps.sessionResetter || !this.deps.seedInjector) {
            Logger.warn('[tokenBudget] 手动压缩失败：依赖未注入');
            return false;
        }
        if (this.deps.commandSender) {
            Logger.info(`[tokenBudget] 手动压缩通过内部指令发送：${LLSCCAI_SUMM_COMMAND}`);
            this.markCompactionCommandPending(session);
            void this.sendCompactionCommand(session.sessionId);
            return true;
        }
        const bodyText = this.lastRequestBodyBySession.get(sessionId);
        if (!bodyText) {
            Logger.warn(`[tokenBudget] 手动压缩失败：session=${sessionId} 没有最近请求体`);
            return false;
        }
        Logger.info('[tokenBudget] 手动压缩直接使用最近请求体启动');
        void this.runCompactionFlow(session, bodyText);
        return true;
    }

    /**
     * 处理 relay 拦截到的 `@llsccai-summ` 压缩指令。
     *
     * @param input 当前 CLI 发出的完整 Anthropic 请求体上下文。
     * @returns 是否成功启动异步压缩流程。
     */
    public handleSummCommand(input: BeforeSendInput): boolean {
        if (!input.sessionId) return false;
        void this.ensureLoaded();
        const session = this.ensureSession(input.sessionId, input.providerId, input.modelId);
        if (this.completedCompactionSessions.has(session.sessionId)) {
            Logger.warn(`[tokenBudget] 压缩指令忽略：session=${session.sessionId} 已完成压缩`);
            return true;
        }
        if (!this.deps.compactionClient || !this.deps.sessionResetter || !this.deps.seedInjector) {
            Logger.warn('[tokenBudget] 压缩指令失败：依赖未注入');
            return false;
        }
        if (session.compact.inProgress) {
            if (this.activeCompactionSessions.has(session.sessionId)) {
                Logger.warn(`[tokenBudget] 压缩指令忽略：session=${session.sessionId} 已有压缩流程运行中`);
                return true;
            }
            void this.runCompactionFlow(session, input.anthropicBody);
            return true;
        }
        this.lastRequestBodyBySession.set(input.sessionId, input.anthropicBody);
        void this.runCompactionFlow(session, input.anthropicBody);
        return true;
    }

    /**
     * 用 CLI result.modelUsage 回填上下文上限与本轮输出 token。
     *
     * - contextWindow 用于把 token-meter 上限从 DEFAULT 166k 修正为 CLI 已知的真实值；
     * - outputTokens 用于让 token-meter 的 used 显示「input + 本轮 assistant 回复」。
     *
     * @param sessionId     CLI session_id。
     * @param contextLimit  可选上下文上限。
     * @param outputTokens  可选本轮输出 token；上游返回 0 时调用方可传本地估算值。
     */
    public updateCliUsage(sessionId: string, contextLimit?: number, outputTokens?: number): void {
        if (!sessionId) return;
        void this.ensureLoaded();
        const session = this.store.getSession(sessionId);
        if (!session) return;
        let changed = false;
        if (typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0) {
            session.contextLimit = Math.floor(contextLimit);
            session.threshold = Math.max(0, session.contextLimit - THRESHOLD_RESERVE);
            changed = true;
        }
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
                if (this.deps.commandSender) {
                    this.markCompactionCommandPending(session);
                    void this.sendCompactionCommand(session.sessionId);
                } else {
                    void this.runCompactionFlow(session, input.anthropicBody);
                }
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
                const bodyAtSend = input.requestBodyAtSend
                    || this.lastRequestBodyBySession.get(input.sessionId)
                    || '';
                if (this.deps.commandSender) {
                    this.markCompactionCommandPending(session);
                    void this.sendCompactionCommand(session.sessionId);
                } else {
                    void this.runCompactionFlow(session, bodyAtSend);
                }
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
        if (session.current.totalInputForBudget < session.threshold) return false;
        if (session.compact.inProgress) return false;
        if (session.compact.lastTriggeredAt) {
            const last = Date.parse(session.compact.lastTriggeredAt);
            if (Number.isFinite(last) && Date.now() - last < COMPACT_DEBOUNCE_MS) return false;
        }
        if (!this.deps.compactionClient || !this.deps.sessionResetter || !this.deps.seedInjector) {
            Logger.warn('[tokenBudget] 触发条件已满足但依赖未注入，跳过自动压缩。');
            return false;
        }
        return true;
    }

    /**
     * 执行完整的自动压缩状态机。
     *
     * @param session  触发时的会话桶（旧 session）。
     * @param bodyText 本轮上行 Anthropic 请求体（含 messages 历史）。
     */
    private async runCompactionFlow(session: SessionUsage, bodyText: string): Promise<void> {
        const oldSessionId = session.sessionId;
        if (this.activeCompactionSessions.has(oldSessionId)) {
            Logger.warn(`[tokenBudget] 压缩流程忽略：session=${oldSessionId} 已在运行中`);
            return;
        }
        this.activeCompactionSessions.add(oldSessionId);
        const beforeTokens = session.current.totalInputForBudget;

        session.compact.inProgress = true;
        session.compact.lastTriggeredAt = new Date().toISOString();
        session.compact.lastTriggeredAtInput = beforeTokens;
        session.compact.triggerCount += 1;
        this.store.saveSession(session);

        const startedState: CompactionState = { kind: 'started', sessionId: oldSessionId, beforeTokens };
        this.compactionEmitter.fire(startedState);
        this.deps.notifier?.notifyCompactionState(startedState);

        try {
            const provider = await this.deps.configManager.getProviderWithSecret(session.providerId);
            if (!provider) throw new Error(`provider 不存在：${session.providerId}`);

            const { messages, system } = this.extractMessagesAndSystem(bodyText);
            if (messages.length === 0) throw new Error('请求体中没有可压缩的 messages');

            const compactionResult = await this.deps.compactionClient!.run({
                provider,
                modelId: session.modelId,
                messages,
                originalSystem: system
            });
            if (!compactionResult.ok) throw new Error(compactionResult.error);

            if (this.deps.commandSender) {
                await new Promise<void>((resolve) => setTimeout(resolve, COMPACTION_RESET_DELAY_MS));
            }
            const { newSessionId: resetSessionId } = await this.deps.sessionResetter!.reset();

            const seedText =
                `<CONTEXT>\n${compactionResult.wrapped}\n</CONTEXT>\n\n` +
                `上文是之前对话的压缩摘要，仅供参考。请回复"上下文已就绪"。`;
            try {
                await this.deps.seedInjector!.sendUserMessage(seedText);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new Error(`摘要注入失败（旧 session 已重置）：${message}`);
            }

            let newSessionId = resetSessionId;
            if (!newSessionId && this.deps.sessionResetter?.awaitNewSessionId) {
                try {
                    newSessionId = await this.deps.sessionResetter.awaitNewSessionId(oldSessionId);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    throw new Error(`CLI 重启后未拿到新 sessionId：${message}`);
                }
            }
            if (!newSessionId) {
                throw new Error('CLI 重启后未拿到新 sessionId');
            }

            const newSession = this.ensureSession(
                newSessionId,
                session.providerId,
                session.modelId,
                { archivedFrom: oldSessionId }
            );
            newSession.compact.lastOutcome = 'success';
            newSession.compact.lastError = null;
            newSession.compact.lastSummary = compactionResult.summaryText.slice(0, SUMMARY_PERSIST_MAX);
            newSession.compact.lastBeforeTokens = beforeTokens;
            newSession.compact.lastAfterTokens = newSession.current.totalInputForBudget;
            this.store.saveSession(newSession);
            this.store.archiveSession(oldSessionId);
            this.lastRequestBodyBySession.delete(oldSessionId);

            const afterTokens = newSession.current.totalInputForBudget;
            const finishedState: CompactionState = {
                kind: 'finished',
                sessionId: newSessionId,
                oldSessionId,
                newSessionId,
                beforeTokens,
                afterTokens,
                summary: compactionResult.summaryText
            };
            this.compactionEmitter.fire(finishedState);
            this.deps.notifier?.notifyCompactionState(finishedState);
            this.completedCompactionSessions.add(oldSessionId);
            this.activeCompactionSessions.delete(oldSessionId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget] 自动压缩失败：${message}`);
            const failedState = await this.resetSessionAfterCompactionFailure(oldSessionId, beforeTokens, message);
            this.compactionEmitter.fire(failedState);
            this.deps.notifier?.notifyCompactionState(failedState);
            this.activeCompactionSessions.delete(oldSessionId);
            return;
        }

        // 成功分支：旧桶已归档，inProgress 在新桶里默认 false。
    }

    /**
     * 压缩失败后也强制清空旧上下文，避免继续保留超大 session。
     *
     * @param oldSessionId 旧 session id。
     * @param beforeTokens 失败前 token 数。
     * @param errorMessage 压缩失败原因。
     * @returns 需要广播给 UI 的失败状态。
     */
    private async resetSessionAfterCompactionFailure(
        oldSessionId: string,
        beforeTokens: number,
        errorMessage: string
    ): Promise<CompactionState> {
        let finalError = `${errorMessage}；已强制清空旧上下文`;
        try {
            const { newSessionId } = await this.deps.sessionResetter!.reset();
            const failedSession = this.store.getSession(oldSessionId);
            const providerId = failedSession?.providerId ?? '';
            const modelId = failedSession?.modelId ?? '';
            if (failedSession) {
                failedSession.compact.inProgress = false;
                failedSession.compact.lastOutcome = 'failed';
                failedSession.compact.lastError = finalError;
                failedSession.compact.lastBeforeTokens = beforeTokens;
                failedSession.compact.lastAfterTokens = 0;
                this.store.saveSession(failedSession);
                this.store.archiveSession(oldSessionId);
            }
            if (newSessionId) {
                const newSession = this.ensureSession(
                    newSessionId,
                    providerId,
                    modelId,
                    { archivedFrom: oldSessionId }
                );
                newSession.compact.lastOutcome = 'failed';
                newSession.compact.lastError = finalError;
                newSession.compact.lastBeforeTokens = beforeTokens;
                newSession.compact.lastAfterTokens = newSession.current.totalInputForBudget;
                this.store.saveSession(newSession);
            }
            this.lastRequestBodyBySession.delete(oldSessionId);
        } catch (resetErr) {
            const resetMessage = resetErr instanceof Error ? resetErr.message : String(resetErr);
            finalError = `${errorMessage}；强制清空旧上下文失败：${resetMessage}`;
            const failedSession = this.store.getSession(oldSessionId);
            if (failedSession) {
                failedSession.compact.inProgress = false;
                failedSession.compact.lastOutcome = 'failed';
                failedSession.compact.lastError = finalError;
                this.store.saveSession(failedSession);
            }
        }
        return { kind: 'failed', sessionId: oldSessionId, error: finalError };
    }

    /**
     * 手动压缩允许覆盖旧的 inProgress 状态。
     *
     * @param session 当前 session 桶。
     */
    private forceResetCompactionForManual(session: SessionUsage): void {
        this.activeCompactionSessions.delete(session.sessionId);
        this.completedCompactionSessions.delete(session.sessionId);
        session.compact.inProgress = false;
        session.compact.lastOutcome = 'failed';
        session.compact.lastError = '手动压缩已覆盖旧的压缩中状态';
        this.store.saveSession(session);
        const failedState: CompactionState = {
            kind: 'failed',
            sessionId: session.sessionId,
            error: session.compact.lastError
        };
        this.compactionEmitter.fire(failedState);
        this.deps.notifier?.notifyCompactionState(failedState);
    }

    /**
     * 检查并复位卡住的压缩状态。
     *
     * @param session 当前 session 桶。
     * @returns 发生复位时返回 true；仍应视为压缩中时返回 false。
     */
    private resetStaleCompactionIfNeeded(session: SessionUsage): boolean {
        const triggeredAt = session.compact.lastTriggeredAt ? Date.parse(session.compact.lastTriggeredAt) : 0;
        const age = triggeredAt > 0 ? Date.now() - triggeredAt : Number.POSITIVE_INFINITY;
        if (age < COMPACT_IN_PROGRESS_STALE_MS) return false;
        Logger.warn(`[tokenBudget] 检测到陈旧压缩状态，自动复位：session=${session.sessionId}, ageMs=${Number.isFinite(age) ? age : 'unknown'}`);
        session.compact.inProgress = false;
        session.compact.lastOutcome = 'failed';
        session.compact.lastError = '压缩状态超时未完成，已自动复位';
        this.store.saveSession(session);
        const failedState: CompactionState = {
            kind: 'failed',
            sessionId: session.sessionId,
            error: session.compact.lastError
        };
        this.compactionEmitter.fire(failedState);
        this.deps.notifier?.notifyCompactionState(failedState);
        return true;
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
            Logger.info(`[tokenBudget] 正在向 Chat CLI 发送压缩指令：${LLSCCAI_SUMM_COMMAND}`);
            await this.deps.commandSender?.(LLSCCAI_SUMM_COMMAND);
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

    /**
     * 从 Anthropic 请求体字符串里解出 messages / system。
     *
     * @param bodyText 请求体字符串。
     * @returns 解析结果（失败时返回空 messages）。
     */
    private extractMessagesAndSystem(bodyText: string): { messages: unknown[]; system?: unknown } {
        try {
            const parsed = JSON.parse(bodyText) as { messages?: unknown; system?: unknown };
            const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
            return { messages, system: parsed.system };
        } catch {
            return { messages: [] };
        }
    }

    /**
     * 保证某 sessionId 存在对应桶；不存在则按当前模型创建。
     *
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
 * 给 token 预算暴露的 ProviderConfig 类型重导出，避免外部需要额外 import。
 *
 * @returns ProviderConfig 类型别名。
 */
export type CompactionProviderConfig = ProviderConfig;

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
