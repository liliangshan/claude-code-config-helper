/**
 * @file ExpertRunnerService：扩展宿主侧的「专家执行入口」组合根。
 *
 * 把以下三块组件粘合到一起，对外暴露一个简单的 `run(args)` 接口：
 *
 * 1. `ChatCliConfigService` —— 用于读取主对话当前的 CLI 配置，再派生出
 *    专家 CLI 的配置（剥除 llsExpert、覆盖 model、强制 permissionMode 等）。
 * 2. `ExpertCliProcessHost` —— 工厂方式按 run 创建专家 CLI 子进程适配器。
 * 3. `ChatViewHost` —— 通过 `postMessage({ type: 'expert/event' })` 把
 *    {@link ExpertEvent} 推到 webview 渲染面板。
 *
 * 方案 3 的核心：本服务是「Relay → ExpertRunner → 专家 CLI 子进程」链路里的
 * 扩展宿主侧入口；其上游是 `relay/router.ts` 中新增的 `POST /__expert/run`
 * 路由，它把 expertMcpServer 子进程 HTTP 转发过来的 `ask_expert` 调用最终
 * 落到这里。
 */

import * as crypto from 'crypto';

import { Logger } from '../logger';
import { buildExpertConfig } from './expertConfig';
import { createExpertCliProcessHost } from './expertCliAdapter';
import { ExpertRunner } from './expertRunner';
import type { ExpertRunRequest, ExpertRunResult } from './expertRunner';
import type { ExpertEvent, ExpertEventSink } from './expertEvents';
import type { AskExpertArgs } from './expertMcpServer';
import type { ChatCliConfigService } from '../chat/cli/cliConfig';
import type { ChatViewHost } from '../chat/chatViewHost';

/**
 * ExpertRunnerService 对外暴露的 run 请求参数。
 *
 * 与 {@link ExpertRunRequest} 的区别：本接口面向「无主对话上下文的 HTTP
 * 入口」，因此 `parentMessageId` / `callId` 都是可选——若调用方没法提供，
 * 会自动生成占位 id，保证 ExpertEvent 仍然能在 webview 里按 runId 聚合
 * 出一个独立面板。
 */
export interface ExpertServiceRunArgs {
    /** ask_expert 透传参数（question + 可选 context/goal/constraints）。 */
    args: AskExpertArgs;
    /**
     * 主对话关联 assistant 消息 id；未提供时使用占位字符串
     * `expert-anon-<runId>`，webview 端可以按 runId 单独渲染。
     */
    parentMessageId?: string;
    /** ask_expert 调用 id；未提供时使用占位字符串 `call-anon-<runId>`。 */
    callId?: string;
    /**
     * 主聊天区 ask_expert 工具卡片的 ChatSegment.id。
     *
     * Webview 用它把专家实时事件追加到对应工具卡片的 Output 区域；缺失时会按
     * callId 推导，避免旧调用方未传此字段时完全失去关联。
     */
    toolSegmentId?: string;
    /** 外部 AbortSignal：可用于响应 webview 关闭或主 CLI 退出。 */
    signal?: AbortSignal;
}

/**
 * 扩展宿主侧 / `/__expert/run` 路由背后的专家执行服务。
 *
 * **生命周期**：随扩展激活生成一个单例，扩展 deactivate 时无需特殊清理
 * （其内部不持有长期资源；每次 run 才创建 CliProcess 并 dispose）。
 *
 * **并发模型**：底层 {@link ExpertRunner} 强制单 run 串行；若 HTTP 路由
 * 收到并发请求，第二个请求会立刻得到 `[Expert mode failed: another
 * expert run is already in progress]`。
 */
export class ExpertRunnerService {
    /** 当前会话的随机鉴权 token；用于校验 `/__expert/run` 请求来源合法。 */
    private readonly authToken: string;

    /**
     * 构造 ExpertRunnerService。
     *
     * @param chatCliConfigService 主 CLI 配置服务，用于派生专家 CLI 配置。
     * @param chatViewHost         webview 宿主，用于推送 ExpertEvent。
     */
    public constructor(
        private readonly chatCliConfigService: ChatCliConfigService,
        private readonly chatViewHost: ChatViewHost
    ) {
        // 32 字节十六进制 token，足以抵御外部进程枚举
        this.authToken = crypto.randomBytes(32).toString('hex');
    }

    /**
     * 读取当前会话的鉴权 token。
     *
     * 由扩展宿主在 RelayServer 启动后注入到 `ChatCliConfigService` 与
     * `RelayRouter`，确保 expertMcpServer 子进程和路由校验使用同一份 token。
     */
    public getAuthToken(): string {
        return this.authToken;
    }

    /**
     * 执行一次专家任务。
     *
     * 内部步骤：
     * 1. 读取主对话当前 ChatCliConfig；
     * 2. 派生专家专用 ChatCliConfig（剥除 llsExpert、覆盖 model 等）；
     * 3. 构造一个 webview 推送 sink；
     * 4. 构造 ExpertRunner 并调用其 run；
     * 5. 返回 ExpertRunResult，由调用方（HTTP 路由）写回 HTTP body。
     *
     * 该方法**永远 resolve**，任何内部异常都会被吸收为
     * `{ isError: true, finalAnswer: '[Expert mode failed: ...]' }`。
     *
     * @param input run 请求。
     * @returns run 结果。
     */
    public async run(input: ExpertServiceRunArgs): Promise<ExpertRunResult> {
        try {
            const mainConfig = this.chatCliConfigService.getConfigWithCachedRelayEnv();
            // 主对话本身是否启用了专家模式？没启用就拒绝；防止用户关闭后还有
            // 残留请求进来。
            if (mainConfig.expertMode?.enabled !== true) {
                const text = '[Expert mode failed: expert mode is not enabled]';
                return {
                    finalAnswer: text,
                    isError: true,
                    durationMs: 0,
                    endReason: 'internal_error'
                };
            }

            const expertConfig = buildExpertConfig(mainConfig);
            const sink = this.createWebviewSink();
            const runner = new ExpertRunner({
                createCliProcess: () => createExpertCliProcessHost(),
                expertConfig,
                eventSink: sink,
                logger: (msg, meta) =>
                    Logger.warn(`[ExpertRunnerService] ${msg}${meta ? ` ${safeJson(meta)}` : ''}`)
            });

            const runId = makeStableId('expert');
            const callId = input.callId ?? `call-anon-${runId}`;
            const toolSegmentId = input.toolSegmentId ?? buildToolSegmentIdFromCallId(callId);
            const req: ExpertRunRequest = {
                parentMessageId: input.parentMessageId ?? `expert-anon-${runId}`,
                callId,
                toolSegmentId,
                args: input.args,
                signal: input.signal
            };
            Logger.info(
                `[ExpertRunnerService] starting expert run model=${expertConfig.model} ` +
                    `question_len=${input.args.question?.length ?? 0}`
            );
            const result = await runner.run(req);
            Logger.info(
                `[ExpertRunnerService] run finished reason=${result.endReason} ` +
                    `isError=${result.isError} duration=${result.durationMs}ms`
            );
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`[ExpertRunnerService] uncaught error: ${message}`);
            return {
                finalAnswer: `[Expert mode failed: internal_error: ${message}]`,
                isError: true,
                durationMs: 0,
                endReason: 'internal_error'
            };
        }
    }

    /**
     * 构造一个把 ExpertEvent 通过 `chatViewHost.postMessage` 推到 webview 的 sink。
     *
     * 推送失败（webview 不在线、postMessage 抛错）会被吞掉并写日志，**不**
     * 影响 ExpertRunner 的主流程——这是设计原则「视图缺席不影响主对话」。
     */
    private createWebviewSink(): ExpertEventSink {
        const host = this.chatViewHost;
        return {
            push(event: ExpertEvent): void {
                // postMessage 是 async，但 sink 协议要求 fire-and-forget；
                // 这里不 await，错误用 .catch 吃掉。
                void host
                    .postMessage({ type: 'expert/event', event })
                    .catch((err) => {
                        Logger.warn(
                            `[ExpertRunnerService] postMessage(expert/event) failed: ${String(
                                (err as Error)?.message ?? err
                            )}`
                        );
                    });
            }
        };
    }
}

/**
 * 根据主 CLI 的 tool_use_id 推导聊天区工具卡片 segment id。
 *
 * 这里必须与 `StreamJsonCliAdapter.buildToolSegmentId()` 的稳定 id 规则保持一致：
 * 只要 tool_use_id 存在，工具卡片 DOM 会带 `data-segment-id="tool:<id>"`。
 * 专家实时事件借助该 id 在 webview 端定位 ask_expert 工具卡片，从而把专家过程
 * 直接追加到卡片 Output 中。
 *
 * @param callId MCP ask_expert 的 tool_use_id。
 * @returns 对应的 ChatSegment.id。
 */
function buildToolSegmentIdFromCallId(callId: string): string {
    return `tool:${callId}`;
}

/**
 * 生成稳定的本地 id，仅用于关联 webview 端事件。
 *
 * @param prefix id 前缀，便于日志区分用途。
 * @returns 形如 `expert-1700000000000-abc12d` 的字符串。
 */
function makeStableId(prefix: string): string {
    const rand = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${Date.now()}-${rand}`;
}

/**
 * 安全地把任意值序列化为 JSON；失败时回退为 `String(value)`。
 *
 * @param value 任意值。
 * @returns 可放入日志的字符串。
 */
function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
