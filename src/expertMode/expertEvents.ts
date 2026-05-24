/**
 * @file 专家模式事件类型与推送通道接口。
 *
 * 专家在运行过程中产生的所有「可见事件」（assistant 文本、工具调用、最终
 * 结论等）都被规范化为 {@link ExpertEvent}，由 `ExpertRunner` 推送给
 * `ChatViewHost`，再透传到 webview 渲染 `ExpertPanel`。
 *
 * 设计原则（详见 `EXPERT_MODE_DESIGN.md` §7）：
 * 1. **平行通道**：ExpertEvent 不会进入主对话历史，仅作为视图层信息流；
 * 2. **不进 sessionStore**：webview 关闭即丢失，符合「不进上下文」目标；
 * 3. **统一字节上限**：单条事件文本超过 {@link EXPERT_EVENT_TEXT_MAX_BYTES}
 *    会被截断并标注 `[truncated]`，避免 webview 卡顿。
 */

import { EXPERT_EVENT_TEXT_MAX_BYTES } from './expertConstants';

/**
 * 专家事件种类。
 *
 * - `start`：专家开始执行（首个事件，含 question / model 等元信息）
 * - `analysis`：专家产出的 assistant 文本片段
 * - `tool_call`：专家发起一次工具调用（Read / Grep / Bash 等）
 * - `tool_result`：上一次工具调用的结果摘要
 * - `final`：专家给出最终结论（最后一个常规事件）
 * - `error`：专家执行失败（与 final 二选一）
 * - `cancelled`：被外部 AbortSignal 中止（与 final 二选一）
 */
export type ExpertEventKind =
    | 'start'
    | 'analysis'
    | 'tool_call'
    | 'tool_result'
    | 'final'
    | 'error'
    | 'cancelled';

/**
 * 单条专家事件。
 *
 * 各字段是否出现取决于 {@link ExpertEventKind}；调用方应当根据 `kind` 分支处理。
 */
export interface ExpertEvent {
    /** 当前专家 run 的稳定 id，用于 webview 把多事件聚合到同一面板。 */
    runId: string;
    /**
     * 关联的主对话消息 id（assistant 消息），用于把 ExpertPanel 折叠面板
     * 挂到对应主气泡的下方。
     */
    parentMessageId: string;
    /** 关联的 ask_expert tool_use_id，用于追溯主对话上下文。 */
    callId: string;
    /** 主聊天区 ask_expert 工具卡片的 ChatSegment.id，用于 webview 实时更新 Output。 */
    toolSegmentId?: string;
    /** 事件产生时间戳（毫秒）。 */
    ts: number;
    /** 事件种类。 */
    kind: ExpertEventKind;

    /** `kind='start'` 时：用户给专家的自包含问题。 */
    question?: string;
    /** `kind='start'` 时：实际使用的专家模型 id。 */
    expertModel?: string;

    /** `kind='analysis' | 'final' | 'error' | 'cancelled'` 时的文本内容。 */
    text?: string;

    /** `kind='tool_call' | 'tool_result'` 时的工具名。 */
    toolName?: string;
    /** `kind='tool_call'` 时的工具入参（已 JSON.parse）。 */
    toolArgs?: unknown;
    /** `kind='tool_result'` 时的结果摘要（已截断到 {@link EXPERT_EVENT_TEXT_MAX_BYTES}）。 */
    toolResultSummary?: string;
    /** `kind='tool_result'` 时：该工具结果是否为错误。 */
    toolIsError?: boolean;

    /** `kind='final'` 时：本次 run 总耗时（毫秒）。 */
    durationMs?: number;
}

/**
 * 专家事件推送通道。
 *
 * `ExpertRunner` 持有该接口的一个实现（通常由 `ChatViewHost` 注入），
 * 在产出事件时调用 {@link push}。具体实现把事件转成 webview 消息并发送。
 *
 * 在单元测试中，可以使用 {@link createMemoryExpertEventSink} 把事件
 * 收集到内存数组里便于断言。
 */
export interface ExpertEventSink {
    /**
     * 推送一条事件。实现应当**同步**完成或异步 fire-and-forget，不应 await。
     *
     * @param event 待推送的事件。
     */
    push(event: ExpertEvent): void;
}

/**
 * 创建一个把事件累积到数组的 sink，便于单元测试断言。
 *
 * @returns 一个对象，包含 `sink` 和访问内部数组的 `events` 字段。
 */
export function createMemoryExpertEventSink(): {
    sink: ExpertEventSink;
    events: ExpertEvent[];
} {
    const events: ExpertEvent[] = [];
    const sink: ExpertEventSink = {
        push(event) {
            events.push(event);
        }
    };
    return { sink, events };
}

/**
 * 按字节上限截断文本，附加 `[truncated, original=NN bytes]` 标记。
 *
 * 用于在事件推送给 webview 前对长 assistant 文本 / tool_result 做安全裁剪。
 *
 * @param text 原始文本（可能为 undefined）。
 * @param maxBytes 最大字节数。默认使用 {@link EXPERT_EVENT_TEXT_MAX_BYTES}。
 * @returns 截断后的文本；undefined 原样返回。
 */
export function truncateForEvent(
    text: string | undefined,
    maxBytes: number = EXPERT_EVENT_TEXT_MAX_BYTES
): string | undefined {
    if (text === undefined) return undefined;
    const buf = Buffer.from(text, 'utf8');
    if (buf.byteLength <= maxBytes) return text;
    // 注意：直接按字节切可能会切坏 UTF-8 序列；用 toString('utf8', 0, maxBytes)
    // 会自动把不完整的尾部字节替换为 U+FFFD，再修剪掉最后一个替换符即可。
    let head = buf.toString('utf8', 0, maxBytes);
    while (head.endsWith('\uFFFD')) {
        head = head.slice(0, -1);
    }
    return `${head}\n[truncated, original=${buf.byteLength} bytes]`;
}
