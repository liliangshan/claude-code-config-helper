/**
 * @file Claude CLI stream-json 长连接协议适配器。
 *
 * 本文件是按方案 B 整体重写后的版本，目标是 **更贴近官方 Claude Code 扩展**
 * （参考实现 `anthropic.claude-code-2.1.144-darwin-arm64`）的解析语义：
 *
 * - 以 **Anthropic stream-json** 协议为一等公民：`message_start` →
 *   `content_block_start` → `content_block_delta` → `content_block_stop` →
 *   `message_stop`。
 * - 每个 `content_block` 由 `index` 标识，本适配器为它单独维护一份状态机；
 *   文本块走 `text_delta`，思考块走 `thinking_delta`，工具入参走
 *   `input_json_delta` 累积成完整 JSON。
 * - `tool_use` 与 `tool_result` 通过 `tool_use_id` 配对，工具卡片可在收到
 *   结果时回填状态与详情。
 * - 对非 stream-json 形态的输出（裸 JSON、裸文本、stderr）保留宽松降级路径，
 *   保持原适配器的容错能力。
 *
 * 对外契约（`StreamJsonCliAdapter` 类名、`ParsedCliEvent` 联合类型与 public
 * 方法签名）**保持与重写前一致**，以便 `src/extension.ts` 等调用方无需改动。
 */

import { EventEmitter } from 'events';
import * as vscode from 'vscode';

import { Logger } from '../../logger';
import {
    createChatParserState,
    flushParser,
    parseChunk,
    type ChatParserState
} from '../parser/chatParser';
import type { ChatSegment } from '../protocol';
import { CliProcess } from './cliProcess';
import type { CliChunk } from './types';

// =============================================================================
// 对外类型契约（与重写前完全兼容）
// =============================================================================

/** Claude CLI stdio 权限请求事件。 */
export interface ToolPermissionRequestEvent {
    /** 事件类型。 */
    type: 'tool/permissionRequest';
    /** CLI control_request 的请求 ID，用于 control_response 回写配对。 */
    requestId: string;
    /** 请求授权的工具名称，例如 Bash/Edit/Write。 */
    toolName: string;
    /** 工具原始输入参数。 */
    input: unknown;
    /** Claude CLI 提供的可选建议列表。 */
    suggestions?: unknown[];
    /** CLI 侧工具调用 ID（如果存在）。 */
    toolUseId?: string;
    /** 权限请求标题（如果 CLI 提供）。 */
    title?: string;
    /** 权限请求显示名（如果 CLI 提供）。 */
    displayName?: string;
    /** 权限请求描述（如果 CLI 提供）。 */
    description?: string;
    /** CLI 判定需要授权的原因（如果提供）。 */
    decisionReason?: string;
    /** 被权限策略拦截的路径（如果提供）。 */
    blockedPath?: string;
    /** 原始 control_request.request 对象，便于后续兼容 CLI 新字段。 */
    rawRequest: Record<string, unknown>;
}

/** Claude CLI stdio 权限响应结果。 */
export type ToolPermissionResponseResult =
    | {
          /** 允许本次工具调用继续执行。 */
          behavior: 'allow';
          /** 可选：修改后的工具输入；默认沿用原输入。 */
          updatedInput?: unknown;
          /** 可选：本次确认附带更新的权限规则。 */
          updatedPermissions?: unknown[];
      }
    | {
          /** 拒绝本次工具调用。 */
          behavior: 'deny';
          /** 返回给 Claude CLI / 模型的拒绝原因。 */
          message?: string;
          /** 是否中断当前模型回合。 */
          interrupt?: boolean;
      };

/** 适配器解析出的 CLI 事件类型。 */
export type ParsedCliEvent =
    | { type: 'segments'; segments: ChatSegment[]; done?: boolean }
    | { type: 'error'; message: string; detail?: string }
    | { type: 'session/init'; sessionId: string; cwd: string }
    | { type: 'compact/status'; status: 'compacting' | null; compactResult?: string; sessionId?: string; uuid?: string }
    | ToolPermissionRequestEvent
    | ExpertSubturnStartedEvent
    | ExpertSubturnFinishedEvent
    | { type: 'done' };

/** 主 CLI 发起一次 ask_expert MCP 工具调用的事件。 */
export interface ExpertSubturnStartedEvent {
    /** 事件类型。 */
    type: 'expert/subturn/started';
    /** Anthropic tool_use_id，用于与后续 tool_result 配对。 */
    toolUseId: string;
    /** 主模型传入的 question 字段。 */
    question: string;
}

/** 主 CLI 收到 ask_expert 工具最终 tool_result 的事件。 */
export interface ExpertSubturnFinishedEvent {
    /** 事件类型。 */
    type: 'expert/subturn/finished';
    /** 配对的 tool_use_id。 */
    toolUseId: string;
    /** 专家最终回答文本（或失败原因）。 */
    content: string;
    /** 是否为错误响应。 */
    isError: boolean;
}

// =============================================================================
// 常量
// =============================================================================

/** 解析事件总线事件名。 */
const EVENT_PARSED = 'parsed';

/** 工具入参累积上限（防止异常情况导致内存爆炸）。 */
const TOOL_INPUT_JSON_MAX_LENGTH = 200_000;

/**
 * 权限拦截 VS Code 弹窗通知的最小时间间隔（毫秒）。
 *
 * 当 Claude 模型在同一回合内多次重试同一被拦截的操作时（例如连续 3 次尝试
 * 写入文件均被 deny），不节流会导致弹窗刷屏。
 */
const PERMISSION_DENIED_NOTIFY_INTERVAL_MS = 8_000;

/** 思考块输出时的视觉前缀，用于在 webview 中以独立段落呈现。 */
const THINKING_SEGMENT_PREFIX = '> 💭 ';

// =============================================================================
// 内部状态机
// =============================================================================

/**
 * 单个 `content_block` 的运行时状态。
 *
 * Anthropic stream-json 协议中，一条 assistant message 由若干 content block 组成，
 * 每个 block 由 `index` 标识，类型可以是 `text` / `thinking` / `tool_use` / `tool_result`。
 * 本适配器需要为每个 block 维护独立状态：
 *
 * - text/thinking：累积 delta 文本，便于后续 flush。
 * - tool_use：记录工具名、id、累积 `input_json_delta`，以及该卡片在
 *   `toolSegmentById` 中的快照，便于在 tool_result 到达时回填。
 */
interface ContentBlockState {
    /** content block 类型。 */
    type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'unknown';
    /** 当前累积的纯文本（text/thinking 才使用）。 */
    text: string;
    /** tool_use 的工具名称。 */
    toolName?: string;
    /** tool_use 的稳定 id。 */
    toolUseId?: string;
    /** tool_use 的累积 input JSON delta。 */
    toolInputJson: string;
}

/**
 * 单条 assistant message 的解析状态。
 *
 * 由 `message_start` 创建，`message_stop` 销毁；期间所有 content block 共享。
 */
interface MessageParseState {
    /** Anthropic message id。 */
    messageId: string;
    /** index → block 状态映射。 */
    blocks: Map<number, ContentBlockState>;
}

// =============================================================================
// 主类：StreamJsonCliAdapter
// =============================================================================

/**
 * 将扩展内部的发送语义映射到 Claude CLI stream-json JSON Lines 协议。
 *
 * 重写后实现说明：
 *
 * 1. **输入侧**：发送形如 `{ "type": "user", "message": { role, content } }` 的
 *    SDK 协议行（与重写前一致）。
 * 2. **输出侧**：
 *    - 主路径：解析 Anthropic stream-json 事件（message_start/content_block_*）。
 *    - 兼容路径：对裸 SDK 事件、tool_use/tool_result、未识别 JSON、纯文本进行
 *      宽松降级，最终都收敛为 `segments` 事件。
 *    - 错误路径：stderr 直接转为 `error` kind 的 segment。
 * 3. **状态管理**：
 *    - 每条 assistant message 拥有独立 `MessageParseState`。
 *    - 工具卡片在 `toolSegmentById` 中按 `tool_use_id` 索引，方便在 tool_result
 *      到达时回填。
 */
export class StreamJsonCliAdapter implements vscode.Disposable {
    /** 解析事件总线。 */
    private readonly emitter = new EventEmitter();

    /** stdout 字符缓冲（按 JSON 对象边界 / 行边界消费）。 */
    private stdoutBuffer = '';

    /** stderr 行缓冲。 */
    private stderrBuffer = '';

    /** Markdown / code / fileRef 流式解析器状态（用于裸文本降级渲染）。 */
    private parserState: ChatParserState = createChatParserState();

    /** 当前正在累积的 assistant message 状态机；null 表示当前没有进行中的消息。 */
    private currentMessage: MessageParseState | null = null;

    /** 当前用户轮次是否已经向聊天区输出过 assistant 正文，用于 result 兜底去重。 */
    private hasEmittedAssistantContent = false;

    /** 最近累计的 assistant 可见文本，用于最终 result 兜底去重。 */
    private recentAssistantText = '';

    /**
     * 已经通过流式 delta 渲染过的 assistant message id 集合。
     *
     * 启用 `--include-partial-messages` 后，CLI 会先发 `content_block_delta` 增量，
     * 再补发一条内容完全相同的聚合 `assistant` 事件；不去重会导致正文与思考各渲染两遍。
     */
    private readonly streamedMessageIds = new Set<string>();

    /** tool_use_id → 工具卡片 segment 引用，便于 tool_result 回填。 */
    private readonly toolSegmentById = new Map<string, ChatSegment>();

    /** tool_use_id 集合，用于静默丢弃被隐藏工具的后续 tool_result。 */
    private readonly hiddenToolUseIds = new Set<string>();

    /**
     * 上一次因权限拦截向用户通知的时间戳，用于在 applyToolResult 中节流。
     *
     * 同一回合内模型可能连续重试同一拦截场景（参考 1.txt 日志：3 次尝试写
     * 1.txt 全部 deny），不节流会导致 VS Code 弹窗刷屏。
     */
    private lastPermissionDeniedNotifyAt = 0;

    /** 已注册到 CliProcess 的 Disposable 列表。 */
    private readonly disposables: vscode.Disposable[] = [];

    /**
     * 创建 stream-json 适配器并订阅 CliProcess 输出。
     *
     * @param process 长连接 CLI 进程封装。
     * @param onPermissionDenied 可选回调：当检测到 Claude CLI 因权限策略拦截工具调用时
     *   触发，宿主可在此弹出 VS Code 通知或引导用户修改 permissionMode 配置。
     *   adapter 内部按 PERMISSION_DENIED_NOTIFY_INTERVAL_MS 节流。
     */
    public constructor(
        private readonly process: CliProcess,
        private readonly onPermissionDenied?: (resultText: string) => void
    ) {
        this.disposables.push(this.process.onChunk((chunk) => this.handleChunk(chunk)));
        this.disposables.push(
            this.process.onExit((event) => {
                this.flushBuffers();
                if (event.code === 0) {
                    this.emitParsed({ type: 'done' });
                } else {
                    this.emitParsed({
                        type: 'error',
                        message: `CLI 进程已退出：code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}`
                    });
                }
            })
        );
    }

    // -------------------------------------------------------------------------
    // 对外 public 接口（保持与重写前签名一致）
    // -------------------------------------------------------------------------

    /**
     * 启动适配器。
     *
     * 当前 CliProcess 生命周期由扩展入口管理，因此该方法保留为协议接口占位。
     */
    public async start(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * 发送用户消息到 CLI stdin。
     *
     * @param text 用户输入文本。
     */
    public async sendUserMessage(text: string): Promise<void> {
        this.hasEmittedAssistantContent = false;
        this.recentAssistantText = '';
        this.streamedMessageIds.clear();
        const jsonLine = JSON.stringify(this.buildUserMessageLine(text));
        this.process.send(jsonLine);
    }

    /**
     * 将用户对 CLI 工具授权请求的选择写回 Claude CLI stdin。
     *
     * Claude CLI 在启用 `--permission-prompt-tool stdio` 后，会通过 stdout 发出
     * `control_request` / `can_use_tool` 请求；宿主必须按相同 `request_id` 写回
     * `control_response`，否则当前工具调用会一直等待。本方法封装官方 SDK 的
     * stdio 回写形态，供 extension.ts 在用户点击允许/拒绝后调用。
     *
     * @param requestId control_request 中的请求 ID。
     * @param result 用户确认后的允许或拒绝结果。
     */
    public respondToToolPermission(requestId: string, result: ToolPermissionResponseResult): void {
        const jsonLine = JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: requestId,
                response: result
            }
        });
        Logger.info(`stream-json 适配器写回工具授权响应：requestId=${requestId}, behavior=${result.behavior}`);
        this.process.send(jsonLine);
    }

    /**
     * 取消当前请求。
     */
    public async cancelCurrentRequest(): Promise<void> {
        this.process.cancel();
    }

    /**
     * 重启底层 CLI 进程。
     */
    public async restart(): Promise<void> {
        await this.process.restart();
    }

    /**
     * 订阅已解析的 CLI 事件。
     *
     * @param listener 事件监听器。
     * @returns 用于取消订阅的 Disposable。
     */
    public onParsedEvent(listener: (event: ParsedCliEvent) => void): vscode.Disposable {
        this.emitter.on(EVENT_PARSED, listener);
        return { dispose: () => this.emitter.off(EVENT_PARSED, listener) };
    }

    /**
     * 解析一个原始 CLI chunk（保留对外暴露的同步解析能力，便于单测）。
     *
     * @param chunk CLI 原始输出。
     * @returns 从该 chunk 中提取出的事件列表。
     */
    public parseOutput(chunk: CliChunk): ParsedCliEvent[] {
        if (chunk.source === 'stderr') {
            const parsed = parseChunk(this.parserState, { source: 'stderr', text: chunk.text });
            this.parserState = parsed.state;
            return [{ type: 'segments', segments: parsed.segments }];
        }
        return this.parseStdoutText(chunk.text);
    }

    /**
     * 释放适配器事件订阅资源。
     */
    public dispose(): void {
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        this.emitter.removeAllListeners();
        this.toolSegmentById.clear();
        this.hiddenToolUseIds.clear();
        this.currentMessage = null;
    }

    // -------------------------------------------------------------------------
    // CLI 输入侧：构造发送给 CLI 的 JSON 行
    // -------------------------------------------------------------------------

    /**
     * 构造发送给 CLI 的用户消息 JSON 行。
     *
     * @param text 用户输入文本。
     * @returns 可 JSON.stringify 的协议对象。
     */
    private buildUserMessageLine(text: string): unknown {
        return {
            type: 'user',
            message: {
                role: 'user',
                content: [{ type: 'text', text }]
            }
        };
    }

    // -------------------------------------------------------------------------
    // CLI 输出侧：chunk → events 主流程
    // -------------------------------------------------------------------------

    /**
     * 处理来自 CliProcess 的 chunk，并把解析结果广播给监听者。
     *
     * @param chunk 原始 CLI chunk。
     */
    private handleChunk(chunk: CliChunk): void {
        const events = this.parseOutput(chunk);
        for (const event of events) {
            this.emitParsed(event);
        }
    }


    /**
     * 解析 stdout 文本：优先按 JSON 对象边界消费，再按行回退，保证 JSONL/粘包都能处理。
     *
     * @param text stdout 文本。
     * @returns 已解析事件列表。
     */
    private parseStdoutText(text: string): ParsedCliEvent[] {
        this.stdoutBuffer += text;
        const events = this.drainJsonObjectsFromStdoutBuffer();
        if (events.length > 0) return events;
        return this.drainLines('stdout');
    }

    /**
     * 从 stdout 缓冲中按完整 JSON 对象边界连续提取事件。
     *
     * 该方法不依赖换行符，维护字符串/转义/括号深度状态，遇到一个完整顶层
     * JSON object 后立即解析，适配 Claude CLI 直接输出 JSON chunk 的情况。
     *
     * @returns 已成功解析出的事件列表。
     */
    private drainJsonObjectsFromStdoutBuffer(): ParsedCliEvent[] {
        const events: ParsedCliEvent[] = [];
        while (true) {
            const extracted = this.extractFirstCompleteJsonObject(this.stdoutBuffer);
            if (!extracted) break;
            const prefix = this.stdoutBuffer.slice(0, extracted.start).trim();
            if (prefix) {
                events.push(this.parseDisplayText(prefix + '\n'));
            }
            events.push(this.parseLine('stdout', extracted.jsonText));
            this.stdoutBuffer = this.stdoutBuffer.slice(extracted.end).trimStart();
        }
        return events;
    }

    /**
     * 从文本中查找第一个完整顶层 JSON object。
     *
     * @param text 待扫描文本。
     * @returns 完整 JSON 的起止位置和文本；未完整时返回 undefined。
     */
    private extractFirstCompleteJsonObject(
        text: string
    ): { start: number; end: number; jsonText: string } | undefined {
        const start = text.indexOf('{');
        if (start < 0) return undefined;
        let depth = 0;
        let inString = false;
        let escaping = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (inString) {
                if (escaping) {
                    escaping = false;
                    continue;
                }
                if (char === '\\') {
                    escaping = true;
                    continue;
                }
                if (char === '"') inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') {
                depth += 1;
                continue;
            }
            if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    const end = index + 1;
                    const jsonText = text.slice(start, end);
                    try {
                        JSON.parse(jsonText);
                        return { start, end, jsonText };
                    } catch {
                        return undefined;
                    }
                }
            }
        }
        return undefined;
    }

    /**
     * 按来源消费行缓冲。
     *
     * @param source 待消费的来源缓冲。
     * @returns 已解析事件列表。
     */
    private drainLines(source: 'stdout' | 'stderr'): ParsedCliEvent[] {
        const events: ParsedCliEvent[] = [];
        let buffer = source === 'stdout' ? this.stdoutBuffer : this.stderrBuffer;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const rawLine = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const line = rawLine.trimEnd();
            if (line.trim()) {
                events.push(this.parseLine(source, line));
            }
            newlineIndex = buffer.indexOf('\n');
        }
        if (source === 'stdout') {
            this.stdoutBuffer = buffer;
        } else {
            this.stderrBuffer = buffer;
        }
        return events;
    }

    /**
     * 刷新尚未遇到换行的缓冲内容，并清空进行中的 message 状态。
     */
    private flushBuffers(): void {
        const stdout = this.stdoutBuffer.trim();
        const stderr = this.stderrBuffer.trim();
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        if (stdout) this.emitParsed(this.parseLine('stdout', stdout));
        if (stderr) this.emitParsed(this.parseLine('stderr', stderr));
        const parserSegments = flushParser(this.parserState);
        if (parserSegments.length > 0) {
            this.emitParsed({ type: 'segments', segments: parserSegments });
        }
        this.currentMessage = null;
    }

    // -------------------------------------------------------------------------
    // 单行解析入口：JSON 优先，文本降级
    // -------------------------------------------------------------------------

    /**
     * 解析单行 stdout/stderr 输出。
     *
     * @param source 输出来源。
     * @param line 单行文本。
     * @returns 解析事件。
     */
    private parseLine(source: 'stdout' | 'stderr', line: string): ParsedCliEvent {
        if (source === 'stderr') {
            return { type: 'segments', segments: [{ kind: 'error', text: line }] };
        }
        try {
            const json = JSON.parse(line) as unknown;
            return this.parseJsonEvent(json, line);
        } catch {
            return this.parseDisplayText(line + '\n');
        }
    }

    /**
     * 从 JSON 事件中提取可显示文本或完成状态。
     *
     * 解析顺序（先精准、后宽松）：
     * 1. system/init                        → session 初始化事件
     * 2. Anthropic 官方 stream-json 事件     → 主路径（message_start 等）
     * 3. SDK 顶层包装（type=assistant/user/tool_use/tool_result）
     * 4. result / done / message_stop       → 流结束
     * 5. 未知工具事件                        → 降级为通用工具卡片
     * 6. 任意带 text 字段                    → 文本降级
     * 7. 完全无法识别                        → 原文降级
     *
     * @param event CLI JSON 事件对象。
     * @param rawLine 原始 JSON 行，无法识别时用于降级显示。
     * @returns 解析事件。
     */
    private parseJsonEvent(event: unknown, rawLine: string): ParsedCliEvent {
        if (!event || typeof event !== 'object') {
            return { type: 'segments', segments: [{ kind: 'markdown', text: rawLine + '\n' }] };
        }
        const record = event as Record<string, unknown>;

        // 1. system / init
        const initEvent = this.parseSystemInitEvent(record);
        if (initEvent) return initEvent;

        // 1.1. system / status → CLI 原生压缩状态
        const statusEvent = this.parseSystemStatusEvent(record);
        if (statusEvent) return statusEvent;

        // 1.2. system / taskstarted / tasknotification → 任务卡片 segment
        const taskEvent = this.parseSystemTaskEvent(record);
        if (taskEvent) return taskEvent;

        // 1.3. 其余 system 事件（api_retry / task_updated 等）→ 折叠卡片而非原文降级
        const genericSystemEvent = this.parseSystemGenericEvent(record);
        if (genericSystemEvent) return genericSystemEvent;

        // 1.5. Claude CLI stdio 控制请求（官方 canUseTool 权限回调通道）
        const permissionRequest = this.parseToolPermissionRequest(record);
        if (permissionRequest) return permissionRequest;

        // 2. Anthropic 官方 stream-json
        const streamEvent = this.parseAnthropicStreamEvent(record);
        if (streamEvent) return streamEvent;

        // 3. SDK 包装（{ type: "assistant", message: {...} } / { type: "user", message: {...} }）
        const sdkEvent = this.parseSdkWrapperEvent(record);
        if (sdkEvent) return sdkEvent;

        // 4. 流结束；result 事件可能同时携带聚合后的正文，需要先兜底输出再结束。
        if (record.type === 'result') return this.parseResultEvent(record);
        if (record.type === 'done' || record.type === 'message_stop') return { type: 'done' };

        // 5. 未知工具事件兜底
        const toolSegment = this.parseLooseToolEvent(record);
        if (toolSegment) {
            return { type: 'segments', segments: [toolSegment], done: false };
        }

        // 6. 任意带 text 字段
        const text = this.extractTextFallback(record);
        if (text) {
            const parsed = this.parseDisplayText(text);
            return parsed.type === 'segments' ? { ...parsed, done: false } : parsed;
        }

        // 7. 完全无法识别 → 原文降级
        Logger.debug('未识别的 CLI JSON 事件，按原始文本降级显示', record);
        return this.parseDisplayText(rawLine + '\n');
    }

    /**
     * 解析 Claude CLI `--permission-prompt-tool stdio` 发出的工具授权请求。
     *
     * 官方扩展通过 Agent SDK 的 `canUseTool` 回调处理该通道；底层在线路上表现为
     * `type: "control_request"` 且 request subtype 为 `can_use_tool`。这里做宽松
     * 字段兼容：不同 CLI 小版本可能把 `request_id` 放在顶层或 request 内部，也
     * 可能使用 `tool_name` / `toolName` 命名。
     *
     * @param record 已 JSON.parse 的顶层事件对象。
     * @returns 解析成功时返回权限请求事件，否则返回 undefined。
     */
    private parseToolPermissionRequest(record: Record<string, unknown>): ToolPermissionRequestEvent | undefined {
        if (record.type !== 'control_request') return undefined;
        const request = this.asRecord(record.request);
        if (!request || request.subtype !== 'can_use_tool') return undefined;
        const requestId = this.readFirstString(record, request, ['request_id', 'requestId', 'id']);
        const toolName = this.readFirstString(request, request, ['tool_name', 'toolName', 'name']);
        if (!requestId || !toolName) {
            Logger.warn('收到不完整的 can_use_tool control_request，已按原始事件降级', record);
            return undefined;
        }
        return {
            type: 'tool/permissionRequest',
            requestId,
            toolName,
            input: request.input,
            suggestions: Array.isArray(request.suggestions) ? request.suggestions : undefined,
            toolUseId: this.readFirstString(request, request, ['tool_use_id', 'toolUseID', 'toolUseId']),
            title: this.readFirstString(request, request, ['title']),
            displayName: this.readFirstString(request, request, ['display_name', 'displayName']),
            description: this.readFirstString(request, request, ['description']),
            decisionReason: this.readFirstString(request, request, ['decision_reason', 'decisionReason']),
            blockedPath: this.readFirstString(request, request, ['blocked_path', 'blockedPath']),
            rawRequest: request
        };
    }

    /**
     * 将 unknown 值安全收窄为普通对象。
     *
     * @param value 待收窄值。
     * @returns 普通对象时返回自身，否则返回 undefined。
     */
    private asRecord(value: unknown): Record<string, unknown> | undefined {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        return value as Record<string, unknown>;
    }

    /**
     * 从多个候选字段名中读取第一个字符串值。
     *
     * @param primary 优先读取的对象。
     * @param fallback 兜底读取的对象。
     * @param keys 候选字段名列表。
     * @returns 找到字符串字段时返回该值，否则返回 undefined。
     */
    private readFirstString(
        primary: Record<string, unknown>,
        fallback: Record<string, unknown>,
        keys: string[]
    ): string | undefined {
        for (const key of keys) {
            const value = primary[key] ?? fallback[key];
            if (typeof value === 'string' && value.trim()) return value;
        }
        return undefined;
    }

    // -------------------------------------------------------------------------
    // 解析路径 1：system/init
    // -------------------------------------------------------------------------

    /**
     * 识别 Claude CLI 初始化系统事件并转换为内部 session 初始化事件。
     *
     * 系统 init 事件只用于保存 session_id，不应该降级显示到聊天区。
     *
     * @param record CLI JSON 事件对象。
     * @returns 命中 system/init 且存在 session_id 时返回内部事件，否则返回 undefined。
     */
    private parseSystemInitEvent(record: Record<string, unknown>): ParsedCliEvent | undefined {
        if (record.type !== 'system' || record.subtype !== 'init') return undefined;
        const sessionId = typeof record.session_id === 'string' ? record.session_id.trim() : '';
        const cwd = typeof record.cwd === 'string' ? record.cwd.trim() : this.process.getCwd();
        if (!sessionId) return { type: 'done' };
        return { type: 'session/init', sessionId, cwd };
    }

    /**
     * 上游可能出现的系统任务事件 subtype 白名单。
     *
     * 上游 SDK 在不同小版本里同时出现过紧凑写法（`taskstarted` / `tasknotification`）
     * 与带下划线写法（`task_started` / `task_notification`），此处一并接收，避免
     * 上游切换写法后任务事件原文漏到聊天区造成视觉噪声。
     */
    private static readonly SYSTEM_TASK_EVENT_SUBTYPES: ReadonlySet<string> = new Set([
        'taskstarted',
        'task_started',
        'tasknotification',
        'task_notification',
        'taskprogress',
        'task_progress',
        'compact_boundary',
    ]);

    private static readonly HIDDEN_CHAT_TOOL_NAMES: ReadonlySet<string> = new Set([
        'Agent',
        'Task',
        'EnterPlanMode',
        'ExitPlanMode'
    ]);

    /**
     * ask_expert 委托工具完整名集合。
     *
     * 由 in-process MCP server 注册到 Claude CLI 后，工具名按 MCP 命名规则
     * 被 CLI 重写为 `mcp__<server>__<tool>`，即 `mcp__askExpert__ask_expert`。
     * 本适配器命中该名称时不渲染普通工具卡片，改为发出 expert/subturn/* 事件。
     */
    private static readonly EXPERT_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
        'mcp__askExpert__ask_expert',
        'ask_expert'
    ]);

    /**
     * 已被拦截的 ask_expert tool_use_id 集合。
     *
     * 当后续 tool_result 命中其中一个 id 时，转换为 expert/subturn/finished 事件
     * 而非渲染普通 tool_result segment。
     */
    private readonly askExpertToolUseIds = new Set<string>();

    /**
     * 识别上游 stdout 中穿插的系统任务事件并静默丢弃。
     *
     * 命中以下两类事件（兼容紧凑写法与下划线写法）：
     * - `{"type":"system","subtype":"taskstarted" | "task_started", ...}`
     * - `{"type":"system","subtype":"tasknotification" | "task_notification", ...}`
     *
     * 这些事件由上游内部任务调度器发出，与终端用户的对话内容无关，曾经被当成
     * 未知 JSON 直接以原文降级显示在聊天区造成视觉噪声。现在直接返回空 segments
     * 让宿主静默忽略（{@link appendAssistantSegments} 已对 length===0 做了短路）。
     *
     * @param record CLI JSON 事件对象。
     * @returns 命中时返回空 segments 事件以丢弃，否则返回 undefined。
     */
    /** 识别 Claude CLI 原生压缩状态事件。 */
    private parseSystemStatusEvent(record: Record<string, unknown>): ParsedCliEvent | undefined {
        if (record.type !== 'system' || record.subtype !== 'status') return undefined;
        const status = record.status === 'compacting' ? 'compacting' : null;
        const compactResult = typeof record.compact_result === 'string' ? record.compact_result : undefined;
        if (status !== 'compacting' && !compactResult) return { type: 'segments', segments: [], done: false };
        return {
            type: 'compact/status',
            status,
            compactResult,
            sessionId: typeof record.session_id === 'string' ? record.session_id : undefined,
            uuid: typeof record.uuid === 'string' ? record.uuid : undefined
        };
    }

    private parseSystemTaskEvent(record: Record<string, unknown>): ParsedCliEvent | undefined {
        if (record.type !== 'system') return undefined;
        const subtype = typeof record.subtype === 'string' ? record.subtype : '';
        if (!StreamJsonCliAdapter.SYSTEM_TASK_EVENT_SUBTYPES.has(subtype)) return undefined;
        return { type: 'segments', segments: [], done: false };
    }

    /**
     * 兜底处理其余 system 事件（api_retry / task_updated 等未知 subtype）。
     *
     * 这些事件此前会命中「完全无法识别 → 原文降级」路径，把原始 JSON 直接打进
     * 聊天区。现在改为渲染成一个默认折叠的工具风格卡片：摘要行显示
     * `System · <subtype>`，点开后显示完整 JSON，既不丢信息也不刷屏。
     *
     * 注意：必须放在 init / status / task 三个精准 system 分支之后调用，
     * 只兜底剩余 subtype。
     *
     * @param record CLI JSON 事件对象。
     * @returns 命中 system 事件时返回折叠卡片 segment，否则返回 undefined。
     */
    private parseSystemGenericEvent(record: Record<string, unknown>): ParsedCliEvent | undefined {
        if (record.type !== 'system') return undefined;
        return { type: 'segments', segments: [this.buildSystemEventSegment(record)], done: false };
    }

    /**
     * 把一个 system 事件对象转成折叠工具卡片 segment。
     *
     * @param record system 事件对象。
     * @returns tool 类型的 ChatSegment。
     */
    private buildSystemEventSegment(record: Record<string, unknown>): ChatSegment {
        const subtype = typeof record.subtype === 'string' && record.subtype ? record.subtype : 'event';
        const uuid = typeof record.uuid === 'string' ? record.uuid : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return {
            id: `system_${subtype}_${uuid}`,
            kind: 'tool',
            tool: {
                name: 'System',
                status: 'success',
                summary: subtype,
                detail: JSON.stringify(record, null, 2),
                input: record
            }
        };
    }

    // -------------------------------------------------------------------------
    // 解析路径 2：Anthropic stream-json 主流程
    // -------------------------------------------------------------------------

    /**
     * 解析 Anthropic stream-json 事件，并维护 `currentMessage` 状态机。
     *
     * 该方法是 **重写后的核心路径**，对应官方 Claude Code 扩展处理 SSE 事件的语义：
     *
     * - `message_start`        ：初始化 messageState
     * - `content_block_start`  ：按 index 注册 block，并立即输出工具卡片占位
     * - `content_block_delta`  ：根据 delta.type 分发到 text/thinking/input_json
     * - `content_block_stop`   ：finalize 工具卡片（解析累积的 input_json）
     * - `message_delta`        ：忽略（usage / stop_reason 信息）
     * - `message_stop`         ：清空 messageState 并发出 `done`
     *
     * @param record CLI JSON 事件对象。
     * @returns 命中流式事件时返回内部事件，否则返回 undefined。
     */
    private parseAnthropicStreamEvent(record: Record<string, unknown>): ParsedCliEvent | undefined {
        const event = this.unwrapStreamEvent(record);
        if (!event) return undefined;

        switch (event.type) {
            case 'message_start':
                return this.handleMessageStart(event);
            case 'content_block_start':
                this.markCurrentMessageStreamed();
                return this.handleContentBlockStart(event);
            case 'content_block_delta':
                this.markCurrentMessageStreamed();
                return this.handleContentBlockDelta(event);
            case 'content_block_stop':
                return this.handleContentBlockStop(event);
            case 'message_delta':
                return { type: 'segments', segments: [], done: false };
            case 'message_stop':
                this.currentMessage = null;
                return { type: 'done' };
            default:
                return undefined;
        }
    }

    /**
     * 兼容直接事件与 `stream_event` 包装两种 Claude Code 输出形态。
     *
     * 形态 A：`{ type: "content_block_delta", index, delta }`
     * 形态 B：`{ type: "stream_event", event: { type: "content_block_delta", ... } }`
     * 形态 C：`{ type: "stream_event", event: "content_block_delta", data: {...} }`
     *
     * @param record CLI JSON 事件对象。
     * @returns 解包后的事件对象。
     */
    private unwrapStreamEvent(record: Record<string, unknown>): Record<string, unknown> | undefined {
        if (typeof record.type === 'string' && this.isStreamEventType(record.type)) return record;
        if (record.type !== 'stream_event') return undefined;
        const nested = record.event;
        if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
        if (typeof nested === 'string' && this.isStreamEventType(nested)) {
            const data =
                record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {};
            return { ...data, type: nested };
        }
        return undefined;
    }

    /**
     * 判断事件名是否属于 Anthropic stream-json 事件集合。
     *
     * @param type 事件 type 字段。
     * @returns 命中时返回 true。
     */
    private isStreamEventType(type: string): boolean {
        return (
            type === 'message_start' ||
            type === 'message_delta' ||
            type === 'message_stop' ||
            type === 'content_block_start' ||
            type === 'content_block_delta' ||
            type === 'content_block_stop'
        );
    }

    /**
     * 处理 `message_start`：初始化当前 message 状态机。
     *
     * @param event 已解包的事件。
     * @returns 空 segments 事件（仅用于占位，让消费方知道 CLI 已开始响应）。
     */
    private handleMessageStart(event: Record<string, unknown>): ParsedCliEvent {
        const message = event.message;
        const messageId =
            message && typeof message === 'object' && typeof (message as Record<string, unknown>).id === 'string'
                ? ((message as Record<string, unknown>).id as string)
                : '';
        this.currentMessage = { messageId, blocks: new Map() };
        return { type: 'segments', segments: [], done: false };
    }

    /**
     * 标记当前 message 已经走过流式增量渲染。
     *
     * 供后续聚合 `assistant` 事件判断是否需要跳过，避免同一内容渲染两遍。
     */
    private markCurrentMessageStreamed(): void {
        const messageId = this.currentMessage?.messageId;
        if (messageId) this.streamedMessageIds.add(messageId);
    }

    /**
     * 判断聚合 `assistant` 事件是否已被流式增量渲染过。
     *
     * @param message SDK 包装事件中的 message 对象。
     * @returns 已流式渲染过时返回 true，调用方应跳过整条聚合事件。
     */
    private isAlreadyStreamedMessage(message: Record<string, unknown>): boolean {
        const messageId = typeof message.id === 'string' ? message.id : '';
        return messageId.length > 0 && this.streamedMessageIds.has(messageId);
    }

    /**
     * 处理 `content_block_start`：注册新 block 状态，并对 tool_use 立即输出工具卡片占位。
     *
     * Anthropic SSE 的 content_block_start 形态：
     * ```json
     * { "type": "content_block_start", "index": 0,
     *   "content_block": { "type": "tool_use", "id": "toolu_...", "name": "Bash" } }
     * ```
     *
     * @param event 已解包的事件。
     * @returns 工具卡片占位（tool_use）或空 segments（text/thinking）。
     */
    private handleContentBlockStart(event: Record<string, unknown>): ParsedCliEvent {
        const index = this.extractBlockIndex(event);
        const block = event.content_block;
        if (!block || typeof block !== 'object') {
            return { type: 'segments', segments: [], done: false };
        }
        const blockRecord = block as Record<string, unknown>;
        const blockType = typeof blockRecord.type === 'string' ? blockRecord.type : 'unknown';

        const state: ContentBlockState = {
            type: this.normalizeBlockType(blockType),
            text: '',
            toolInputJson: ''
        };

        if (state.type === 'tool_use') {
            state.toolUseId = typeof blockRecord.id === 'string' ? blockRecord.id : undefined;
            state.toolName = typeof blockRecord.name === 'string' ? blockRecord.name : 'tool';
            this.registerBlockState(index, state);
            if (this.isHiddenChatToolName(state.toolName)) {
                if (state.toolUseId) this.hiddenToolUseIds.add(state.toolUseId);
                return { type: 'segments', segments: [], done: false };
            }
            if (this.isExpertDelegationToolName(state.toolName)) {
                if (state.toolUseId) this.askExpertToolUseIds.add(state.toolUseId);
                // 第一阶段：仅静默隐藏卡片，正式 expert/subturn/started 事件待
                // input_json_delta 累积完整 question 后在 content_block_stop 中发出。
                return { type: 'segments', segments: [], done: false };
            }

            const segment = this.buildInitialToolSegment(state);
            if (state.toolUseId) {
                this.toolSegmentById.set(state.toolUseId, segment);
            }
            return { type: 'segments', segments: [segment], done: false };
        }

        // text block 可能在 start 时就携带初始文本
        if (state.type === 'text' && typeof blockRecord.text === 'string' && blockRecord.text) {
            state.text = blockRecord.text;
            this.registerBlockState(index, state);
            const parsed = this.parseDisplayText(blockRecord.text);
            return parsed.type === 'segments' ? { ...parsed, done: false } : parsed;
        }

        this.registerBlockState(index, state);
        return { type: 'segments', segments: [], done: false };
    }

    /**
     * 处理 `content_block_delta`：根据 delta.type 分发到对应累积器。
     *
     * 支持的 delta.type：
     * - `text_delta`        ：assistant 文本增量
     * - `thinking_delta`    ：思考块增量
     * - `input_json_delta`  ：tool_use 入参增量，partial_json 累积为完整 JSON
     *
     * @param event 已解包的事件。
     * @returns segments 事件，含本次增量产生的 segment。
     */
    private handleContentBlockDelta(event: Record<string, unknown>): ParsedCliEvent {
        const index = this.extractBlockIndex(event);
        const delta = event.delta;
        if (!delta || typeof delta !== 'object') {
            return { type: 'segments', segments: [], done: false };
        }
        const deltaRecord = delta as Record<string, unknown>;
        const deltaType = typeof deltaRecord.type === 'string' ? deltaRecord.type : '';

        switch (deltaType) {
            case 'text_delta':
                return this.handleTextDelta(index, deltaRecord);
            case 'thinking_delta':
                return this.handleThinkingDelta(index, deltaRecord);
            case 'input_json_delta':
                return this.handleInputJsonDelta(index, deltaRecord);
            default:
                return { type: 'segments', segments: [], done: false };
        }
    }

    /**
     * 处理 text_delta：累积文本并通过 ChatParser 流式产出 markdown/code/diff/fileRef segments。
     *
     * @param index content block index。
     * @param delta delta 子对象。
     * @returns segments 事件。
     */
    private handleTextDelta(index: number, delta: Record<string, unknown>): ParsedCliEvent {
        const text = typeof delta.text === 'string' ? delta.text : '';
        if (!text) return { type: 'segments', segments: [], done: false };
        const block = this.ensureBlockState(index, 'text');
        block.text += text;
        const parsed = this.parseDisplayText(text);
        if (parsed.type === 'segments' && parsed.segments.length > 0) this.hasEmittedAssistantContent = true;
        return parsed.type === 'segments' ? { ...parsed, done: false } : parsed;
    }

    /**
     * 处理 thinking_delta：每次补写整块累积的思考文本，并带稳定 id，供 Webview
     * 按 id 原地替换，呈现为单个逐字增长的引用块而非每片一个 blockquote。
     *
     * 绕开 parseDisplayText：该函数会把文本喂进增量解析器并累积 parserState，
     * 重复投喂整块会污染解析状态。思考块是纯引用文本，直接产出 markdown segment。
     *
     * @param index content block index。
     * @param delta delta 子对象。
     * @returns segments 事件。
     */
    private handleThinkingDelta(index: number, delta: Record<string, unknown>): ParsedCliEvent {
        const text = typeof delta.thinking === 'string' ? delta.thinking : '';
        if (!text) return { type: 'segments', segments: [], done: false };
        const block = this.ensureBlockState(index, 'thinking');
        block.text += text;
        return {
            type: 'segments',
            segments: [{ id: `thinking:${index}`, kind: 'markdown', text: this.formatThinkingBlock(block.text) }],
            done: false
        };
    }

    /**
     * 处理 input_json_delta：累积 tool_use 入参 partial_json，并把已累积内容更新到工具卡片 detail。
     *
     * @param index content block index。
     * @param delta delta 子对象。
     * @returns segments 事件；含被复用更新的工具卡片 segment。
     */
    private handleInputJsonDelta(index: number, delta: Record<string, unknown>): ParsedCliEvent {
        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        if (!partial) return { type: 'segments', segments: [], done: false };
        const block = this.ensureBlockState(index, 'tool_use');
        if (this.isHiddenChatToolName(block.toolName)) return { type: 'segments', segments: [], done: false };
        if (block.toolInputJson.length + partial.length > TOOL_INPUT_JSON_MAX_LENGTH) {
            Logger.warn(`tool_use 入参累积超过 ${TOOL_INPUT_JSON_MAX_LENGTH}，已停止累积`);
            return { type: 'segments', segments: [], done: false };
        }
        block.toolInputJson += partial;

        const segment = block.toolUseId ? this.toolSegmentById.get(block.toolUseId) : undefined;
        if (!segment) return { type: 'segments', segments: [], done: false };

        // 在 detail 中实时呈现当前累积的 partial JSON（无法完整 parse 也展示原文）
        const prettyInput = this.tryFormatJson(block.toolInputJson) ?? block.toolInputJson;
        const parsedInput = this.tryParseJsonObject(block.toolInputJson);
        const toolName = block.toolName ?? 'tool';
        segment.tool = {
            ...(segment.tool ?? { name: toolName, status: 'running' }),
            name: toolName,
            status: 'running',
            summary: this.buildToolSummary(toolName, 'running'),
            detail: prettyInput,
            input: parsedInput ?? segment.tool?.input
        };
        segment.sourceText = prettyInput;
        return { type: 'segments', segments: [segment], done: false };
    }

    /**
     * 处理 `content_block_stop`：finalize 当前 block。
     *
     * 对于 tool_use 块：把累积的 partial_json 解析为对象并刷新工具卡片状态为 running。
     * tool_result 的最终成功/失败状态由配对的 tool_result 事件决定（见 parseSdkWrapperEvent）。
     *
     * @param event 已解包的事件。
     * @returns segments 事件。
     */
    private handleContentBlockStop(event: Record<string, unknown>): ParsedCliEvent {
        const index = this.extractBlockIndex(event);
        const block = this.currentMessage?.blocks.get(index);
        if (!block) return { type: 'segments', segments: [], done: false };

        // 文本块流式解析按整行产出，最后一行若没有换行符会滞留在 pendingLine 中；
        // 块结束时必须强制 flush，否则末行在聊天区缺失。
        if (block.type === 'text') {
            const tailSegments = flushParser(this.parserState);
            if (tailSegments.length > 0) this.hasEmittedAssistantContent = true;
            return { type: 'segments', segments: tailSegments, done: false };
        }

        if (block.type === 'tool_use' && block.toolUseId) {
            if (this.isHiddenChatToolName(block.toolName)) return { type: 'segments', segments: [], done: false };
            if (this.isExpertDelegationToolName(block.toolName) && this.askExpertToolUseIds.has(block.toolUseId)) {
                const question = this.extractAskExpertQuestion(block.toolInputJson);
                return {
                    type: 'expert/subturn/started',
                    toolUseId: block.toolUseId,
                    question
                };
            }
            const segment = this.toolSegmentById.get(block.toolUseId);
            if (segment) {
                const pretty = this.tryFormatJson(block.toolInputJson) ?? block.toolInputJson;
                const parsedInput = this.tryParseJsonObject(block.toolInputJson);
                const toolName = block.toolName ?? 'tool';
                segment.tool = {
                    ...(segment.tool ?? { name: toolName, status: 'running' }),
                    name: toolName,
                    status: 'running',
                    summary: this.buildToolSummary(toolName, 'running'),
                    detail: pretty,
                    input: parsedInput ?? segment.tool?.input
                };
                segment.sourceText = pretty;
                return { type: 'segments', segments: [segment], done: false };
            }
        }
        return { type: 'segments', segments: [], done: false };
    }

    /**
     * 在 currentMessage.blocks 中注册或覆盖一个 block 状态。
     *
     * @param index content block index。
     * @param state block 状态。
     */
    private registerBlockState(index: number, state: ContentBlockState): void {
        if (!this.currentMessage) {
            this.currentMessage = { messageId: '', blocks: new Map() };
        }
        this.currentMessage.blocks.set(index, state);
    }

    /**
     * 取得指定 index 的 block 状态；不存在时按预期类型新建一个。
     *
     * 这种"按需创建"策略可容忍 CLI 在 message_start/content_block_start 之前
     * 直接发 content_block_delta 的异常情况。
     *
     * @param index content block index。
     * @param expectedType 预期 block 类型。
     * @returns block 状态。
     */
    private ensureBlockState(index: number, expectedType: ContentBlockState['type']): ContentBlockState {
        if (!this.currentMessage) {
            this.currentMessage = { messageId: '', blocks: new Map() };
        }
        let block = this.currentMessage.blocks.get(index);
        if (!block) {
            block = { type: expectedType, text: '', toolInputJson: '' };
            this.currentMessage.blocks.set(index, block);
        }
        return block;
    }

    /**
     * 从事件对象中提取 content block 的 index 字段。
     *
     * @param event 已解包事件。
     * @returns block index，缺失时回退为 0。
     */
    private extractBlockIndex(event: Record<string, unknown>): number {
        return typeof event.index === 'number' ? event.index : 0;
    }

    /**
     * 把字符串 block type 收敛到内部状态枚举。
     *
     * @param raw 原始 type 字符串。
     * @returns 规范化后的内部枚举值。
     */
    private normalizeBlockType(raw: string): ContentBlockState['type'] {
        switch (raw) {
            case 'text':
            case 'thinking':
            case 'tool_use':
            case 'tool_result':
                return raw;
            default:
                return 'unknown';
        }
    }

    /**
     * 创建工具卡片初始 segment（用于 tool_use content block 启动时）。
     *
     * @param state tool_use block 状态。
     * @returns 工具卡片 segment。
     */
    private buildInitialToolSegment(state: ContentBlockState): ChatSegment {
        const name = state.toolName ?? 'tool';
        return {
            id: this.buildToolSegmentId(state.toolUseId),
            kind: 'tool',
            text: name,
            tool: {
                name,
                status: 'running',
                summary: this.buildToolSummary(name, 'running'),
                detail: '',
                input: undefined
            },
            sourceText: '',
            confidence: 'high'
        };
    }

    /**
     * 根据 tool_use_id 构造稳定的 segment ID。
     *
     * 该 ID 会写入 ChatSegment.id，宿主与 Webview 凭此识别"同一张工具卡片"，
     * 在多次更新中复用而非重复渲染。
     *
     * @param toolUseId Anthropic tool_use id；缺失时回退为时间戳 + 随机串。
     * @returns 稳定 segment ID。
     */
    private buildToolSegmentId(toolUseId: string | undefined): string {
        if (toolUseId && toolUseId.trim()) return `tool:${toolUseId}`;
        return `tool:anon:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * 构造工具卡片 summary 文本。
     *
     * `permission_denied` 状态会给出更口语化的中文提示，方便用户在聊天区一眼
     * 识别"模型尝试调用工具但被本地权限策略拒绝"的场景。
     *
     * @param name 工具名。
     * @param status 工具状态。
     * @returns summary 文本。
     */
    private buildToolSummary(
        name: string,
        status: 'pending' | 'running' | 'success' | 'failed' | 'permission_denied'
    ): string {
        if (status === 'permission_denied') return `${name} · 需要授权（已拦截）`;
        return `${name} · ${status}`;
    }

    private isHiddenChatToolName(name: string | undefined): boolean {
        return !!name && StreamJsonCliAdapter.HIDDEN_CHAT_TOOL_NAMES.has(name);
    }

    /**
     * 判断工具名是否是 ask_expert 委托工具（含 MCP 前缀变体）。
     *
     * Claude CLI 把 MCP 工具的完整名重写为 `mcp__<server>__<tool>`，所以这里
     * 同时匹配 `mcp__askExpert__ask_expert` 与裸名 `ask_expert`。
     *
     * @param name 工具名。
     * @returns 是否命中。
     */
    private isExpertDelegationToolName(name: string | undefined): boolean {
        return !!name && StreamJsonCliAdapter.EXPERT_DELEGATION_TOOL_NAMES.has(name);
    }

    /**
     * 给思考块文本加上"> 💭 "前缀，并保证以换行结尾，便于 Markdown 引用块渲染。
     *
     * 由于 thinking_delta 是流式增量，单次 chunk 不一定包含完整段落，这里以
     * 简单字符串前缀策略保证最终在 Webview 中呈现为带前缀的引用样式。
     *
     * @param text 原始 thinking 文本片段。
     * @returns 格式化后的文本。
     */
    private formatThinkingChunk(text: string): string {
        if (!text) return text;
        // 把内部换行转成行内空格，避免破坏引用块渲染（流式增量 thinking 段往往很短）
        const inlined = text.replace(/\r?\n/g, ' ');
        return `${THINKING_SEGMENT_PREFIX}${inlined}\n`;
    }

    /**
     * 把整块思考文本格式化为 Markdown 引用块（打字机路径专用）。
     *
     * 与按片处理的 formatThinkingChunk 不同，本方法用于「每次补写整块累积文本」
     * 的打字机路径：首行带 `> 💭 `，续行带 `> `，保证 Webview 的 renderMarkdown
     * 把它们合并成单个 blockquote 而非每片一个引用块。
     *
     * 空行输出裸 `>` 而非 `"> "`：Webview 渲染前会对每行 trim，带尾空格的 `"> "`
     * 会被还原成 `>`，两端保持一致可避免空行把思考块劈成多个 blockquote。
     *
     * @param text 已累积的完整思考文本。
     * @returns 可直接作为 markdown segment 的引用块文本。
     */
    private formatThinkingBlock(text: string): string {
        if (!text) return text;
        const lines = text.split(/\r?\n/);
        return lines
            .map((line, i) => {
                const prefix = i === 0 ? THINKING_SEGMENT_PREFIX : '> ';
                return line ? `${prefix}${line}` : prefix.trimEnd();
            })
            .join('\n');
    }

    /**
     * 将 assistant 文本里以 `<think>...</think>` 形式内联的"伪思考块"
     * 转换为与 Anthropic 原生 thinking 块视觉一致的引用块格式。
     *
     * 背景：部分 OpenAI-compatible 上游模型不会按 Anthropic 协议输出独立的
     * thinking 块，而是把模型内部思考写在普通 text 块里并用 `<think>...</think>`
     * 包起来。`<think>` 不是合法 HTML/Markdown 标签，会被 webview 的 markdown
     * 渲染器当成 raw HTML 处理，导致 `</think>` 之后的正文一并被吞掉无法渲染。
     *
     * 本方法在文本进入 ChatParser 之前做一次预处理：
     * - 匹配所有成对 `<think>...</think>`，去除标签，将思考内容套上 `> 💭 `
     *   引用块前缀，并在前后补空行保证 markdown 引用块独立成段。
     * - 未闭合的 `<think>` 视为思考块直到字符串结尾，避免残留裸标签影响渲染。
     * - 标签外的剩余文本原样保留，作为正常 markdown 输出。
     *
     * @param text 原始 assistant 文本（可能内联 `<think>...</think>`）。
     * @returns 已规范化、可直接交给 ChatParser 的 markdown 文本。
     */
    private normalizeInlineThinkBlocks(text: string): string {
        if (!text || (!text.includes('<think>') && !text.includes('</think>'))) return text;
        const PAIRED = /<think>([\s\S]*?)<\/think>/gi;
        let normalized = text.replace(PAIRED, (_match, inner: string) => {
            const formatted = this.formatThinkingChunk(inner ?? '');
            return `\n\n${formatted}\n`;
        });
        // 处理未闭合的开标签（罕见，但应避免裸标签泄漏到 webview）。
        const openIdx = normalized.toLowerCase().indexOf('<think>');
        if (openIdx >= 0) {
            const head = normalized.slice(0, openIdx);
            const rest = normalized.slice(openIdx + '<think>'.length);
            const formatted = this.formatThinkingChunk(rest);
            normalized = `${head}\n\n${formatted}\n`;
        }
        // 保证文本以换行结尾，避免下游 chunkMarkdown 把末尾正文留在 pendingLine
        // 缓冲里直到下次 flushParser 才输出（这是导致"</think> 之后正文不显示"的关键原因）。
        if (!normalized.endsWith('\n')) normalized += '\n';
        return normalized;
    }

    /**
     * 尝试美化 JSON 字符串；解析失败返回 undefined。
     *
     * @param raw JSON 字符串。
     * @returns 缩进 2 空格的 JSON，或 undefined。
     */
    private tryFormatJson(raw: string): string | undefined {
        if (!raw.trim()) return undefined;
        try {
            return JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
            return undefined;
        }
    }

    /**
     * 尝试把 JSON 字符串解析为对象；解析失败返回 undefined。
     *
     * 与 `tryFormatJson` 区分：本方法返回**结构化对象**，给前端按工具名读取
     * 具体字段（如 Bash 的 `command`、Edit 的 `old_string`）做差异化渲染使用。
     *
     * @param raw JSON 字符串。
     * @returns 解析后的对象/数组/原始值，或 undefined。
     */
    private tryParseJsonObject(raw: string): unknown {
        if (!raw.trim()) return undefined;
        try {
            return JSON.parse(raw);
        } catch {
            return undefined;
        }
    }

    // -------------------------------------------------------------------------
    // 解析路径 3：SDK 顶层包装事件
    // -------------------------------------------------------------------------

    /**
     * 解析 SDK 包装事件：`{ type: "assistant", message: {...} }`、`tool_use`、`tool_result`。
     *
     * Claude Code SDK 在 stream-json 之上提供了顶层包装，最典型的两类：
     *
     * 1. `{ type: "assistant", message: { content: [ {type:"text",text}, ... ] } }`
     * 2. `{ type: "user", message: { content: [ {type:"tool_result",tool_use_id,content,is_error}, ... ] } }`
     *
     * 第 1 类用于已经聚合完毕的 message（非流式），直接提取文本即可。
     * 第 2 类用于 tool_result 回填，需要按 tool_use_id 命中工具卡片。
     *
     * @param record CLI JSON 事件对象。
     * @returns 命中 SDK 包装时返回内部事件，否则返回 undefined。
     */
    private parseSdkWrapperEvent(record: Record<string, unknown>): ParsedCliEvent | undefined {
        const type = typeof record.type === 'string' ? record.type : '';

        // 直接出现的 tool_use / tool_result（非 SSE 形态，部分 CLI 模式下会这样发）
        if (type === 'tool_use' || type === 'tool_result') {
            return this.handleStandaloneToolBlock(record);
        }

        if (type !== 'assistant' && type !== 'user') return undefined;
        const message = record.message;
        if (!message || typeof message !== 'object') return undefined;

        // 启用 --include-partial-messages 后，CLI 会在流式增量之后补发同 id 的聚合
        // assistant 事件；此处直接跳过，避免正文与思考块重复渲染。
        if (type === 'assistant' && this.isAlreadyStreamedMessage(message as Record<string, unknown>)) {
            return { type: 'segments', segments: [], done: false };
        }

        const content = (message as Record<string, unknown>).content;
        if (!Array.isArray(content)) return undefined;

        const segments: ChatSegment[] = [];
        for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            const block = item as Record<string, unknown>;
            const blockType = typeof block.type === 'string' ? block.type : '';

            if (blockType === 'text' && typeof block.text === 'string' && block.text) {
                // 非流式完整文本：不能直接走增量 chunker，否则无换行短文本会留在 pendingLine
                // 中，直到进程 flush 才输出；这里应立即转换为可渲染片段。
                // 同时把上游用 <think>...</think> 形式内联的伪思考块预先转成 markdown 引用块，
                // 避免裸 HTML 标签让 webview 渲染器把 </think> 之后的正文一并吞掉。
                const normalized = this.normalizeInlineThinkBlocks(block.text);
                const parsed = this.parseCompleteDisplayText(normalized);
                if (parsed.type === 'segments') segments.push(...parsed.segments);
                if (parsed.type === 'segments' && parsed.segments.length > 0) this.hasEmittedAssistantContent = true;
                continue;
            }
            if (blockType === 'tool_use') {
                const toolName = typeof block.name === 'string' ? block.name : undefined;
                if (this.isHiddenChatToolName(toolName)) {
                    if (typeof block.id === 'string') this.hiddenToolUseIds.add(block.id);
                    continue;
                }
                if (this.isExpertDelegationToolName(toolName)) {
                    const toolUseId = typeof block.id === 'string' ? block.id : '';
                    if (toolUseId) this.askExpertToolUseIds.add(toolUseId);
                    const question = this.extractAskExpertQuestionFromInput(block.input);
                    // 注意：parseSdkWrapperEvent 返回的是 segments 事件，无法直接发出独立的
                    // expert/subturn/started。这里用 ad-hoc sourceText 编码 expert event 信息
                    // 由 extension.ts 端通过订阅 onParsed 后用一个监听切片识别。
                    // 简化起见：直接通过 emitter 旁路发出 expert/subturn/started。
                    this.emitAdHoc({
                        type: 'expert/subturn/started',
                        toolUseId,
                        question
                    });
                    continue;
                }
                const segment = this.buildSegmentFromCompleteToolUse(block);
                segments.push(segment);
                continue;
            }
            if (blockType === 'tool_result') {
                const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                if (toolUseId && this.askExpertToolUseIds.has(toolUseId)) {
                    const content = this.stringifyToolResultContent(block.content);
                    const isError = block.is_error === true;
                    this.askExpertToolUseIds.delete(toolUseId);
                    this.emitAdHoc({
                        type: 'expert/subturn/finished',
                        toolUseId,
                        content,
                        isError
                    });
                    continue;
                }
                const segment = this.applyToolResult(block);
                if (segment) segments.push(segment);
                continue;
            }
            if (blockType === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
                const formatted = this.formatThinkingChunk(block.thinking);
                const parsed = parseChunk(this.parserState, { source: 'stdout', text: formatted });
                this.parserState = parsed.state;
                segments.push(...parsed.segments);
            }
        }

        return { type: 'segments', segments, done: false };
    }

    /**
     * 解析 CLI 最终 result 事件。
     *
     * 部分 OpenAI/Responses 转换链路会同时输出：
     * 1. 顶层 `assistant` 事件（含 message.content 文本）；
     * 2. 顶层 `result` 事件（含聚合后的 result 字符串 + usage / modelUsage）。
     *
     * 正常情况下 assistant 事件已经渲染正文，result 只负责结束；但如果上游没有发
     * assistant 文本，或者非流式文本被缓存导致未输出，直接把 result 当 done 会让
     * 聊天区为空。因此这里在 `result` 字段存在时先输出正文，并将同一事件标记为
     * done，让宿主在 patch 后立即结束 pending 状态。
     *
     * 同时，CLI 的 result 事件携带的 `usage` / `modelUsage` 是本轮回复**最终、
     * 权威**的 token 统计——它由 CLI 自己聚合所有上游响应得出，比 Relay 拿到的
     * 中间结果更准，也更适合"和最后一条消息一起显示"的需求。本方法会把它转换
     * 为 `kind:'usage'` 的 ChatSegment 一并附在 segments 末尾，与最终 done 在同
     * 一帧到达，不会与等待动画/正文输出错序。
     *
     * @param record CLI JSON result 事件对象。
     * @returns 带正文+usage 的 segments 完成事件，或纯 done 事件。
     */
    private parseResultEvent(record: Record<string, unknown>): ParsedCliEvent {
        const text = typeof record.result === 'string' ? record.result : '';
        const usageSegment = this.buildUsageSegmentFromResult(record);
        // 优先把已有正文与 usage 合并到同一帧返回。
        const tailSegments: ChatSegment[] = [];
        if (text) {
            // result.result 兜底渲染时也要先把 <think>...</think> 转成引用块，
            // 与 parseSdkWrapperEvent 中的 text 分支保持一致的渲染行为。
            const normalized = this.normalizeInlineThinkBlocks(text);
            const parsed = this.hasEmittedAssistantContent
                ? this.parseDisplayTextIfMissingFromTail(normalized)
                : this.parseCompleteDisplayText(normalized);
            if (parsed.type === 'segments' && parsed.segments.length > 0) {
                this.hasEmittedAssistantContent = true;
                tailSegments.push(...parsed.segments);
            }
        }
        if (usageSegment) tailSegments.push(usageSegment);
        if (tailSegments.length === 0) return { type: 'done' };
        return { type: 'segments', segments: tailSegments, done: true };
    }

    /**
     * 在最终 result 帧中为已流式输出过的正文做一次轻量兜底解析。
     *
     * Claude CLI 的最终 `result` 事件通常只需要补 usage；但在 OpenAI Responses
     * 转换链路下，主聊天区可能已收到中间 assistant 文本，最后一帧却只携带
     * `usage+done`。某些 Webview 增量替换/重绘路径会让最后一段短文本在视觉上
     * 丢失，因此这里在最终 `record.result` 与最近一次 assistant 文本不完全重复时，
     * 再追加一次 Markdown 兜底片段，确保用户最终答案一定可见。
     *
     * @param text CLI result.result 的规范化文本。
     * @returns 需要补渲染的 segments；若判断为重复则返回空 segments。
     */
    private parseDisplayTextIfMissingFromTail(text: string): ParsedCliEvent {
        const normalizedText = text.trim();
        if (!normalizedText) return { type: 'segments', segments: [] };
        const recentText = this.recentAssistantText.trim();
        if (recentText.endsWith(normalizedText)) return { type: 'segments', segments: [] };
        return this.parseCompleteDisplayText(text);
    }

    /**
     * 从 CLI result 事件中抽取 token 统计并构造 usage segment。
     *
     * 字段优先级：
     * - 模型名：`modelUsage` 第一个 key（形如 `provider/model`）> `record.model`；
     * - token：`record.usage.{input_tokens,output_tokens,cache_creation_input_tokens,
     *   cache_read_input_tokens}`，缺失时从 `modelUsage` 第一项的
     *   `{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens}`
     *   兜底，保证 OpenAI 转换链路也能取到非零值。
     *
     * 任一 token 字段存在即返回 segment；全部缺失返回 undefined，避免渲染空行。
     *
     * @param record CLI JSON result 事件对象。
     * @returns kind:'usage' segment，或 undefined。
     */
    private buildUsageSegmentFromResult(record: Record<string, unknown>): ChatSegment | undefined {
        const usageRaw = record.usage as Record<string, unknown> | undefined;
        const modelUsage = record.modelUsage as Record<string, Record<string, unknown>> | undefined;
        const modelUsageEntry = modelUsage ? Object.entries(modelUsage)[0] : undefined;
        const modelUsageKey = modelUsageEntry?.[0];
        const modelUsageVal = modelUsageEntry?.[1];

        // 模型名：modelUsage key 中冒号后的部分通常是真实 model id；否则尝试 record.model。
        const inferredModel =
            (modelUsageKey?.includes('/') ? modelUsageKey.split('/').slice(1).join('/') : modelUsageKey) ||
            (typeof record.model === 'string' ? record.model : undefined);

        const pickNumber = (...candidates: unknown[]): number | undefined => {
            for (const c of candidates) {
                if (typeof c === 'number' && Number.isFinite(c)) return c;
            }
            return undefined;
        };

        const inputTokens = pickNumber(usageRaw?.input_tokens, modelUsageVal?.inputTokens);
        const outputTokens = pickNumber(usageRaw?.output_tokens, modelUsageVal?.outputTokens);
        const cacheCreationInputTokens = pickNumber(
            usageRaw?.cache_creation_input_tokens,
            modelUsageVal?.cacheCreationInputTokens
        );
        const cacheReadInputTokens = pickNumber(
            usageRaw?.cache_read_input_tokens,
            modelUsageVal?.cacheReadInputTokens
        );
        const contextWindow = pickNumber(modelUsageVal?.contextWindow);

        if (
            inputTokens === undefined &&
            outputTokens === undefined &&
            cacheCreationInputTokens === undefined &&
            cacheReadInputTokens === undefined
        ) {
            return undefined;
        }

        const messageId = this.currentMessage?.messageId;
        const segmentId = messageId ? `usage-${messageId}` : `usage-${Date.now()}`;
        return {
            id: segmentId,
            kind: 'usage',
            usage: {
                model: inferredModel,
                inputTokens,
                outputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
                contextWindow
            }
        };
    }

    /**
     * 处理顶层直接出现的 tool_use / tool_result 事件（部分 CLI 模式不走 SDK 包装）。
     *
     * @param record JSON 事件对象。
     * @returns segments 事件。
     */
    private handleStandaloneToolBlock(record: Record<string, unknown>): ParsedCliEvent {
        const type = record.type === 'tool_result' ? 'tool_result' : 'tool_use';
        if (type === 'tool_use') {
            const toolName = typeof record.name === 'string' ? record.name : undefined;
            if (this.isHiddenChatToolName(toolName)) {
                if (typeof record.id === 'string') this.hiddenToolUseIds.add(record.id);
                return { type: 'segments', segments: [], done: false };
            }
            if (this.isExpertDelegationToolName(toolName)) {
                const toolUseId = typeof record.id === 'string' ? record.id : '';
                if (toolUseId) this.askExpertToolUseIds.add(toolUseId);
                const question = this.extractAskExpertQuestionFromInput(record.input);
                return {
                    type: 'expert/subturn/started',
                    toolUseId,
                    question
                };
            }
            const segment = this.buildSegmentFromCompleteToolUse(record);
            return { type: 'segments', segments: [segment], done: false };
        }
        const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : '';
        if (toolUseId && this.askExpertToolUseIds.has(toolUseId)) {
            const content = this.stringifyToolResultContent(record.content);
            const isError = record.is_error === true;
            this.askExpertToolUseIds.delete(toolUseId);
            return {
                type: 'expert/subturn/finished',
                toolUseId,
                content,
                isError
            };
        }
        const segment = this.applyToolResult(record);
        return { type: 'segments', segments: segment ? [segment] : [], done: false };
    }

    /**
     * 根据一个完整 tool_use block 构造工具卡片 segment，并登记到 toolSegmentById。
     *
     * @param block tool_use 内容块。
     * @returns 工具卡片 segment。
     */
    private buildSegmentFromCompleteToolUse(block: Record<string, unknown>): ChatSegment {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        const id = typeof block.id === 'string' ? block.id : undefined;
        const inputValue = block.input;
        const inputPretty = this.tryStringifyValue(inputValue);
        const segment: ChatSegment = {
            id: this.buildToolSegmentId(id),
            kind: 'tool',
            text: name,
            tool: {
                name,
                status: 'running',
                summary: this.buildToolSummary(name, 'running'),
                detail: inputPretty,
                input: inputValue
            },
            sourceText: inputPretty,
            confidence: 'high'
        };
        if (id) this.toolSegmentById.set(id, segment);
        return segment;
    }

    /**
     * 把 tool_result 回填到匹配的工具卡片，未找到时创建新卡片。
     *
     * 特别处理：当 result 文本命中"需要授权"模式时（例如 Claude CLI 在
     * `--bare --print` 非交互模式下返回的 `This command requires approval` /
     * `Output redirection ... was blocked` 等），把卡片状态标记为 `permission_denied`
     * 并补充更易读的 summary，提示用户调整 `chat.permissionMode` 配置或在 VS Code
     * 终端中手动执行。
     *
     * @param block tool_result 内容块。
     * @returns 已更新或新建的工具卡片 segment；无任何有效内容时返回 undefined。
     */
    private applyToolResult(block: Record<string, unknown>): ChatSegment | undefined {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        if (toolUseId && this.hiddenToolUseIds.has(toolUseId)) return undefined;
        if (toolUseId && this.askExpertToolUseIds.has(toolUseId)) {
            // ask_expert 的 tool_result 由 cliAdapter 通过单独的 expert/subturn/finished
            // 事件回写（见 parseSdkWrapperEvent 的内联拦截）；这里返回 undefined 避免
            // 渲染成普通工具结果卡片。
            this.askExpertToolUseIds.delete(toolUseId);
            return undefined;
        }
        const isError = block.is_error === true;
        const resultText = this.stringifyToolResultContent(block.content);
        const isPermissionDenied = isError && this.isPermissionDeniedMessage(resultText);
        const status: 'success' | 'failed' | 'permission_denied' = isPermissionDenied
            ? 'permission_denied'
            : isError
                ? 'failed'
                : 'success';

        // 命中权限拦截时，触发一次面向用户的 VS Code 通知（节流由
        // notifyPermissionDeniedOnce 内部处理，避免短时间内大量重试导致弹窗刷屏）。
        if (isPermissionDenied) {
            this.notifyPermissionDeniedOnce(resultText);
        }

        let segment = toolUseId ? this.toolSegmentById.get(toolUseId) : undefined;
        if (!segment) {
            // 找不到配对的 tool_use：作为孤立结果卡片输出
            segment = {
                id: this.buildToolSegmentId(toolUseId),
                kind: 'tool',
                text: 'tool_result',
                tool: {
                    name: 'tool_result',
                    status,
                    summary: this.buildToolSummary('tool_result', status),
                    detail: resultText,
                    resultText,
                    isError
                },
                sourceText: resultText,
                confidence: 'medium'
            };
            if (toolUseId) this.toolSegmentById.set(toolUseId, segment);
            return segment;
        }

        const previousTool = segment.tool ?? { name: 'tool', status };
        const name = previousTool.name ?? 'tool';
        // 保留 input，把 result 单独放到 resultText；detail 仍是 input 的 pretty JSON（前端会自行特化展示）
        segment.tool = {
            name,
            status,
            summary: this.buildToolSummary(name, status),
            detail: previousTool.detail ?? '',
            input: previousTool.input,
            resultText,
            isError
        };
        // sourceText 仍保留为完整文本（input + result），方便复制
        segment.sourceText = previousTool.detail
            ? `${previousTool.detail}\n\n---\n${resultText}`
            : resultText;
        return segment;
    }

    /**
     * 判断 tool_result 文本是否属于"需要授权"的拦截信息。
     *
     * 当前覆盖 Claude CLI 在非交互模式下常见的几种拦截文案：
     *  - `This command requires approval`（执行类命令需要确认）
     *  - `Output redirection ... was blocked`（写文件被工作目录限制拦截）
     *  - `<tool_use_error>` 包装的 permission 相关错误
     *
     * @param text 拍平后的 tool_result 文本。
     * @returns 命中需要授权场景时返回 true。
     */
    private isPermissionDeniedMessage(text: string): boolean {
        if (!text) return false;
        const lower = text.toLowerCase();
        return (
            lower.includes('requires approval') ||
            lower.includes('requires permission') ||
            lower.includes('permission denied') ||
            lower.includes('was blocked') ||
            lower.includes('blocked for security')
        );
    }

    /**
     * 仅在距离上一次通知超过节流阈值时弹出 VS Code 警告，避免一次回合内大量重试
     * 触发多次相同弹窗。
     *
     * 实际通知由 onPermissionDenied 回调处理（由宿主在创建 adapter 时注入），
     * 这里只负责节流。
     *
     * @param resultText 触发本次通知的 tool_result 文本，会原样作为详情传给宿主。
     */
    private notifyPermissionDeniedOnce(resultText: string): void {
        const now = Date.now();
        if (now - this.lastPermissionDeniedNotifyAt < PERMISSION_DENIED_NOTIFY_INTERVAL_MS) return;
        this.lastPermissionDeniedNotifyAt = now;
        try {
            this.onPermissionDenied?.(resultText);
        } catch (err) {
            Logger.warn('权限拦截通知回调抛错', err);
        }
    }

    /**
     * 把 tool_result.content 拍平为可读字符串。
     *
     * Anthropic tool_result.content 可能是字符串、文本块数组，或更复杂结构。
     *
     * @param content tool_result.content 字段。
     * @returns 纯文本表示。
     */
    private stringifyToolResultContent(content: unknown): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((item) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item === 'object') {
                        const block = item as Record<string, unknown>;
                        if (typeof block.text === 'string') return block.text;
                    }
                    return this.tryStringifyValue(item);
                })
                .filter((line) => line.length > 0)
                .join('\n');
        }
        return this.tryStringifyValue(content);
    }

    /**
     * 把任意值安全转为字符串（JSON 失败时回退为 String()）。
     *
     * @param value 任意值。
     * @returns 字符串表示。
     */
    private tryStringifyValue(value: unknown): string {
        if (value === undefined || value === null) return '';
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }

    // -------------------------------------------------------------------------
    // 解析路径 5：未知工具事件的宽松降级
    // -------------------------------------------------------------------------

    /**
     * 宽松识别 CLI JSON 中的工具事件（非标准形态的兜底）。
     *
     * 与 `parseSdkWrapperEvent` 的区别：此处不要求 type 属于 SDK 已知集合，只要
     * type 字段包含 "tool" 字眼，或属于历史遗留的 function_call/function_result
     * 形态，都尝试构造一张工具卡片。
     *
     * @param record CLI JSON 事件对象。
     * @returns 命中时返回 tool segment，否则返回 undefined。
     */
    private parseLooseToolEvent(record: Record<string, unknown>): ChatSegment | undefined {
        const type = typeof record.type === 'string' ? record.type : '';
        const isToolEvent = type.includes('tool') || type === 'function_call' || type === 'function_result';
        if (!isToolEvent) return undefined;

        const name = this.extractLooseToolName(record);
        if (this.isHiddenChatToolName(name)) {
            const looseId =
                typeof record.id === 'string' ? record.id :
                typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
            if (looseId) this.hiddenToolUseIds.add(looseId);
            return undefined;
        }
        const status = this.extractLooseToolStatus(record);
        const detail = this.tryStringifyValue(record);
        const looseId =
            typeof record.id === 'string' ? record.id :
            typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
        // 宽松路径下无法精确区分 input/result，整体 record 一并写入 input 供前端兜底展示
        return {
            id: this.buildToolSegmentId(looseId),
            kind: 'tool',
            text: name,
            tool: {
                name,
                status,
                summary: this.extractLooseToolSummary(record, name, status),
                detail,
                input: record
            },
            sourceText: detail,
            confidence: 'medium'
        };
    }

    /**
     * 从未知工具事件中提取工具名称。
     *
     * @param record JSON 事件对象。
     * @returns 工具名称。
     */
    private extractLooseToolName(record: Record<string, unknown>): string {
        if (typeof record.name === 'string') return record.name;
        if (typeof record.tool_name === 'string') return record.tool_name;
        if (typeof record.toolName === 'string') return record.toolName;
        const tool = record.tool;
        if (tool && typeof tool === 'object' && typeof (tool as Record<string, unknown>).name === 'string') {
            return (tool as Record<string, string>).name;
        }
        return typeof record.type === 'string' ? record.type : 'tool';
    }

    /**
     * 从未知工具事件中提取状态。
     *
     * @param record JSON 事件对象。
     * @returns 规范化工具状态。
     */
    private extractLooseToolStatus(
        record: Record<string, unknown>
    ): 'pending' | 'running' | 'success' | 'failed' {
        const status = String(record.status ?? record.state ?? record.type ?? '').toLowerCase();
        if (status.includes('error') || status.includes('fail')) return 'failed';
        if (status.includes('success') || status.includes('result') || status.includes('complete')) return 'success';
        if (status.includes('start') || status.includes('running') || status.includes('use')) return 'running';
        return 'pending';
    }

    /**
     * 构造未知工具事件的 summary 文本。
     *
     * @param record JSON 事件对象。
     * @param name 工具名称。
     * @param status 工具状态。
     * @returns summary 文本。
     */
    private extractLooseToolSummary(
        record: Record<string, unknown>,
        name: string,
        status: 'pending' | 'running' | 'success' | 'failed'
    ): string {
        if (typeof record.summary === 'string') return record.summary;
        if (typeof record.message === 'string') return record.message;
        return `${name} · ${status}`;
    }

    // -------------------------------------------------------------------------
    // 解析路径 6：纯文本字段降级
    // -------------------------------------------------------------------------

    /**
     * 从常见 stream-json 事件形态中尽力提取文本（最后的兜底）。
     *
     * @param record JSON 事件对象。
     * @returns 可显示文本，未命中时为空字符串。
     */
    private extractTextFallback(record: Record<string, unknown>): string {
        if (typeof record.text === 'string') return record.text;
        if (typeof record.delta === 'string') return record.delta;
        if (typeof record.result === 'string') return record.result;
        const delta = record.delta;
        if (delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>).text === 'string') {
            return (delta as Record<string, string>).text;
        }
        const message = record.message;
        if (message && typeof message === 'object') {
            return this.extractTextFromMessageContent(message as Record<string, unknown>);
        }
        return '';
    }

    /**
     * 从 message.content 数组中提取文本块（用于 fallback 路径）。
     *
     * @param message JSON 事件中的 message 对象。
     * @returns 拼接后的文本。
     */
    private extractTextFromMessageContent(message: Record<string, unknown>): string {
        const content = message.content;
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content
            .map((item) => {
                if (!item || typeof item !== 'object') return '';
                const block = item as Record<string, unknown>;
                return typeof block.text === 'string' ? block.text : '';
            })
            .join('');
    }

    // -------------------------------------------------------------------------
    // 文本降级 + 日志辅助
    // -------------------------------------------------------------------------

    /**
     * 使用 ChatParser 解析需要显示到 Webview 的普通文本。
     *
     * @param text 待解析文本。
     * @returns segments 事件。
     */
    private parseDisplayText(text: string): ParsedCliEvent {
        return this.parseDisplayTextInternal(text, false);
    }

    /**
     * 解析一段已完整到达的 assistant 文本，并强制刷新尾部半行。
     *
     * 非流式 SDK wrapper 事件和最终 `result.result` 都是完整文本。如果文本中包含
     * 换行但最后一行没有换行符，普通流式解析会把最后一行留在 `pendingLine`，
     * 等下一帧再输出；当下一帧只有 usage/done 时，尾部短文本（例如数字 `1`）就会
     * 在聊天区缺失。因此完整文本路径必须在本次解析结束后立即 flush。
     *
     * @param text 已完整到达的文本。
     * @returns segments 事件。
     */
    private parseCompleteDisplayText(text: string): ParsedCliEvent {
        return this.parseDisplayTextInternal(text, true);
    }

    /**
     * 解析可见文本的内部实现。
     *
     * @param text 待解析文本。
     * @param forceFlushTail 是否强制刷新尾部未换行的半行。
     * @returns segments 事件。
     */
    private parseDisplayTextInternal(text: string, forceFlushTail: boolean): ParsedCliEvent {
        const stripped = this.stripEmbeddedSystemTaskEvents(text);
        text = stripped.text;
        if (!text) {
            return { type: 'segments', segments: stripped.systemSegments, done: false };
        }
        this.rememberAssistantText(text);
        const parsed = parseChunk(this.parserState, { source: 'stdout', text });
        this.parserState = parsed.state;
        const segments = [...stripped.systemSegments, ...parsed.segments];
        if (forceFlushTail) {
            const tailSegments = flushParser(this.parserState);
            if (tailSegments.length > 0) segments.push(...tailSegments);
        }
        return { type: 'segments', segments };
    }

    /**
     * 从可见 assistant 文本中移除嵌入的上游 system 事件 JSON。
     *
     * 有些上游代理不会把 system 事件作为顶层 stream-json 事件发送，而是把它们
     * 混入 assistant text 中（可能多段紧贴、无换行）。顶层解析路径无法命中这种
     * 形态，因此在 markdown 解析前再做一层过滤：
     *
     * - 任务调度类 subtype（taskstarted / tasknotification 等）→ 静默丢弃；
     * - 其余 subtype（api_retry / task_updated 等）→ 转成折叠 System 卡片
     *   segment 返回，避免原始 JSON 刷进聊天区。
     *
     * 实现细节：通过正则定位 `{"type":"system"` 起始位置，再用括号配对扫描到
     * 匹配的右花括号，整段连同紧随的一个换行符一起切除。
     *
     * @param text 待过滤的可见文本。
     * @returns 过滤后的文本与提取出的 System 卡片 segments。
     */
    private stripEmbeddedSystemTaskEvents(text: string): { text: string; systemSegments: ChatSegment[] } {
        if (!text) return { text, systemSegments: [] };
        const marker = /\{[^{}]*?"type"\s*:\s*"system"[^{}]*?"subtype"\s*:\s*"/g;
        if (!marker.test(text)) return { text, systemSegments: [] };
        marker.lastIndex = 0;
        let out = '';
        let cursor = 0;
        const systemSegments: ChatSegment[] = [];
        let match: RegExpExecArray | null;
        while ((match = marker.exec(text)) !== null) {
            const start = match.index;
            if (start < cursor) { marker.lastIndex = cursor; continue; }
            const end = this.findJsonObjectEnd(text, start);
            if (end < 0) break;
            const rawJson = text.slice(start, end + 1);
            let record: Record<string, unknown> | undefined;
            try {
                const parsed = JSON.parse(rawJson);
                if (parsed && typeof parsed === 'object') record = parsed as Record<string, unknown>;
            } catch {
                // 非法 JSON（如恰好长得像的普通文本）→ 保留原文不切除。
            }
            if (!record || record.type !== 'system') {
                out += text.slice(cursor, end + 1);
                cursor = end + 1;
                marker.lastIndex = cursor;
                continue;
            }
            out += text.slice(cursor, start);
            cursor = end + 1;
            if (text[cursor] === '\n') cursor += 1;
            marker.lastIndex = cursor;
            const subtype = typeof record.subtype === 'string' ? record.subtype : '';
            if (!StreamJsonCliAdapter.SYSTEM_TASK_EVENT_SUBTYPES.has(subtype)) {
                systemSegments.push(this.buildSystemEventSegment(record));
            }
        }
        out += text.slice(cursor);
        return { text: out, systemSegments };
    }

    /**
     * 从 `start` 位置开始按括号配对扫描，返回与之配对的右花括号下标。
     *
     * 支持字符串字面量与转义，跳过字符串内部的花括号。仅在外层 JSON 对象未闭合时
     * 返回 -1。
     *
     * @param text 原始文本。
     * @param start 左花括号下标，调用前应保证 `text[start] === '{'`。
     * @returns 匹配的右花括号下标，未闭合返回 -1。
     */
    private findJsonObjectEnd(text: string, start: number): number {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    /**
     * 记录最近一轮 assistant 可见文本，供最终 result 事件判断是否重复。
     *
     * 只保留尾部一小段（按 Unicode code point 计 8000 个），避免长会话或大段输出
     * 占用额外内存；去重只需要判断 `record.result` 是否已经出现在最近尾部即可。
     *
     * 注意：使用扩展运算符 `[...str]` 按 code point 切分而不是 `String.prototype.slice`，
     * 后者按 UTF-16 code unit 切分，对中日韩 + emoji 等代理对字符可能在中间截断，
     * 导致拼接出非法 UTF-16 序列并让后续 result 去重哈希出现奇怪的 mismatch。
     *
     * @param text 本次即将显示到聊天区的文本片段。
     */
    private rememberAssistantText(text: string): void {
        if (!text) return;
        const combined = this.recentAssistantText + text;
        const limit = 8000;
        const codePoints = Array.from(combined);
        this.recentAssistantText = codePoints.length > limit
            ? codePoints.slice(-limit).join('')
            : combined;
    }

    /**
     * 广播解析事件。
     *
     * @param event 待广播事件。
     */
    private emitParsed(event: ParsedCliEvent): void {
        this.emitter.emit(EVENT_PARSED, event);
    }

    /**
     * 旁路 emit 一个 ParsedCliEvent；用于在 segments 主循环中插入独立事件
     * （例如 expert/subturn/started）而不打断本帧的 segments 返回值。
     *
     * @param event 待广播事件。
     */
    private emitAdHoc(event: ParsedCliEvent): void {
        this.emitter.emit(EVENT_PARSED, event);
    }

    /**
     * 从 ask_expert tool_use 的累积 partial_json 中抽取 `question` 字段。
     *
     * 失败时返回空字符串；调用方可在 expert/subturn/started 后再次校验。
     *
     * @param raw 累积的 partial_json 字符串。
     * @returns question 文本。
     */
    private extractAskExpertQuestion(raw: string): string {
        if (!raw) return '';
        const parsed = this.tryParseJsonObject(raw);
        if (parsed && typeof (parsed as Record<string, unknown>).question === 'string') {
            return ((parsed as Record<string, unknown>).question as string).trim();
        }
        return '';
    }

    /**
     * 从 SDK 完整 input 对象抽取 ask_expert 的 question 字段。
     *
     * @param input 已解析的 tool_use.input 对象。
     * @returns question 文本。
     */
    private extractAskExpertQuestionFromInput(input: unknown): string {
        if (input && typeof input === 'object' && !Array.isArray(input)) {
            const q = (input as Record<string, unknown>).question;
            if (typeof q === 'string') return q.trim();
        }
        return '';
    }
}
