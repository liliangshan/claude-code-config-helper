/**
 * @file OpenAI Chat Completions 兼容提供商转发适配器。
 *
 * 接收 Claude Code 的 Anthropic Messages 请求，先按 Anthropic 形态注入任务流，
 * 再转换为 OpenAI Chat Completions 请求转发给上游，最后把 OpenAI 响应转换回
 * Anthropic Messages JSON / SSE。
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

import { Logger } from '../logger';
import { interceptAnthropicResponse } from '../llsTask/interceptor';
import { LlsTaskStreamingInterceptor } from '../llsTask/streamingInterceptor';
import type { ApiType } from '../types';
import { convertAnthropicToOpenAIChat } from './converters/anthropicToOpenAIChat';
import { buildAnthropicErrorFromUpstream, formatAnthropicSseError, sanitizeErrorMessage } from './converters/openAIErrorToAnthropic';
import { convertOpenAIChatJsonToAnthropic, OpenAIChatToAnthropicStreamConverter } from './converters/openAIChatToAnthropic';
import type { DebugRecorder } from './debugRecorder';
import { buildOpenAIForwardHeaders, describeOpenAIAuthHeaders } from './openAIHeaders';
import { buildForwardHeaders, redactHeaders } from './forwardHeadersCommon';
import type { UpstreamAdapter, UpstreamRequestContext } from './router';
import { injectLlsTaskRequestBody, type LlsTaskRequestInjectionDeps } from './taskRequestInjection';
import { joinUpstreamUrl } from './upstreamUrl';

/** OpenAI Chat Completions 路径。 */
const OPENAI_CHAT_COMPLETIONS_PATH = '/chat/completions';

/** OpenAI Chat Proxy 可选任务流依赖。 */
export type OpenAIChatProxyTaskDeps = LlsTaskRequestInjectionDeps;

/**
 * OpenAI Chat Completions 兼容适配器。
 *
 * 负责 Anthropic → OpenAI Chat → Anthropic 的协议双向转换，并支持任务流注入、
 * 调试落盘、流式转换和任务流工具本地拦截。
 */
export class OpenAIChatProxyAdapter implements UpstreamAdapter {
    /** 适配器对应的 apiType。 */
    public readonly apiType: ApiType = 'openai-compatible';

    /**
     * 创建 OpenAI Chat 兼容转发适配器。
     *
     * @param recorder 可选调试记录器。
     * @param taskDeps 可选任务流依赖。
     */
    public constructor(
        private readonly recorder?: DebugRecorder,
        private readonly taskDeps?: OpenAIChatProxyTaskDeps
    ) {}

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
            upstreamUrl = joinUpstreamUrl(provider.baseUrl, OPENAI_CHAT_COMPLETIONS_PATH);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.writeJsonError(res, 502, buildAnthropicErrorFromUpstream(502, message));
            await this.safeRecord(ctx, startedAt, provider.baseUrl, {}, rawBody, '', undefined, undefined, 502, {}, message);
            return;
        }

        const injectedBodyText = injectLlsTaskRequestBody(
            this.rewriteAnthropicModel(rawBody, parsedBody, modelId),
            this.taskDeps,
            { createTriggered: ctx.llsTaskCreateTriggered === true }
        ).bodyText;
        const anthropicBody = this.parseJson(injectedBodyText);
        const converted = convertAnthropicToOpenAIChat(anthropicBody);
        if (converted.warnings.length > 0) {
            Logger.warn(`OpenAI Chat 请求转换 warnings：${JSON.stringify(converted.warnings)}`);
        }
        const upstreamBodyText = JSON.stringify(converted.body);
        const headers = buildOpenAIForwardHeaders(provider, req.headers);
        headers['content-length'] = String(Buffer.byteLength(upstreamBodyText, 'utf-8'));

        Logger.info(
            `OpenAI Chat 转发：${upstreamUrl.toString()} model=${modelId} auth=${JSON.stringify(
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
            const upstreamReq = transport.request(options, (upstreamRes) => {
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
                        resolve();
                    });
                    return;
                }
                if (isStream) {
                    this.handleStreamResponse(ctx, upstreamRes, upstreamBodyText, (body) => { responseBody = body; }, resolve);
                    return;
                }
                upstreamRes.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
                upstreamRes.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    upstreamResponseBody = body;
                    responseBody = this.handleJsonResponse(ctx, upstreamRes.statusCode ?? 200, upstreamRes.headers, body);
                    resolve();
                });
                upstreamRes.on('error', (err) => {
                    errorMessage = err.message;
                    this.writeStreamOrJsonError(ctx.res, isStream, 'api_error', `上游响应流中断：${err.message}`);
                    resolve();
                });
            });
            upstreamReq.on('error', (err) => {
                errorMessage = err.message;
                this.writeJsonError(ctx.res, 502, buildAnthropicErrorFromUpstream(502, err.message));
                resolve();
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
     * 处理非流式 OpenAI JSON 响应。
     *
     * @param ctx 请求上下文。
     * @param statusCode 上游状态码。
     * @param headers 上游响应头。
     * @param body 上游响应体。
     */
    private handleJsonResponse(
        ctx: UpstreamRequestContext,
        statusCode: number,
        headers: Record<string, string | string[] | undefined>,
        body: string
    ): string {
        try {
            const converted = convertOpenAIChatJsonToAnthropic(JSON.parse(body) as unknown);
            if (converted.warnings.length > 0) {
                Logger.warn(`OpenAI Chat 响应转换 warnings：${JSON.stringify(converted.warnings)}`);
            }
            const anthropicBody = JSON.stringify(converted.body);
            const intercepted = this.taskDeps
                ? interceptAnthropicResponse(anthropicBody, 'application/json', this.toInterceptorDeps())
                : { body: anthropicBody };
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
     * 处理流式 OpenAI SSE 响应。
     *
     * @param ctx 请求上下文。
     * @param upstreamRes 上游响应。
     * @param upstreamBodyText 上游请求体文本，仅用于签名保持与调试上下文。
     * @param captureBody 捕获转换后响应体的回调。
     * @param resolve 完成回调。
     */
    private handleStreamResponse(
        ctx: UpstreamRequestContext,
        upstreamRes: http.IncomingMessage,
        upstreamBodyText: string,
        captureBody: (body: string) => void,
        resolve: () => void
    ): void {
        void upstreamBodyText;
        ctx.res.statusCode = upstreamRes.statusCode ?? 200;
        this.copyResponseHeaders(ctx.res, upstreamRes.headers, 'text/event-stream; charset=utf-8');
        const converter = new OpenAIChatToAnthropicStreamConverter();
        const interceptor = this.taskDeps ? new LlsTaskStreamingInterceptor(this.toInterceptorDeps()) : undefined;
        const chunks: string[] = [];
        upstreamRes.on('data', (chunk: Buffer | string) => {
            const converted = converter.feed(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk));
            if (!converted) return;
            const out = interceptor ? interceptor.feed(converted) : converted;
            chunks.push(out);
            ctx.res.write(out);
        });
        upstreamRes.on('end', () => {
            const tail = converter.end();
            const out = interceptor ? interceptor.feed(tail) + interceptor.end() : tail;
            chunks.push(out);
            if (out) ctx.res.write(out);
            if (!ctx.res.writableEnded) ctx.res.end();
            const warnings = converter.getWarnings();
            if (warnings.length > 0) Logger.warn(`OpenAI Chat SSE 转换 warnings：${JSON.stringify(warnings)}`);
            captureBody(chunks.join(''));
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
    private toInterceptorDeps(): { service: NonNullable<OpenAIChatProxyTaskDeps>['llsTaskService']; autoContinueScheduler: NonNullable<OpenAIChatProxyTaskDeps>['autoContinueScheduler'] } {
        if (!this.taskDeps) throw new Error('任务流依赖不存在');
        return {
            service: this.taskDeps.llsTaskService,
            autoContinueScheduler: this.taskDeps.autoContinueScheduler
        };
    }

    /**
     * 安全记录调试快照。
     *
     * @param ctx 请求上下文。
     * @param startedAt 开始时间。
     * @param upstreamUrl 上游 URL。
     * @param requestHeaders 已脱敏请求头。
     * @param requestBody Anthropic 请求体。
     * @param responseBody Anthropic 响应体或原始错误体。
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
    * 保留旧调用签名但不再写入 request/response 调试快照文件。
    *
    * 现在只保留 {@link safeRecord} 的按天 messages 聚合日志，避免落盘完整请求和响应体。
     *
     * @param stage 快照阶段。
     * @param ctx 请求上下文。
     * @param startedAt 开始时间。
     * @param upstreamUrl 上游 URL。
     * @param requestHeaders 已脱敏请求头。
     * @param requestBody Anthropic 请求体。
     * @param responseBody Anthropic 响应体。
     * @param upstreamRequestBody 转换后提交给 OpenAI Chat 的请求体。
    * @param upstreamRequestHeaders 转换后提交给 OpenAI Chat 的请求头。
     * @param upstreamResponseBody OpenAI Chat 原始响应体。
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

    /**
     * 保留旧调用签名但不再写入转换后的 OpenAI Chat 请求独立快照。
     *
     * 现在不再落盘完整 OpenAI Chat request body，避免产生额外调试文件。
     *
     * @param ctx 请求上下文。
     * @param startedAt 开始时间。
     * @param upstreamUrl 上游 URL。
     * @param anthropicBodyText 注入和改写后的 Anthropic 请求体。
     * @param upstreamBodyText 转换后提交给 OpenAI Chat 的请求体。
     * @param upstreamRequestHeaders 转换后提交给 OpenAI Chat 的请求头。
     */
    private async safeRecordOpenAIChatRequest(
        ctx: UpstreamRequestContext,
        startedAt: number,
        upstreamUrl: string,
        anthropicBodyText: string,
        upstreamBodyText: string,
        upstreamRequestHeaders: Record<string, string>
    ): Promise<void> {
        void ctx;
        void startedAt;
        void upstreamUrl;
        void anthropicBodyText;
        void upstreamBodyText;
        void upstreamRequestHeaders;
    }
}
