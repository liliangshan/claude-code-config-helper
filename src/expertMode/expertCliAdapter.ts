/**
 * @file ExpertCliProcessHost：把扩展宿主里现有的 CliProcess + StreamJsonCliAdapter
 * 适配成 {@link ExpertCliProcessLike} 接口，供 {@link ExpertRunner} 驱动。
 *
 * 设计要点（方案 3）：
 *
 * 1. 专家 CLI 必须是「扩展宿主的直接子进程」——只有这样，stream 事件才能直接
 *    通过 `ChatViewHost.postMessage` 推送到 webview，无需走孙进程 → 父进程的
 *    IPC 链。本类负责持有该子进程实例。
 * 2. 不重复实现 Claude stream-json 解析协议——直接复用主对话已有的
 *    `StreamJsonCliAdapter`，订阅它解析后的 {@link ParsedCliEvent}，再做一次
 *    轻量转换映射到 {@link ExpertStreamEvent}。
 * 3. 收尾时确保 CLI 子进程被释放（disposing CliProcess 内部会发 SIGINT/kill），
 *    防止「专家 run 已结束但子进程仍在后台跑」的资源泄露。
 *
 * 注意：本文件中所有的对外 API 都以 Chinese JSDoc 注释，保持与项目其他文件
 * 一致的风格。
 */

import * as vscode from 'vscode';

import { CliProcess } from '../chat/cli/cliProcess';
import { StreamJsonCliAdapter } from '../chat/cli/cliAdapter';
import type { ParsedCliEvent } from '../chat/cli/cliAdapter';
import type { ChatCliConfig } from '../chat/cli/types';
import type { ChatSegment } from '../chat/protocol';
import type {
    ExpertCliProcessLike,
    ExpertStreamEvent
} from './expertRunner';
import { Logger } from '../logger';

/**
 * ExpertCliProcessHost：单次专家 run 期间持有的 CliProcess + Adapter 组合。
 *
 * 生命周期：由 {@link ExpertRunnerService} 在每次 run 之前 `new`，run 结束
 * （正常 / 异常 / 超时 / 取消）后调用 {@link dispose}。**不复用**——避免
 * 多个并发 run 状态相互污染。
 */
export class ExpertCliProcessHost implements ExpertCliProcessLike {
    /** 底层 Claude CLI 子进程。 */
    private readonly cli: CliProcess;
    /** stream-json 适配器（持有 CLI 输出的解析状态机）。 */
    private readonly adapter: StreamJsonCliAdapter;
    /** 已订阅的内部 disposable 列表，dispose 时统一释放。 */
    private readonly internalDisposables: vscode.Disposable[] = [];

    /** 事件监听器集合（多个 ExpertRunner 内部模块可同时订阅）。 */
    private readonly eventListeners = new Set<(event: ExpertStreamEvent) => void>();
    /** 退出监听器集合。 */
    private readonly exitListeners = new Set<() => void>();

    /**
     * 已经为某个 tool_use_id 推送过 `tool_use` 事件的集合，
     * 用于避免在流式 input_json_delta 累积过程中反复 emit tool_use。
     */
    private readonly emittedToolUseIds = new Set<string>();
    /**
     * 已经为某个 tool_use_id 推送过 `tool_result` 事件的集合，
     * 用于避免同一 tool 卡片在 segments patch 多次时重复 emit。
     */
    private readonly emittedToolResultIds = new Set<string>();

    /** 是否已经 dispose，防止重复释放。 */
    private disposed = false;

    /**
     * 创建 ExpertCliProcessHost。
     *
     * 构造时只准备空壳；真正的 CLI 子进程在 {@link start} 中通过
     * CliProcess.start(config) 启动。
     */
    public constructor() {
        this.cli = new CliProcess();
        this.adapter = new StreamJsonCliAdapter(this.cli);
        // 监听 adapter 解析出的事件并按需做转换 + 转发
        this.internalDisposables.push(
            this.adapter.onParsedEvent((event) => this.handleParsedEvent(event))
        );
        // 监听底层 CLI 退出 → 派发给外部
        this.internalDisposables.push(
            this.cli.onExit(() => {
                for (const listener of this.exitListeners) {
                    try {
                        listener();
                    } catch (err) {
                        Logger.warn(`Expert CLI exit listener threw: ${String((err as Error)?.message ?? err)}`);
                    }
                }
            })
        );
    }

    /**
     * 启动专家 CLI 子进程。
     *
     * @param config 已派生的专家 ChatCliConfig（由 `buildExpertConfig()` 产出）。
     */
    public async start(config: ChatCliConfig): Promise<void> {
        Logger.info('Expert CLI 启动 → 派发到底层 CliProcess.start');
        await this.cli.start(config);
    }

    /**
     * 向专家 CLI 的 stdin 写入一行 JSON Lines 文本。
     *
     * 通常仅在 ExpertRunner 第一次发送 user 消息时调用一次；后续若需要补充
     * 消息，应通过 ExpertRunner 重新调度，不要绕过它直接 send。
     */
    public send(jsonLine: string): void {
        this.cli.send(jsonLine);
    }

    /**
     * 订阅经 ParsedCliEvent → ExpertStreamEvent 转换后的事件流。
     *
     * @param listener 事件回调。
     * @returns 取消订阅的 dispose 句柄。
     */
    public onEvent(listener: (event: ExpertStreamEvent) => void): { dispose(): void } {
        this.eventListeners.add(listener);
        return {
            dispose: () => {
                this.eventListeners.delete(listener);
            }
        };
    }

    /**
     * 订阅 CLI 子进程退出事件。
     *
     * @param listener 退出回调（无参数）。
     * @returns 取消订阅的 dispose 句柄。
     */
    public onExit(listener: () => void): { dispose(): void } {
        this.exitListeners.add(listener);
        return {
            dispose: () => {
                this.exitListeners.delete(listener);
            }
        };
    }

    /**
     * 释放 ExpertCliProcessHost 持有的所有资源：
     * 1. 取消所有内部订阅；
     * 2. 关闭 CLI 子进程；
     * 3. 清空监听器集合。
     */
    public async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        for (const d of this.internalDisposables) {
            try {
                d.dispose();
            } catch (err) {
                Logger.warn(`Expert CLI host disposable threw: ${String((err as Error)?.message ?? err)}`);
            }
        }
        this.internalDisposables.length = 0;
        try {
            this.cli.dispose();
        } catch (err) {
            Logger.warn(`Expert CLI dispose threw: ${String((err as Error)?.message ?? err)}`);
        }
        this.eventListeners.clear();
        this.exitListeners.clear();
    }

    // ---------------------------------------------------------------------
    // ParsedCliEvent → ExpertStreamEvent 转换
    // ---------------------------------------------------------------------

    /**
     * 把一个 ParsedCliEvent 转换并派发为零个或多个 ExpertStreamEvent。
     *
     * 转换规则：
     * - `session/init`：忽略，专家不需要主对话级 session 元信息。
     * - `error`：透传成 `{ kind:'error', message }`。
     * - `done`：透传成 `{ kind:'result' }`，finalText 取所有 text segment 拼接。
     * - `segments`：遍历 segments，按 kind 分别映射：
     *     - `text` / `markdown` 文本累计并 emit `assistant_text`；
     *     - `tool` 首次出现的 tool_use_id emit `tool_use`；
     *     - `tool` 携带 `resultText` 且未 emit 过结果时 emit `tool_result`；
     *     - `error` 文案 emit `error`；
     *     - 其它（image / usage / fileRef / diff / code / permission）忽略
     *       —— 它们对最终回写主对话的 finalAnswer 没贡献，也无需推到 webview。
     *   若 segments 携带 `done===true`，在遍历结束后追加一个 `result` 事件。
     */
    private handleParsedEvent(event: ParsedCliEvent): void {
        switch (event.type) {
            case 'error': {
                this.emitEvent({ kind: 'error', message: event.message });
                return;
            }
            case 'done': {
                // adapter 内部 stream end，等同 'result' 终结事件
                this.emitEvent({ kind: 'result' });
                return;
            }
            case 'session/init': {
                // 专家不消费 session/init
                return;
            }
            case 'segments': {
                this.dispatchSegments(event.segments);
                if (event.done) {
                    // segments 流末尾的 done 标志：单独 emit 一个 message_end，
                    // 帮助 ExpertRunner 的 assistantMessageCount 计数。
                    this.emitEvent({ kind: 'message_end' });
                    // StreamJsonCliAdapter 在部分路径下不会额外再 emit `type:'done'`，
                    // 而是把 done 标记挂在最后一帧 segments 上。若这里只发
                    // message_end，ExpertRunner 会一直等不到 `result` 终止事件，
                    // 造成主聊天区工具卡片一直显示「执行中」，且 finalAnswer 无法
                    // 回写给主 CLI。因此 segments+done 必须同时视为本次专家 run
                    // 已完成，并把当前帧可见文本作为 finalText 传回。
                    this.emitEvent({
                        kind: 'result',
                        finalText: collectTextFromSegments(event.segments)
                    });
                }
                return;
            }
            default: {
                // 类型穷尽兜底
                return;
            }
        }
    }

    /**
     * 把 ChatSegment 列表逐条转换为 ExpertStreamEvent。
     *
     * @param segments 一次 patch 中的 segments 列表。
     */
    private dispatchSegments(segments: ChatSegment[]): void {
        for (const seg of segments) {
            this.dispatchSingleSegment(seg);
        }
    }

    /**
     * 把单个 ChatSegment 转换为 0 或 1 个 ExpertStreamEvent 并 emit。
     */
    private dispatchSingleSegment(seg: ChatSegment): void {
        switch (seg.kind) {
            case 'text':
            case 'markdown': {
                const text = seg.text ?? '';
                if (text.length > 0) {
                    this.emitEvent({ kind: 'assistant_text', text });
                }
                return;
            }
            case 'tool': {
                const tool = seg.tool;
                if (!tool) return;
                const id = seg.id ?? `anon-${tool.name}`;
                // 首次见到该 tool_use_id：emit tool_use
                if (!this.emittedToolUseIds.has(id)) {
                    this.emittedToolUseIds.add(id);
                    this.emitEvent({
                        kind: 'tool_use',
                        toolName: tool.name,
                        args: tool.input
                    });
                }
                // 若已带上 resultText 且尚未 emit 结果：emit tool_result
                if (
                    typeof tool.resultText === 'string' &&
                    !this.emittedToolResultIds.has(id)
                ) {
                    this.emittedToolResultIds.add(id);
                    this.emitEvent({
                        kind: 'tool_result',
                        toolName: tool.name,
                        resultText: tool.resultText,
                        isError: tool.isError === true
                    });
                }
                return;
            }
            case 'error': {
                this.emitEvent({ kind: 'error', message: seg.text ?? 'unknown error' });
                return;
            }
            default:
                // image / usage / fileRef / diff / code / permission：忽略
                return;
        }
    }

    /**
     * 把一个 ExpertStreamEvent 派发给所有订阅者；监听器抛错时只记录日志。
     */
    private emitEvent(event: ExpertStreamEvent): void {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            } catch (err) {
                Logger.warn(`Expert stream event listener threw: ${String((err as Error)?.message ?? err)}`);
            }
        }
    }
}

/**
 * 从一帧 ChatSegment 中提取可作为专家最终答案的文本。
 *
 * 仅合并 `text` / `markdown` / `error` 三类可见文本；工具卡片、图片、usage、
 * 文件引用等 UI 辅助片段不进入 finalAnswer。若本帧没有可见文本则返回
 * undefined，让 ExpertRunner 回落到它自身累计的 assistant_text 片段。
 *
 * @param segments StreamJsonCliAdapter 最后一帧 segments。
 * @returns 可作为 `ExpertStreamEvent.kind='result'` 的 finalText，或 undefined。
 */
function collectTextFromSegments(segments: ChatSegment[]): string | undefined {
    const parts: string[] = [];
    for (const seg of segments) {
        if ((seg.kind === 'text' || seg.kind === 'markdown' || seg.kind === 'error') && seg.text) {
            parts.push(seg.text);
        }
    }
    const text = parts.join('\n').trim();
    return text.length > 0 ? text : undefined;
}

/**
 * 创建一个新的 ExpertCliProcessHost 实例（便于在 DI 场景中传 factory 回调）。
 *
 * @returns 新的 ExpertCliProcessHost 实例（尚未 start）。
 */
export function createExpertCliProcessHost(): ExpertCliProcessHost {
    return new ExpertCliProcessHost();
}
