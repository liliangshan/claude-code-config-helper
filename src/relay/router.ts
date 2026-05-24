/**
 * @file `/v1/messages` 路由分发器。
 *
 * 第二阶段只承载 Claude Code 必需的 `POST /v1/messages`；其他路径一律返回 404。
 * 路由会从请求体的 `model` 字段解析出 `<providerId>/<modelId>`，缺省则回退到
 * {@link ConfigManager.getCurrentModel}，然后根据 provider 的 `apiType`
 * 委派给对应的 {@link UpstreamAdapter}。
 *
 * 为任务 18 预留可扩展的 adapter 接口，本阶段只注册 anthropic 适配器。
 *
 * Vendored from liliangshan.openapi-compatible-copilot@3.0.3, last-sync 2026-05-20。
 */

import * as http from 'http';

import type { ConfigManager } from '../configManager';
import { Logger } from '../logger';
import type { AutoContinueScheduler } from '../llsTask/autoContinue';
import { isLlsCcaiTaskTriggered } from '../llsTask/detector';
import type { LlsTaskService } from '../llsTask/service';
import type {
    ApiType,
    CurrentModelSelection,
    ProviderConfig
} from '../types';
import type { RelayRequestHandler } from './server';

/** Claude Code 当前转发的目标路径。 */
const RELAY_PATH = '/v1/messages';

/**
 * 「专家模式回环」HTTP 入口路径。
 *
 * 由 expertMcpServer stdio 子进程在收到 `tools/call ask_expert` 时通过
 * `fetch(LLS_EXPERT_RELAY_URL + EXPERT_RELAY_PATH, ...)` 反向调用扩展宿主，
 * 让宿主进程 spawn 真正的「专家」Claude CLI（成为扩展宿主的直接子进程而
 * 非 expertMcpServer 的孙进程），便于直接 postMessage 推送事件给 webview。
 *
 * 仅允许本机回环访问；通过 `Authorization: Bearer <token>` 校验来源，
 * token 由 ExpertRunnerService 在扩展激活时随机生成。
 */
const EXPERT_RELAY_PATH = '/__expert/run';

/** 转发请求体读取上限，避免恶意大包占用内存（10 MiB）。 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 上游适配器拿到的上下文。
 *
 * 适配器拿到原始请求 / 响应、解析后的 provider 与 modelId、读到的请求体，
 * 自行负责对上游发起请求并把响应写回到 res。
 */
export interface UpstreamRequestContext {
    /** 原始 HTTP 请求。 */
    req: http.IncomingMessage;
    /** 原始 HTTP 响应。 */
    res: http.ServerResponse;
    /** 解析后的提供商完整配置（含密钥）。 */
    provider: ProviderConfig;
    /** 解析后的目标 modelId（已剥离 providerId 前缀）。 */
    modelId: string;
    /** 已经完整读取的请求体（utf-8 解码后的字符串）。 */
    rawBody: string;
    /** 请求体解析得到的 JSON，解析失败为 null。 */
    parsedBody: unknown | null;
    /** 本轮请求是否触发了创建 LLS CCAI 任务流。 */
    llsTaskCreateTriggered?: boolean;
}

/**
 * 上游适配器接口。
 *
 * 任务 18 中会基于该接口扩展 openai-compatible / v1-response 等适配器。
 */
export interface UpstreamAdapter {
    /** 该适配器对应的 apiType。 */
    readonly apiType: ApiType;
    /**
     * 处理一次上游转发。
     *
     * 适配器必须自己负责写完整响应（包括状态码、headers、body 与流式 chunk）。
     */
    handle(ctx: UpstreamRequestContext): Promise<void>;
}

/** 创建路由器所需的依赖。 */
export interface RelayRouterDeps {
    /** 配置管理器，提供 provider/currentModel 读取能力。 */
    configManager: ConfigManager;
    /** 上游适配器列表，按 apiType 选择匹配。 */
    adapters: UpstreamAdapter[];
    /** 可选任务流服务，用于处理 @llsccai-task 触发。 */
    llsTaskService?: LlsTaskService;
    /**
     * 可选自动续推调度器；保留字段以便外部装配。
     *
     * Router 自身不再在收到请求时无条件 cancel——这样会被 Claude Code CLI 的
     * 标题生成等侧轨请求误触发，导致主对话刚登记的"缺失工具调用"续推被清掉。
     * 真正的 cancel 时机已下沉到 {@link injectLlsTaskRequestBody}。
     */
    autoContinueScheduler?: AutoContinueScheduler;
    /**
     * 可选「专家模式」回环执行入口。
     *
     * 注入后，路由会接管 `POST /__expert/run`，由该 handler 负责：
     * 1. 校验 `Authorization: Bearer <token>`；
     * 2. 派 spawn 第二个 Claude CLI 作为专家；
     * 3. 把 ExpertEvent 推到 webview；
     * 4. 返回 `{ finalAnswer, isError, durationMs, endReason }` 给调用方。
     *
     * 未注入时，该路径仍返回 404。
     */
    expertHandler?: ExpertRelayHandler;
}

/**
 * 专家模式回环 HTTP 入口的处理契约。
 *
 * 由 `ExpertRunnerService` 在扩展宿主侧实现并注入。Router 只负责通用
 * 鉴权 / 解析 / 反序列化，真正的 spawn 与事件推送都交给该接口实现。
 */
export interface ExpertRelayHandler {
    /**
     * 与 expertMcpServer 子进程握手的一次性鉴权 token。
     *
     * Router 在收到 `/__expert/run` 请求时会从 `Authorization` 头取出
     * `Bearer <token>` 部分与该值做常数时间比较；不一致直接 401。
     */
    readonly authToken: string;
    /**
     * 执行一次专家任务。
     *
     * @param args HTTP body 反序列化后的 ask_expert 参数。
     * @param signal 可选 AbortSignal；当 HTTP 客户端断开连接时由 router 触发。
     * @returns 专家 run 结果；保证不抛异常（失败时 isError=true）。
     */
    run(
        args: ExpertRelayRunBody,
        signal?: AbortSignal
    ): Promise<ExpertRelayRunResult>;
}

/**
 * `/__expert/run` 入口期望的请求体。
 *
 * 由 expertMcpServer 子进程在收到 `tools/call` 时序列化得到；只透传 MCP
 * 工具 `arguments` + 主对话上下文 id（可选）。
 */
export interface ExpertRelayRunBody {
    /** ask_expert 入参中的 question 字段；必填。 */
    question: string;
    /** ask_expert 入参中的 context 字段；可选。 */
    context?: string;
    /** ask_expert 入参中的 goal 字段；可选。 */
    goal?: string;
    /** ask_expert 入参中的 constraints 字段；可选。 */
    constraints?: string;
    /** 关联的主对话 assistant 消息 id；用于 webview 把事件聚合到对应气泡下方。 */
    parentMessageId?: string;
    /** ask_expert 调用 id（tool_use_id）；可选。 */
    callId?: string;
    /** 主聊天区 ask_expert 工具卡片 segment id；可选，仅用于 webview 实时关联。 */
    toolSegmentId?: string;
}

/** `/__expert/run` 入口的响应体。 */
export interface ExpertRelayRunResult {
    /** 写回主对话的 finalAnswer（已截断）。 */
    finalAnswer: string;
    /** 是否为错误。 */
    isError: boolean;
    /** 本次 run 总耗时（毫秒）。 */
    durationMs: number;
    /** 结束原因。 */
    endReason: string;
}

/**
 * 解析请求体 model 字段为 `<providerId>/<modelId>`。
 *
 * 当 model 缺省、为空或非字符串时返回 null，调用方需要回退到当前模型选择。
 *
 * @param body 已解析的请求体 JSON。
 * @returns 解析出的 providerId/modelId，或 null。
 */
export function parseModelField(body: unknown): { providerId: string; modelId: string } | null {
    if (!body || typeof body !== 'object') return null;
    const value = (body as { model?: unknown }).model;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1) {
        // 没有 providerId 前缀，让上层走 currentModel 回退。
        return null;
    }
    return {
        providerId: trimmed.slice(0, slash),
        modelId: trimmed.slice(slash + 1)
    };
}

/**
 * 读取完整请求体（带大小上限）。
 *
 * @param req 原始 HTTP 请求。
 * @returns utf-8 解码后的请求体字符串。
 * @throws 当请求体超过 {@link MAX_BODY_BYTES} 时抛出。
 */
export function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            total += buf.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error(`请求体过大，超过 ${MAX_BODY_BYTES} 字节限制`));
                req.destroy();
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => {
            try {
                resolve(Buffer.concat(chunks).toString('utf-8'));
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
        req.on('error', (err) => reject(err));
    });
}

/**
 * 写入一个 JSON 错误响应（仅在尚未发送响应头时使用）。
 *
 * @param res HTTP 响应对象。
 * @param status HTTP 状态码。
 * @param type Anthropic 风格错误类型字符串。
 * @param message 错误描述。
 */
function writeJsonError(
    res: http.ServerResponse,
    status: number,
    type: string,
    message: string
): void {
    if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
    }
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/**
 * 创建 Relay 路由处理函数。
 *
 * 该函数仅承担"路径校验 + 模型解析 + 适配器分发"的工作，
 * 真正的上游 HTTP 请求由具体的 {@link UpstreamAdapter} 负责发起。
 *
 * @param deps 路由器所需依赖。
 * @returns 与 {@link RelayRequestHandler} 兼容的请求处理函数。
 */
export function createRelayRouter(deps: RelayRouterDeps): RelayRequestHandler {
    const { configManager, adapters, llsTaskService, expertHandler } = deps;
    const adapterMap = new Map<ApiType, UpstreamAdapter>();
    for (const adapter of adapters) {
        adapterMap.set(adapter.apiType, adapter);
    }

    return async (req, res) => {
        // 注意：此处刻意不再无条件 cancel 自动续推。
        // Claude Code CLI 会与主对话毫秒级并发发送"会话标题生成"等侧轨请求，
        // 早期在 relay 入口就 cancel 会把上一轮主对话刚登记的"缺失工具调用"续推
        // 定时器误清掉。真正需要 cancel 的时机已下沉到 injectLlsTaskRequestBody
        // 中——只有在确认是要注入任务流上下文的非侧轨请求时才取消。
        const method = (req.method ?? 'GET').toUpperCase();
        const url = req.url ?? '';
        const path = url.split('?', 1)[0];

        // ----------------------------------------------------------------
        // 专家模式回环入口：`POST /__expert/run`
        // ----------------------------------------------------------------
        // 该分支必须放在 `RELAY_PATH` 校验之前，否则会被 404 兜底拦截。
        // 若未注入 expertHandler，则保持 404 行为（与未启用专家模式一致）。
        if (path === EXPERT_RELAY_PATH) {
            if (method !== 'POST') {
                writeJsonError(res, 405, 'method_not_allowed', `专家入口仅接受 POST：${method}`);
                return;
            }
            if (!expertHandler) {
                writeJsonError(res, 404, 'not_found', '专家模式未启用或未注入 handler');
                return;
            }
            await handleExpertRelayRun(req, res, expertHandler);
            return;
        }

        // 仅匹配 POST /v1/messages（允许携带 query string，目前忽略）。
        if (path !== RELAY_PATH || method !== 'POST') {
            writeJsonError(res, 404, 'not_found', `路径不在第二阶段支持范围内：${method} ${path}`);
            return;
        }

        let rawBody = '';
        try {
            rawBody = await readRequestBody(req);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeJsonError(res, 413, 'request_too_large', message);
            return;
        }

        let parsedBody: unknown | null = null;
        try {
            parsedBody = rawBody ? JSON.parse(rawBody) : null;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeJsonError(res, 400, 'invalid_request_error', `请求体不是合法 JSON：${message}`);
            return;
        }

        const messages = parsedBody && typeof parsedBody === 'object'
            ? (parsedBody as { messages?: unknown }).messages
            : undefined;
        const llsTaskCreateTriggered = !!llsTaskService
            && !llsTaskService.hasActiveWorkflow()
            && isLlsCcaiTaskTriggered(messages);
        if (llsTaskCreateTriggered) {
            llsTaskService.markWorkflowCreationPending();
        }

        // 解析目标模型：优先取请求体中的 model 字段，否则回退到当前模型选择。
        const explicit = parseModelField(parsedBody);
        const fallback: CurrentModelSelection | null = explicit ? null : configManager.getCurrentModel();
        const providerId = explicit?.providerId ?? fallback?.providerId;
        const modelId = explicit?.modelId ?? fallback?.modelId;
        if (!providerId || !modelId) {
            writeJsonError(
                res,
                400,
                'invalid_request_error',
                '未指定 model 字段且当前模型为空，无法路由请求'
            );
            return;
        }

        const provider = await configManager.getProviderWithSecret(providerId);
        if (!provider) {
            writeJsonError(res, 404, 'provider_not_found', `提供商不存在：${providerId}`);
            return;
        }
        if (provider.enabled === false) {
            writeJsonError(res, 503, 'provider_disabled', `提供商已禁用：${providerId}`);
            return;
        }

        const adapter = adapterMap.get(provider.apiType);
        if (!adapter) {
            writeJsonError(
                res,
                501,
                'not_implemented',
                `第二阶段尚未支持 apiType=${provider.apiType} 的转发`
            );
            return;
        }

        Logger.info(
            `Relay 转发：${providerId}/${modelId} -> ${provider.baseUrl}（apiType=${provider.apiType}）`
        );
        await adapter.handle({ req, res, provider, modelId, rawBody, parsedBody, llsTaskCreateTriggered });
    };
}

// ============================================================================
// 专家模式回环入口实现
// ============================================================================

/**
 * 处理 `POST /__expert/run` 请求：鉴权 → 解析 body → 调用 expertHandler → 写回响应。
 *
 * 失败兜底：
 * - body 过大 / 非法 JSON / 缺字段 → 4xx + JSON 错误；
 * - expertHandler.run 抛异常（不应发生但兜底）→ 500；
 * - 客户端中途断开 → 通过 AbortController 通知 expertHandler。
 *
 * @param req      原始 HTTP 请求。
 * @param res      原始 HTTP 响应。
 * @param handler  扩展宿主注入的专家执行 handler。
 */
async function handleExpertRelayRun(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: ExpertRelayHandler
): Promise<void> {
    // 1) 校验鉴权头
    const authHeader = req.headers['authorization'];
    const expected = `Bearer ${handler.authToken}`;
    if (typeof authHeader !== 'string' || !constantTimeEquals(authHeader, expected)) {
        writeJsonError(res, 401, 'unauthorized', '专家入口鉴权失败');
        return;
    }

    // 2) 读取并解析 body
    let rawBody = '';
    try {
        rawBody = await readRequestBody(req);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeJsonError(res, 413, 'request_too_large', message);
        return;
    }
    let parsed: unknown;
    try {
        parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeJsonError(res, 400, 'invalid_request_error', `请求体不是合法 JSON：${message}`);
        return;
    }
    if (!parsed || typeof parsed !== 'object') {
        writeJsonError(res, 400, 'invalid_request_error', '请求体必须为对象');
        return;
    }
    const obj = parsed as Record<string, unknown>;
    const question = typeof obj.question === 'string' ? obj.question : '';
    if (!question.trim()) {
        writeJsonError(res, 400, 'invalid_request_error', '缺少必填字段 question');
        return;
    }
    const body: ExpertRelayRunBody = {
        question,
        context: typeof obj.context === 'string' ? obj.context : undefined,
        goal: typeof obj.goal === 'string' ? obj.goal : undefined,
        constraints: typeof obj.constraints === 'string' ? obj.constraints : undefined,
        parentMessageId: typeof obj.parentMessageId === 'string' ? obj.parentMessageId : undefined,
        callId: typeof obj.callId === 'string' ? obj.callId : undefined,
        toolSegmentId: typeof obj.toolSegmentId === 'string' ? obj.toolSegmentId : undefined
    };

    // 3) 准备 AbortSignal：客户端断开时通知 handler
    const ac = new AbortController();
    const onClose = () => {
        ac.abort();
    };
    req.once('close', onClose);

    // 4) 调用 handler，确保最终把 close 监听器解绑
    try {
        const result = await handler.run(body, ac.signal);
        if (!res.headersSent) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
        }
        if (!res.writableEnded) {
            res.end(JSON.stringify(result));
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`/__expert/run 处理异常：${message}`);
        writeJsonError(res, 500, 'internal_error', message);
    } finally {
        req.off('close', onClose);
    }
}

/**
 * 常数时间字符串比较，避免通过响应时长枚举 token。
 *
 * 长度不同会立即返回 false（这是预期行为：长度本身已可观察）。
 *
 * @param a 字符串 a。
 * @param b 字符串 b。
 * @returns 两者完全相等返回 true。
 */
function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i += 1) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}
