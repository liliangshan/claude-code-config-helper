/**
 * @file ExpertRunner：专家执行状态机。
 *
 * 职责（详见 `EXPERT_MODE_DESIGN.md` §6 + §11）：
 *
 * 1. 接到一次 `ask_expert` 调用 → spawn 第二个 Claude CLI 子进程（专家）；
 * 2. 把专家的 stream 输出实时转成 {@link ExpertEvent} 推给 webview；
 * 3. 在四层护栏中**任一条件**触发时强制收尾：
 *    - 总超时 `EXPERT_TIMEOUT_MS`
 *    - 空闲超时 `EXPERT_IDLE_TIMEOUT_MS`
 *    - 步数上限 `EXPERT_MAX_STEPS`
 *    - 消息软上限 `EXPERT_MAX_ASSISTANT_MESSAGES`
 *    - 外部 AbortSignal（webview 关闭 / 主 CLI 退出 / 用户取消）
 * 4. 收尾时**一定**关闭专家子进程（SIGTERM → 等待 EXPERT_KILL_GRACE_MS → SIGKILL）；
 * 5. 永远返回一个 `finalAnswer`，失败时为 `[Expert mode failed: <reason>]`。
 *
 * 设计原则：
 * - **不直接依赖 vscode**：通过依赖注入接收 CLI 工厂、事件 sink、Logger，
 *   方便单元测试用 mock 替换；
 * - **状态机内聚**：所有定时器、计数器、监听器都在一个 run 生命周期内创建和销毁，
 *   不留全局副作用；
 * - **错误吸收**：内部任何异常都被捕获并归一化成 `error` 事件 + 失败 finalAnswer，
 *   不抛给调用方（MCP server 期望这是个"永远成功"的接口）。
 */

import {
    EXPERT_FINAL_ANSWER_MAX_BYTES,
    EXPERT_IDLE_TIMEOUT_MS,
    EXPERT_KILL_GRACE_MS,
    EXPERT_MAX_ASSISTANT_MESSAGES,
    EXPERT_MAX_STEPS,
    EXPERT_TIMEOUT_MS
} from './expertConstants';
import { buildExpertInitialUserMessage } from './expertPromptBuilder';
import { truncateForEvent } from './expertEvents';
import type { ExpertEvent, ExpertEventSink } from './expertEvents';
import type { AskExpertArgs } from './expertMcpServer';
import type { ChatCliConfig } from '../chat/cli/types';

// ---------------------------------------------------------------------------
// 注入式接口
// ---------------------------------------------------------------------------

/**
 * 专家用 CLI 子进程的最小接口契约（CliProcess 的精简视图）。
 *
 * 用接口而非具体类型，方便在单元测试中用 fake 替代。
 */
export interface ExpertCliProcessLike {
    /**
     * 启动 CLI 子进程。
     * @param config 已派生的专家 ChatCliConfig（由 `buildExpertConfig()` 生成）。
     */
    start(config: ChatCliConfig): Promise<void>;
    /**
     * 向 CLI stdin 写入一行 JSON Lines 文本（如初始 user 消息）。
     */
    send(jsonLine: string): void;
    /**
     * 订阅结构化事件流。
     *
     * 我们要求 CliProcess 的上层适配器（StreamJsonCliAdapter）把原始 chunk 解析成
     * {@link ExpertStreamEvent}——这里只列出 ExpertRunner 关心的子集，
     * 实际接入时由 adapter 适配。
     *
     * @param listener 事件监听器。
     * @returns dispose 回调。
     */
    onEvent(listener: (event: ExpertStreamEvent) => void): { dispose(): void };
    /**
     * 订阅进程退出事件。
     */
    onExit(listener: () => void): { dispose(): void };
    /**
     * 释放 CLI（关闭子进程）。Phase 4 内部会负责 SIGTERM → SIGKILL 升级。
     */
    dispose(): Promise<void> | void;
}

/**
 * ExpertRunner 关心的 stream 事件结构。
 *
 * 是 `ParsedCliEvent` / `ChatSegment` 的最小化映射，避免把 webview 渲染细节
 * 渗透到 expertMode 模块。具体接入时由调用方做转换。
 */
export type ExpertStreamEvent =
    | { kind: 'assistant_text'; text: string }
    | { kind: 'tool_use'; toolName: string; args: unknown }
    | { kind: 'tool_result'; toolName: string; resultText: string; isError: boolean }
    | { kind: 'message_end' }
    | { kind: 'result'; finalText?: string }
    | { kind: 'error'; message: string };

/**
 * ExpertRunner 构造依赖。
 */
export interface ExpertRunnerDeps {
    /**
     * 创建一个新的 CLI 子进程实例。
     *
     * 每个 run 调用一次；返回的实例由 ExpertRunner 在收尾时 dispose。
     */
    createCliProcess: () => ExpertCliProcessLike;
    /**
     * 事件推送通道（通常注入 `ChatViewHost` 的 webview 桥）。
     */
    eventSink: ExpertEventSink;
    /**
     * 已经派生好的专家 CLI 配置（由 `buildExpertConfig(mainConfig)` 得到）。
     */
    expertConfig: ChatCliConfig;
    /**
     * 可选：注入自定义计时器（默认使用 setTimeout / Date.now）。
     * 测试中可用 sinon 或自实现的 fake-timer 替换。
     */
    timers?: ExpertTimers;
    /**
     * 可选：错误日志回调（默认 console.error）。
     */
    logger?: (message: string, meta?: unknown) => void;
}

/**
 * 计时器抽象，便于测试中用假时间。
 */
export interface ExpertTimers {
    /** 返回当前时间戳（毫秒）。 */
    now(): number;
    /** 启动一个定时器，返回 dispose 回调。 */
    setTimeout(handler: () => void, ms: number): () => void;
}

/** 默认计时器实现（使用 Node.js 全局 API）。 */
const defaultTimers: ExpertTimers = {
    now: () => Date.now(),
    setTimeout: (handler, ms) => {
        const id = setTimeout(handler, ms);
        return () => clearTimeout(id);
    }
};

// ---------------------------------------------------------------------------
// Run 请求与结果
// ---------------------------------------------------------------------------

/**
 * 单次 `run()` 的请求参数。
 */
export interface ExpertRunRequest {
    /** 主对话关联 message id（用于把事件挂到对应 assistant 气泡下方）。 */
    parentMessageId: string;
    /** ask_expert 调用 id（tool_use_id）。 */
    callId: string;
    /** 主聊天区 ask_expert 工具卡片的 ChatSegment.id，用于 webview 实时更新 Output。 */
    toolSegmentId?: string;
    /** 主模型透传的 ask_expert 参数。 */
    args: AskExpertArgs;
    /** 外部 AbortSignal：webview 关闭 / 主 CLI 退出 / 用户取消时触发。 */
    signal?: AbortSignal;
}

/**
 * 单次 `run()` 的结果。
 */
export interface ExpertRunResult {
    /** 最终结论文本（已截断到 {@link EXPERT_FINAL_ANSWER_MAX_BYTES}）。 */
    finalAnswer: string;
    /** 是否为错误（true 时 finalAnswer 是 `[Expert mode failed: ...]`）。 */
    isError: boolean;
    /** 本次 run 总耗时（毫秒）。 */
    durationMs: number;
    /** 结束原因（用于日志与诊断）。 */
    endReason: ExpertRunEndReason;
}

/** 一次 run 的结束原因。 */
export type ExpertRunEndReason =
    | 'completed'              // 专家正常给出 finalText
    | 'cancelled'              // 外部 AbortSignal
    | 'timeout'                // 总超时
    | 'idle_timeout'           // 空闲超时
    | 'max_steps'              // 步数上限
    | 'max_messages'           // 消息软上限
    | 'cli_exit'               // CLI 异常退出
    | 'cli_error'              // CLI 报错
    | 'internal_error';        // ExpertRunner 内部异常

// ---------------------------------------------------------------------------
// ExpertRunner
// ---------------------------------------------------------------------------

/**
 * 专家执行状态机。
 *
 * **生命周期**：每次 {@link run} 调用是一个独立 run；ExpertRunner 实例本身
 * 不持有跨 run 的状态，可以安全地复用。
 *
 * **线程模型**：单实例同时只允许跑一个 run（由调用方/MCP server 的
 * `EXPERT_MAX_CALLS_PER_TURN=1` 保证）；若并发调用，第二次会立即得到
 * 一个 `[Expert mode failed: another run in progress]` 失败结果。
 */
export class ExpertRunner {
    /** 是否有 run 正在进行。 */
    private inFlight = false;

    public constructor(private readonly deps: ExpertRunnerDeps) {}

    /**
     * 执行一次专家任务。
     *
     * 该方法**永远 resolve**（不会 reject）；任何异常都会被吸收成
     * `{ isError: true, finalAnswer: '[Expert mode failed: ...]' }`。
     *
     * @param req run 请求。
     * @returns run 结果。
     */
    public async run(req: ExpertRunRequest): Promise<ExpertRunResult> {
        const timers = this.deps.timers ?? defaultTimers;
        const log = this.deps.logger ?? ((m, meta) => console.error(`[ExpertRunner] ${m}`, meta));
        const startedAt = timers.now();
        const runId = generateRunId(startedAt);

        if (this.inFlight) {
            // 第二次并发调用：立即失败，不 spawn 第二个进程。
            const text = '[Expert mode failed: another expert run is already in progress]';
            this.pushFinal(req, runId, text, true, 0);
            return { finalAnswer: text, isError: true, durationMs: 0, endReason: 'internal_error' };
        }
        this.inFlight = true;

        // 用 RunContext 把全部局部变量集中起来，便于 helper 共享与清理。
        const ctx: RunContext = {
            req,
            runId,
            startedAt,
            timers,
            log,
            cli: undefined,
            collectedTexts: [],
            finalTextFromCli: undefined,
            toolUseCount: 0,
            assistantMessageCount: 0,
            assistantHasNewText: false,
            endReason: undefined,
            endError: undefined,
            disposers: [],
            resetIdleTimer: () => {},
            settled: false
        };

        // 推送 start 事件
        this.pushStart(ctx);

        try {
            await this.executeRun(ctx);
        } catch (e) {
            // 兜底：任何未捕获异常都标记为 internal_error
            ctx.endReason = ctx.endReason ?? 'internal_error';
            ctx.endError = String((e as Error)?.message ?? e);
            log('run() threw uncaught error', e);
        } finally {
            await this.cleanup(ctx);
            this.inFlight = false;
        }

        const durationMs = timers.now() - ctx.startedAt;
        const { finalAnswer, isError } = this.buildFinalAnswer(ctx);

        // 推送 final / error / cancelled 事件
        this.pushTerminationEvent(ctx, finalAnswer, isError, durationMs);

        return {
            finalAnswer,
            isError,
            durationMs,
            endReason: ctx.endReason ?? 'completed'
        };
    }

    /**
     * 真正驱动 CLI 的内层逻辑，由 {@link run} 在 try/finally 中调用。
     *
     * 该方法在四种情况下退出：
     * 1. CLI 推送 `result` 事件 → 正常完成；
     * 2. 任一护栏触发 → 抛 {@link AbortRunError} 由外层 finally 兜底；
     * 3. 外部 AbortSignal → 抛 AbortRunError(reason='cancelled')；
     * 4. CLI 退出 / 报错 → 抛 AbortRunError(reason='cli_exit' | 'cli_error')。
     */
    private async executeRun(ctx: RunContext): Promise<void> {
        // 检查 signal 是否已经 abort（罕见，但要早退）
        if (ctx.req.signal?.aborted) {
            ctx.endReason = 'cancelled';
            return;
        }

        ctx.cli = this.deps.createCliProcess();
        await ctx.cli.start(this.deps.expertConfig);

        // ---------------- 监听 + 护栏 ----------------
        // 用 Promise + resolver 把"事件流终止"与"超时"统一到一个等待点。
        const done = new Promise<void>((resolve) => {
            const settle = (reason: ExpertRunEndReason, errorMsg?: string): void => {
                if (ctx.settled) return;
                ctx.settled = true;
                ctx.endReason = ctx.endReason ?? reason;
                if (errorMsg) ctx.endError = errorMsg;
                resolve();
            };

            // 总超时
            const totalTimer = ctx.timers.setTimeout(() => settle('timeout'), EXPERT_TIMEOUT_MS);
            ctx.disposers.push(totalTimer);

            // 空闲超时（每次有事件到达时重置）
            let cancelIdle: () => void = () => {};
            const armIdleTimer = (): void => {
                cancelIdle();
                cancelIdle = ctx.timers.setTimeout(() => settle('idle_timeout'), EXPERT_IDLE_TIMEOUT_MS);
            };
            armIdleTimer();
            ctx.disposers.push(() => cancelIdle());
            ctx.resetIdleTimer = armIdleTimer;

            // CLI 事件订阅
            const eventSub = ctx.cli!.onEvent((event) => this.handleStreamEvent(ctx, event, settle));
            ctx.disposers.push(() => eventSub.dispose());

            // CLI 退出订阅
            const exitSub = ctx.cli!.onExit(() => settle('cli_exit', 'expert CLI exited unexpectedly'));
            ctx.disposers.push(() => exitSub.dispose());

            // 外部 AbortSignal
            if (ctx.req.signal) {
                const onAbort = (): void => settle('cancelled');
                ctx.req.signal.addEventListener('abort', onAbort, { once: true });
                ctx.disposers.push(() => ctx.req.signal!.removeEventListener('abort', onAbort));
            }
        });

        // 发首条 user 消息
        try {
            const userText = buildExpertInitialUserMessage(ctx.req.args);
            const jsonLine = JSON.stringify({
                type: 'user',
                message: { role: 'user', content: userText }
            });
            ctx.cli.send(jsonLine);
        } catch (e) {
            ctx.endReason = 'cli_error';
            ctx.endError = `failed to send initial message: ${String((e as Error)?.message ?? e)}`;
            return;
        }

        await done;
    }

    /**
     * 把 CLI 推上来的一条事件转换为：
     *   1. ExpertEvent 推给 webview；
     *   2. 更新计数器 / 重置空闲计时器；
     *   3. 判断是否触发护栏 / 是否正常完成，调用 settle()。
     */
    private handleStreamEvent(
        ctx: RunContext,
        event: ExpertStreamEvent,
        settle: (reason: ExpertRunEndReason, errorMsg?: string) => void
    ): void {
        ctx.resetIdleTimer();
        const baseEvent = {
            runId: ctx.runId,
            parentMessageId: ctx.req.parentMessageId,
            callId: ctx.req.callId,
            toolSegmentId: ctx.req.toolSegmentId,
            ts: ctx.timers.now()
        };

        switch (event.kind) {
            case 'assistant_text': {
                ctx.collectedTexts.push(event.text);
                ctx.assistantHasNewText = true;
                this.deps.eventSink.push({
                    ...baseEvent,
                    kind: 'analysis',
                    text: truncateForEvent(event.text)
                });
                break;
            }
            case 'tool_use': {
                ctx.toolUseCount += 1;
                this.deps.eventSink.push({
                    ...baseEvent,
                    kind: 'tool_call',
                    toolName: event.toolName,
                    toolArgs: event.args
                });
                if (ctx.toolUseCount >= EXPERT_MAX_STEPS) {
                    settle('max_steps');
                }
                break;
            }
            case 'tool_result': {
                this.deps.eventSink.push({
                    ...baseEvent,
                    kind: 'tool_result',
                    toolName: event.toolName,
                    toolResultSummary: truncateForEvent(event.resultText),
                    toolIsError: event.isError
                });
                break;
            }
            case 'message_end': {
                // 一条 assistant message 结束，计入软上限
                if (ctx.assistantHasNewText) {
                    ctx.assistantMessageCount += 1;
                    ctx.assistantHasNewText = false;
                    if (ctx.assistantMessageCount >= EXPERT_MAX_ASSISTANT_MESSAGES) {
                        settle('max_messages');
                    }
                }
                break;
            }
            case 'result': {
                if (typeof event.finalText === 'string' && event.finalText.length > 0) {
                    ctx.finalTextFromCli = event.finalText;
                }
                settle('completed');
                break;
            }
            case 'error': {
                settle('cli_error', event.message);
                break;
            }
        }
    }

    /**
     * 清理一次 run 的所有副作用：取消计时器、解绑监听器、关闭 CLI 子进程。
     *
     * 关键：CLI 进程**一定**会被 dispose——即使 dispose 本身抛错也只记录日志。
     */
    private async cleanup(ctx: RunContext): Promise<void> {
        // 先 dispose 所有计时器与监听器，避免 cleanup 期间继续触发回调
        for (const d of ctx.disposers) {
            try {
                d();
            } catch (e) {
                ctx.log('disposer threw', e);
            }
        }
        ctx.disposers = [];

        // 关闭 CLI（带 grace period 由 CliProcess 内部处理；此处只调用其 dispose）
        if (ctx.cli) {
            try {
                const result = ctx.cli.dispose();
                if (result && typeof (result as Promise<void>).then === 'function') {
                    await Promise.race([
                        result,
                        new Promise<void>((resolve) => {
                            ctx.timers.setTimeout(resolve, EXPERT_KILL_GRACE_MS);
                        })
                    ]);
                }
            } catch (e) {
                ctx.log('expert cli dispose threw', e);
            }
            ctx.cli = undefined;
        }
    }

    /**
     * 根据 run 状态构造最终回写主对话的 finalAnswer 字符串。
     *
     * 成功完成：使用 CLI 提供的 finalText；若 CLI 未提供则拼接所有 assistant 文本；
     * 失败：拼装 `[Expert mode failed: <reason>]`。
     *
     * 输出会按 {@link EXPERT_FINAL_ANSWER_MAX_BYTES} 截断。
     */
    private buildFinalAnswer(ctx: RunContext): { finalAnswer: string; isError: boolean } {
        const reason = ctx.endReason ?? 'completed';
        let text: string;
        let isError = false;
        if (reason === 'completed') {
            text =
                (ctx.finalTextFromCli && ctx.finalTextFromCli.trim().length > 0
                    ? ctx.finalTextFromCli
                    : ctx.collectedTexts.join('\n').trim()) || '[Expert returned no text]';
            if (text === '[Expert returned no text]') {
                isError = true;
            }
        } else {
            isError = true;
            const detail = ctx.endError ? `: ${ctx.endError}` : '';
            text = `[Expert mode failed: ${reason}${detail}]`;
        }
        return {
            finalAnswer: truncateForFinalAnswer(text),
            isError
        };
    }

    /** 推送 start 事件。 */
    private pushStart(ctx: RunContext): void {
        this.deps.eventSink.push({
            runId: ctx.runId,
            parentMessageId: ctx.req.parentMessageId,
            callId: ctx.req.callId,
            toolSegmentId: ctx.req.toolSegmentId,
            ts: ctx.startedAt,
            kind: 'start',
            question: ctx.req.args.question,
            expertModel: this.deps.expertConfig.model
        });
    }

    /**
     * 在 run() 入口处遇到无法启动的硬错误时，直接推送一条 error final 事件。
     *
     * 仅用于「inFlight 冲突」这种早退场景；正常路径由 pushTerminationEvent 统一处理。
     */
    private pushFinal(
        req: ExpertRunRequest,
        runId: string,
        text: string,
        isError: boolean,
        durationMs: number
    ): void {
        const ev: ExpertEvent = {
            runId,
            parentMessageId: req.parentMessageId,
            callId: req.callId,
            toolSegmentId: req.toolSegmentId,
            ts: Date.now(),
            kind: isError ? 'error' : 'final',
            text,
            durationMs
        };
        this.deps.eventSink.push(ev);
    }

    /**
     * 根据 endReason 推送 final / error / cancelled 事件之一。
     */
    private pushTerminationEvent(
        ctx: RunContext,
        finalAnswer: string,
        isError: boolean,
        durationMs: number
    ): void {
        let kind: ExpertEvent['kind'] = 'final';
        if (ctx.endReason === 'cancelled') kind = 'cancelled';
        else if (isError) kind = 'error';

        this.deps.eventSink.push({
            runId: ctx.runId,
            parentMessageId: ctx.req.parentMessageId,
            callId: ctx.req.callId,
            toolSegmentId: ctx.req.toolSegmentId,
            ts: ctx.timers.now(),
            kind,
            text: finalAnswer,
            durationMs
        });
    }
}

// ---------------------------------------------------------------------------
// 内部状态结构
// ---------------------------------------------------------------------------

/**
 * 单次 run 的所有局部状态。
 *
 * 之所以把它们抽成一个对象，是为了让 ExpertRunner 的 helper 方法可以共享同一份
 * 状态，且 cleanup 时一目了然要清理哪些资源——杜绝散落在闭包里的隐形引用。
 */
interface RunContext {
    /** 原始请求。 */
    req: ExpertRunRequest;
    /** 本次 run 的稳定 id。 */
    runId: string;
    /** 开始时间戳。 */
    startedAt: number;
    /** 计时器实现。 */
    timers: ExpertTimers;
    /** 日志回调。 */
    log: (message: string, meta?: unknown) => void;
    /** 已 spawn 的 CLI 实例（cleanup 时需 dispose）。 */
    cli: ExpertCliProcessLike | undefined;
    /** 已收集的所有 assistant 文本片段，按时间顺序拼接成 finalAnswer 兜底。 */
    collectedTexts: string[];
    /** CLI 在 `result` 事件里提供的 finalText（如果有）。 */
    finalTextFromCli: string | undefined;
    /** 累计 tool_use 内容块数（步数护栏）。 */
    toolUseCount: number;
    /** 累计完成的 assistant 消息数（消息软上限）。 */
    assistantMessageCount: number;
    /** 当前 assistant 消息中是否已经收到过 text（用于 message_end 时判断是否计数）。 */
    assistantHasNewText: boolean;
    /** 结束原因（settle 时设置）。 */
    endReason: ExpertRunEndReason | undefined;
    /** 错误说明（cli_error 等场景）。 */
    endError: string | undefined;
    /** 所有需在 cleanup 时调用的 dispose 回调（计时器、监听器）。 */
    disposers: Array<() => void>;
    /** 重置空闲计时器；由 executeRun 内部装配后赋值。 */
    resetIdleTimer: () => void;
    /** 是否已 settle（确保 done Promise 只 resolve 一次）。 */
    settled: boolean;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 生成本次 run 的稳定 id。
 *
 * 格式 `expert-<timestamp>-<rand>`，仅用于关联事件，不要求全局唯一。
 */
function generateRunId(timestampMs: number): string {
    const rand = Math.floor(Math.random() * 1e6).toString(36);
    return `expert-${timestampMs}-${rand}`;
}

/**
 * 按 {@link EXPERT_FINAL_ANSWER_MAX_BYTES} 截断写回主对话的 finalAnswer。
 *
 * 与 {@link truncateForEvent} 的区别仅在于上限不同：finalAnswer 上限更大（64KB），
 * 因为它会进入主模型上下文。
 */
function truncateForFinalAnswer(text: string): string {
    const buf = Buffer.from(text, 'utf8');
    if (buf.byteLength <= EXPERT_FINAL_ANSWER_MAX_BYTES) return text;
    let head = buf.toString('utf8', 0, EXPERT_FINAL_ANSWER_MAX_BYTES);
    while (head.endsWith('\uFFFD')) {
        head = head.slice(0, -1);
    }
    return `${head}\n[truncated, original=${buf.byteLength} bytes]`;
}
