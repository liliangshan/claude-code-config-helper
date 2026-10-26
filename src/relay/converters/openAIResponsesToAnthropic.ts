/** @file OpenAI Responses JSON/SSE 到 Anthropic Messages 的转换与可见思考摘要透传。 */

import type { ModelReasoningMode } from '../../types';

import type { ResponsesConversionWarning } from './anthropicToOpenAIResponses';
import { formatAnthropicSseError } from './openAIErrorToAnthropic';
import { anthropicCacheFields, normalizeOpenAIUsage } from './openAIUsage';

/** Anthropic content block。 */
type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
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
        /** 已包含在 OpenAI 总输入中的缓存写入，由扩充明细还原；缺失时不推测。 */
        cache_creation_input_tokens?: number;
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
    /** 实际发出的 partial_json 拼接结果；不随上游 done 快照替换。 */
    emittedArgumentsJson: string;
    /** 最近一次上游 done 事件给出的完整参数，长度变短时也保留用于诊断。 */
    finalArgumentsJson?: string;
    /** 上一次已报告异常的完整证据，避免多个终止事件重复报告。 */
    lastArgumentsDiagnostic?: string;
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

/** 可见摘要 part 的去重状态；不保存 encrypted_content，也不复用工具参数状态。 */
interface ResponsesReasoningPartState {
    /** 已实际发送的可见摘要文本，完整快照只能补发匹配前缀的后缀。 */
    emittedText: string;
    /** 非空摘要才分配 Anthropic block，避免空思考占用正文/工具索引。 */
    anthropicBlockIndex?: number;
    /** 已关闭的 part 不能被重复 done 或迟到 delta 重新打开。 */
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
    /** 输入 token 数（已扣除缓存读写）。 */
    inputTokens: number;
    /** 命中缓存的输入 token 数；上游未返回时为 undefined。 */
    cacheReadTokens?: number;
    /** 网关扩充明细中的缓存写入；与读取独立保存。 */
    cacheWriteTokens?: number;
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

    /**
     * 对比上游最终参数与实际下发给 CLI 的分片，检测解析错误及错误包装。
     *
     * 只追加诊断，不修改参数或工具执行语义。
     * @param state 单个工具输出项状态。
     * @param source 当前校验触发来源。
     * @returns 无返回值。
     */
    private logInvalidToolArguments(state: ResponsesOutputItemState, source: string): void {
        const errors: string[] = [];
        const candidates: Array<[string, string]> = [['upstream', state.finalArgumentsJson ?? state.argumentsJson]];
        if (state.started) candidates.push(['emitted', state.emittedArgumentsJson]);
        for (const [label, raw] of candidates) {
            try {
                const value: unknown = JSON.parse(raw);
                if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, '__unparsedToolInput')) {
                    errors.push(`${label}: contains __unparsedToolInput error wrapper`);
                }
            } catch (error) {
                errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (state.started && state.emittedArgumentsJson !== (state.finalArgumentsJson ?? state.argumentsJson)) {
            errors.push('emitted arguments differ from upstream final arguments');
        }
        if (source === 'delta_after_tool_stop') errors.push('received arguments delta after tool block closed');
        if (errors.length === 0) return;
        const detail = {
            tool: state.name,
            callId: state.callId || state.id,
            outputIndex: state.outputIndex,
            chars: state.argumentsJson.length,
            emittedChars: state.emittedArgumentsLength,
            error: errors.join('; '),
            argumentsRaw: state.argumentsJson,
            emittedArgumentsRaw: state.emittedArgumentsJson,
            finalArgumentsRaw: state.finalArgumentsJson
        };
        const key = JSON.stringify(detail);
        if (state.lastArgumentsDiagnostic === key) return;
        state.lastArgumentsDiagnostic = key;
        this.onInvalidToolArguments?.(`[tool-json] invalid JSON: ${JSON.stringify({ source, ...detail })}`);
    }

    private readonly reasoningParts = new Map<string, ResponsesReasoningPartState>();
    /** output_index 与 item_id 双向关联，避免最终快照重复开出同一摘要。 */
    private readonly reasoningItemIds = new Map<number, string>();
    /** 已结束的 reasoning item，重复快照不新增 part。 */
    private readonly closedReasoningItems = new Set<number>();
    /** 任意可见内容已打开后，不在末尾补发先前遗漏的思考摘要。 */
    private hasVisibleNonReasoning = false;

    /**
     * 创建转换器；思考透传关闭时维持原有输出，不影响工具诊断回调。
     * @param onInvalidToolArguments 工具 JSON 异常诊断。
     * @param reasoningMode 仅 passthrough 显示上游提供的可见摘要。
     */
    public constructor(private readonly onInvalidToolArguments?: (message: string) => void, private readonly reasoningMode: ModelReasoningMode = 'off') {}

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
        if (this.state.finished) {
            for (const item of this.state.outputItems.values()) {
                if (item.started) this.logInvalidToolArguments(item, 'http_end');
            }
            return '';
        }
        const tail = this.buffer.trim();
        this.buffer = '';
        const out = tail ? this.handleOpenAIEvent(tail) : '';
        const final = out + this.finishIfNeeded('end');
        for (const item of this.state.outputItems.values()) {
            if (item.started) this.logInvalidToolArguments(item, 'http_end');
        }
        return final;
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
     * 返回实际下发的工具调用 ID，供后续 CLI 错误反馈关联原响应。
     * @returns 本轮已启动的工具调用 ID，不包含未发给客户端的输出项。
     */
    public getToolCallIds(): string[] {
        return Array.from(this.state.outputItems.values()).filter(item => item.started)
            .map(item => item.callId || item.id || `toolu_${item.outputIndex}`);
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
        if (this.state.finished || !isRecord(payload)) return '';
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
            case 'response.reasoning_summary_part.added':
            case 'response.reasoning_summary_part.done':
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_summary_text.done':
                return this.handleReasoningSummary(type, payload);
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
     * 解析摘要事件的输出索引，并绑定 item_id；冲突身份不猜测归属。
     * @param payload 摘要事件或最终输出项。
     * @returns 输出索引，缺失或冲突时跳过。
     */
    private reasoningOutputIndex(payload: Record<string, unknown>): number | undefined {
        const itemId = typeof payload.item_id === 'string' ? payload.item_id : undefined;
        let index = typeof payload.output_index === 'number' && Number.isSafeInteger(payload.output_index) && payload.output_index >= 0
            ? payload.output_index : undefined;
        if (payload.output_index !== undefined && index === undefined) return undefined;
        if (index === undefined && itemId) {
            index = [...this.reasoningItemIds].find(([, id]) => id === itemId)?.[0];
        }
        if (index === undefined) return undefined;
        const previous = this.reasoningItemIds.get(index);
        const boundIndex = itemId ? [...this.reasoningItemIds].find(([, id]) => id === itemId)?.[0] : undefined;
        if (itemId && ((previous && previous !== itemId) || (boundIndex !== undefined && boundIndex !== index))) {
            this.warnings.push({ path: 'reasoning.item_id', code: 'reasoning_identity_conflict', message: '摘要输出项身份冲突，已跳过，不改写已发送文本。' });
            return undefined;
        }
        if (itemId) this.reasoningItemIds.set(index, itemId);
        return index;
    }

    /**
     * 将可见摘要 delta/完整快照转换为 thinking_delta；加密内容从不参与展示。
     * @param type 摘要事件类型。
     * @param payload 上游摘要事件。
     * @returns 可立即下发的 Anthropic SSE。
     */
    private handleReasoningSummary(type: string, payload: Record<string, unknown>): string {
        if (this.reasoningMode !== 'passthrough') return '';
        const outputIndex = this.reasoningOutputIndex(payload);
        const summaryIndex = payload.summary_index;
        if (outputIndex === undefined || typeof summaryIndex !== 'number' || !Number.isSafeInteger(summaryIndex) || summaryIndex < 0) return '';
        const part = isRecord(payload.part) ? payload.part : {};
        const isDelta = type === 'response.reasoning_summary_text.delta';
        const text = isDelta ? payload.delta : type === 'response.reasoning_summary_text.done' ? payload.text
            : part.type === 'summary_text' ? part.text : undefined;
        let out = this.emitReasoningText(outputIndex, summaryIndex, typeof text === 'string' ? text : '', !isDelta);
        if (type.endsWith('.done')) out += this.closeReasoningPart(`${outputIndex}:${summaryIndex}`);
        return out;
    }

    /**
     * 输出摘要增量或只补发完整快照的匹配后缀；不回滚或猜测修改内容。
     * @param outputIndex 输出项索引。
     * @param summaryIndex 摘要段索引。
     * @param text 可见摘要文本。
     * @param snapshot 是否为完整快照而非 delta。
     * @returns thinking SSE，不触碰工具参数状态。
     */
    private emitReasoningText(outputIndex: number, summaryIndex: number, text: string, snapshot: boolean): string {
        const key = `${outputIndex}:${summaryIndex}`;
        let part = this.reasoningParts.get(key);
        if (this.closedReasoningItems.has(outputIndex)) return '';
        if (!part) {
            if (!text) return '';
            const nonReasoningOpen = [...this.state.textParts.values()].some(value => !value.closed)
                || [...this.state.outputItems.values()].some(value => value.started && !value.closed);
            if ((snapshot && this.hasVisibleNonReasoning) || nonReasoningOpen) {
                this.warnings.push({ path: `output[${outputIndex}].summary[${summaryIndex}]`, code: 'late_reasoning_summary', message: '摘要出现时正文/工具尚未关闭，或仅在后续快照出现；已跳过以保留输出顺序。' });
                return '';
            }
            part = { emittedText: '', closed: false };
            this.reasoningParts.set(key, part);
        }
        let delta = text;
        if (snapshot) {
            if (text === part.emittedText) return '';
            if (!text.startsWith(part.emittedText)) {
                this.warnings.push({ path: `output[${outputIndex}].summary[${summaryIndex}]`, code: 'reasoning_summary_conflict', message: '摘要快照不匹配已发送前缀，保留原文，不拼接猜测后缀。' });
                return '';
            }
            delta = text.slice(part.emittedText.length);
        }
        if (!delta || part.closed) return '';
        let out = this.ensureMessageStart();
        if (part.anthropicBlockIndex === undefined) {
            // 新摘要段前关闭旧段，避免两个 Anthropic thinking block 嵌套。
            out += this.closeReasoningParts();
            part.anthropicBlockIndex = this.state.nextBlockIndex++;
            out += formatAnthropicSse('content_block_start', { type: 'content_block_start', index: part.anthropicBlockIndex, content_block: { type: 'thinking', thinking: '' } });
        }
        part.emittedText += delta;
        return out + formatAnthropicSse('content_block_delta', { type: 'content_block_delta', index: part.anthropicBlockIndex, delta: { type: 'thinking_delta', thinking: delta } });
    }

    /**
     * 关闭一个非空摘要段；重复 done 不再输出 stop，也不重新开块。
     * @param key 输出项与摘要段的组合键。
     * @returns 可能产生的 block_stop。
     */
    private closeReasoningPart(key: string): string {
        const part = this.reasoningParts.get(key);
        if (!part) {
            this.reasoningParts.set(key, { emittedText: '', closed: true });
            return '';
        }
        if (part.closed) return '';
        part.closed = true;
        return part.anthropicBlockIndex === undefined ? ''
            : formatAnthropicSse('content_block_stop', { type: 'content_block_stop', index: part.anthropicBlockIndex });
    }

    /**
     * 关闭当前摘要段，供正文、工具开始或流收尾使用。
     * @returns 按分配顺序产生的 block_stop。
     */
    private closeReasoningParts(): string {
        let out = '';
        for (const [key, part] of this.reasoningParts) {
            if (part.anthropicBlockIndex !== undefined) out += this.closeReasoningPart(key);
        }
        return out;
    }

    /**
     * 从 reasoning item 快照回填摘要；按 item/summary 索引去重，忽略 encrypted_content。
     * @param outputIndex 输出项索引。
     * @param item 上游 reasoning 输出项。
     * @param done 是否结束整个输出项。
     * @returns 缺失摘要的安全补发及 block_stop。
     */
    private reconcileReasoningItem(outputIndex: number, item: Record<string, unknown>, done: boolean): string {
        if (this.reasoningMode !== 'passthrough') return '';
        const index = this.reasoningOutputIndex({ output_index: outputIndex, item_id: item.id });
        if (index === undefined) return '';
        let out = '';
        if (Array.isArray(item.summary)) item.summary.forEach((part, summaryIndex) => {
            if (!isRecord(part) || part.type !== 'summary_text' || typeof part.text !== 'string') return;
            out += this.emitReasoningText(index, summaryIndex, part.text, true);
            if (done) out += this.closeReasoningPart(`${index}:${summaryIndex}`);
        });
        if (done) {
            for (const key of this.reasoningParts.keys()) {
                if (key.startsWith(`${index}:`)) out += this.closeReasoningPart(key);
            }
            this.closedReasoningItems.add(index);
        }
        return out;
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
     * 接受完整参数快照前校验已下发前缀；不能回滚的参数冲突按流错误结束。
     * @param state 工具输出项状态。
     * @param value 上游完整参数或新增项的初始参数。
     * @param source SSE 事件来源。
     * @returns 冲突时的 SSE 错误；undefined 表示可以继续处理。
     */
    private acceptFunctionArguments(state: ResponsesOutputItemState, value: unknown, source: string): string | undefined {
        if (typeof value !== 'string') return undefined;
        state.finalArgumentsJson = value;
        if (!value.startsWith(state.emittedArgumentsJson) || (state.closed && value !== state.emittedArgumentsJson)) {
            return this.failFunctionArguments(state, source);
        }
        state.argumentsJson = value;
        return undefined;
    }

    /**
     * 参数冲突时保留证据并发送错误，不再补发无法验证的后缀或成功结束标记。
     * @param state 冲突的工具输出项。
     * @param source 触发冲突的 SSE 事件来源。
     * @returns Anthropic SSE 错误事件。
     */
    private failFunctionArguments(state: ResponsesOutputItemState, source: string): string {
        this.logInvalidToolArguments(state, source);
        this.state.finished = true;
        this.warnings.push({ path: `output[${state.outputIndex}].arguments`, code: 'tool_arguments_conflict', message: '工具参数与已发送内容不一致，已中止响应，未拼接猜测后缀。' });
        return formatAnthropicSseError('api_error', 'Upstream tool arguments changed after streaming; request aborted to avoid corrupted tool input.');
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
        if (this.reasoningMode === 'passthrough' && item.type === 'reasoning') return this.reconcileReasoningItem(outputIndex, item, false);
        const state = this.getOutputItemState(outputIndex);
        if (typeof item.type === 'string') state.type = item.type;
        if (typeof item.id === 'string') state.id = item.id;
        if (typeof item.call_id === 'string') state.callId = item.call_id;
        if (typeof item.name === 'string') state.name = item.name;
        if (typeof item.arguments === 'string' && item.arguments.length > 0) {
            const conflict = this.acceptFunctionArguments(state, item.arguments, 'output_item.added');
            if (conflict !== undefined) return conflict;
        }
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
        if (this.reasoningMode === 'passthrough' && item.type === 'reasoning') return this.reconcileReasoningItem(outputIndex, item, true);
        const state = this.getOutputItemState(outputIndex);
        if (typeof item.type === 'string') state.type = item.type;
        if (typeof item.id === 'string') state.id = item.id;
        if (typeof item.call_id === 'string') state.callId = item.call_id;
        if (typeof item.name === 'string') state.name = item.name;
        const conflict = this.acceptFunctionArguments(state, item.arguments, 'output_item.done');
        if (conflict !== undefined) return conflict;
        let out = this.ensureMessageStart() + this.maybeStartFunctionCall(state) + this.emitPendingFunctionArgumentsDelta(state);
        if (state.started && !state.closed && state.anthropicBlockIndex !== undefined) {
            this.logInvalidToolArguments(state, 'output_item.done');
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
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        state.argumentsJson += delta;
        if (state.closed && delta) return this.failFunctionArguments(state, 'delta_after_tool_stop');
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
        const conflict = this.acceptFunctionArguments(state, payload.arguments, 'function_call_arguments.done');
        if (conflict !== undefined) return conflict;
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
        let out = '';
        if (this.reasoningMode === 'passthrough' && Array.isArray(response.output)) {
            response.output.forEach((item, outputIndex) => {
                if (isRecord(item) && item.type === 'reasoning') out += this.reconcileReasoningItem(outputIndex, item, true);
            });
        }
        return out + this.finishIfNeeded(status);
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
        return this.closeReasoningParts() + formatAnthropicSseError('api_error', readErrorMessage(response, 'Responses response.failed'));
    }

    /**
     * 处理 response.error 或顶层 error 事件。
     *
     * @param payload Responses error payload。
     * @returns Anthropic SSE error 文本。
     */
    private handleErrorPayload(payload: Record<string, unknown>): string {
        this.state.finished = true;
        return this.closeReasoningParts() + formatAnthropicSseError('api_error', readErrorMessage(payload, 'Responses stream error'));
    }

    /**
     * 读取 response 元信息，缓存读写与 JSON 共用含总输入约束的归一化。
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
            const normalizedUsage = normalizeOpenAIUsage(usage, 'responses');
            this.state.inputTokens = normalizedUsage.inputTokens;
            this.state.cacheReadTokens = normalizedUsage.cacheReadTokens;
            this.state.cacheWriteTokens = normalizedUsage.cacheWriteTokens;
            this.state.outputTokens = normalizedUsage.outputTokens;
        }
    }

    /**
     * 确保已输出 Anthropic message_start，缓存读写分别按已知计数发送。
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
                    ...anthropicCacheFields(this.state)
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
            emittedArgumentsJson: '',
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
        const reasoningTail = this.closeReasoningParts();
        this.hasVisibleNonReasoning = true;
        const index = this.state.nextBlockIndex++;
        this.state.textParts.set(key, { outputIndex, contentIndex, anthropicBlockIndex: index, closed: false });
        let out = this.ensureMessageStart() + reasoningTail;
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
        const reasoningTail = this.closeReasoningParts();
        this.hasVisibleNonReasoning = true;
        const index = this.state.nextBlockIndex++;
        state.anthropicBlockIndex = index;
        state.started = true;
        const id = state.callId || state.id || `toolu_${state.outputIndex}`;
        return reasoningTail + formatAnthropicSse('content_block_start', {
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
        if (!state.started || state.closed || state.anthropicBlockIndex === undefined) return '';
        if (!state.argumentsJson.startsWith(state.emittedArgumentsJson)) return this.failFunctionArguments(state, 'emit_arguments');
        const delta = state.argumentsJson.slice(state.emittedArgumentsLength);
        if (!delta) return '';
        state.emittedArgumentsLength += delta.length;
        state.emittedArgumentsJson += delta;
        return formatAnthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index: state.anthropicBlockIndex,
            delta: { type: 'input_json_delta', partial_json: delta }
        });
    }

    /**
     * 如尚未完成则关闭所有 block，输出带真实缓存读写明细的 message_delta/message_stop。
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
                ...anthropicCacheFields(this.state)
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
        let out = this.closeReasoningParts();
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
                this.logInvalidToolArguments(item, 'stream_finish');
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
 * @param reasoningMode 可见摘要透传开关，关闭时保持原有输出。
 * @returns Anthropic 响应体与 warning 列表。
 */
export function convertResponsesJsonToAnthropic(json: unknown, reasoningMode: ModelReasoningMode = 'off'): OpenAIResponsesToAnthropicJsonResult {
    const source = isRecord(json) ? json : {};
    const warnings: ResponsesConversionWarning[] = [];
    const content = convertOutputToContent(source.output, warnings, reasoningMode);
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
 * @param reasoningMode 可见摘要策略；不展示 encrypted_content。
 * @returns Anthropic content blocks。
 */
function convertOutputToContent(output: unknown, warnings: ResponsesConversionWarning[], reasoningMode: ModelReasoningMode): AnthropicContentBlock[] {
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
                if (reasoningMode === 'passthrough') {
                    const summary = Array.isArray(item.summary) ? item.summary : [];
                    for (const part of summary) {
                        if (isRecord(part) && part.type === 'summary_text' && typeof part.text === 'string' && part.text) {
                            content.push({ type: 'thinking', thinking: part.text });
                        }
                    }
                } else {
                    warnings.push({ path, code: 'ignored_reasoning', message: 'Responses reasoning output 已忽略。' });
                }
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
 * 转换 Responses usage，缓存写入从扩充明细还原，普通输入扣除读写各一次。
 * @param usage Responses usage 字段。
 * @returns 与 SSE 相同口径的 Anthropic usage。
 */
function convertUsage(usage: unknown): AnthropicResponsesMessageResponse['usage'] {
    const normalized = normalizeOpenAIUsage(usage, 'responses');
    return {
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens,
        ...anthropicCacheFields(normalized)
    };
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
