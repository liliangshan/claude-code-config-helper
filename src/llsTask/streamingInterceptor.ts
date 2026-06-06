/**
 * @file LLS CCAI 任务流 Anthropic SSE 增量拦截器。
 *
 * 该拦截器工作在“已经转换为 Anthropic SSE”的流上，用于在实时流式场景中
 * 本地执行下列工具，并把原始 tool_use 改写为 text block，避免 Claude Code
 * 再进入工具往返：
 *
 * - `create_llsccai_task_workflow` / `update_llsccai_task_workflow`：任务流。
 */

import type { AutoContinueScheduler } from './autoContinue';
import { isFileOpenToolName } from '../editorAutoOpen';
import {
    classifyLocalToolKind,
    executeLocalToolByKind,
    type LlsTaskInterceptorDeps
} from './interceptor';
import type { LlsTaskService } from './service';

/** SSE 事件结构。 */
interface SseEventRecord {
    /** 事件名。 */
    event?: string;
    /** data 行拼接后的文本。 */
    data: string;
}

/** 被拦截的本地工具 content block 状态。 */
interface LocalToolBlockState {
    /** 原始 Anthropic content block index。 */
    index: number;
    /** 工具名。 */
    name: string;
    /** 累积的 input JSON 字符串。 */
    inputJson: string;
    /** 改写后文本块是否已经 start。 */
    textBlockStarted: boolean;
    /** 本地工具种类。 */
    kind: 'workflow';
}

/** 流式拦截器依赖。 */
export interface LlsTaskStreamingInterceptorDeps {
    /** 任务流服务。 */
    service: LlsTaskService;
    /** 自动续推调度器。 */
    autoContinueScheduler: AutoContinueScheduler;
    /** 文件工具观察回调。 */
    onFileTool?: (toolName: string, input: unknown) => void;
}

/** 流式拦截器最终状态。 */
export interface LlsTaskStreamingInterceptorResult {
    /** 是否出现任意 tool_use。 */
    sawToolUse: boolean;
    /** 是否本地处理了 workflow tool。 */
    handledWorkflowTool: boolean;
    /** 是否出现"非本地"工具（Claude Code 会进入 tool_result 往返）。 */
    sawNonLocalTool: boolean;
}

/**
 * Anthropic SSE 任务流增量拦截器。
 *
 * 输入 Anthropic SSE 文本，输出已经改写本地工具 tool_use 的 Anthropic SSE 文本。
 * 非本地工具的 tool_use 会原样透传。
 */
export class LlsTaskStreamingInterceptor {
    /** 尚未形成完整 SSE event 的缓冲。 */
    private buffer = '';

    /** 本地工具 block 状态，按原始 block index 记录。 */
    private readonly localBlocks = new Map<number, LocalToolBlockState>();

    /** 非本地文件工具 block 状态，按原始 block index 记录。 */
    private readonly fileToolBlocks = new Map<number, { name: string; inputJson: string }>();

    /** 是否出现任意 tool_use。 */
    private sawToolUse = false;

    /** 是否本地处理了 workflow tool。 */
    private handledWorkflowTool = false;

    /** 是否出现"非本地"工具调用。 */
    private sawNonLocalTool = false;

    /**
     * 创建 Anthropic SSE 任务流增量拦截器。
     *
     * @param deps 拦截器依赖。
     */
    public constructor(private readonly deps: LlsTaskStreamingInterceptorDeps) {}

    /**
     * 输入一段 Anthropic SSE 文本并输出改写后的 Anthropic SSE 文本。
     *
     * @param chunk Anthropic SSE chunk。
     * @returns 可写给 Claude Code 的 SSE 文本。
     */
    public feed(chunk: string): string {
        this.buffer += chunk;
        const events = this.drainCompleteEvents();
        return events.map((event) => this.handleEvent(event)).join('');
    }

    /**
     * 结束拦截并返回剩余文本。
     *
     * @returns 剩余可输出 SSE 文本。
     */
    public end(): string {
        const tail = this.buffer.trim();
        this.buffer = '';
        const out = tail ? this.handleEvent(tail) : '';
        this.finalizeScheduling();
        return out;
    }

    /**
     * 获取拦截结果状态。
     *
     * @returns 当前结果状态。
     */
    public getResult(): LlsTaskStreamingInterceptorResult {
        return {
            sawToolUse: this.sawToolUse,
            handledWorkflowTool: this.handledWorkflowTool,
            sawNonLocalTool: this.sawNonLocalTool
        };
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
     * 处理单个 Anthropic SSE event。
     *
     * @param rawEvent 原始 event 文本。
     * @returns 改写后 event 文本。
     */
    private handleEvent(rawEvent: string): string {
        const record = parseSseEvent(rawEvent);
        if (!record.data || record.data === '[DONE]') return formatSseEvent(record);
        let payload: unknown;
        try {
            payload = JSON.parse(record.data) as unknown;
        } catch {
            return formatSseEvent(record);
        }
        if (!isRecord(payload)) return formatSseEvent(record);
        if (payload.type === 'content_block_start') return this.handleContentBlockStart(record, payload);
        if (payload.type === 'content_block_delta') return this.handleContentBlockDelta(payload);
        if (payload.type === 'content_block_stop') return this.handleContentBlockStop(record, payload);
        if (payload.type === 'message_delta') return this.handleMessageDelta(record, payload);
        return formatSseEvent(record);
    }

    /**
     * 处理 content_block_start。
     *
     * @param record SSE event。
     * @param payload event payload。
     * @returns 改写后 SSE 文本。
     */
    private handleContentBlockStart(record: SseEventRecord, payload: Record<string, unknown>): string {
        const contentBlock = isRecord(payload.content_block) ? payload.content_block : undefined;
        if (contentBlock?.type !== 'tool_use') return formatSseEvent(record);
        this.sawToolUse = true;
        const index = Number(payload.index ?? 0);
        const name = typeof contentBlock.name === 'string' ? contentBlock.name : '';
        const kind = classifyLocalToolKind(name);
        if (!kind) {
            this.sawNonLocalTool = true;
            if (isFileOpenToolName(name)) this.fileToolBlocks.set(index, { name, inputJson: '' });
            return formatSseEvent(record);
        }
        if (kind === 'workflow') this.handledWorkflowTool = true;
        this.localBlocks.set(index, { index, name, inputJson: '', textBlockStarted: true, kind });
        return formatSseEvent({
            event: 'content_block_start',
            data: JSON.stringify({
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' }
            })
        });
    }

    /**
     * 处理 content_block_delta。
     *
     * @param payload event payload。
     * @returns 改写后 SSE 文本。
     */
    private handleContentBlockDelta(payload: Record<string, unknown>): string {
        const index = Number(payload.index ?? 0);
        const block = this.localBlocks.get(index);
        if (!block) {
            const fileBlock = this.fileToolBlocks.get(index);
            const delta = isRecord(payload.delta) ? payload.delta : {};
            if (fileBlock && typeof delta.partial_json === 'string') fileBlock.inputJson += delta.partial_json;
            return formatSseEvent({ event: 'content_block_delta', data: JSON.stringify(payload) });
        }
        const delta = isRecord(payload.delta) ? payload.delta : {};
        if (typeof delta.partial_json === 'string') block.inputJson += delta.partial_json;
        return '';
    }

    /**
     * 处理 content_block_stop。
     *
     * @param record SSE event。
     * @param payload event payload。
     * @returns 改写后 SSE 文本。
     */
    private handleContentBlockStop(record: SseEventRecord, payload: Record<string, unknown>): string {
        const index = Number(payload.index ?? 0);
        const block = this.localBlocks.get(index);
        if (!block) {
            const fileBlock = this.fileToolBlocks.get(index);
            if (fileBlock) {
                this.deps.onFileTool?.(fileBlock.name, parseToolInput(fileBlock.inputJson));
                this.fileToolBlocks.delete(index);
            }
            return formatSseEvent(record);
        }
        const message = executeLocalToolByKind(block.kind, block.name, parseToolInput(block.inputJson), this.toInterceptorDeps());
        this.localBlocks.delete(index);
        return formatSseEvent({
            event: 'content_block_delta',
            data: JSON.stringify({
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: message }
            })
        }) + formatSseEvent(record);
    }

    /**
     * 处理 message_delta，必要时把仅本地工具的 stop_reason 改为 end_turn。
     *
     * @param record SSE event。
     * @param payload event payload。
     * @returns 改写后 SSE 文本。
     */
    private handleMessageDelta(record: SseEventRecord, payload: Record<string, unknown>): string {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        if (delta?.stop_reason === 'tool_use' && this.handledWorkflowTool && !this.sawNonLocalTool) {
            delta.stop_reason = 'end_turn';
            return formatSseEvent({ event: record.event, data: JSON.stringify(payload) });
        }
        return formatSseEvent(record);
    }

    /**
     * 根据拦截结果调度自动续推。
     *
     * 调度规则与非流式拦截器 {@link interceptAnthropicResponse} 保持一致：
     * - 命中 workflow 工具 → 按工作流状态触发或取消续推；
     * - 命中真正的"非本地"工具 → 取消续推，由 Claude Code 自己处理 tool_result；
     * - 全部都不是 → 任务流活跃则按"缺失"重新登记续推。
     */
    private finalizeScheduling(): void {
        if (this.handledWorkflowTool) {
            this.deps.service.clearWorkflowUpdateMissing();
            if (this.deps.service.hasActiveWorkflow() && !this.deps.service.isWorkflowCompleted()) {
                this.deps.autoContinueScheduler.scheduleAfterWorkflowTool();
            } else {
                this.deps.autoContinueScheduler.cancel('任务流工具处理后 workflow 已完成或不存在');
            }
        } else if (this.sawNonLocalTool) {
            this.deps.autoContinueScheduler.cancel('响应包含非任务流工具调用，等待 Claude Code 工具结果');
        } else if (this.deps.service.hasActiveWorkflow()) {
            this.deps.service.markWorkflowUpdateMissing();
            this.deps.autoContinueScheduler.schedule();
        }
    }

    /**
     * 转换为现有整段拦截器依赖类型。
     *
     * @returns 拦截器依赖。
     */
    private toInterceptorDeps(): LlsTaskInterceptorDeps {
        return {
            service: this.deps.service,
            autoContinueScheduler: this.deps.autoContinueScheduler,
            onFileTool: this.deps.onFileTool
        };
    }
}

/**
 * 安全解析工具 input JSON。
 *
 * @param text JSON 文本。
 * @returns 解析结果；失败时返回空对象。
 */
function parseToolInput(text: string): unknown {
    try {
        return JSON.parse(text || '{}') as unknown;
    } catch {
        return {};
    }
}

/**
 * 解析单个 SSE event 文本。
 *
 * @param rawEvent 原始 event 文本。
 * @returns SSE event 记录。
 */
function parseSseEvent(rawEvent: string): SseEventRecord {
    const record: SseEventRecord = { data: '' };
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('event:')) record.event = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    record.data = dataLines.join('\n');
    return record;
}

/**
 * 格式化 SSE event。
 *
 * @param record SSE event 记录。
 * @returns SSE 文本。
 */
function formatSseEvent(record: SseEventRecord): string {
    const lines: string[] = [];
    if (record.event) lines.push(`event: ${record.event}`);
    for (const line of record.data.split('\n')) {
        lines.push(`data: ${line}`);
    }
    return `${lines.join('\n')}\n\n`;
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
