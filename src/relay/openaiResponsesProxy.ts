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

import { Logger } from '../logger';
import { interceptAnthropicResponse } from '../llsTask/interceptor';
import { LlsTaskStreamingInterceptor } from '../llsTask/streamingInterceptor';
import type { ApiType } from '../types';
import { convertAnthropicToOpenAIResponses } from './converters/anthropicToOpenAIResponses';
import { buildAnthropicErrorFromUpstream, formatAnthropicSseError, sanitizeErrorMessage } from './converters/openAIErrorToAnthropic';
import { convertResponsesJsonToAnthropic, OpenAIResponsesToAnthropicStreamConverter } from './converters/openAIResponsesToAnthropic';
import type { DebugRecorder } from './debugRecorder';
import { buildForwardHeaders, redactHeaders } from './forwardHeadersCommon';
import { buildOpenAIForwardHeaders, describeOpenAIAuthHeaders } from './openAIHeaders';
import type { UpstreamAdapter, UpstreamRequestContext } from './router';
import { injectLlsTaskRequestBody, type LlsTaskRequestInjectionDeps } from './taskRequestInjection';
import type { TokenBudgetService } from './tokenBudget/service';
import { joinUpstreamUrl } from './upstreamUrl';
import { UPSTREAM_FIRST_BYTE_TIMEOUT_MS, UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from './upstreamTimeouts';
import { UsageReporter, type UsageSink } from './usageReporter';

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
        private readonly tokenBudget?: TokenBudgetService
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
                    anthropicBody: injectedBodyText
                });
            }
        } catch (err) {
            Logger.warn(`[tokenBudget] beforeSend 调用异常：${err instanceof Error ? err.message : String(err)}`);
        }
        await this.safeRecordRequestBody(injectedBodyText);
        const anthropicBody = this.parseJson(injectedBodyText);
        const converted = convertAnthropicToOpenAIResponses(anthropicBody);
        const upstreamBodyText = JSON.stringify(converted.body);
        const headers = buildOpenAIForwardHeaders(provider, req.headers);
        headers['content-length'] = String(Buffer.byteLength(upstreamBodyText, 'utf-8'));

        Logger.info(
            `OpenAI Responses 转发：${upstreamUrl.toString()} model=${modelId} auth=${JSON.stringify(
                describeOpenAIAuthHeaders(provider, headers)
            )} headers=${JSON.stringify(redactHeaders(headers))}`
        );
        await this.forward({ ctx, startedAt, upstreamUrl, headers, anthropicBodyText: injectedBodyText, upstreamBodyText });
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
    }): Promise<void> {
        const { ctx, startedAt, upstreamUrl, headers, anthropicBodyText, upstreamBodyText } = args;
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
        let errorMessage: string | undefined;

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
                Logger.error(`OpenAI Responses 上游首字节 ${seconds}s 超时，主动断开：${upstreamUrl.toString()}`);
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
                const isStream = this.isEventStream(upstreamRes.headers['content-type']);
                const chunks: Buffer[] = [];
                if ((upstreamRes.statusCode ?? 500) >= 400) {
                    upstreamRes.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
                    upstreamRes.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf-8');
                        upstreamResponseBody = body;
                        const error = buildAnthropicErrorFromUpstream(upstreamRes.statusCode ?? 500, body);
                        responseBody = JSON.stringify(error);
                        this.writeJsonError(ctx.res, upstreamRes.statusCode ?? 500, error);
                        finish();
                    });
                    return;
                }
                if (isStream) {
                    this.handleStreamResponse(ctx, upstreamRes, (body) => { responseBody = body; }, (body) => { upstreamResponseBody = body; }, finish);
                    return;
                }
                upstreamRes.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
                upstreamRes.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    upstreamResponseBody = body;
                    responseBody = this.handleJsonResponse(ctx, upstreamRes.statusCode ?? 200, upstreamRes.headers, body);
                    finish();
                });
                upstreamRes.on('error', (err) => {
                    errorMessage = err.message;
                    this.writeStreamOrJsonError(ctx.res, isStream, 'api_error', `上游响应流中断：${err.message}`);
                    finish();
                });
            });
            upstreamReq.on('error', (err) => {
                if (settled) return;
                errorMessage = err.message;
                this.writeJsonError(ctx.res, 502, buildAnthropicErrorFromUpstream(502, err.message));
                finish();
            });
            upstreamReq.write(upstreamBodyText);
            upstreamReq.end();
        });

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
     * @returns 转换后的 Anthropic 响应体文本。
     */
    private handleJsonResponse(
        ctx: UpstreamRequestContext,
        statusCode: number,
        headers: Record<string, string | string[] | undefined>,
        body: string
    ): string {
        try {
            const parsed = JSON.parse(body) as unknown;
            const inlineError = this.buildInlineResponsesJsonError(statusCode, parsed);
            if (inlineError) {
                const errorBody = JSON.stringify(inlineError.body);
                this.writeJsonError(ctx.res, inlineError.statusCode, inlineError.body);
                return errorBody;
            }
            const converted = convertResponsesJsonToAnthropic(parsed);
            const anthropicBody = JSON.stringify(converted.body);
            const intercepted = this.taskDeps
                ? interceptAnthropicResponse(anthropicBody, 'application/json', this.toInterceptorDeps())
                : { body: anthropicBody };
            // 在 Anthropic 转换完成后立即抽取 usage 并上报给 Chat UI。
            const usageReporter = new UsageReporter(this.usageSink);
            usageReporter.feedJson(intercepted.body);
            ctx.res.statusCode = statusCode;
            this.copyResponseHeaders(ctx.res, headers, 'application/json; charset=utf-8');
            ctx.res.end(intercepted.body);
            return intercepted.body;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
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
        const hasTopLevelError = source.error !== undefined;
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
     */
    private handleStreamResponse(
        ctx: UpstreamRequestContext,
        upstreamRes: http.IncomingMessage,
        captureBody: (body: string) => void,
        captureUpstreamBody: (body: string) => void,
        resolve: () => void
    ): void {
        ctx.res.statusCode = upstreamRes.statusCode ?? 200;
        this.copyResponseHeaders(ctx.res, upstreamRes.headers, 'text/event-stream; charset=utf-8');
        const converter = new OpenAIResponsesToAnthropicStreamConverter();
        const interceptor = this.taskDeps ? new LlsTaskStreamingInterceptor(this.toInterceptorDeps()) : undefined;
        // 每次响应独立的 usage 抽取器，吃下行 Anthropic SSE。
        const usageReporter = new UsageReporter(this.usageSink);
        const chunks: string[] = [];
        const upstreamChunks: string[] = [];
        upstreamRes.setTimeout(UPSTREAM_STREAM_IDLE_TIMEOUT_MS, () => {
            const seconds = Math.round(UPSTREAM_STREAM_IDLE_TIMEOUT_MS / 1000);
            const message = sanitizeErrorMessage(`上游流式响应空闲超时（${seconds}s）`);
            ctx.onUpstreamTimeout?.('stream_idle');
            const out = converter.end() + formatAnthropicSseError('timeout', message);
            chunks.push(out);
            if (!ctx.res.writableEnded) {
                ctx.res.write(out);
                ctx.res.end();
            }
            captureBody(chunks.join(''));
            captureUpstreamBody(upstreamChunks.join(''));
            usageReporter.end();
            upstreamRes.destroy(new Error(message));
            resolve();
        });
        upstreamRes.on('data', (chunk: Buffer | string) => {
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
            upstreamChunks.push(text);
            const converted = converter.feed(text);
            if (!converted) return;
            const out = interceptor ? interceptor.feed(converted) : converted;
            chunks.push(out);
            usageReporter.feed(out);
            ctx.res.write(out);
        });
        upstreamRes.on('end', () => {
            const tail = converter.end();
            const out = interceptor ? interceptor.feed(tail) + interceptor.end() : tail;
            chunks.push(out);
            if (out) {
                usageReporter.feed(out);
                ctx.res.write(out);
            }
            usageReporter.end();
            if (!ctx.res.writableEnded) ctx.res.end();
            captureBody(chunks.join(''));
            captureUpstreamBody(upstreamChunks.join(''));
            resolve();
        });
        upstreamRes.on('error', (err) => {
            const message = sanitizeErrorMessage(`上游响应流中断：${err.message}`);
            const out = converter.end() + formatAnthropicSseError('api_error', message);
            chunks.push(out);
            if (!ctx.res.writableEnded) {
                ctx.res.write(out);
                ctx.res.end();
            }
            captureBody(chunks.join(''));
            captureUpstreamBody(upstreamChunks.join(''));
            usageReporter.end();
            resolve();
        });
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
    private toInterceptorDeps(): { service: NonNullable<OpenAIResponsesProxyTaskDeps>['llsTaskService']; autoContinueScheduler: NonNullable<OpenAIResponsesProxyTaskDeps>['autoContinueScheduler'] } {
        if (!this.taskDeps) throw new Error('任务流依赖不存在');
        return {
            service: this.taskDeps.llsTaskService,
            autoContinueScheduler: this.taskDeps.autoContinueScheduler
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
        await this.recorder.record({
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
     * 安全写入 request/response 调试快照。
     *
     * @param stage 快照阶段。
     * @param ctx 请求上下文。
     * @param startedAt 开始时间。
     * @param upstreamUrl 上游 URL。
     * @param requestHeaders 已脱敏请求头。
     * @param requestBody Anthropic 请求体。
     * @param responseBody Anthropic 响应体。
     * @param upstreamRequestBody 转换后提交给 Responses 的请求体。
     * @param upstreamRequestHeaders 转换后提交给 Responses 的请求头。
     * @param upstreamResponseBody Responses 原始响应体。
     * @param responseStatus 响应状态。
     * @param responseHeaders 响应头。
     * @param error 错误消息。
     */
    private async safeRecordSnapshot(
        stage: 'request' | 'response',
        ctx: UpstreamRequestContext,
        startedAt: number,
        upstreamUrl: string,
        requestHeaders: Record<string, string>,
        requestBody: string,
        responseBody: string,
        upstreamRequestBody: string | undefined,
        upstreamRequestHeaders: Record<string, string> | undefined,
        upstreamResponseBody: string | undefined,
        responseStatus: number | undefined,
        responseHeaders: Record<string, string | string[] | undefined>,
        error?: string
    ): Promise<void> {
        void stage;
        void ctx;
        void startedAt;
        void upstreamUrl;
        void requestHeaders;
        void requestBody;
        void responseBody;
        void upstreamRequestBody;
        void upstreamRequestHeaders;
        void upstreamResponseBody;
        void responseStatus;
        void responseHeaders;
        void error;
    }
}
