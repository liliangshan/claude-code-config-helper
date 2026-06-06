/** @file LLS CCAI 任务流响应与 SSE 工具调用拦截器。 */

import { Logger } from '../logger';
import { isFileOpenToolName } from '../editorAutoOpen';
import type { AutoContinueScheduler } from './autoContinue';
import type { LlsTaskService } from './service';
import {
    LLS_CCAI_TASK_CREATE_TOOL_NAME,
    LLS_CCAI_TASK_TOOL_NAME
} from './tools';
import type { LlsTaskStatusUpdate } from './types';

/** 拦截器依赖。 */
export interface LlsTaskInterceptorDeps {
    /** 任务流服务。 */
    service: LlsTaskService;
    /** 自动续推调度器。 */
    autoContinueScheduler: AutoContinueScheduler;
    /** 文件工具观察回调。 */
    onFileTool?: (toolName: string, input: unknown) => void;
}

/** 响应拦截结果。 */
export interface InterceptResponseResult {
    /** 改写后的响应体。 */
    body: string;
    /** 本轮是否出现任意 tool_use。 */
    sawToolUse: boolean;
    /** 本轮是否命中 LLS CCAI 任务流工具（create/update）。 */
    handledWorkflowTool: boolean;
    /** 本轮是否出现"非本地"工具调用（Claude Code 会触发 tool_result 往返）。 */
    sawNonLocalTool: boolean;
}

/** Anthropic content block 的最小结构。 */
interface AnthropicContentBlockLike {
    /** block 类型。 */
    type?: unknown;
    /** 工具名。 */
    name?: unknown;
    /** 工具输入。 */
    input?: unknown;
    /** 文本内容。 */
    text?: unknown;
    /** 其它字段。 */
    [key: string]: unknown;
}

/** SSE 事件结构。 */
interface SseEventRecord {
    /** 事件名。 */
    event?: string;
    /** data 行拼接后的文本。 */
    data: string;
}

/** 本地可执行工具的种类标识，用于区分调度副作用。 */
type LocalToolKind = 'workflow';

/** 流式 tool_use 累积器。 */
interface ToolUseAccumulator {
    /** content block index。 */
    index: number;
    /** 工具名。 */
    name: string;
    /** 累积到的 JSON 输入片段。 */
    inputJson: string;
    /** 命中的本地工具种类；非本地工具时为 undefined。 */
    localKind?: LocalToolKind;
}

/**
 * 拦截 Anthropic 非流式或 SSE 响应体中的工具调用。
 *
 * 命中下列任意本地工具会执行本地逻辑，并把 tool_use 改写为 text 块，避免
 * Claude Code 再发起 tool_result 往返：
 *
 * - {@link LLS_CCAI_TASK_TOOL_NAME} / {@link LLS_CCAI_TASK_CREATE_TOOL_NAME}：任务流创建/更新；
 * - {@link LLS_CCAI_GET_DIAGNOSTICS_TOOL_NAME}：本地读取 VS Code 问题面板。
 *
 * 调度副作用：
 * - 命中 workflow 工具 → 按工作流状态调度 `scheduleAfterWorkflowTool` / 取消续推；
 * - 仅命中诊断工具 → 不调度续推（诊断结果已在同一轮以 text 形式返回，模型会自行继续）；
 *   但若任务流处于活跃状态、且本轮没有任何 workflow 工具调用，仍按"缺失"标记并调度续推。
 *
 * @param body 原始响应体。
 * @param contentType 响应 content-type。
 * @param deps 拦截器依赖。
 * @returns 改写结果。
 */
export function interceptAnthropicResponse(
    body: string,
    contentType: string | string[] | undefined,
    deps: LlsTaskInterceptorDeps
): InterceptResponseResult {
    const typeText = Array.isArray(contentType) ? contentType.join(';') : contentType ?? '';
    const result = typeText.includes('text/event-stream') || body.includes('event:')
        ? interceptSseResponse(body, deps)
        : interceptJsonResponse(body, deps);
    if (result.handledWorkflowTool) {
        deps.service.clearWorkflowUpdateMissing();
        if (deps.service.hasActiveWorkflow() && !deps.service.isWorkflowCompleted()) {
            deps.autoContinueScheduler.scheduleAfterWorkflowTool();
        } else {
            deps.autoContinueScheduler.cancel('任务流工具处理后 workflow 已完成或不存在');
        }
    } else if (result.sawNonLocalTool) {
        deps.autoContinueScheduler.cancel('响应包含非任务流工具调用，等待 Claude Code 工具结果');
    } else if (deps.service.hasActiveWorkflow()) {
        deps.service.markWorkflowUpdateMissing();
        deps.autoContinueScheduler.schedule();
    }
    return result;
}

/**
 * 拦截非流式 JSON 响应。
 *
 * @param body 原始 JSON 响应体。
 * @param deps 拦截器依赖。
 * @returns 改写结果。
 */
function interceptJsonResponse(body: string, deps: LlsTaskInterceptorDeps): InterceptResponseResult {
    try {
        const json = JSON.parse(body) as { content?: AnthropicContentBlockLike[]; stop_reason?: string | null };
        const content = Array.isArray(json.content) ? json.content : [];
        let sawToolUse = false;
        let handledWorkflowTool = false;
        let sawNonLocalTool = false;
        const rewritten = content.map((block) => {
            if (block?.type !== 'tool_use') return block;
            sawToolUse = true;
            const name = String(block.name ?? '');
            if (isWorkflowToolName(name)) {
                handledWorkflowTool = true;
                const message = executeWorkflowTool(block.input, deps, name);
                return { type: 'text', text: message };
            }
            sawNonLocalTool = true;
            if (isFileOpenToolName(name)) deps.onFileTool?.(name, block.input);
            return block;
        });
        if (handledWorkflowTool) {
            json.content = rewritten;
            if (json.stop_reason === 'tool_use' && !sawNonLocalTool) {
                json.stop_reason = 'end_turn';
            }
        }
        return {
            body: handledWorkflowTool ? JSON.stringify(json) : body,
            sawToolUse,
            handledWorkflowTool,
            sawNonLocalTool
        };
    } catch (err) {
        Logger.warn('[LlsTask][Interceptor] 非流式响应解析失败：' + (err instanceof Error ? err.message : String(err)));
        return { body, sawToolUse: false, handledWorkflowTool: false, sawNonLocalTool: false };
    }
}

/**
 * 拦截 SSE 响应。
 *
 * @param body 原始 SSE 文本。
 * @param deps 拦截器依赖。
 * @returns 改写结果。
 */
function interceptSseResponse(body: string, deps: LlsTaskInterceptorDeps): InterceptResponseResult {
    const records = parseSseEvents(body);
    const output: string[] = [];
    const accumulators = new Map<number, ToolUseAccumulator>();
    let sawToolUse = false;
    let handledWorkflowTool = false;
    let sawNonLocalTool = false;

    for (const record of records) {
        if (!record.data || record.data === '[DONE]') {
            output.push(formatSseEvent(record));
            continue;
        }
        let payload: any;
        try {
            payload = JSON.parse(record.data);
        } catch {
            output.push(formatSseEvent(record));
            continue;
        }

        if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
            sawToolUse = true;
            const index = Number(payload.index ?? 0);
            const name = String(payload.content_block.name ?? '');
            const localKind = classifyLocalToolKind(name);
            accumulators.set(index, { index, name, inputJson: '', localKind });
            if (localKind === 'workflow') handledWorkflowTool = true;
            else sawNonLocalTool = true;
            if (localKind) {
                // 把本地工具的 content_block_start 改写为 text 块的 start。
                output.push(formatSseEvent({
                    event: record.event,
                    data: JSON.stringify({
                        type: 'content_block_start',
                        index,
                        content_block: { type: 'text', text: '' }
                    })
                }));
                continue;
            }
        }

        if (payload.type === 'content_block_delta') {
            const index = Number(payload.index ?? 0);
            const acc = accumulators.get(index);
            if (acc?.localKind) {
                // 累积本地工具的 input JSON，不向下游输出原始 delta。
                if (typeof payload.delta?.partial_json === 'string') acc.inputJson += payload.delta.partial_json;
                continue;
            }
            if (acc && isFileOpenToolName(acc.name) && typeof payload.delta?.partial_json === 'string') {
                acc.inputJson += payload.delta.partial_json;
            }
        }

        if (payload.type === 'content_block_stop') {
            const index = Number(payload.index ?? 0);
            const acc = accumulators.get(index);
            if (acc?.localKind) {
                const message = executeLocalToolByKind(acc.localKind, acc.name, parseToolInput(acc.inputJson), deps);
                output.push(formatSseEvent({
                    event: 'content_block_delta',
                    data: JSON.stringify({
                        type: 'content_block_delta',
                        index,
                        delta: { type: 'text_delta', text: message }
                    })
                }));
                output.push(formatSseEvent(record));
                accumulators.delete(index);
                continue;
            }
            accumulators.delete(index);
            if (acc && isFileOpenToolName(acc.name)) deps.onFileTool?.(acc.name, parseToolInput(acc.inputJson));
        }

        if (payload.type === 'message_delta' && payload.delta?.stop_reason === 'tool_use') {
            sawToolUse = true;
            if (handledWorkflowTool && !sawNonLocalTool) {
                payload.delta.stop_reason = 'end_turn';
                output.push(formatSseEvent({
                    event: record.event,
                    data: JSON.stringify(payload)
                }));
                continue;
            }
        }

        output.push(formatSseEvent(record));
    }

    return { body: output.join(''), sawToolUse, handledWorkflowTool, sawNonLocalTool };
}

/**
 * 执行任务流状态回写工具。
 *
 * @param input 工具输入。
 * @param deps 拦截器依赖。
 * @returns 可展示给客户端的执行结果文本。
 */
export function executeWorkflowTool(input: unknown, deps: LlsTaskInterceptorDeps, name?: string): string {
    if (name === LLS_CCAI_TASK_CREATE_TOOL_NAME) {
        const normalized = normalizeWorkflowInput(input);
        return deps.service.createWorkflow(
            normalized.workflow,
            normalized.planningDocumentPath,
            normalized.originalUserPrompt
        ).message;
    }
    return deps.service.updateTaskStatuses(normalizeUpdates(input)).message;
}

/**
 * 判断工具名称是否属于 LLS CCAI 任务流本地工具。
 *
 * @param name 待判断的工具名。
 * @returns 是否为创建或更新任务流工具。
 */
export function isWorkflowToolName(name: unknown): boolean {
    return name === LLS_CCAI_TASK_TOOL_NAME || name === LLS_CCAI_TASK_CREATE_TOOL_NAME;
}

/**
 * 把工具名分类为本地工具种类。
 *
 * - `workflow`：任务流创建 / 更新工具；
 * - `undefined`：非本地工具，应原样透传给下游 Claude Code。
 *
 * @param name 待分类的工具名。
 * @returns 本地工具种类；非本地工具时返回 undefined。
 */
export function classifyLocalToolKind(name: unknown): 'workflow' | undefined {
    if (isWorkflowToolName(name)) return 'workflow';
    return undefined;
}

/**
 * 按本地工具种类执行本地逻辑，并返回应写回响应的文本内容。
 *
 * @param kind 本地工具种类。
 * @param name 原始工具名（用于 workflow 区分 create / update）。
 * @param input 工具输入。
 * @param deps 拦截器依赖。
 * @returns 写回响应文本块的内容。
 */
export function executeLocalToolByKind(
    kind: 'workflow',
    name: string,
    input: unknown,
    deps: LlsTaskInterceptorDeps
): string {
    if (kind === 'workflow') return executeWorkflowTool(input, deps, name);
    return '';
}

/**
 * 规范化创建工具输入。
 *
 * 除了把 `workflow` 子对象解出来，还会回传模型同时填写的
 * `planningDocumentPath` / `originalUserPrompt`，供 service 写入 snapshot
 * 作为"原始用户上下文"锚点，让后续续推始终能拼回这两段附加内容。
 *
 * @param input 工具输入。
 * @returns 包含 workflow 与可选 path/prompt 的规范化对象。
 */
function normalizeWorkflowInput(input: unknown): {
    workflow: unknown;
    planningDocumentPath: string;
    originalUserPrompt: string;
} {
    if (!input || typeof input !== 'object') {
        return { workflow: {}, planningDocumentPath: '', originalUserPrompt: '' };
    }
    const obj = input as { workflow?: unknown; planningDocumentPath?: unknown; originalUserPrompt?: unknown };
    return {
        workflow: obj.workflow ?? {},
        planningDocumentPath: typeof obj.planningDocumentPath === 'string' ? obj.planningDocumentPath : '',
        originalUserPrompt: typeof obj.originalUserPrompt === 'string' ? obj.originalUserPrompt : ''
    };
}

/**
 * 规范化工具输入中的 updates 数组。
 *
 * @param input 工具输入。
 * @returns 状态更新数组。
 */
function normalizeUpdates(input: unknown): LlsTaskStatusUpdate[] {
    if (!input || typeof input !== 'object') return [];
    const updates = (input as { updates?: unknown }).updates;
    return Array.isArray(updates) ? updates as LlsTaskStatusUpdate[] : [];
}

/**
 * 安全解析 tool_use 的 JSON 输入。
 *
 * @param text JSON 文本。
 * @returns 解析结果；失败时返回空对象。
 */
function parseToolInput(text: string): unknown {
    try {
        return JSON.parse(text || '{}');
    } catch {
        return {};
    }
}

/**
 * 解析 SSE 文本为事件记录数组。
 *
 * @param body SSE 原文。
 * @returns SSE 事件记录数组。
 */
function parseSseEvents(body: string): SseEventRecord[] {
    return body.split(/\r?\n\r?\n/).filter(Boolean).map((chunk) => {
        const record: SseEventRecord = { data: '' };
        const dataLines: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
            if (line.startsWith('event:')) record.event = line.slice('event:'.length).trim();
            if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
        }
        record.data = dataLines.join('\n');
        return record;
    });
}

/**
 * 格式化 SSE 事件记录。
 *
 * @param record SSE 事件记录。
 * @returns SSE 文本片段。
 */
function formatSseEvent(record: SseEventRecord): string {
    const lines: string[] = [];
    if (record.event) lines.push(`event: ${record.event}`);
    for (const line of record.data.split('\n')) {
        lines.push(`data: ${line}`);
    }
    return `${lines.join('\n')}\n\n`;
}
