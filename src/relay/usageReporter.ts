/**
 * @file Anthropic 协议响应 usage 抽取与上报。
 *
 * 工作位置：三个 proxy（Anthropic / OpenAI Chat / OpenAI Responses）在把上游
 * 响应转换为 Anthropic 协议（SSE 或 JSON）之后、写给下游 Claude Code 之前，
 * 同时把同一份 Anthropic 内容喂给本模块。本模块负责：
 *
 * 1. 解析 Anthropic `message_start.message.usage` 与 `message_delta.usage`
 *    （流式），以及非流式 JSON 的顶层 `usage`；
 * 2. 累计得到完整的 input / output / cache_creation / cache_read token；
 * 3. 通过外部注入的 {@link UsageSink} 上报给 Chat UI。
 *
 * 与 {@link LlsTaskStreamingInterceptor} 并列，不与之耦合：拦截器只管"工具
 * 改写"，本模块只管"token 抽取"。
 */

import { requestUsageRegistry } from '../chatRuntime/requestUsage';
import type { UpstreamRequestContext } from './router';
import { Logger } from '../logger';

/** 每个转发上下文共享一个报告器，覆盖尚未收到响应头的失败路径。 */
const requestReporters = new WeakMap<UpstreamRequestContext, UsageReporter>();

/** 取请求级报告器，禁止 JSON、SSE 和错误分支重复上报同一请求。 */
export function getRequestUsageReporter(ctx: UpstreamRequestContext, sink?: UsageSink): UsageReporter {
    let reporter = requestReporters.get(ctx);
    if (!reporter) {
        reporter = new UsageReporter(sink, ctx.usageContext);
        requestReporters.set(ctx, reporter);
    }
    return reporter;
}
import { normalizeRequestUsage, type RequestUsageContext, type RequestUsageSummary, type RequestUsageStatus } from './requestUsage';

/** 单次响应聚合后的 token 使用量。 */
export interface UsageReport {
    /** 由请求入口固定的身份；后续代理接入时填充。 */
    context?: RequestUsageContext;
    /** 请求级结束状态、用量及完整性，不使用 CLI 累计 usage。 */
    summary?: RequestUsageSummary;
    /** 上游返回的模型 id（来自 Anthropic message.model）。 */
    model?: string;
    /** 输入 token 数。 */
    inputTokens?: number;
    /** 输出 token 数。 */
    outputTokens?: number;
    /** 缓存写入 token（Anthropic prompt caching）。 */
    cacheCreationInputTokens?: number;
    /** 缓存读取 token（Anthropic prompt caching）。 */
    cacheReadInputTokens?: number;
}

/**
 * Usage 上报通道：proxy 收到响应、聚合到 usage 之后调用一次。
 *
 * @param report 本次响应的 token 统计。
 */
export type UsageSink = (report: UsageReport) => void;

/** SSE 事件结构。 */
interface SseEventRecord {
    /** 事件名。 */
    event?: string;
    /** data 行拼接后的文本。 */
    data: string;
}

/**
 * Anthropic 响应 usage 抽取器。
 *
 * 支持同时接受流式与非流式两种喂入：
 *
 * - 流式：调用方在 onData 中把每段 Anthropic SSE 文本喂给 {@link feed}，
 *   end 时调用 {@link end}；
 * - 非流式：调用方在拿到完整响应文本时调用一次 {@link feedJson}（不需要再
 *   调用 end）。
 *
 * 同一实例仅服务一次响应；多次响应请新建实例。
 */
export class UsageReporter {
    /** 尚未形成完整 SSE 事件的输入缓冲。 */
    private buffer = '';

    /** 已聚合的 usage 信息。 */
    private readonly report: UsageReport = {};

    /** 是否已经触发过上报，避免 end 时重复上报。 */
    private reported = false;

    /**
     * 创建 usage 抽取器。
     *
     * @param sink usage 上报回调；为空时模块仅维护内部状态、不向外发布。
     */
    public constructor(private readonly sink: UsageSink | undefined, context?: RequestUsageContext) {
        this.report.context = context;
        if (context) requestUsageRegistry.registerRequest(context);
    }

    /** 终止状态；错误事件优先于普通流结束。 */
    private status: RequestUsageStatus = 'completed';

    /**
     * 喂入一段 Anthropic SSE 文本（流式专用）。
     *
     * @param chunk Anthropic SSE 文本片段。
     */
    public feed(chunk: string): void {
        if (this.reported || !chunk) return;
        this.buffer += chunk;
        const events = this.drainCompleteEvents();
        for (const ev of events) this.handleEvent(ev);
    }

    /**
     * 流式输入结束，发出最终上报。
     */
    public end(status?: RequestUsageStatus): void {
        if (this.reported) return;
        if (status) this.status = status;
        const tail = this.buffer.trim();
        this.buffer = '';
        if (tail) this.handleEvent(tail);
        this.flushReport();
    }

    /**
     * 喂入一份完整 Anthropic JSON 响应文本（非流式专用）。
     *
     * @param body Anthropic JSON 响应文本。
     */
    public feedJson(body: string): void {
        if (this.reported) return;
        if (!body) { this.end(); return; }
        try {
            const json = JSON.parse(body) as unknown;
            this.collectFromAnthropicMessage(json);
        } catch (err) {
            this.status = 'error';
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[UsageReporter] 非流式响应解析失败：${message}`);
        }
        this.flushReport();
    }

    /**
     * 从缓冲区取出所有完整的 SSE event 文本，兼容 LF、CRLF 及跨分片分隔符。
     *
     * @returns event 原始文本数组。
     */
    private drainCompleteEvents(): string[] {
        const events: string[] = [];
        while (true) {
            const marker = /\r?\n\r?\n/.exec(this.buffer);
            if (!marker) break;
            events.push(this.buffer.slice(0, marker.index));
            this.buffer = this.buffer.slice(marker.index + marker[0].length);
        }
        return events;
    }

    /**
     * 处理单个 SSE event：仅关心 message_start / message_delta。
     *
     * @param rawEvent 原始 SSE 事件文本。
     */
    private handleEvent(rawEvent: string): void {
        const record = parseSseEvent(rawEvent);
        if (!record.data || record.data === '[DONE]') return;
        let payload: unknown;
        try {
            payload = JSON.parse(record.data) as unknown;
        } catch {
            return;
        }
        if (!isRecord(payload)) return;
        const type = payload.type;
        const context = this.report.context;
        if (context && type === 'content_block_start' && isRecord(payload.content_block)
            && payload.content_block.type === 'tool_use' && typeof payload.content_block.id === 'string') {
            requestUsageRegistry.bindResponseMessage(context.requestId, context.sessionId, payload.content_block.id, 'tool');
        }
        if (type === 'error') this.status = 'error';
        if (type === 'message_start') {
            this.collectFromAnthropicMessage(payload.message);
        } else if (type === 'message_delta') {
            this.collectUsage(payload.usage);
        }
    }

    /**
     * 从 Anthropic Message JSON 对象里抓取 model 与 usage。
     *
     * @param messageJson Anthropic message 对象（顶层 / message_start.message / 非流式 JSON）。
     */
    private collectFromAnthropicMessage(messageJson: unknown): void {
        if (!isRecord(messageJson)) return;
        if (messageJson.type === 'error' || messageJson.error) this.status = 'error';
        if (typeof messageJson.model === 'string' && messageJson.model) {
            this.report.model = messageJson.model;
        }
        const context = this.report.context;
        if (context && typeof messageJson.id === 'string') {
            requestUsageRegistry.bindResponseMessage(context.requestId, context.sessionId, messageJson.id);
        }
        if (context && Array.isArray(messageJson.content)) {
            for (const block of messageJson.content) {
                if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
                    requestUsageRegistry.bindResponseMessage(context.requestId, context.sessionId, block.id, 'tool');
                }
            }
        }
        this.collectUsage(messageJson.usage);
    }

    /**
     * 从 Anthropic usage 对象里抓取所有 token 字段。
     *
     * Anthropic 的流式协议会在 message_start 给基础 usage，再在 message_delta
     * 上下文里更新 output_tokens；缓存类字段通常一次性带在 message_start.usage
     * 上。我们对所有字段都取"最后一次有效值"。
     *
     * @param usageJson Anthropic usage 对象。
     */
    private collectUsage(usageJson: unknown): void {
        if (!isRecord(usageJson)) return;
        const input = readPositiveNumber(usageJson.input_tokens);
        if (input !== undefined) this.report.inputTokens = input;
        const output = readPositiveNumber(usageJson.output_tokens);
        if (output !== undefined) this.report.outputTokens = output;
        const cacheWrite = readPositiveNumber(usageJson.cache_creation_input_tokens);
        if (cacheWrite !== undefined) this.report.cacheCreationInputTokens = cacheWrite;
        const cacheRead = readPositiveNumber(usageJson.cache_read_input_tokens);
        if (cacheRead !== undefined) this.report.cacheReadInputTokens = cacheRead;
    }

    /**
     * 通过 sink 上报最终 usage；若信息全空则跳过。
     */
    private flushReport(): void {
        if (this.reported) return;
        if (this.report.context) {
            this.report.summary = normalizeRequestUsage(this.report.context, this.report, this.status);
        }
        this.reported = true;
        // 每个上游请求独立汇总一次，不等待 CLI 整轮 result；缺失字段不冒充实际用量。
        const { model, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = this.report;
        const totalInput = this.report.summary?.totalInputTokens;
        const rate = this.report.summary?.cacheHitRate;
        const hitRate = rate === undefined ? 'N/A' : `${rate.toFixed(2)}%`;
        Logger.info(`[usage] 请求结束：model=${model || 'unknown'} 输入合计=${totalInput ?? 'N/A'} 输出=${outputTokens ?? 'N/A'} 未缓存输入=${inputTokens ?? 'N/A'} 缓存读取=${cacheReadInputTokens ?? 'N/A'} 缓存写入=${cacheCreationInputTokens ?? 'N/A'} 缓存命中率=${hitRate}`);
        if (!this.sink) {
            this.reported = true;
            return;
        }
        const hasAny = this.report.inputTokens !== undefined
            || this.report.outputTokens !== undefined
            || this.report.cacheCreationInputTokens !== undefined
            || this.report.cacheReadInputTokens !== undefined;
        if (!hasAny && !this.report.context) {
            this.reported = true;
            return;
        }
        try {
            this.sink(this.report);
            this.reported = true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[UsageReporter] sink 调用失败：${message}`);
        }
    }
}

/**
 * 解析单个 Anthropic SSE event 文本。
 *
 * @param rawEvent 原始 event 文本。
 * @returns 解析得到的 event 与 data。
 */
function parseSseEvent(rawEvent: string): SseEventRecord {
    const lines = rawEvent.split(/\r?\n/);
    let event: string | undefined;
    const dataParts: string[] = [];
    for (const line of lines) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataParts.push(line.slice(5).trim());
        }
    }
    return { event, data: dataParts.join('\n') };
}

/**
 * 判断未知值是否为 plain object。
 *
 * @param value 待判断值。
 * @returns 是否为 Record。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把未知值解析为非负数字；非法时返回 undefined。
 *
 * @param value 待解析值。
 * @returns 非负数字或 undefined。
 */
function readPositiveNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return value;
}
