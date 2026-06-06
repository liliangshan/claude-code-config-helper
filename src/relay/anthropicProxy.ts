/**
 * @file Anthropic 类型提供商透传适配器。
 *
 * 仅处理 `apiType=anthropic` 的 provider：把 Claude Code 发来的 `/v1/messages`
 * 请求转发到 provider.baseUrl 对应的 Anthropic 兼容端点，替换鉴权请求头并
 * 附加 customHeaders；忽略 Claude Code 自带的 `authorization` / `x-api-key`。
 *
 * 同时实现任务 7 要求：从 SecretStorage 注入密钥、按 authMode 生成鉴权头、
 * 在日志中对敏感字段脱敏。
 *
 * 流式与非流式响应都通过原生 stream 直接透传，不在本扩展内做协议解析。
 *
 * Vendored from liliangshan.openapi-compatible-copilot@3.0.3, last-sync 2026-05-20。
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

import { Logger } from '../logger';
import { interceptAnthropicResponse } from '../llsTask/interceptor';
import { LlsTaskStreamingInterceptor } from '../llsTask/streamingInterceptor';
import type { ApiType, ProviderConfig } from '../types';
import type { DebugRecorder } from './debugRecorder';
import { buildForwardHeaders, redactHeaders } from './forwardHeadersCommon';
import type { UpstreamAdapter, UpstreamRequestContext } from './router';
import { extractAnthropicSessionId } from './summCommand';
import { injectLlsTaskRequestBody, type LlsTaskRequestInjectionDeps } from './taskRequestInjection';
import type { TokenBudgetService } from './tokenBudget/service';
import { UPSTREAM_FIRST_BYTE_TIMEOUT_MS, UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from './upstreamTimeouts';
import { UsageReporter, type UsageSink } from './usageReporter';

/** Anthropic 协议默认转发路径；provider.baseUrl 已自行决定是否包含 /v1。 */
const ANTHROPIC_MESSAGES_PATH = '/messages';

/** Anthropic Messages API 默认版本号，缺省下传值与官方一致。 */
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * 把 provider 的 baseUrl 拼接为完整上游 URL。
 *
 * 规则：
 *   1. 若 baseUrl 已显式带上 `/messages` 路径，直接使用；
 *   2. 否则在 baseUrl pathname 末尾追加 `/messages`，去重多余斜杠；
 *   3. 始终保留原 baseUrl 的协议、host、port。
 *
 * @param baseUrl provider 配置中的 baseUrl。
 * @returns 完整上游 URL。
 * @throws 当 baseUrl 不是合法 URL 时抛出。
 */
export function buildUpstreamUrl(baseUrl: string): URL {
    const trimmed = (baseUrl || '').trim();
    if (!trimmed) {
        throw new Error('provider.baseUrl 为空');
    }
    const url = new URL(trimmed);
    // 已经显式指向 /messages，则保留原 path。
    if (url.pathname.endsWith(ANTHROPIC_MESSAGES_PATH)) {
        return url;
    }
    // 去掉末尾多余斜杠后追加 messages 路径。
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base}${ANTHROPIC_MESSAGES_PATH}`;
    return url;
}

/**
 * 根据 provider.authMode 在请求头中追加鉴权信息。
 *
 * - `api_key`：使用 `x-api-key: <apiKey>` 并补充 `anthropic-version` 头；
 * - `auth_token`：使用 `authorization: Bearer <apiKey>`；
 * - `none`：不追加任何鉴权头。
 *
 * @param headers 待修改的请求头对象。
 * @param provider 完整 provider 配置（含 apiKey）。
 */
export function applyAuthHeaders(
    headers: Record<string, string>,
    provider: ProviderConfig
): void {
    const apiKey = (provider.apiKey || '').trim();
    switch (provider.authMode) {
        case 'api_key':
            if (apiKey) headers['x-api-key'] = apiKey;
            if (!headers['anthropic-version']) {
                headers['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
            }
            break;
        case 'auth_token':
            if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
            break;
        case 'none':
        default:
            break;
    }
}

/**
 * 把 provider.customHeaders 合并到上游请求头中。
 *
 * 用户配置的 customHeaders 优先级高于上游默认头，但永远不会覆盖
 * `host`/`content-length` 等由 Node 控制的字段。
 *
 * @param headers 待修改的请求头对象。
 * @param provider provider 配置。
 */
export function applyCustomHeaders(
    headers: Record<string, string>,
    provider: ProviderConfig
): void {
    if (!Array.isArray(provider.customHeaders)) return;
    for (const entry of provider.customHeaders) {
        if (!entry || !entry.key) continue;
        const key = entry.key.trim();
        if (!key) continue;
        const lower = key.toLowerCase();
        if (lower === 'host' || lower === 'content-length') continue;
        headers[lower] = entry.value ?? '';
    }
}

/**
 * 改写请求体中的 model 字段为目标 modelId。
 *
 * Claude Code 发来的 body 通常是 `<providerId>/<modelId>`，
 * 上游不认识这种前缀，必须替换为纯 modelId。
 *
 * @param rawBody 原始请求体字符串。
 * @param parsedBody 已解析的请求体 JSON。
 * @param modelId 目标 modelId。
 * @returns 新的请求体字符串（始终为合法 JSON）。
 */
export function rewriteRequestBody(
    rawBody: string,
    parsedBody: unknown,
    modelId: string
): string {
    if (parsedBody && typeof parsedBody === 'object') {
        const cloned: Record<string, unknown> = { ...(parsedBody as Record<string, unknown>) };
        cloned.model = modelId;
        return JSON.stringify(cloned);
    }
    // 解析失败时退回原样；保证调用方拿到字符串。
    return rawBody;
}

/** Anthropic Proxy 可选任务流依赖。 */
export type AnthropicProxyTaskDeps = LlsTaskRequestInjectionDeps;

/**
 * 从 Anthropic 形态的请求体中提取 CLI 纯 session_id。
 *
 * Claude Code CLI 会把 `{device_id, account_uuid, session_id}` 序列化为 JSON 字符串
 * 再塞到 `metadata.user_id` 里下发；少数实现也可能直接给纯字符串。优先级：
 *   1. metadata.session_id（字符串、UUID 形态）→ 直接返回；
 *   2. metadata.user_id 是 JSON → 解析后取其中的 session_id；
 *   3. metadata.user_id 是纯字符串 → 直接返回。
 *
 * 与 webview 那边从 stream-json `session/init` 事件拿到的 `event.sessionId` 对齐，
 * 避免 relay 与 webview 用不同 key 写同一份 token-count.json。
 *
 * @param parsedBody 已解析的请求体 JSON。
 * @returns CLI 纯 session_id 字符串；取不到时返回空串。
 */
function extractSessionId(parsedBody: unknown): string {
    if (!parsedBody || typeof parsedBody !== 'object') return '';
    const metadata = (parsedBody as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') return '';
    const meta = metadata as Record<string, unknown>;
    if (typeof meta.session_id === 'string' && meta.session_id) return meta.session_id;
    if (typeof meta.user_id === 'string' && meta.user_id) {
        const raw = meta.user_id.trim();
        if (raw.startsWith('{')) {
            try {
                const parsed = JSON.parse(raw) as { session_id?: unknown };
                if (typeof parsed.session_id === 'string' && parsed.session_id) {
                    return parsed.session_id;
                }
            } catch {
                // 落到原值兜底。
            }
        }
        return raw;
    }
    return '';
}

/**
 * Anthropic 透传适配器实现。
 *
 * 可选地把每次转发请求中的 messages 聚合写入工作区 `.LLSOAI/` 目录，便于排查上下文问题。
 */
export class AnthropicProxyAdapter implements UpstreamAdapter {
    /** 适配器对应的 apiType，固定为 anthropic。 */
    public readonly apiType: ApiType = 'anthropic';

    /**
     * 创建 Anthropic 透传适配器。
     *
     * @param recorder 可选的调试记录器；提供后会按天聚合写入 messages。
     * @param taskDeps 可选任务流依赖；提供后才会执行任务流注入与拦截。
     * @param usageSink 可选 token 使用量上报回调；提供后会从上游响应抽取 usage 并上报到 Chat UI。
     * @param tokenBudget 可选 token 预算服务；提供后在每次发送前/接收后做 token 累计与自动压缩判定。
     * @param fileOpenObserver 可选文件工具观察回调。
     */
    public constructor(
        private readonly recorder?: DebugRecorder,
        private readonly taskDeps?: AnthropicProxyTaskDeps,
        private readonly usageSink?: UsageSink,
        private readonly tokenBudget?: TokenBudgetService,
        private readonly fileOpenObserver?: (toolName: string, input: unknown) => void
    ) {}

    /**
     * 执行一次 `/v1/messages` 透传。
     *
     * @param ctx 路由器构造好的请求上下文。
     */
    public async handle(ctx: UpstreamRequestContext): Promise<void> {
        const { req, res, provider, modelId, rawBody, parsedBody } = ctx;
        const startedAt = Date.now();
        let upstreamUrl: URL;
        try {
            upstreamUrl = buildUpstreamUrl(provider.baseUrl);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.writeErrorJson(res, 502, 'bad_gateway', `上游 baseUrl 不合法：${message}`);
            await this.safeRecord({
                providerId: provider.id,
                modelId,
                upstreamUrl: provider.baseUrl,
                method: 'POST',
                requestHeaders: {},
                requestBody: rawBody,
                responseStatus: 502,
                responseHeaders: {},
                responseBody: '',
                startedAt,
                endedAt: Date.now(),
                error: message
            });
            return;
        }

        const headers = buildForwardHeaders(req.headers);
        applyCustomHeaders(headers, provider);
        applyAuthHeaders(headers, provider);
        // 始终发 JSON；上游响应类型由上游决定（可能为 SSE）。
        headers['content-type'] = headers['content-type'] || 'application/json; charset=utf-8';

        const injectedRequest = injectLlsTaskRequestBody(
            rewriteRequestBody(rawBody, parsedBody, modelId),
            this.taskDeps,
            { createTriggered: ctx.llsTaskCreateTriggered === true, modelName: modelId }
        );
        const bodyText = injectedRequest.bodyText;
        // token 预算登记（仅估算 + 登记，不改写 body；阈值触发的压缩走响应侧 afterRecv）
        try {
            const sessionId = extractSessionId(parsedBody);
            if (sessionId) {
                this.tokenBudget?.beforeSend({
                    sessionId,
                    providerId: provider.id,
                    modelId,
                    anthropicBody: bodyText
                });
            }
        } catch (err) {
            Logger.warn(`[tokenBudget] beforeSend 调用异常：${err instanceof Error ? err.message : String(err)}`);
        }
        await this.safeRecordRequestBody(bodyText);
        const bodyBuffer = Buffer.from(bodyText, 'utf-8');
        headers['content-length'] = String(bodyBuffer.byteLength);

        Logger.info(
            `Anthropic 透传：${upstreamUrl.toString()} model=${modelId} headers=${JSON.stringify(
                redactHeaders(headers)
            )}`
        );

        const transport = upstreamUrl.protocol === 'http:' ? http : https;
        const options: http.RequestOptions = {
            method: 'POST',
            protocol: upstreamUrl.protocol,
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (upstreamUrl.protocol === 'http:' ? 80 : 443),
            path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
            headers
        };

        // 聚合响应体用于任务流本地拦截与最终 messages 聚合记录；不再输出单次 request/response 调试文件。
        const responseChunks: Buffer[] = [];
        let responseStatus: number | undefined;
        let responseHeaders: Record<string, string | string[] | undefined> = {};
        const streamedOutputChunks: string[] = [];
        let errorMessage: string | undefined;
        // 每次响应独立的 usage 抽取器，从下行 Anthropic SSE / JSON 中收集 token 统计。
        const usageReporter = new UsageReporter(this.usageSink);

        await new Promise<void>((resolve) => {
            let settled = false;
            let gotHeaders = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(firstByteTimer);
                resolve();
            };
            const firstByteTimer = setTimeout(() => {
                if (gotHeaders) return;
                const seconds = Math.round(UPSTREAM_FIRST_BYTE_TIMEOUT_MS / 1000);
                errorMessage = `上游首字节超时（${seconds}s）`;
                Logger.error(`Anthropic 透传上游首字节 ${seconds}s 超时，主动断开：${upstreamUrl.toString()}`);
                ctx.onUpstreamTimeout?.('first_byte');
                try {
                    upstreamReq.destroy(new Error(errorMessage));
                } catch {
                    // ignore
                }
                this.writeErrorJson(res, 504, 'timeout', errorMessage);
                usageReporter.end();
                finish();
            }, UPSTREAM_FIRST_BYTE_TIMEOUT_MS);
            const upstreamReq = transport.request(options, (upstreamRes) => {
                gotHeaders = true;
                clearTimeout(firstByteTimer);
                responseStatus = upstreamRes.statusCode;
                responseHeaders = upstreamRes.headers;
                const isStream = this.isEventStream(upstreamRes.headers['content-type']);
                if (isStream) {
                    upstreamRes.setTimeout(UPSTREAM_STREAM_IDLE_TIMEOUT_MS, () => {
                        const seconds = Math.round(UPSTREAM_STREAM_IDLE_TIMEOUT_MS / 1000);
                        errorMessage = `上游流式响应空闲超时（${seconds}s）`;
                        Logger.error(`Anthropic 透传上游流式响应空闲 ${seconds}s 超时，主动断开：${upstreamUrl.toString()}`);
                        ctx.onUpstreamTimeout?.('stream_idle');
                        try {
                            upstreamRes.destroy(new Error(errorMessage));
                        } catch {
                            // ignore
                        }
                        if (!res.writableEnded) {
                            res.end();
                        }
                        usageReporter.end();
                        finish();
                    });
                }
                const streamInterceptor = isStream && this.taskDeps
                    ? new LlsTaskStreamingInterceptor({
                        service: this.taskDeps.llsTaskService,
                        autoContinueScheduler: this.taskDeps.autoContinueScheduler,
                        onFileTool: this.fileOpenObserver
                    })
                    : undefined;
                // 将上游状态码与响应头透传给 Claude Code。
                res.statusCode = upstreamRes.statusCode ?? 502;
                for (const key of Object.keys(upstreamRes.headers)) {
                    if (isStream && key.toLowerCase() === 'content-length') continue;
                    const value = upstreamRes.headers[key];
                    if (value === undefined) continue;
                    try {
                        res.setHeader(key, value as string | string[]);
                    } catch {
                        // 个别非法 header 直接忽略，避免影响主流程。
                    }
                }
                // 聚合响应体，便于任务流拦截器在完整响应上执行本地伪工具。
                upstreamRes.on('data', (chunk: Buffer | string) => {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
                    responseChunks.push(buf);
                    if (isStream && !res.writableEnded) {
                        const out = streamInterceptor ? streamInterceptor.feed(buf.toString('utf-8')) : buf;
                        if (typeof out === 'string') {
                            streamedOutputChunks.push(out);
                            usageReporter.feed(out);
                        } else if (Buffer.isBuffer(out)) {
                            usageReporter.feed(out.toString('utf-8'));
                        }
                        if (out) res.write(out);
                    }
                });
                upstreamRes.on('error', (err) => {
                    errorMessage = err.message;
                    Logger.error(`上游响应流错误：${err.message}`);
                    if (!res.writableEnded) {
                        res.end();
                    }
                    usageReporter.end();
                    finish();
                });
                upstreamRes.on('end', () => {
                    if (!res.writableEnded) {
                        const rawResponseBody = Buffer.concat(responseChunks).toString('utf-8');
                        if (isStream) {
                            const tail = streamInterceptor?.end() ?? '';
                            if (tail) {
                                streamedOutputChunks.push(tail);
                                usageReporter.feed(tail);
                                res.write(tail);
                            }
                            usageReporter.end();
                            res.end();
                            finish();
                            return;
                        }
                        const finalBody = this.taskDeps
                            ? interceptAnthropicResponse(rawResponseBody, upstreamRes.headers['content-type'], {
                                service: this.taskDeps.llsTaskService,
                                autoContinueScheduler: this.taskDeps.autoContinueScheduler,
                                onFileTool: this.fileOpenObserver
                            }).body
                            : rawResponseBody;
                        usageReporter.feedJson(finalBody);
                        try {
                            res.removeHeader('transfer-encoding');
                            res.setHeader('content-length', String(Buffer.byteLength(finalBody, 'utf-8')));
                        } catch {
                            // headers 已发送或非法时忽略，主流程继续写响应。
                        }
                        res.write(finalBody);
                        res.end();
                    }
                    finish();
                });
            });

            upstreamReq.on('error', (err) => {
                if (settled) return;
                errorMessage = err.message;
                Logger.error(`上游请求错误：${err.message}`);
                this.writeErrorJson(res, 502, 'bad_gateway', `上游请求失败：${err.message}`);
                usageReporter.end();
                finish();
            });

            // 客户端中途断开时尽量释放上游连接。
            req.on('aborted', () => {
                try {
                    upstreamReq.destroy();
                } catch {
                    // ignore
                }
            });

            upstreamReq.end(bodyBuffer);
        });

        await this.safeRecord({
            providerId: provider.id,
            modelId,
            upstreamUrl: upstreamUrl.toString(),
            method: 'POST',
            requestHeaders: redactHeaders(headers),
            requestBody: bodyText,
            responseStatus,
            responseHeaders,
            responseBody: streamedOutputChunks.length > 0 ? streamedOutputChunks.join('') : Buffer.concat(responseChunks).toString('utf-8'),
            startedAt,
            endedAt: Date.now(),
            error: errorMessage
        });
    }

    /**
     * 判断上游响应是否为 SSE 流。
     *
     * @param value content-type 响应头。
     * @returns 命中 text/event-stream 时返回 true。
     */
    private isEventStream(value: string | string[] | undefined): boolean {
        const text = Array.isArray(value) ? value.join(';') : value ?? '';
        return text.toLowerCase().includes('text/event-stream');
    }

    /**
     * 写入当前请求最终 body，捕获并吞掉所有异常。
     *
     * @param bodyText 已注入工具、即将发送到上游的请求体文本。
     */
    private async safeRecordRequestBody(bodyText: string): Promise<void> {
        if (!this.recorder) return;
        try {
            await this.recorder.recordRequestBody(bodyText);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`请求 body 写入失败：${message}`);
        }
    }

    /**
     * 调用 recorder 写入调试快照，捕获并吞掉所有异常。
     *
     * @param entry 待落盘的快照数据。
     */
    private async safeRecord(entry: Parameters<DebugRecorder['record']>[0]): Promise<void> {
        if (!this.recorder) return;
        try {
            await this.recorder.record(entry);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`调试快照写入失败：${message}`);
        }
    }

    /**
     * 在响应头尚未发送时向客户端写入一个 JSON 错误响应。
     *
     * @param res HTTP 响应对象。
     * @param status HTTP 状态码。
     * @param type Anthropic 风格错误类型。
     * @param message 错误描述。
     */
    private writeErrorJson(
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
}
