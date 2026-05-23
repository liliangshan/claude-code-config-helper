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

import { Logger } from '../logger';

/** 单次响应聚合后的 token 使用量。 */
export interface UsageReport {
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
    public constructor(private readonly sink: UsageSink | undefined) {}

    /**
     * 喂入一段 Anthropic SSE 文本（流式专用）。
     *
     * @param chunk Anthropic SSE 文本片段。
     */
    public feed(chunk: string): void {
        if (!chunk) return;
        this.buffer += chunk;
        const events = this.drainCompleteEvents();
        for (const ev of events) this.handleEvent(ev);
    }

    /**
     * 流式输入结束，发出最终上报。
     */
    public end(): void {
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
        if (!body) return;
        try {
            const json = JSON.parse(body) as unknown;
            this.collectFromAnthropicMessage(json);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[UsageReporter] 非流式响应解析失败：${message}`);
        }
        this.flushReport();
    }

    /**
     * 从缓冲区取出所有完整的 SSE event 文本。
     *
     * @returns event 原始文本数组。
     */
    private drainCompleteEvents(): string[] {
        const events: string[] = [];
        let idx = this.buffer.indexOf('\n\n');
        while (idx !== -1) {
            events.push(this.buffer.slice(0, idx));
            this.buffer = this.buffer.slice(idx + 2);
            idx = this.buffer.indexOf('\n\n');
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
        if (typeof messageJson.model === 'string' && messageJson.model) {
            this.report.model = messageJson.model;
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
        if (!this.sink) {
            this.reported = true;
            return;
        }
        const hasAny = this.report.inputTokens !== undefined
            || this.report.outputTokens !== undefined
            || this.report.cacheCreationInputTokens !== undefined
            || this.report.cacheReadInputTokens !== undefined;
        if (!hasAny) {
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
