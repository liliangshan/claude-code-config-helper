/**
 * @file OpenAI Responses 非流式响应到 Anthropic Messages 响应的转换器。
 *
 * 本模块先实现 JSON 非流式响应转换；SSE 流式状态机会在后续任务中补充。
 */

import type { ResponsesConversionWarning } from './anthropicToOpenAIResponses';
import { formatAnthropicSseError } from './openAIErrorToAnthropic';
import { readCachedTokens } from './openAIChatToAnthropic';

/** Anthropic content block。 */
type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown };

/** Anthropic Messages 非流式响应体。 */
export interface AnthropicResponsesMessageResponse {
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

/** OpenAI Responses JSON → Anthropic JSON 转换结果。 */
export interface OpenAIResponsesToAnthropicJsonResult {
    /** 转换后的 Anthropic Messages 响应。 */
    body: AnthropicResponsesMessageResponse;
    /** 转换 warning。 */
    warnings: ResponsesConversionWarning[];
}

/** 单个 Responses output_index 对应的输出项状态。 */
interface ResponsesOutputItemState {
    /** Responses 顶层 output_index。 */
    outputIndex: number;
    /** output item 类型。 */
    type?: string;
    /** Responses item.id。 */
    id?: string;
    /** Responses function_call.call_id。 */
    callId?: string;
    /** Responses function_call.name。 */
    name?: string;
    /** 累积的 function_call arguments JSON 字符串。 */
    argumentsJson: string;
    /** 已经向 Anthropic 发送过的 arguments 字符数。 */
    emittedArgumentsLength: number;
    /** 对应 Anthropic content_block index。 */
    anthropicBlockIndex?: number;
    /** 是否已经输出 content_block_start。 */
    started: boolean;
    /** 是否已经输出 content_block_stop。 */
    closed: boolean;
}

/** 单个 Responses 文本 content part 的状态。 */
interface ResponsesTextPartState {
    /** Responses 顶层 output_index。 */
    outputIndex: number;
    /** Responses content_index。 */
    contentIndex: number;
    /** 对应 Anthropic content_block index。 */
    anthropicBlockIndex: number;
    /** 是否已经输出 content_block_stop。 */
    closed: boolean;
}

/** Responses SSE → Anthropic SSE 的整体转换状态。 */
interface OpenAIResponsesToAnthropicState {
    /** Anthropic message id。 */
    messageId: string;
    /** 上游模型 ID。 */
    model: string;
    /** 是否已输出 message_start。 */
    messageStartEmitted: boolean;
    /** output_index -> output item 状态。 */
    outputItems: Map<number, ResponsesOutputItemState>;
    /** `${output_index}:${content_index}` -> 文本 part 状态。 */
    textParts: Map<string, ResponsesTextPartState>;
    /** 下一个 Anthropic content block index。 */
    nextBlockIndex: number;
    /** 输入 token 数（已扣除缓存命中部分）。 */
    inputTokens: number;
    /** 命中缓存的输入 token 数；上游未返回时为 undefined。 */
    cacheReadTokens?: number;
    /** 输出 token 数。 */
    outputTokens: number;
    /** Responses status。 */
    status?: string;
    /** Responses incomplete_details。 */
    incompleteDetails?: unknown;
    /** 是否已完成流。 */
    finished: boolean;
}

/**
 * OpenAI Responses SSE 到 Anthropic SSE 的增量转换器。
 *
 * 调用方可把任意上游 chunk 传入 {@link feed}，本转换器会缓存不完整 SSE event，
 * 并返回可立即写给 Claude Code 的 Anthropic SSE 文本。
 */
export class OpenAIResponsesToAnthropicStreamConverter {
    /** 尚未形成完整 SSE event 的输入缓冲。 */
    private buffer = '';

    /** 当前流转换状态。 */
    private readonly state: OpenAIResponsesToAnthropicState = {
        messageId: 'msg_openai_response_stream',
        model: '',
        messageStartEmitted: false,
        outputItems: new Map<number, ResponsesOutputItemState>(),
        textParts: new Map<string, ResponsesTextPartState>(),
        nextBlockIndex: 0,
        inputTokens: 0,
        outputTokens: 0,
        finished: false
    };

    /** 转换 warning。 */
    private readonly warnings: ResponsesConversionWarning[] = [];

    /**
     * 输入一段 OpenAI Responses SSE 原始文本并输出 Anthropic SSE 文本。
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
        return out + this.finishIfNeeded('end');
    }

    /**
     * 获取转换过程中的 warning 列表。
     *
     * @returns warning 副本。
     */
    public getWarnings(): ResponsesConversionWarning[] {
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
     * 处理单个 Responses SSE event。
     *
     * @param eventText SSE event 原始文本。
     * @returns Anthropic SSE 文本。
     */
    private handleOpenAIEvent(eventText: string): string {
        const eventName = readSseEventName(eventText);
        const dataLines = eventText.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) return '';
        const data = dataLines.join('\n');
        if (data === '[DONE]') return this.finishIfNeeded('done');
        let parsed: unknown;
        try {
            parsed = JSON.parse(data) as unknown;
        } catch (err) {
            this.warnings.push({ path: 'sse.data', code: 'invalid_sse_json', message: `Responses SSE data 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` });
            return '';
        }
        return this.handleEventPayload(eventName, parsed);
    }

    /**
     * 根据 Responses 事件类型处理事件 payload。
     *
     * @param eventName SSE event 字段。
     * @param payload 已解析 JSON payload。
     * @returns Anthropic SSE 文本。
     */
    private handleEventPayload(eventName: string, payload: unknown): string {
        if (!isRecord(payload)) return '';
        const type = typeof payload.type === 'string' ? payload.type : eventName;
        switch (type) {
            case 'response.created':
                return this.handleResponseCreated(payload);
            case 'response.in_progress':
                return this.handleResponseInProgress(payload);
            case 'response.output_item.added':
                return this.handleOutputItemAdded(payload);
            case 'response.output_item.done':
                return this.handleOutputItemDone(payload);
            case 'response.content_part.added':
                return this.handleContentPartAdded(payload);
            case 'response.content_part.done':
                return this.handleContentPartDone(payload);
            case 'response.output_text.delta':
                return this.handleOutputTextDelta(payload);
            case 'response.output_text.done':
                return this.handleOutputTextDone(payload);
            case 'response.refusal.delta':
                return this.handleRefusalDelta(payload);
            case 'response.refusal.done':
                return this.handleOutputTextDone(payload);
            case 'response.function_call_arguments.delta':
                return this.handleFunctionArgumentsDelta(payload);
            case 'response.function_call_arguments.done':
                return this.handleFunctionArgumentsDone(payload);
            case 'response.completed':
                return this.handleResponseTerminal(payload, 'completed');
            case 'response.incomplete':
                return this.handleResponseTerminal(payload, 'incomplete');
            case 'response.failed':
                return this.handleResponseFailed(payload);
            case 'response.error':
            case 'error':
                return this.handleErrorPayload(payload);
            default:
                this.warnings.push({ path: 'sse.type', code: 'unsupported_sse_event', message: `已忽略未知 Responses SSE 事件：${type}。` });
                return '';
        }
    }

    /**
     * 处理 response.created 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns Anthropic message_start SSE 文本。
     */
    private handleResponseCreated(payload: Record<string, unknown>): string {
        const response = isRecord(payload.response) ? payload.response : payload;
        this.readResponseMetadata(response);
        return this.ensureMessageStart();
    }

    /**
     * 处理 response.in_progress 事件。
     *
     * 该事件只表示 Responses 对象进入运行态，通常不包含可转给 Anthropic 的
     * content block；这里读取元信息并确保 message_start 已发出，避免被记录成
     * unsupported_sse_event。
     *
     * @param payload Responses 事件 payload。
     * @returns 可能产生的 Anthropic message_start SSE 文本。
     */
    private handleResponseInProgress(payload: Record<string, unknown>): string {
        const response = isRecord(payload.response) ? payload.response : payload;
        this.readResponseMetadata(response);
        return this.ensureMessageStart();
    }

    /**
     * 处理 response.output_item.added 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns 可能产生的 Anthropic SSE 文本。
     */
    private handleOutputItemAdded(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.output_item.added');
        if (outputIndex === undefined) return '';
        const item = isRecord(payload.item) ? payload.item : {};
        const state = this.getOutputItemState(outputIndex);
        if (typeof item.type === 'string') state.type = item.type;
        if (typeof item.id === 'string') state.id = item.id;
        if (typeof item.call_id === 'string') state.callId = item.call_id;
        if (typeof item.name === 'string') state.name = item.name;
        if (typeof item.arguments === 'string') state.argumentsJson = item.arguments;
        return this.ensureMessageStart() + this.maybeStartFunctionCall(state) + this.emitPendingFunctionArgumentsDelta(state);
    }

    /**
     * 处理 response.output_item.done 事件。
     *
     * 对 function_call 来说，该事件表示整个工具调用输出项完成；如果 arguments
     * 尚有未输出的片段，先补发 input_json_delta，然后关闭对应 content block。
     * 普通 message output item 的文本块由 content_part/output_text 事件负责关闭。
     *
     * @param payload Responses 事件 payload。
     * @returns 可能产生的 Anthropic SSE 文本。
     */
    private handleOutputItemDone(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.output_item.done');
        if (outputIndex === undefined) return '';
        const item = isRecord(payload.item) ? payload.item : {};
        const state = this.getOutputItemState(outputIndex);
        if (typeof item.type === 'string') state.type = item.type;
        if (typeof item.id === 'string') state.id = item.id;
        if (typeof item.call_id === 'string') state.callId = item.call_id;
        if (typeof item.name === 'string') state.name = item.name;
        if (typeof item.arguments === 'string' && item.arguments.length >= state.argumentsJson.length) {
            state.argumentsJson = item.arguments;
        }
        let out = this.ensureMessageStart() + this.maybeStartFunctionCall(state) + this.emitPendingFunctionArgumentsDelta(state);
        if (state.started && !state.closed && state.anthropicBlockIndex !== undefined) {
            state.closed = true;
            out += formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index: state.anthropicBlockIndex });
        }
        return out;
    }

    /**
     * 处理 response.content_part.added 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns 可能产生的 Anthropic SSE 文本。
     */
    private handleContentPartAdded(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.content_part.added');
        const contentIndex = readContentIndex(payload, this.warnings, 'response.content_part.added');
        if (outputIndex === undefined || contentIndex === undefined) return '';
        const part = isRecord(payload.part) ? payload.part : {};
        const initialText = typeof part.text === 'string' ? part.text : typeof part.refusal === 'string' ? part.refusal : '';
        return this.startTextPart(outputIndex, contentIndex, initialText);
    }

    /**
     * 处理 response.content_part.done 事件。
     *
     * 若之前未收到 content_part.added / output_text.delta，但 done 事件携带完整文本，
     * 则先创建文本块并输出该文本，再关闭 block；否则只关闭已存在的文本块。
     *
     * @param payload Responses 事件 payload。
     * @returns Anthropic content_block_stop SSE 文本。
     */
    private handleContentPartDone(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.content_part.done');
        const contentIndex = readContentIndex(payload, this.warnings, 'response.content_part.done');
        if (outputIndex === undefined || contentIndex === undefined) return '';
        const key = makeTextPartKey(outputIndex, contentIndex);
        const existing = this.state.textParts.get(key);
        if (!existing) {
            const part = isRecord(payload.part) ? payload.part : {};
            const text = typeof part.text === 'string' ? part.text : typeof part.refusal === 'string' ? part.refusal : '';
            return this.startTextPart(outputIndex, contentIndex, text) + this.closeTextPart(outputIndex, contentIndex);
        }
        return this.closeTextPart(outputIndex, contentIndex);
    }

    /**
     * 处理 response.output_text.delta 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns Anthropic text_delta SSE 文本。
     */
    private handleOutputTextDelta(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.output_text.delta');
        const contentIndex = readContentIndex(payload, this.warnings, 'response.output_text.delta');
        if (outputIndex === undefined || contentIndex === undefined) return '';
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        return this.emitTextDelta(outputIndex, contentIndex, delta);
    }

    /**
     * 处理 response.output_text.done/refusal.done 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns content_block_stop SSE 文本。
     */
    private handleOutputTextDone(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.output_text.done');
        const contentIndex = readContentIndex(payload, this.warnings, 'response.output_text.done');
        if (outputIndex === undefined || contentIndex === undefined) return '';
        return this.closeTextPart(outputIndex, contentIndex);
    }

    /**
     * 处理 response.refusal.delta 事件，并将 refusal 降级为 text_delta。
     *
     * @param payload Responses 事件 payload。
     * @returns Anthropic text_delta SSE 文本。
     */
    private handleRefusalDelta(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.refusal.delta');
        const contentIndex = readContentIndex(payload, this.warnings, 'response.refusal.delta');
        if (outputIndex === undefined || contentIndex === undefined) return '';
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        this.warnings.push({ path: 'response.refusal.delta', code: 'refusal_as_text', message: 'Responses refusal delta 已降级为 Anthropic text_delta。' });
        return this.emitTextDelta(outputIndex, contentIndex, delta);
    }

    /**
     * 处理 response.function_call_arguments.delta 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns Anthropic input_json_delta SSE 文本。
     */
    private handleFunctionArgumentsDelta(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.function_call_arguments.delta');
        if (outputIndex === undefined) return '';
        const state = this.getOutputItemState(outputIndex);
        state.type = state.type ?? 'function_call';
        state.argumentsJson += typeof payload.delta === 'string' ? payload.delta : '';
        return this.ensureMessageStart() + this.maybeStartFunctionCall(state) + this.emitPendingFunctionArgumentsDelta(state);
    }

    /**
     * 处理 response.function_call_arguments.done 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns 可能产生的 Anthropic input_json_delta SSE 文本。
     */
    private handleFunctionArgumentsDone(payload: Record<string, unknown>): string {
        const outputIndex = readOutputIndex(payload, this.warnings, 'response.function_call_arguments.done');
        if (outputIndex === undefined) return '';
        const state = this.getOutputItemState(outputIndex);
        state.type = state.type ?? 'function_call';
        if (typeof payload.arguments === 'string' && payload.arguments.length >= state.argumentsJson.length) {
            state.argumentsJson = payload.arguments;
        }
        return this.ensureMessageStart() + this.maybeStartFunctionCall(state) + this.emitPendingFunctionArgumentsDelta(state);
    }

    /**
     * 处理 response.completed/response.incomplete 终止事件。
     *
     * @param payload Responses 事件 payload。
     * @param status Responses 终态。
     * @returns Anthropic 收尾 SSE 文本。
     */
    private handleResponseTerminal(payload: Record<string, unknown>, status: string): string {
        const response = isRecord(payload.response) ? payload.response : payload;
        this.readResponseMetadata(response);
        this.state.status = status;
        if (response.incomplete_details !== undefined) this.state.incompleteDetails = response.incomplete_details;
        return this.finishIfNeeded(status);
    }

    /**
     * 处理 response.failed 事件。
     *
     * @param payload Responses 事件 payload。
     * @returns Anthropic SSE error 文本。
     */
    private handleResponseFailed(payload: Record<string, unknown>): string {
        const response = isRecord(payload.response) ? payload.response : payload;
        this.readResponseMetadata(response);
        this.state.finished = true;
        return formatAnthropicSseError('api_error', readErrorMessage(response, 'Responses response.failed'));
    }

    /**
     * 处理 response.error 或顶层 error 事件。
     *
     * @param payload Responses error payload。
     * @returns Anthropic SSE error 文本。
     */
    private handleErrorPayload(payload: Record<string, unknown>): string {
        this.state.finished = true;
        return formatAnthropicSseError('api_error', readErrorMessage(payload, 'Responses stream error'));
    }

    /**
     * 读取 response 元信息，包括 id/model/usage/status。
     *
     * @param response Responses response 对象。
     */
    private readResponseMetadata(response: Record<string, unknown>): void {
        if (typeof response.id === 'string') this.state.messageId = `msg_${response.id}`;
        if (typeof response.model === 'string') this.state.model = response.model;
        if (typeof response.status === 'string') this.state.status = response.status;
        if (response.incomplete_details !== undefined) this.state.incompleteDetails = response.incomplete_details;
        const usage = isRecord(response.usage) ? response.usage : undefined;
        if (usage) {
            const normalizedUsage = normalizeResponsesUsage(usage);
            this.state.inputTokens = normalizedUsage.inputTokens;
            this.state.cacheReadTokens = normalizedUsage.cacheReadTokens;
            this.state.outputTokens = normalizedUsage.outputTokens;
        }
    }

    /**
     * 确保已输出 Anthropic message_start。
     *
     * @returns 可能产生的 message_start SSE 文本。
     */
    private ensureMessageStart(): string {
        if (this.state.messageStartEmitted) return '';
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
                    input_tokens: this.state.inputTokens,
                    output_tokens: 0,
                    ...(this.state.cacheReadTokens === undefined
                        ? {}
                        : { cache_read_input_tokens: this.state.cacheReadTokens })
                }
            }
        });
    }

    /**
     * 获取或创建 output item 状态。
     *
     * @param outputIndex Responses 顶层 output_index。
     * @returns output item 状态。
     */
    private getOutputItemState(outputIndex: number): ResponsesOutputItemState {
        const existing = this.state.outputItems.get(outputIndex);
        if (existing) return existing;
        const created: ResponsesOutputItemState = {
            outputIndex,
            argumentsJson: '',
            emittedArgumentsLength: 0,
            started: false,
            closed: false
        };
        this.state.outputItems.set(outputIndex, created);
        return created;
    }

    /**
     * 启动或获取文本 part 对应的 Anthropic content block。
     *
     * @param outputIndex Responses 顶层 output_index。
     * @param contentIndex Responses content_index。
     * @param initialText part 初始文本。
     * @returns Anthropic SSE 文本。
     */
    private startTextPart(outputIndex: number, contentIndex: number, initialText = ''): string {
        const key = makeTextPartKey(outputIndex, contentIndex);
        const existing = this.state.textParts.get(key);
        if (existing) return initialText ? this.emitTextDelta(outputIndex, contentIndex, initialText) : '';
        const index = this.state.nextBlockIndex++;
        this.state.textParts.set(key, { outputIndex, contentIndex, anthropicBlockIndex: index, closed: false });
        let out = this.ensureMessageStart();
        out += formatAnthropicSse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' }
        });
        if (initialText) out += this.emitTextDelta(outputIndex, contentIndex, initialText);
        return out;
    }

    /**
     * 输出指定文本 part 的 text_delta。
     *
     * @param outputIndex Responses 顶层 output_index。
     * @param contentIndex Responses content_index。
     * @param delta 文本增量。
     * @returns Anthropic SSE 文本。
     */
    private emitTextDelta(outputIndex: number, contentIndex: number, delta: string): string {
        if (!delta) return '';
        let out = this.startTextPart(outputIndex, contentIndex);
        const part = this.state.textParts.get(makeTextPartKey(outputIndex, contentIndex));
        if (!part || part.closed) return out;
        out += formatAnthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index: part.anthropicBlockIndex,
            delta: { type: 'text_delta', text: delta }
        });
        return out;
    }

    /**
     * 关闭指定文本 part。
     *
     * @param outputIndex Responses 顶层 output_index。
     * @param contentIndex Responses content_index。
     * @returns Anthropic content_block_stop SSE 文本。
     */
    private closeTextPart(outputIndex: number, contentIndex: number): string {
        const part = this.state.textParts.get(makeTextPartKey(outputIndex, contentIndex));
        if (!part || part.closed) return '';
        part.closed = true;
        return formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index: part.anthropicBlockIndex });
    }

    /**
     * 在 call_id/name 齐全后启动 Anthropic tool_use block。
     *
     * @param state output item 状态。
     * @returns Anthropic SSE 文本。
     */
    private maybeStartFunctionCall(state: ResponsesOutputItemState): string {
        if (state.started || state.type !== 'function_call' || !state.name) return '';
        const index = this.state.nextBlockIndex++;
        state.anthropicBlockIndex = index;
        state.started = true;
        const id = state.callId || state.id || `toolu_${state.outputIndex}`;
        return formatAnthropicSse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name: state.name, input: {} }
        });
    }

    /**
     * 输出 function_call 尚未发送的 arguments delta。
     *
     * @param state output item 状态。
     * @returns Anthropic input_json_delta SSE 文本。
     */
    private emitPendingFunctionArgumentsDelta(state: ResponsesOutputItemState): string {
        if (!state.started || state.anthropicBlockIndex === undefined) return '';
        const delta = state.argumentsJson.slice(state.emittedArgumentsLength);
        if (!delta) return '';
        state.emittedArgumentsLength += delta.length;
        return formatAnthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index: state.anthropicBlockIndex,
            delta: { type: 'input_json_delta', partial_json: delta }
        });
    }

    /**
     * 如尚未完成则关闭所有 block 并输出 message_delta/message_stop。
     *
     * @param source 触发收尾的来源。
     * @returns Anthropic SSE 文本。
     */
    private finishIfNeeded(source: string): string {
        if (this.state.finished) return '';
        let out = this.ensureMessageStart();
        out += this.closeAllOpenBlocks();
        // usage 通常随 response.completed 才到达，message_start 那份可能为 0，这里补发真值。
        out += formatAnthropicSse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: this.mapStreamStopReason(), stop_sequence: null },
            usage: {
                input_tokens: this.state.inputTokens,
                output_tokens: this.state.outputTokens,
                ...(this.state.cacheReadTokens === undefined
                    ? {}
                    : { cache_read_input_tokens: this.state.cacheReadTokens })
            }
        });
        out += formatAnthropicSse('message_stop', { type: 'message_stop' });
        this.state.finished = true;
        if (source === 'end') {
            this.warnings.push({ path: 'sse', code: 'stream_ended_without_terminal_event', message: 'Responses SSE 断流或未收到终止事件，已合成 message_stop。' });
        }
        return out;
    }

    /**
     * 关闭所有尚未关闭的文本块与工具块。
     *
     * @returns Anthropic content_block_stop SSE 文本。
     */
    private closeAllOpenBlocks(): string {
        let out = '';
        for (const part of Array.from(this.state.textParts.values()).sort(compareTextParts)) {
            if (!part.closed) {
                part.closed = true;
                out += formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index: part.anthropicBlockIndex });
            }
        }
        for (const item of Array.from(this.state.outputItems.values()).sort((a, b) => a.outputIndex - b.outputIndex)) {
            out += this.maybeStartFunctionCall(item);
            out += this.emitPendingFunctionArgumentsDelta(item);
            if (item.started && !item.closed && item.anthropicBlockIndex !== undefined) {
                item.closed = true;
                out += formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index: item.anthropicBlockIndex });
            }
        }
        return out;
    }

    /**
     * 映射流式 Responses 终态为 Anthropic stop_reason。
     *
     * @returns Anthropic stop_reason。
     */
    private mapStreamStopReason(): AnthropicResponsesMessageResponse['stop_reason'] {
        if (Array.from(this.state.outputItems.values()).some((item) => item.type === 'function_call' && item.started)) return 'tool_use';
        if (this.state.status === 'incomplete') return mapIncompleteReason(this.state.incompleteDetails);
        return 'end_turn';
    }
}

/**
 * 将 OpenAI Responses 非流式 JSON 转为 Anthropic Messages JSON。
 *
 * @param json OpenAI Responses JSON。
 * @returns Anthropic 响应体与 warning 列表。
 */
export function convertResponsesJsonToAnthropic(json: unknown): OpenAIResponsesToAnthropicJsonResult {
    const source = isRecord(json) ? json : {};
    const warnings: ResponsesConversionWarning[] = [];
    const content = convertOutputToContent(source.output, warnings);
    const stopReason = mapResponseStopReason(source, content);
    ensureFilteredPlaceholder(source, content);
    return {
        body: {
            id: `msg_${typeof source.id === 'string' ? source.id : 'openai_response'}`,
            type: 'message',
            role: 'assistant',
            model: typeof source.model === 'string' ? source.model : '',
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: convertUsage(source.usage)
        },
        warnings
    };
}

/**
 * 按 Responses output 顺序转换为 Anthropic content blocks。
 *
 * @param output Responses output 字段。
 * @param warnings warning 收集器。
 * @returns Anthropic content blocks。
 */
function convertOutputToContent(output: unknown, warnings: ResponsesConversionWarning[]): AnthropicContentBlock[] {
    if (!Array.isArray(output)) return [];
    const content: AnthropicContentBlock[] = [];
    output.forEach((item, index) => {
        if (!isRecord(item)) return;
        const path = `output[${index}]`;
        switch (item.type) {
            case 'message':
                appendMessageOutputContent(content, item.content, `${path}.content`, warnings);
                break;
            case 'function_call':
                appendFunctionCall(content, item, path, warnings);
                break;
            case 'reasoning':
                warnings.push({ path, code: 'ignored_reasoning', message: 'Responses reasoning output 已忽略。' });
                break;
            default:
                warnings.push({ path, code: 'unsupported_output_item', message: `已忽略未知 Responses output item：${String(item.type)}。` });
                break;
        }
    });
    return content;
}

/**
 * 转换 Responses message output 的 content parts。
 *
 * @param content Anthropic content blocks 输出数组。
 * @param parts Responses message.content 字段。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 */
function appendMessageOutputContent(
    content: AnthropicContentBlock[],
    parts: unknown,
    path: string,
    warnings: ResponsesConversionWarning[]
): void {
    if (!Array.isArray(parts)) return;
    parts.forEach((part, index) => {
        const partPath = `${path}[${index}]`;
        if (!isRecord(part)) return;
        switch (part.type) {
            case 'output_text':
                if (typeof part.text === 'string' && part.text) content.push({ type: 'text', text: part.text });
                break;
            case 'refusal':
                appendRefusalText(content, part, partPath, warnings);
                break;
            default:
                warnings.push({ path: partPath, code: 'unsupported_content_part', message: `已忽略未知 Responses content part：${String(part.type)}。` });
                break;
        }
    });
}

/**
 * 将 Responses refusal content part 降级为 Anthropic text block。
 *
 * @param content Anthropic content blocks 输出数组。
 * @param part Responses refusal part。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 */
function appendRefusalText(
    content: AnthropicContentBlock[],
    part: Record<string, unknown>,
    path: string,
    warnings: ResponsesConversionWarning[]
): void {
    const refusal = typeof part.refusal === 'string' ? part.refusal : typeof part.text === 'string' ? part.text : '';
    if (refusal) content.push({ type: 'text', text: refusal });
    warnings.push({ path, code: 'refusal_as_text', message: 'Responses refusal 已降级为 Anthropic text。' });
}

/**
 * 转换 Responses function_call 为 Anthropic tool_use。
 *
 * @param content Anthropic content blocks 输出数组。
 * @param item Responses function_call item。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 */
function appendFunctionCall(
    content: AnthropicContentBlock[],
    item: Record<string, unknown>,
    path: string,
    warnings: ResponsesConversionWarning[]
): void {
    const name = typeof item.name === 'string' ? item.name : '';
    if (!name) {
        warnings.push({ path: `${path}.name`, code: 'missing_tool_name', message: 'Responses function_call 缺少 name，已跳过。' });
        return;
    }
    const id = typeof item.call_id === 'string' && item.call_id
        ? item.call_id
        : typeof item.id === 'string' && item.id
            ? item.id
            : `toolu_${content.length}`;
    const argPath = `${path}.arguments`;
    content.push({
        type: 'tool_use',
        id,
        name,
        input: normalizeToolInput(name, parseToolArguments(item.arguments, argPath, warnings), warnings, argPath)
    });
}

/**
 * 解析 Responses function_call.arguments JSON 字符串。
 *
 * @param value arguments 字段。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @returns 解析后的对象，失败时返回空对象。
 */
function parseToolArguments(value: unknown, path: string, warnings: ResponsesConversionWarning[]): unknown {
    if (isRecord(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        return JSON.parse(value) as unknown;
    } catch (err) {
        warnings.push({
            path,
            code: 'invalid_tool_arguments_json',
            message: `Responses function_call arguments 不是合法 JSON，已使用空对象：${err instanceof Error ? err.message : String(err)}`
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
    warnings: ResponsesConversionWarning[],
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
 * Write 工具空参数/缺字段拦截。
 *
 * 当上游返回的 Write 调用 file_path 缺失或 content 字段缺失时，把 input 替换为
 * 带 __error__ 说明的占位 input，让下游 CLI Write 工具因 schema 校验失败而返回
 * 错误 tool_result，模型据此重试或改用 Edit 追加。
 *
 * @param input 上游解析后的 arguments。
 * @param warnings warning 收集器。
 * @param path warning 路径。
 * @returns 修正后的 input。
 */
function normalizeWriteToolInput(
    input: unknown,
    warnings: ResponsesConversionWarning[],
    path: string
): unknown {
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
 * 映射 Responses 状态为 Anthropic stop_reason。
 *
 * @param source Responses 响应对象。
 * @param content 已转换 content blocks。
 * @returns Anthropic stop_reason。
 */
function mapResponseStopReason(
    source: Record<string, unknown>,
    content: AnthropicContentBlock[]
): AnthropicResponsesMessageResponse['stop_reason'] {
    if (content.some((block) => block.type === 'tool_use')) return 'tool_use';
    if (source.status === 'incomplete') return mapIncompleteReason(source.incomplete_details);
    if (source.status === 'failed') return 'end_turn';
    return 'end_turn';
}

/**
 * 映射 Responses incomplete_details.reason 为 Anthropic stop_reason。
 *
 * @param incompleteDetails Responses incomplete_details 字段。
 * @returns Anthropic stop_reason。
 */
function mapIncompleteReason(incompleteDetails: unknown): AnthropicResponsesMessageResponse['stop_reason'] {
    if (!isRecord(incompleteDetails)) return 'max_tokens';
    switch (incompleteDetails.reason) {
        case 'max_output_tokens':
        case 'max_tokens':
            return 'max_tokens';
        case 'content_filter':
            return 'end_turn';
        default:
            return 'max_tokens';
    }
}

/**
 * 当 Responses 因内容过滤而无正文时追加占位文本。
 *
 * @param source Responses 响应对象。
 * @param content Anthropic content blocks。
 */
function ensureFilteredPlaceholder(source: Record<string, unknown>, content: AnthropicContentBlock[]): void {
    if (content.length > 0) return;
    const details = isRecord(source.incomplete_details) ? source.incomplete_details : undefined;
    if (source.status === 'incomplete' && details?.reason === 'content_filter') {
        content.push({ type: 'text', text: '[content filtered by upstream provider]' });
    }
}

/**
 * 转换 Responses usage，仅保留 Anthropic 支持的 input/output tokens。
 *
 * @param usage Responses usage 字段。
 * @returns Anthropic usage。
 */
function convertUsage(usage: unknown): AnthropicResponsesMessageResponse['usage'] {
    const normalized = normalizeResponsesUsage(usage);
    return {
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens,
        ...(normalized.cacheReadTokens === undefined
            ? {}
            : { cache_read_input_tokens: normalized.cacheReadTokens })
    };
}

/** Responses usage 的统一非负归一化结果。 */
interface NormalizedResponsesUsage {
    /** 已扣除缓存读且不小于 0 的输入 token。 */
    inputTokens: number;
    /** 输出 token。 */
    outputTokens: number;
    /** 经总输入上限约束的缓存读 token。 */
    cacheReadTokens?: number;
}

/**
 * 统一归一化 JSON 与 response.completed 的 Responses usage。
 *
 * input_tokens 含 cached_tokens；明细异常大于总输入时钳制到总输入。由于没有
 * cache_write_tokens 非零样本及其包含关系证据，当前不映射也不参与扣减。
 *
 * @param usage Responses usage 字段。
 * @returns 可安全映射到 Anthropic 的 token 统计。
 */
function normalizeResponsesUsage(usage: unknown): NormalizedResponsesUsage {
    const source = isRecord(usage) ? usage : {};
    const totalInput = readNonNegativeNumber(source.input_tokens);
    const cached = readCachedTokens(source, 'input_tokens_details');
    const cacheReadTokens = cached === undefined
        ? undefined
        : Math.min(readNonNegativeNumber(cached), totalInput);
    return {
        inputTokens: Math.max(0, totalInput - (cacheReadTokens ?? 0)),
        outputTokens: readNonNegativeNumber(source.output_tokens),
        cacheReadTokens
    };
}

/** 安全读取有限非负数字；非法值返回 0。 */
function readNonNegativeNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
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
 * 从 SSE event 文本中读取 event 字段。
 *
 * @param eventText SSE event 原始文本。
 * @returns event 名称；缺失时返回空字符串。
 */
function readSseEventName(eventText: string): string {
    const line = eventText.split(/\r?\n/).find((item) => item.startsWith('event:'));
    return line ? line.slice(6).trim() : '';
}

/**
 * 读取 Responses 事件顶层 output_index。
 *
 * @param payload Responses 事件 payload。
 * @param warnings warning 收集器。
 * @param path JSON 路径。
 * @returns output_index；缺失时返回 undefined。
 */
function readOutputIndex(
    payload: Record<string, unknown>,
    warnings: ResponsesConversionWarning[],
    path: string
): number | undefined {
    if (typeof payload.output_index === 'number' && Number.isInteger(payload.output_index)) return payload.output_index;
    warnings.push({ path: `${path}.output_index`, code: 'missing_output_index', message: 'Responses SSE 事件缺少顶层 output_index，已忽略。' });
    return undefined;
}

/**
 * 读取 Responses 事件顶层 content_index。
 *
 * @param payload Responses 事件 payload。
 * @param warnings warning 收集器。
 * @param path JSON 路径。
 * @returns content_index；缺失时返回 undefined。
 */
function readContentIndex(
    payload: Record<string, unknown>,
    warnings: ResponsesConversionWarning[],
    path: string
): number | undefined {
    if (typeof payload.content_index === 'number' && Number.isInteger(payload.content_index)) return payload.content_index;
    warnings.push({ path: `${path}.content_index`, code: 'missing_content_index', message: 'Responses SSE 事件缺少顶层 content_index，已忽略。' });
    return undefined;
}

/**
 * 构造文本 part 状态表 key。
 *
 * @param outputIndex Responses 顶层 output_index。
 * @param contentIndex Responses content_index。
 * @returns 状态表 key。
 */
function makeTextPartKey(outputIndex: number, contentIndex: number): string {
    return `${outputIndex}:${contentIndex}`;
}

/**
 * 按 Responses output_index/content_index 排序文本 part。
 *
 * @param a 左侧文本 part。
 * @param b 右侧文本 part。
 * @returns 排序结果。
 */
function compareTextParts(a: ResponsesTextPartState, b: ResponsesTextPartState): number {
    return a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex;
}

/**
 * 从 Responses 错误 payload 中读取错误消息。
 *
 * @param payload Responses error/failed payload。
 * @param fallback 默认错误消息。
 * @returns 人类可读错误消息。
 */
function readErrorMessage(payload: Record<string, unknown>, fallback: string): string {
    const error = isRecord(payload.error) ? payload.error : undefined;
    if (error && typeof error.message === 'string') return error.message;
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.error === 'string') return payload.error;
    return fallback;
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
