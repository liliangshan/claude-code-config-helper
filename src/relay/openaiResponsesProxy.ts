/**
 * @file OpenAI Responses API 转发适配器。
 *
 * 接收 Claude Code 的 Anthropic Messages 请求，先按 Anthropic 形态完成模型改写与
 * LLS 任务流注入，再转换为 OpenAI Responses 请求转发给上游，最后把 Responses
 * JSON / SSE 响应转换回 Anthropic Messages 协议。
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { StringDecoder } from 'node:string_decoder';

import { Logger } from '../logger';
import { interceptAnthropicResponse } from '../llsTask/interceptor';
import type { LlsTaskInterceptorDeps } from '../llsTask/interceptor';
import { LlsTaskStreamingInterceptor } from '../llsTask/streamingInterceptor';
import type { ApiType, ModelReasoningMode } from '../types';
import { convertAnthropicToOpenAIResponses } from './converters/anthropicToOpenAIResponses';
import { buildAnthropicErrorFromUpstream, formatAnthropicSseError, sanitizeErrorMessage } from './converters/openAIErrorToAnthropic';
import { convertResponsesJsonToAnthropic, OpenAIResponsesToAnthropicStreamConverter } from './converters/openAIResponsesToAnthropic';
import type { DebugRecorder, ToolJsonErrorSnapshot } from './debugRecorder';
import { extractExplicitCacheSessionId } from './explicitPromptCache';
import { buildForwardHeaders, redactHeaders } from './forwardHeadersCommon';
import { buildOpenAIForwardHeaders, describeOpenAIAuthHeaders } from './openAIHeaders';
import { resolveModelCacheMode, resolveModelExplicitCache, resolveReasoningMode } from './modelCacheMode';
import type { UpstreamAdapter, UpstreamRequestContext } from './router';
import { injectLlsTaskRequestBody, type LlsTaskRequestInjectionDeps } from './taskRequestInjection';
import type { TokenBudgetService } from './tokenBudget/service';
import { joinUpstreamUrl } from './upstreamUrl';
import { bindClientAbortToUpstream } from './upstreamAbort';
import { UPSTREAM_FIRST_BYTE_TIMEOUT_MS, UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from './upstreamTimeouts';
import { getRequestUsageReporter, type UsageSink } from './usageReporter';

/** OpenAI Responses API 路径。 */
const OPENAI_RESPONSES_PATH = '/responses';

/** OpenAI Responses Proxy 可选任务流依赖。 */
export type OpenAIResponsesProxyTaskDeps = LlsTaskRequestInjectionDeps;

/**
 * OpenAI Responses API 转发适配器。
 *
 * 负责 Anthropic → OpenAI Responses → Anthropic 的协议双向转换，并支持任务流
 * 注入、调试落盘、流式转换和任务流工具本地拦截。
 */
export class OpenAIResponsesProxyAdapter implements UpstreamAdapter {
    /** 适配器对应的 apiType。 */
    public readonly apiType: ApiType = 'v1-response';

    /**
     * 创建 OpenAI Responses 转发适配器。
     *
     * @param recorder 可选调试记录器。
     * @param taskDeps 可选任务流依赖。
     * @param usageSink 可选 token 使用量上报回调；用于把上游 usage 透传到 Chat UI。
     * @param tokenBudget 可选 token 预算服务；在每次发送前/接收后做累计与自动压缩判定。
     */
    public constructor(
        private readonly recorder?: DebugRecorder,
        private readonly taskDeps?: OpenAIResponsesProxyTaskDeps,
        private readonly usageSink?: UsageSink,
        private readonly tokenBudget?: TokenBudgetService,
        private readonly fileOpenObserver?: (toolName: string, input: unknown) => void
    ) {}

    /**
     * 从 Anthropic 形态的请求体里提取 CLI 纯 session_id。
     *
     * CLI 通常会把 `{device_id, account_uuid, session_id}` 序列化后塞进
     * `metadata.user_id`；这里优先解析其中的 session_id 字段，保证与 webview
     * 收到的 stream-json `session/init` 事件 sessionId 对齐。
     *
     * @param parsedBody 已解析的请求体 JSON。
     * @returns CLI 纯 session_id 字符串；取不到时返回空串。
     */
    private extractSessionId(parsedBody: unknown): string {
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
     * 处理一次 Claude Code `/v1/messages` 请求。
     *
     * @param ctx 上游请求上下文。
     */
    public async handle(ctx: UpstreamRequestContext): Promise<void> {
        const startedAt = Date.now();
        const { req, res, provider, modelId, rawBody, parsedBody } = ctx;
        if (this.recorder) {
            try {
                await this.recorder.recordCliToolJsonErrors(parsedBody, { providerId: provider.id, modelId, sessionId: ctx.usageContext?.sessionId || this.extractSessionId(parsedBody) });
            } catch (error) {
                Logger.warn(`[tool-json] 保存 CLI 错误反馈失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        let upstreamUrl: URL;
        try {
            upstreamUrl = joinUpstreamUrl(provider.baseUrl, OPENAI_RESPONSES_PATH);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.writeJsonError(res, 502, buildAnthropicErrorFromUpstream(502, message));
            await this.safeRecord(ctx, startedAt, provider.baseUrl, {}, rawBody, '', undefined, undefined, 502, {}, message);
            return;
        }

        const injectedBodyText = injectLlsTaskRequestBody(
            this.rewriteAnthropicModel(rawBody, parsedBody, modelId),
            this.taskDeps,
            { createTriggered: ctx.llsTaskCreateTriggered === true, modelName: modelId }
        ).bodyText;
        // token 预算登记（在 Anthropic 形态下估算，不改写 body）
        try {
            const sessionId = this.extractSessionId(parsedBody);
            if (sessionId) {
                this.tokenBudget?.beforeSend({
                    sessionId,
                    providerId: provider.id,
                    modelId,
                    anthropicBody: injectedBodyText,
                    compactCommandTriggered: ctx.compactCommandTriggered === true
                });
            }
        } catch (err) {
            Logger.warn(`[tokenBudget] beforeSend 调用异常：${err instanceof Error ? err.message : String(err)}`);
        }
        await this.safeRecordRequestBody(injectedBodyText);
        const anthropicBody = this.parseJson(injectedBodyText);
        const explicitCache = resolveModelExplicitCache(provider, modelId);
        const reasoningMode = resolveReasoningMode(provider, modelId);
        const converted = convertAnthropicToOpenAIResponses(anthropicBody, {
            cacheMode: resolveModelCacheMode(provider, modelId),
            reasoningMode,
            reasoningEffort: ctx.reasoningEffort,
            explicitCache,
            cacheSessionId: explicitCache ? extractExplicitCacheSessionId(anthropicBody) : undefined
        });
        const upstreamBodyText = JSON.stringify(converted.body);
        const headers = buildOpenAIForwardHeaders(provider, req.headers);
        headers['content-length'] = String(Buffer.byteLength(upstreamBodyText, 'utf-8'));

        Logger.info(
            `OpenAI Responses 转发：${upstreamUrl.toString()} model=${modelId} auth=${JSON.stringify(
                describeOpenAIAuthHeaders(provider, headers)
            )} headers=${JSON.stringify(redactHeaders(headers))}`
        );
        await this.forward({ ctx, startedAt, upstreamUrl, headers, anthropicBodyText: injectedBodyText, upstreamBodyText, reasoningMode });
    }

    /**
     * 执行实际 HTTP 请求并根据响应类型转换回 Anthropic。
     *
     * @param args 转发参数。
     */
    private async forward(args: {
        ctx: UpstreamRequestContext;
        startedAt: number;
        upstreamUrl: URL;
        headers: Record<string, string>;
        anthropicBodyText: string;
        upstreamBodyText: string;
        /** 请求开始时冻结模型思考策略，响应侧遵循同一个开关。 */
        reasoningMode: ModelReasoningMode;
    }): Promise<void> {
        const { ctx, startedAt, upstreamUrl, headers, anthropicBodyText, upstreamBodyText, reasoningMode } = args;
        const transport = upstreamUrl.protocol === 'http:' ? http : https;
        const options: http.RequestOptions = {
            method: 'POST',
            protocol: upstreamUrl.protocol,
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (upstreamUrl.protocol === 'http:' ? 80 : 443),
            path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
            headers
        };
        let responseStatus: number | undefined;
        let responseHeaders: Record<string, string | string[] | undefined> = {};
        let responseBody = '';
        let upstreamResponseBody = '';
        let streamRecording: Promise<void> | undefined;
        let errorMessage: string | undefined;
        const requestUsage = getRequestUsageReporter(ctx, this.usageSink);

        await new Promise<void>((resolve) => {
            let settled = false;
            let gotHeaders = false;
            /** 客户端断开监听的解绑函数，上游请求发出后才有值。 */
            let unbindClientAbort: (() => void) | undefined;
            const finish = () => {
                if (settled) return;
                settled = true;
                requestUsage.end(errorMessage || (responseStatus ?? 500) >= 400 ? 'error' : undefined);
                clearTimeout(firstByteTimer);
                // 本轮已结算，解除断开监听，避免正常收尾阶段再去 destroy 上游。
                unbindClientAbort?.();
                resolve();
            };
            const firstByteTimer = setTimeout(() => {
                if (gotHeaders) return;
                const seconds = Math.round(UPSTREAM_FIRST_BYTE_TIMEOUT_MS / 1000);
                errorMessage = `上游首字节超时（${seconds}s）`;
                Logger.error(`OpenAI Responses 上游首字节 ${seconds}s 超时，主动断开：${upstreamUrl.toString()}`);
                requestUsage.end('timeout');
                ctx.outcome?.fail('upstream_first_byte', 'first_byte_timeout');
                ctx.onUpstreamTimeout?.('first_byte');
                try {
                    upstreamReq.destroy(new Error(errorMessage));
                } catch {
                    // ignore
                }
                const isStream = ctx.res.headersSent && !ctx.res.writableEnded;
                this.writeStreamOrJsonError(ctx.res, isStream, 'timeout', errorMessage);
                finish();
            }, UPSTREAM_FIRST_BYTE_TIMEOUT_MS);
            const upstreamReq = transport.request(options, (upstreamRes) => {
                gotHeaders = true;
                clearTimeout(firstByteTimer);
                responseStatus = upstreamRes.statusCode;
                responseHeaders = upstreamRes.headers;
                ctx.outcome?.headers(upstreamRes.statusCode, upstreamRes.headers['retry-after']);
                const isStream = this.isEventStream(upstreamRes.headers['content-type']);
                upstreamRes.once('aborted', () => { ctx.outcome?.fail('upstream_stream', 'ECONNRESET'); requestUsage.end('aborted'); finish(); });
                upstreamRes.once('error', (err) => { ctx.outcome?.fail('upstream_stream', (err as NodeJS.ErrnoException).code); requestUsage.end('error'); finish(); });
                const chunks: Buffer[] = [];
                if ((upstreamRes.statusCode ?? 500) >= 400) {
                    upstreamRes.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
                    upstreamRes.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf-8');
                        upstreamResponseBody = body;
                        try { ctx.outcome?.json(JSON.parse(body)); } catch { /* HTTP 状态已记录。 */ }
                        const error = buildAnthropicErrorFromUpstream(upstreamRes.statusCode ?? 500, body);
                        responseBody = JSON.stringify(error);
                        this.writeJsonError(ctx.res, upstreamRes.statusCode ?? 500, error);
                        finish();
                    });
                    return;
                }
                if (isStream) {
                    streamRecording = this.handleStreamResponse(ctx, upstreamRes, (body) => { responseBody = body; }, (body) => { upstreamResponseBody = body; }, finish, startedAt, upstreamBodyText, reasoningMode);
                    return;
                }
                upstreamRes.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
                upstreamRes.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    upstreamResponseBody = body;
                    responseBody = this.handleJsonResponse(ctx, upstreamRes.statusCode ?? 200, upstreamRes.headers, body, reasoningMode);
                    finish();
                });
                upstreamRes.on('error', (err) => {
                    ctx.outcome?.fail('upstream_stream', (err as NodeJS.ErrnoException).code);
                    errorMessage = err.message;
                    this.writeStreamOrJsonError(ctx.res, isStream, 'api_error', `上游响应流中断：${err.message}`);
                    finish();
                });
            });
            upstreamReq.on('error', (err) => {
                if (settled) return;
                ctx.outcome?.fail('upstream_connect', (err as NodeJS.ErrnoException).code);
                errorMessage = err.message;
                this.writeJsonError(ctx.res, 502, buildAnthropicErrorFromUpstream(502, err.message));
                finish();
            });
            // 提前关闭只记录一次中断，正常 finish 后忽略。
            ctx.res.once('close', () => {
                if (!settled) { ctx.outcome?.fail(undefined, 'client_aborted', true); requestUsage.end('aborted'); finish(); }
            });
            upstreamReq.write(upstreamBodyText);
            // 客户端中途断开时销毁上游请求（替代已废弃的 req 'aborted'）。
            unbindClientAbort = bindClientAbortToUpstream(ctx.res, upstreamReq, 'OpenAI Responses');

            upstreamReq.end();
        });

        await streamRecording;
        await this.safeRecord(
            ctx,
            startedAt,
            upstreamUrl.toString(),
            redactHeaders(headers),
            anthropicBodyText,
            responseBody,
            upstreamBodyText,
            upstreamResponseBody,
            responseStatus,
            responseHeaders,
            errorMessage
        );
    }

    /**
     * 处理非流式 OpenAI Responses JSON 响应。
     *
     * @param ctx 请求上下文。
     * @param statusCode 上游状态码。
     * @param headers 上游响应头。
     * @param body 上游响应体。
     * @param reasoningMode 请求开始时的思考内容透传策略。
     * @returns 转换后的 Anthropic 响应体文本。
     */
    private handleJsonResponse(
        ctx: UpstreamRequestContext,
        statusCode: number,
        headers: Record<string, string | string[] | undefined>,
        body: string,
        reasoningMode: ModelReasoningMode
    ): string {
        try {
            const parsed = JSON.parse(body) as unknown;
            ctx.outcome?.json(parsed);
            const inlineError = this.buildInlineResponsesJsonError(statusCode, parsed);
            if (inlineError) {
                const errorBody = JSON.stringify(inlineError.body);
                this.writeJsonError(ctx.res, inlineError.statusCode, inlineError.body);
                return errorBody;
            }
            const converted = convertResponsesJsonToAnthropic(parsed, reasoningMode);
            const anthropicBody = JSON.stringify(converted.body);
            const intercepted = this.taskDeps
                ? interceptAnthropicResponse(anthropicBody, 'application/json', this.toInterceptorDeps())
                : { body: anthropicBody };
            // 在 Anthropic 转换完成后立即抽取 usage 并上报给 Chat UI。
            const usageReporter = getRequestUsageReporter(ctx, this.usageSink);
            usageReporter.feedJson(intercepted.body);
            ctx.res.statusCode = statusCode;
            this.copyResponseHeaders(ctx.res, headers, 'application/json; charset=utf-8');
            ctx.res.end(intercepted.body);
            return intercepted.body;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.outcome?.fail('upstream_inline_error', 'invalid_json');
            getRequestUsageReporter(ctx, this.usageSink).end('error');
            const error = buildAnthropicErrorFromUpstream(502, message);
            this.writeJsonError(ctx.res, 502, error);
            return JSON.stringify(error);
        }
    }

    /**
     * 将 HTTP 2xx 内联返回的 Responses error / failed JSON 转为 Anthropic 错误。
     *
     * 有些 Responses 兼容服务会在 HTTP 200 下返回 `{ error: ... }` 或
     * `{ status: 'failed', error: ... }`。这类响应不能继续走 message 转换，
     * 否则会变成空 assistant message；这里统一改写为 Anthropic JSON error。
     *
     * @param statusCode 上游 HTTP 状态码。
     * @param parsed 已解析的 Responses JSON。
     * @returns Anthropic 错误状态与 body；非错误响应返回 undefined。
     */
    private buildInlineResponsesJsonError(
        statusCode: number,
        parsed: unknown
    ): { statusCode: number; body: { type: 'error'; error: { type: string; message: string } } } | undefined {
        if (!parsed || typeof parsed !== 'object') return undefined;
        const source = parsed as Record<string, unknown>;
        const hasTopLevelError = source.error !== undefined && source.error !== null;
        const isFailedResponse = source.status === 'failed';
        if (!hasTopLevelError && !isFailedResponse) return undefined;
        const effectiveStatus = statusCode >= 400 ? statusCode : 502;
        const message = this.readResponsesJsonErrorMessage(source) || 'OpenAI Responses 返回错误响应';
        return {
            statusCode: effectiveStatus,
            body: {
                type: 'error',
                error: {
                    type: effectiveStatus === 429 ? 'rate_limit_error' : 'api_error',
                    message: sanitizeErrorMessage(message)
                }
            }
        };
    }

    /**
     * 从 Responses JSON 错误结构中读取人类可读 message。
     *
     * @param source Responses JSON 对象。
     * @returns 错误消息；没有时返回空字符串。
     */
    private readResponsesJsonErrorMessage(source: Record<string, unknown>): string {
        const error = source.error;
        if (typeof error === 'string') return error;
        if (error && typeof error === 'object') {
            const record = error as Record<string, unknown>;
            if (typeof record.message === 'string') return record.message;
            if (typeof record.code === 'string') return record.code;
        }
        if (typeof source.message === 'string') return source.message;
        return '';
    }

    /**
     * 处理流式 OpenAI Responses SSE 响应。
     *
     * @param ctx 请求上下文。
     * @param upstreamRes 上游响应。
     * @param captureBody 捕获转换后响应体的回调。
     * @param captureUpstreamBody 捕获上游原始 SSE 的回调。
     * @param resolve 完成回调。
     * @param startedAt 本次请求开始时间。
     * @param upstreamBodyText 实际出站请求，仅抽取输出预算和思考配置用于诊断。
     * @param reasoningMode 请求开始时冻结的思考内容透传策略。
     * @returns 流结束后的异常响应快照写入任务。
     */
    private handleStreamResponse(
        ctx: UpstreamRequestContext,
        upstreamRes: http.IncomingMessage,
        captureBody: (body: string) => void,
        captureUpstreamBody: (body: string) => void,
        resolve: () => void,
        startedAt: number,
        upstreamBodyText: string,
        reasoningMode: ModelReasoningMode
    ): Promise<void> {
        ctx.res.statusCode = upstreamRes.statusCode ?? 200;
        this.copyResponseHeaders(ctx.res, upstreamRes.headers, 'text/event-stream; charset=utf-8');
        const diagnostics: string[] = [];
        const converter = new OpenAIResponsesToAnthropicStreamConverter((message) => {
            diagnostics.push(message);
            Logger.warn(message);
        }, reasoningMode);
        const interceptor = this.taskDeps ? new LlsTaskStreamingInterceptor(this.toInterceptorDeps()) : undefined;
        // 每次响应独立的 usage 抽取器，吃下行 Anthropic SSE。
        const usageReporter = getRequestUsageReporter(ctx, this.usageSink);
        const chunks: string[] = [];
        const upstreamChunks: Buffer[] = [];
        const decoder = new StringDecoder('utf8');
        let decoderEnded = false;
        /** 流结束或中断时只刷新一次残留字节，并交给同一转换器处理。 */
        const finishConversion = (): string => {
            if (decoderEnded) return converter.end();
            decoderEnded = true;
            const tail = decoder.end();
            if (tail) ctx.outcome?.feed(tail);
            return converter.feed(tail) + converter.end();
        };
        let recorded = false;
        let finishRecording!: () => void;
        const recording = new Promise<void>((done) => { finishRecording = done; });
        /** 所有结束路径只保存一次；保留原始字节，避免 UTF-8 跨 chunk 的诊断内容损坏。 */
        const recordToolJsonStream = (reason: string): void => {
            if (recorded) return;
            recorded = true;
            ctx.res.off('close', onClientClose);
            const raw = Buffer.concat(upstreamChunks);
            const rawSse = raw.toString('utf-8');
            captureBody(chunks.join(''));
            captureUpstreamBody(rawSse);
            if (converter.getWarnings().some(warning => warning.code === 'tool_arguments_conflict')) {
                ctx.outcome?.fail('upstream_stream', 'tool_arguments_conflict');
                usageReporter.end('error');
            }
            if (!this.recorder) {
                finishRecording();
                return;
            }
            const requestParameters: Record<string, unknown> = {};
            try {
                const body = JSON.parse(upstreamBodyText) as Record<string, unknown>;
                for (const key of ['max_tokens', 'max_output_tokens', 'max_completion_tokens', 'reasoning', 'thinking', 'output_config', 'stream']) {
                    if (body[key] !== undefined) requestParameters[key] = body[key];
                }
            } catch { /* 请求参数无法解析不影响保存响应证据。 */ }
            const evidence: ToolJsonErrorSnapshot = {
                protocol: 'responses', requestId: ctx.usageContext?.requestId,
                sessionId: ctx.usageContext?.sessionId || this.extractSessionId(ctx.parsedBody), providerId: ctx.provider.id, modelId: ctx.modelId,
                startedAt, endedAt: Date.now(), reason, httpStatus: upstreamRes.statusCode,
                httpComplete: upstreamRes.complete, readableEnded: upstreamRes.readableEnded, destroyed: upstreamRes.destroyed,
                requestParameters, upstreamResponseBytes: raw.length, upstreamResponseBody: rawSse,
                upstreamResponseBase64: Buffer.from(rawSse, 'utf-8').equals(raw) ? undefined : raw.toString('base64'),
                responseBody: chunks.join(''), diagnostics: [...diagnostics], warnings: converter.getWarnings()
            };
            this.recorder.rememberToolResponse(evidence, converter.getToolCallIds());
            if (diagnostics.length === 0) {
                finishRecording();
                return;
            }
            void this.recorder.recordToolJsonError(evidence).catch((error) => {
                Logger.warn(`[tool-json] 保存异常响应失败：${error instanceof Error ? error.message : String(error)}`);
            }).finally(finishRecording);
        };
        /** 客户端中断时也检查已经收到的工具参数，不向已关闭的连接补写响应。 */
        const onClientClose = (): void => {
            if (recorded) return;
            finishConversion();
            recordToolJsonStream('client_closed');
        };
        ctx.res.once('close', onClientClose);
        upstreamRes.setTimeout(UPSTREAM_STREAM_IDLE_TIMEOUT_MS, () => {
            const seconds = Math.round(UPSTREAM_STREAM_IDLE_TIMEOUT_MS / 1000);
            const message = sanitizeErrorMessage(`上游流式响应空闲超时（${seconds}s）`);
            ctx.outcome?.fail('upstream_stream', 'stream_idle_timeout');
            ctx.onUpstreamTimeout?.('stream_idle');
            const out = finishConversion() + formatAnthropicSseError('timeout', message);
            chunks.push(out);
            recordToolJsonStream('stream_idle_timeout');
            if (!ctx.res.writableEnded) {
                ctx.res.write(out);
                ctx.res.end();
            }
            usageReporter.end('timeout');
            upstreamRes.destroy(new Error(message));
            resolve();
        });
        upstreamRes.on('data', (chunk: Buffer | string) => {
            if (decoderEnded) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
            upstreamChunks.push(bytes);
            const text = decoder.write(bytes);
            ctx.outcome?.feed(text);
            const converted = converter.feed(text);
            if (!converted) return;
            const out = interceptor ? interceptor.feed(converted) : converted;
            chunks.push(out);
            usageReporter.feed(out);
            ctx.res.write(out);
        });
        upstreamRes.on('end', () => {
            const tail = finishConversion();
            const out = interceptor ? interceptor.feed(tail) + interceptor.end() : tail;
            chunks.push(out);
            recordToolJsonStream('http_end');
            if (out) {
                usageReporter.feed(out);
                ctx.res.write(out);
            }
            usageReporter.end();
            if (!ctx.res.writableEnded) ctx.res.end();
            resolve();
        });
        upstreamRes.on('error', (err) => {
                    ctx.outcome?.fail('upstream_stream', (err as NodeJS.ErrnoException).code);
            const message = sanitizeErrorMessage(`上游响应流中断：${err.message}`);
            const out = finishConversion() + formatAnthropicSseError('api_error', message);
            chunks.push(out);
            recordToolJsonStream(`http_error: ${err.message}`);
            if (!ctx.res.writableEnded) {
                ctx.res.write(out);
                ctx.res.end();
            }
            usageReporter.end('error');
            resolve();
        });
        upstreamRes.once('close', () => {
            if (recorded) return;
            const tail = finishConversion();
            if (tail) chunks.push(tail);
            recordToolJsonStream('upstream_closed');
            resolve();
        });
        return recording;
    }

    /**
     * 将 Anthropic 请求中的 model 改写为纯 modelId。
     *
     * @param rawBody 原始请求体。
     * @param parsedBody 已解析请求体。
     * @param modelId 目标 modelId。
     * @returns 改写后的 Anthropic 请求体文本。
     */
    private rewriteAnthropicModel(rawBody: string, parsedBody: unknown, modelId: string): string {
        if (parsedBody && typeof parsedBody === 'object') {
            return JSON.stringify({ ...(parsedBody as Record<string, unknown>), model: modelId });
        }
        return rawBody;
    }

    /**
     * 解析 JSON 文本。
     *
     * @param text JSON 文本。
     * @returns 解析后的值。
     */
    private parseJson(text: string): unknown {
        return JSON.parse(text) as unknown;
    }

    /**
     * 判断 content-type 是否为 SSE。
     *
     * @param value content-type header。
     * @returns 是否为 text/event-stream。
     */
    private isEventStream(value: string | string[] | undefined): boolean {
        const text = Array.isArray(value) ? value.join(';') : value ?? '';
        return text.toLowerCase().includes('text/event-stream');
    }

    /**
     * 复制响应头并强制设置 content-type。
     *
     * @param res 下游响应。
     * @param headers 上游响应头。
     * @param contentType 下游 content-type。
     */
    private copyResponseHeaders(res: http.ServerResponse, headers: Record<string, string | string[] | undefined>, contentType: string): void {
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'content-length' || key.toLowerCase() === 'content-encoding') continue;
            const value = headers[key];
            if (value === undefined) continue;
            try {
                res.setHeader(key, value);
            } catch {
                // 非法响应头忽略。
            }
        }
        res.setHeader('content-type', contentType);
    }

    /**
     * 写入 JSON 错误响应。
     *
     * @param res 下游响应。
     * @param status HTTP 状态码。
     * @param body Anthropic 错误体。
     */
    private writeJsonError(res: http.ServerResponse, status: number, body: { type: 'error'; error: { type: string; message: string } }): void {
        if (res.headersSent) {
            if (!res.writableEnded) res.end();
            return;
        }
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
    }

    /**
     * 根据响应是否已按流式启动写入错误。
     *
     * @param res 下游响应。
     * @param stream 是否为 SSE。
     * @param type Anthropic 错误类型。
     * @param message 错误消息。
     */
    private writeStreamOrJsonError(res: http.ServerResponse, stream: boolean, type: string, message: string): void {
        if (stream && res.headersSent && !res.writableEnded) {
            res.write(formatAnthropicSseError(type, message));
            res.end();
            return;
        }
        this.writeJsonError(res, 502, { type: 'error', error: { type, message: sanitizeErrorMessage(message) } });
    }

    /**
     * 把请求注入依赖转换为响应拦截器依赖。
     *
     * @returns 响应拦截器依赖。
     */
    private toInterceptorDeps(): LlsTaskInterceptorDeps {
        if (!this.taskDeps) throw new Error('任务流依赖不存在');
        return {
            service: this.taskDeps.llsTaskService,
            autoContinueScheduler: this.taskDeps.autoContinueScheduler,
            onFileTool: this.fileOpenObserver
        };
    }

    /**
     * 写入当前请求最终 Anthropic body，捕获并吞掉所有异常。
     *
     * @param bodyText 已注入工具、协议转换前的 Anthropic 请求体文本。
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
     * 安全记录调试 messages。
     *
     * @param ctx 请求上下文。
     * @param startedAt 开始时间。
     * @param upstreamUrl 上游 URL。
     * @param requestHeaders 已脱敏请求头。
     * @param requestBody Anthropic 请求体。
     * @param responseBody Anthropic 响应体。
     * @param upstreamRequestBody Responses 请求体。
     * @param upstreamResponseBody Responses 原始响应体。
     * @param responseStatus 响应状态。
     * @param responseHeaders 响应头。
     * @param error 错误消息。
     */
    private async safeRecord(
        ctx: UpstreamRequestContext,
        startedAt: number,
        upstreamUrl: string,
        requestHeaders: Record<string, string>,
        requestBody: string,
        responseBody: string,
        upstreamRequestBody: string | undefined,
        upstreamResponseBody: string | undefined,
        responseStatus: number | undefined,
        responseHeaders: Record<string, string | string[] | undefined>,
        error?: string
    ): Promise<void> {
        if (!this.recorder) return;
        await this.recorder.recordChatSnapshot({
            sessionId: ctx.usageContext?.sessionId,
            providerId: ctx.provider.id,
            modelId: ctx.modelId,
            upstreamUrl,
            method: 'POST',
            requestHeaders,
            requestBody,
            upstreamRequestBody,
            responseStatus,
            responseHeaders,
            responseBody,
            upstreamResponseBody,
            startedAt,
            endedAt: Date.now(),
            error
        });
    }

    /**
     * 安全写入协议转换调试快照。
     *
     * @param stage 快照阶段。
     * @param ctx 请求上下文。
     * @param startedAt 开始时间。
     * @param upstreamUrl 上游 URL。
     * @param requestHeaders 已脱敏请求头。
     * @param requestBody Anthropic 请求体。
     * @param responseBody 转换后的 Anthropic 响应体。
     * @param upstreamRequestBody Responses 请求体。
     * @param upstreamRequestHeaders Responses 请求头。
     * @param upstreamResponseBody Responses 原始响应体。
     * @param responseStatus 响应状态。
     * @param responseHeaders 响应头。
     * @param error 错误消息。
     */
    private async safeRecordSnapshot(
        stage: 'request' | 'response', ctx: UpstreamRequestContext, startedAt: number, upstreamUrl: string,
        requestHeaders: Record<string, string>, requestBody: string, responseBody: string,
        upstreamRequestBody: string | undefined, upstreamRequestHeaders: Record<string, string> | undefined,
        upstreamResponseBody: string | undefined, responseStatus: number | undefined,
        responseHeaders: Record<string, string | string[] | undefined>, error?: string
    ): Promise<void> {
        void stage;
        void upstreamRequestHeaders;
        await this.safeRecord(ctx, startedAt, upstreamUrl, requestHeaders, requestBody, responseBody, upstreamRequestBody, upstreamResponseBody, responseStatus, responseHeaders, error);
    }

}
