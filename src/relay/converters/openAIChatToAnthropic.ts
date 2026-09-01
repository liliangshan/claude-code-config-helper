/**
 * @file OpenAI Chat Completions 非流式响应到 Anthropic Messages 响应的转换器。
 *
 * 本模块只处理 JSON 非流式响应；SSE 流式转换由后续状态机模块实现。
 */

import type { ModelReasoningMode } from '../../types';
import type { ConversionWarning } from './anthropicToOpenAIChat';

/** Anthropic content block。 */
type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown };

/** Anthropic Messages 非流式响应体。 */
export interface AnthropicMessageResponse {
    /** Anthropic message id。 */
    id: string;
    /** 固定 message 类型。 */
    type: 'message';
    /** 固定 assistant 角色。 */
    role: 'assistant';
    /** 上游模型 ID。 */
    model: string;
    /** Anthropic content blocks。 */
    content: AnthropicContentBlock[];
    /** Anthropic stop_reason。 */
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
    /** 命中的 stop sequence。 */
    stop_sequence: string | null;
    /** Anthropic usage。 */
    usage: {
        /** 输入 token 数。 */
        input_tokens: number;
        /** 输出 token 数。 */
        output_tokens: number;
        /** 命中缓存的输入 token 数；上游未返回该字段时不下发。 */
        cache_read_input_tokens?: number;
    };
}

/** OpenAI Chat JSON → Anthropic JSON 转换结果。 */
export interface OpenAIChatToAnthropicJsonResult {
    /** 转换后的 Anthropic Messages 响应。 */
    body: AnthropicMessageResponse;
    /** 转换 warning。 */
    warnings: ConversionWarning[];
}

/** 单个 OpenAI tool_call 在流式过程中的累积状态。 */
interface ToolCallStreamState {
    /** OpenAI tool_calls[].index。 */
    openAiIndex: number;
    /** 对应 Anthropic content_block 的 index，未发 start 时为 undefined。 */
    anthropicBlockIndex?: number;
    /** OpenAI tool_call.id，可能跨 chunk 才到齐。 */
    id?: string;
    /** OpenAI tool_call.function.name，可能跨 chunk 才到齐。 */
    name?: string;
    /** 累积的 function.arguments JSON 字符串。 */
    argumentsJson: string;
    /** 已经向客户端发送过的 argumentsJson 长度。 */
    emittedArgumentsLength: number;
    /** 是否已发出 content_block_start。 */
    started: boolean;
    /** 是否已发出 content_block_stop。 */
    closed: boolean;
}

/** Chat Completions SSE → Anthropic SSE 的整体转换状态。 */
interface OpenAIChatToAnthropicState {
    /** Anthropic message id。 */
    messageId: string;
    /** 上游模型 ID。 */
    model: string;
    /** 是否已发 message_start。 */
    messageStartEmitted: boolean;
    /** 当前文本 content block index。 */
    currentTextIndex?: number;
    /** 文本 block 是否打开。 */
    textBlockOpen: boolean;
    /** 当前 thinking content block index。 */
    currentThinkingIndex?: number;
    /** thinking block 是否打开。 */
    thinkingBlockOpen: boolean;
    /** OpenAI tool_calls[].index -> ToolCallStreamState。 */
    toolCalls: Map<number, ToolCallStreamState>;
    /** 下一个可用 Anthropic content block index。 */
    nextBlockIndex: number;
    /** 输入 token 数（已扣除缓存命中部分）。 */
    promptTokens: number;
    /** 命中缓存的输入 token 数；上游未返回时为 undefined。 */
    cacheReadTokens?: number;
    /** 输出 token 数。 */
    completionTokens: number;
    /** OpenAI finish_reason。 */
    finishReason?: string;
    /** 是否已完成流。 */
    finished: boolean;
}

/**
 * OpenAI Chat SSE 到 Anthropic SSE 的增量转换器。
 *
 * 调用方可把任意上游 chunk 传入 {@link feed}，本转换器会缓存不完整行，
 * 并返回可立即写给 Claude Code 的 Anthropic SSE 文本。
 */
export class OpenAIChatToAnthropicStreamConverter {
    /** 尚未形成完整 SSE event 的输入缓冲。 */
    private buffer = '';

    /** 当前流转换状态。 */
    private readonly state: OpenAIChatToAnthropicState = {
        messageId: 'msg_openai_chat_stream',
        model: '',
        messageStartEmitted: false,
        textBlockOpen: false,
        thinkingBlockOpen: false,
        toolCalls: new Map<number, ToolCallStreamState>(),
        nextBlockIndex: 0,
        promptTokens: 0,
        completionTokens: 0,
        finished: false
    };

    /**
     * @param reasoningMode 模型级思考策略；仅 'passthrough' 时才把上游 reasoning
     *                      合成为 Anthropic thinking block。缺省 'off' 保持既有行为。
     */
    constructor(private readonly reasoningMode: ModelReasoningMode = 'off') {}

    /** 转换 warning。 */
    private readonly warnings: ConversionWarning[] = [];

    /**
     * 输入一段 OpenAI SSE 原始文本并输出 Anthropic SSE 文本。
     *
     * @param chunk 上游 SSE chunk。
     * @returns 可写给客户端的 Anthropic SSE 文本。
     */
    public feed(chunk: string): string {
        if (this.state.finished) return '';
        this.buffer += chunk;
        const events = this.drainCompleteEvents();
        return events.map((eventText) => this.handleOpenAIEvent(eventText)).join('');
    }

    /**
     * 结束输入流，并在必要时合成 message_delta / message_stop。
     *
     * @returns 剩余应输出的 Anthropic SSE 文本。
     */
    public end(): string {
        if (this.state.finished) return '';
        const tail = this.buffer.trim();
        this.buffer = '';
        const out = tail ? this.handleOpenAIEvent(tail) : '';
        return out + this.finishIfNeeded();
    }

    /**
     * 获取转换过程中的 warning 列表。
     *
     * @returns warning 副本。
     */
    public getWarnings(): ConversionWarning[] {
        return [...this.warnings];
    }

    /**
     * 从缓冲区取出完整 SSE event 文本。
     *
     * @returns 完整 event 文本列表。
     */
    private drainCompleteEvents(): string[] {
        const events: string[] = [];
        while (true) {
            const marker = this.buffer.indexOf('\n\n');
            if (marker < 0) break;
            events.push(this.buffer.slice(0, marker));
            this.buffer = this.buffer.slice(marker + 2);
        }
        return events;
    }

    /**
     * 处理单个 OpenAI SSE event。
     *
     * @param eventText SSE event 原始文本。
     * @returns Anthropic SSE 文本。
     */
    private handleOpenAIEvent(eventText: string): string {
        const dataLines = eventText.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) return '';
        const data = dataLines.join('\n');
        if (data === '[DONE]') return this.finishIfNeeded();
        let parsed: unknown;
        try {
            parsed = JSON.parse(data) as unknown;
        } catch (err) {
            this.warnings.push({ path: 'sse.data', code: 'invalid_sse_json', message: `OpenAI SSE data 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` });
            return '';
        }
        return this.handleChunk(parsed);
    }

    /**
     * 处理一个 OpenAI Chat chunk JSON。
     *
     * @param chunk OpenAI Chat chunk。
     * @returns Anthropic SSE 文本。
     */
    private handleChunk(chunk: unknown): string {
        if (!isRecord(chunk)) return '';
        let out = this.ensureMessageStart(chunk);
        this.readUsage(chunk);
        const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
        if (!choice) return out;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        // passthrough 时读回上游 reasoning。分支必须在 content 之前：真实报文里
        // reasoning 分片先于正文到达且不与正文交错。length > 0 是硬要求——
        // 上游正文阶段的每个 chunk 也带 "reasoning_content":""，用 !== undefined
        // 会反复开出空 thinking block。
        if (this.reasoningMode === 'passthrough' && typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            out += this.emitThinkingDelta(delta.reasoning_content);
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            out += this.emitTextDelta(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
            out += this.handleToolCallDeltas(delta.tool_calls);
        }
        if (typeof choice.finish_reason === 'string' || choice.finish_reason === null) {
            this.state.finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
            // 收尾只关闭 content block，不发 message_delta：多数上游把 usage 放在
            // finish_reason 之后的独立 chunk 里，提前收尾会让那份 usage 永远发不出去。
            if (choice.finish_reason !== null) {
                // thinking 先关：覆盖「只有思考、没有正文」的退化流。
                out += this.closeThinkingBlockIfOpen();
                out += this.closeTextBlockIfOpen();
                out += this.closeAllToolBlocks();
            }
        }
        return out;
    }

    /**
     * 确保已输出 Anthropic message_start。
     *
     * @param chunk OpenAI chunk。
     * @returns 可能产生的 message_start SSE 文本。
     */
    private ensureMessageStart(chunk: Record<string, unknown>): string {
        if (this.state.messageStartEmitted) return '';
        if (typeof chunk.id === 'string') this.state.messageId = `msg_${chunk.id}`;
        if (typeof chunk.model === 'string') this.state.model = chunk.model;
        this.state.messageStartEmitted = true;
        return formatAnthropicSse('message_start', {
            type: 'message_start',
            message: {
                id: this.state.messageId,
                type: 'message',
                role: 'assistant',
                model: this.state.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: this.state.promptTokens,
                    output_tokens: 0,
                    ...(this.state.cacheReadTokens === undefined
                        ? {}
                        : { cache_read_input_tokens: this.state.cacheReadTokens })
                }
            }
        });
    }

    /**
     * 读取 chunk 中的 usage 信息。
     *
     * @param chunk OpenAI chunk。
     */
    private readUsage(chunk: Record<string, unknown>): void {
        if (!isRecord(chunk.usage)) return;
        const cachedTokens = readCachedTokens(chunk.usage, 'prompt_tokens_details');
        // OpenAI 的 prompt_tokens 含缓存命中部分，Anthropic 的 input_tokens 不含，故做减法。
        this.state.promptTokens = readNumber(chunk.usage.prompt_tokens) - (cachedTokens ?? 0);
        this.state.cacheReadTokens = cachedTokens;
        this.state.completionTokens = readNumber(chunk.usage.completion_tokens);
    }

    /**
     * 输出文本增量。
     *
     * @param text 文本 delta。
     * @returns Anthropic SSE 文本。
     */
    private emitTextDelta(text: string): string {
        // 正文开始前必须先关闭 thinking block，保证块顺序为 thinking → text。
        let out = this.closeThinkingBlockIfOpen();
        if (!this.state.textBlockOpen) {
            const index = this.state.nextBlockIndex++;
            this.state.currentTextIndex = index;
            this.state.textBlockOpen = true;
            out += formatAnthropicSse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' }
            });
        }
        out += formatAnthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index: this.state.currentTextIndex ?? 0,
            delta: { type: 'text_delta', text }
        });
        return out;
    }

    /**
     * 输出 thinking block 增量，必要时先开启 thinking block。
     *
     * 上游 reasoning 分片先于正文到达且不与正文交错，故 thinking block 天然
     * 占据 index 0，正文与工具块顺次后移，无需重排。
     *
     * 不发 signature_delta：OpenAI 侧不产出 Anthropic 服务端签名，合成的块
     * 仅供展示，不参与多轮回传（回传时会被 anthropicProxy 的签名校验剥离）。
     *
     * @param text 非空 reasoning 文本分片。
     * @returns Anthropic SSE 文本。
     */
    private emitThinkingDelta(text: string): string {
        let out = '';
        if (!this.state.thinkingBlockOpen) {
            const index = this.state.nextBlockIndex++;
            this.state.currentThinkingIndex = index;
            this.state.thinkingBlockOpen = true;
            out += formatAnthropicSse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'thinking', thinking: '' }
            });
        }
        out += formatAnthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index: this.state.currentThinkingIndex ?? 0,
            delta: { type: 'thinking_delta', thinking: text }
        });
        return out;
    }

    /**
     * 关闭当前 thinking 块。
     *
     * @returns Anthropic SSE 文本；未打开时为空串。
     */
    private closeThinkingBlockIfOpen(): string {
        if (!this.state.thinkingBlockOpen || this.state.currentThinkingIndex === undefined) return '';
        const index = this.state.currentThinkingIndex;
        this.state.thinkingBlockOpen = false;
        this.state.currentThinkingIndex = undefined;
        return formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index });
    }

    /**
     * 处理 OpenAI tool_calls 增量。
     *
     * @param deltas OpenAI delta.tool_calls 数组。
     * @returns Anthropic SSE 文本。
     */
    private handleToolCallDeltas(deltas: unknown[]): string {
        let out = '';
        for (const delta of deltas) {
            if (!isRecord(delta) || typeof delta.index !== 'number') continue;
            const state = this.getToolCallState(delta.index);
            if (typeof delta.id === 'string') state.id = delta.id;
            const fn = isRecord(delta.function) ? delta.function : {};
            if (typeof fn.name === 'string') state.name = fn.name;
            const argDelta = readToolArgumentsDelta(fn.arguments);
            state.argumentsJson += argDelta;
            out += this.maybeStartToolBlock(state);
            out += this.emitPendingToolArgumentsDelta(state);
        }
        return out;
    }

    /**
     * 获取或创建指定 OpenAI index 的 tool_call 状态。
     *
     * @param index OpenAI tool_calls[].index。
     * @returns tool_call 状态对象。
     */
    private getToolCallState(index: number): ToolCallStreamState {
        const existing = this.state.toolCalls.get(index);
        if (existing) return existing;
        const created: ToolCallStreamState = {
            openAiIndex: index,
            argumentsJson: '',
            emittedArgumentsLength: 0,
            started: false,
            closed: false
        };
        this.state.toolCalls.set(index, created);
        return created;
    }

    /**
     * 在 id 与 name 齐全后启动 Anthropic tool_use block。
     *
     * @param toolCall tool_call 状态。
     * @returns Anthropic SSE 文本。
     */
    private maybeStartToolBlock(toolCall: ToolCallStreamState): string {
        if (toolCall.started || !toolCall.id || !toolCall.name) return '';
        // thinking → text → tool_use 顺序关闭，保证块 index 单调递增。
        let out = this.closeThinkingBlockIfOpen();
        out += this.closeTextBlockIfOpen();
        const index = this.state.nextBlockIndex++;
        toolCall.anthropicBlockIndex = index;
        toolCall.started = true;
        out += formatAnthropicSse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.name, input: {} }
        });
        out += this.emitPendingToolArgumentsDelta(toolCall);
        return out;
    }

    /**
     * 输出 tool_use 尚未发送的 arguments partial_json delta。
     *
     * @param toolCall tool_call 状态。
     * @returns Anthropic SSE 文本。
     */
    private emitPendingToolArgumentsDelta(toolCall: ToolCallStreamState): string {
        if (!toolCall.started) return '';
        const delta = toolCall.argumentsJson.slice(toolCall.emittedArgumentsLength);
        return this.emitToolArgumentsDelta(toolCall, delta);
    }

    /**
     * 输出 tool_use arguments partial_json delta。
     *
     * @param toolCall tool_call 状态。
     * @param delta 本次要输出的 arguments delta。
     * @returns Anthropic SSE 文本。
     */
    private emitToolArgumentsDelta(toolCall: ToolCallStreamState, delta: string): string {
        const index = toolCall.anthropicBlockIndex;
        if (index === undefined || !delta) return '';
        toolCall.emittedArgumentsLength += delta.length;
        return formatAnthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: delta }
        });
    }

    /**
     * 关闭当前文本块。
     *
     * @returns Anthropic SSE 文本。
     */
    private closeTextBlockIfOpen(): string {
        if (!this.state.textBlockOpen || this.state.currentTextIndex === undefined) return '';
        const index = this.state.currentTextIndex;
        this.state.textBlockOpen = false;
        this.state.currentTextIndex = undefined;
        return formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index });
    }

    /**
     * 如尚未完成则关闭所有 block 并输出 message_delta/message_stop。
     *
     * @returns Anthropic SSE 文本。
     */
    private finishIfNeeded(): string {
        if (this.state.finished) return '';
        let out = this.closeThinkingBlockIfOpen();
        out += this.closeTextBlockIfOpen();
        out += this.closeAllToolBlocks();
        const stopReason = mapFinishReason(
            this.state.finishReason,
            Array.from(this.state.toolCalls.values()),
            this.warnings
        );
        // usage 只在最后一个 chunk 到达，message_start 那份可能是 0，这里补发真值。
        out += formatAnthropicSse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
                input_tokens: this.state.promptTokens,
                output_tokens: this.state.completionTokens,
                ...(this.state.cacheReadTokens === undefined
                    ? {}
                    : { cache_read_input_tokens: this.state.cacheReadTokens })
            }
        });
        out += formatAnthropicSse('message_stop', { type: 'message_stop' });
        this.state.finished = true;
        return out;
    }

    /**
     * 按 OpenAI index 顺序关闭所有 tool_use blocks。
     *
     * @returns Anthropic SSE 文本。
     */
    private closeAllToolBlocks(): string {
        let out = '';
        const ordered = Array.from(this.state.toolCalls.values()).sort((a, b) => a.openAiIndex - b.openAiIndex);
        for (const toolCall of ordered) {
            out += this.maybeStartToolBlock(toolCall);
            if (!toolCall.started || toolCall.closed || toolCall.anthropicBlockIndex === undefined) {
                if (!toolCall.started) {
                    this.warnings.push({ path: `tool_calls[${toolCall.openAiIndex}]`, code: 'incomplete_stream_tool_call', message: 'tool_call 流结束时仍缺 id 或 name，已跳过。' });
                }
                continue;
            }
            toolCall.closed = true;
            out += formatAnthropicSse('content_block_stop', {
                type: 'content_block_stop',
                index: toolCall.anthropicBlockIndex
            });
        }
        return out;
    }
}

function readToolArgumentsDelta(value: unknown): string {
    if (typeof value === 'string') return value;
    if (isRecord(value)) return JSON.stringify(value);
    return '';
}

/**
 * 将 OpenAI Chat Completions 非流式 JSON 转为 Anthropic Messages JSON。
 *
 * @param json OpenAI Chat completion JSON。
 * @param reasoningMode 模型级思考策略；'passthrough' 时把 message.reasoning_content
 *                      合成为 thinking block 置于 content 最前。缺省 'off' 保持既有行为。
 * @returns Anthropic 响应体与 warning 列表。
 */
export function convertOpenAIChatJsonToAnthropic(
    json: unknown,
    reasoningMode: ModelReasoningMode = 'off'
): OpenAIChatToAnthropicJsonResult {
    const source = isRecord(json) ? json : {};
    const warnings: ConversionWarning[] = [];
    const choice = Array.isArray(source.choices) && isRecord(source.choices[0]) ? source.choices[0] : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const content: AnthropicContentBlock[] = [];
    // thinking 放在正文之前，与流式路径的块顺序保持一致。
    if (reasoningMode === 'passthrough' && typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        content.push({ type: 'thinking', thinking: message.reasoning_content });
    }
    if (typeof message.content === 'string' && message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
    }
    appendToolCalls(content, message.tool_calls, warnings);
    const stopReason = mapFinishReason(choice.finish_reason, message.tool_calls, warnings);
    if (choice.finish_reason === 'content_filter' && content.length === 0) {
        content.push({ type: 'text', text: '[content filtered by upstream provider]' });
    }
    const usage = isRecord(source.usage) ? source.usage : undefined;
    const cachedTokens = readCachedTokens(usage, 'prompt_tokens_details');
    return {
        body: {
            id: `msg_${typeof source.id === 'string' ? source.id : 'openai_chat'}`,
            type: 'message',
            role: 'assistant',
            model: typeof source.model === 'string' ? source.model : '',
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                // OpenAI 的 prompt_tokens 含缓存命中部分，Anthropic 的 input_tokens 不含。
                input_tokens: readNumber(usage?.prompt_tokens) - (cachedTokens ?? 0),
                output_tokens: readNumber(usage?.completion_tokens),
                ...(cachedTokens === undefined ? {} : { cache_read_input_tokens: cachedTokens })
            }
        },
        warnings
    };
}

/**
 * 把 OpenAI tool_calls 追加为 Anthropic tool_use blocks。
 *
 * @param content Anthropic content blocks 输出数组。
 * @param toolCalls OpenAI tool_calls 字段。
 * @param warnings warning 收集器。
 */
function appendToolCalls(
    content: AnthropicContentBlock[],
    toolCalls: unknown,
    warnings: ConversionWarning[]
): void {
    if (!Array.isArray(toolCalls)) return;
    toolCalls.forEach((toolCall, index) => {
        if (!isRecord(toolCall)) return;
        const fn = isRecord(toolCall.function) ? toolCall.function : {};
        const id = typeof toolCall.id === 'string' ? toolCall.id : `toolu_${index}`;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) {
            warnings.push({ path: `choices[0].message.tool_calls[${index}].function.name`, code: 'missing_tool_name', message: 'OpenAI tool_call 缺少 function.name，已跳过。' });
            return;
        }
        const argPath = `choices[0].message.tool_calls[${index}].function.arguments`;
        content.push({
            type: 'tool_use',
            id,
            name,
            input: normalizeToolInput(name, parseToolArguments(fn.arguments, argPath, warnings), warnings, argPath)
        });
    });
}

/**
 * 解析 OpenAI function.arguments JSON 字符串。
 *
 * @param value arguments 字段。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @returns 解析后的对象，失败时返回空对象。
 */
function parseToolArguments(value: unknown, path: string, warnings: ConversionWarning[]): unknown {
    if (isRecord(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        return JSON.parse(value) as unknown;
    } catch (err) {
        warnings.push({
            path,
            code: 'invalid_tool_arguments_json',
            message: `tool_call arguments 不是合法 JSON，已使用空对象：${err instanceof Error ? err.message : String(err)}`
        });
        return {};
    }
}

/**
 * 归一化工具输入。
 *
 * @param name 工具名。
 * @param input 原始输入。
 * @param warnings warning 收集器。
 * @param path 用于 warning 的 JSON 路径。
 * @returns 归一化后的输入。
 */
function normalizeToolInput(
    name: string,
    input: unknown,
    warnings: ConversionWarning[],
    path: string
): unknown {
    if (name === 'Read') {
        if (!isRecord(input)) return input;
        const pages = input.pages;
        if (typeof pages === 'number' && Number.isInteger(pages) && pages >= 1) return { ...input, pages: String(pages) };
        if (typeof pages === 'string' && isValidPages(pages)) return input;
        return { ...input, pages: '1' };
    }
    if (name === 'Write') return normalizeWriteToolInput(input, warnings, path);
    return input;
}

/**
 * Write 工具空参数/缺字段拦截：把无效调用改写为带 __error__ 字段的占位 input，
 * 让下游 Claude CLI 端 Write 工具因 schema 校验失败而返回错误 tool_result，
 * 模型据此重试或改用 Edit 追加。
 *
 * @param input 上游返回的 arguments 解析结果。
 * @param warnings warning 收集器。
 * @param path warning 路径。
 * @returns 修正后的 input。
 */
function normalizeWriteToolInput(input: unknown, warnings: ConversionWarning[], path: string): unknown {
    const record = isRecord(input) ? { ...input } : {};
    const filePath = typeof record.file_path === 'string' ? record.file_path.trim() : '';
    const hasContent = typeof record.content === 'string';
    const reasons: string[] = [];
    if (!filePath) reasons.push('file_path missing or empty');
    if (!hasContent) reasons.push('content missing');
    if (reasons.length === 0) return record;
    warnings.push({
        path,
        code: 'invalid_write_tool_input',
        message: `Write tool call rejected: ${reasons.join('; ')}. Replaced with error placeholder.`
    });
    return {
        file_path: filePath || '__INVALID_WRITE_NO_PATH__',
        content: '',
        __error__: `Empty Write call blocked by relay: ${reasons.join('; ')}. Provide a non-empty file_path AND a non-empty initial content (one short segment), then use Edit to append the rest.`
    };
}

function isValidPages(value: string): boolean {
    const match = /^(\d+)(?:-(\d+))?$/.exec(value);
    if (!match) return false;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start;
}

/**
 * 映射 OpenAI finish_reason 为 Anthropic stop_reason。
 *
 * @param finishReason OpenAI finish_reason。
 * @param toolCalls OpenAI tool_calls 字段。
 * @param warnings warning 收集器。
 * @returns Anthropic stop_reason。
 */
function mapFinishReason(
    finishReason: unknown,
    toolCalls: unknown,
    warnings: ConversionWarning[]
): AnthropicMessageResponse['stop_reason'] {
    switch (finishReason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
        case 'function_call':
            return 'tool_use';
        case 'content_filter':
            return 'end_turn';
        case null:
        case undefined:
            return Array.isArray(toolCalls) && toolCalls.length > 0 ? 'tool_use' : 'end_turn';
        default:
            warnings.push({ path: 'choices[0].finish_reason', code: 'unknown_finish_reason', message: `未知 finish_reason=${String(finishReason)}，已映射为 end_turn。` });
            return 'end_turn';
    }
}

/**
 * 安全读取数字字段。
 *
 * @param value 待读取值。
 * @returns 有效数字或 0。
 */
function readNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 读取 OpenAI usage 中的缓存命中 token 数。
 *
 * 只认 OpenAI 规范字段 `prompt_tokens_details.cached_tokens`，上游未返回
 * 或非有效数字时返回 undefined，调用方据此决定是否下发
 * `cache_read_input_tokens`。
 *
 * @param usage OpenAI usage 对象。
 * @param detailsKey 存放明细的字段名（Chat 为 `prompt_tokens_details`）。
 * @returns 缓存命中 token 数；不可用时为 undefined。
 */
export function readCachedTokens(usage: unknown, detailsKey: string): number | undefined {
    if (!isRecord(usage)) return undefined;
    const details = usage[detailsKey];
    if (!isRecord(details)) return undefined;
    const cached = details.cached_tokens;
    return typeof cached === 'number' && Number.isFinite(cached) ? cached : undefined;
}

/**
 * 格式化 Anthropic SSE 事件。
 *
 * @param event 事件名。
 * @param payload 事件 JSON payload。
 * @returns Anthropic SSE 文本。
 */
function formatAnthropicSse(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 判断未知值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 是否为非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
