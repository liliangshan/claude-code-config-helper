/**
 * @file 自动压缩客户端。
 *
 * 当 TokenBudgetService 决定触发自动压缩时，调用 {@link CompactionClient.run} 发起
 * 一次非流式 Anthropic Messages 请求：携带完整历史 messages + 固定的压缩 system
 * prompt，要求模型输出纯 Markdown 正文。响应到达后 Relay 本地包装为
 * `<summ>${text}</summ>` 作为后续注入新 session 的内容。
 *
 * 失败判定：
 * - HTTP 状态 >= 400；
 * - 网络/超时错误；
 * - 空响应或长度 < 50 字（视为模型未理解或拒绝）。
 *
 * 任何失败都不抛出，而是返回 { ok: false, error } 结构，由 TokenBudgetService
 * 决定是否切 session。
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

import { Logger } from '../../logger';
import type { ProviderConfig } from '../../types';
import { convertAnthropicToOpenAIResponses } from '../converters/anthropicToOpenAIResponses';
import { convertResponsesJsonToAnthropic } from '../converters/openAIResponsesToAnthropic';
import { buildOpenAIForwardHeaders } from '../openAIHeaders';

/** 压缩任务的固定 system prompt。 */
export const COMPACT_SYSTEM_PROMPT = `你是一个对话上下文压缩器。

任务：阅读以下完整的多轮对话历史，输出一份"后续工作所需的最小上下文"。

输出要求：
1. 必须覆盖：当前正在进行的任务目标、已做出的关键决策、未完成的步骤、
   涉及的文件路径与变量名、用户的强约束（"不要做 X"、"必须用 Y"）、
   外部引用的 URL / Issue / PR 号。
2. 必须省略：寒暄、思考过程、已被推翻的中间方案、模型自己的措辞修饰。
3. 长度控制在 400~1200 个汉字（或等量英文）。
4. 用 Markdown，分小节："## 任务目标 / ## 关键决策 / ## 未完成 / ## 约束 / ## 引用"。
5. **不要使用任何 XML 标签包裹**，不要写"以下是摘要"之类的元话语，直接开始正文。

读者是同一个模型在下一轮对话里读取，请按它能理解的密度写。`;

/** 单次压缩请求的最大输出 token。 */
const COMPACT_MAX_TOKENS = 4000;

/** 压缩请求的超时（毫秒）。 */
const COMPACT_TIMEOUT_MS = 120000;

/** 视为失败的最小响应字符长度。 */
const MIN_VALID_LENGTH = 50;

/** 压缩成功结果。 */
export interface CompactionSuccess {
    /** 是否成功。 */
    ok: true;
    /** 模型输出的原始 Markdown 正文（未包标签）。 */
    summaryText: string;
    /** Relay 本地包装好的 `<summ>...</summ>` 字符串。 */
    wrapped: string;
}

/** 压缩失败结果。 */
export interface CompactionFailure {
    /** 是否成功。 */
    ok: false;
    /** 失败原因，已脱敏可直接展示。 */
    error: string;
}

/** 压缩结果联合类型。 */
export type CompactionResult = CompactionSuccess | CompactionFailure;

/** 压缩请求入参。 */
export interface CompactionRunInput {
    /** 目标提供商完整配置（含 apiKey）。 */
    provider: ProviderConfig;
    /** 目标 modelId（不带 providerId 前缀）。 */
    modelId: string;
    /** Anthropic messages 数组（原历史）。 */
    messages: unknown[];
    /** 原请求里的 system 字段；可选，传入则作为副 system 与压缩 system 一并下发。 */
    originalSystem?: unknown;
}

/**
 * 自动压缩客户端。
 *
 * 当前仅支持 `apiType=anthropic` 的 provider。OpenAI 两种 apiType 在压缩这个
 * 子任务上理论可走 Relay 内回环（让 Relay 自己跑一次完整的协议转换），第一版
 * 先用最简单的"直接打 Anthropic 兼容端点"路径——绝大多数 provider 都同时支持
 * Anthropic 路径，落地最小可用足够。
 */
export class CompactionClient {
    /**
     * 发起一次压缩请求。
     *
     * @param input 入参：provider / modelId / messages / 可选 system。
     * @returns 成功或失败结果；不抛异常。
     */
    public async run(input: CompactionRunInput): Promise<CompactionResult> {
        const { provider } = input;
        if (provider.apiType === 'anthropic') return this.runAnthropic(input);
        if (provider.apiType === 'openai-compatible') return this.runOpenAIChat(input);
        if (provider.apiType === 'v1-response') return this.runOpenAIResponses(input);
        return {
            ok: false,
            error: `compactor 暂不支持 apiType=${provider.apiType} 的 provider`
        };
    }

    /**
     * 通过 Anthropic Messages 协议发起压缩请求。
     *
     * @param input 压缩请求入参。
     * @returns 压缩结果。
     */
    private async runAnthropic(input: CompactionRunInput): Promise<CompactionResult> {
        const { provider, modelId, messages: sourceMessages, originalSystem } = input;
        let upstreamUrl: URL;
        try {
            upstreamUrl = this.buildUrl(provider.baseUrl);
        } catch (err) {
            return {
                ok: false,
                error: `provider.baseUrl 不合法：${err instanceof Error ? err.message : String(err)}`
            };
        }

        const compactMessages = [this.buildSingleUserContextMessage(sourceMessages)];
        const body = JSON.stringify({
            model: modelId,
            max_tokens: COMPACT_MAX_TOKENS,
            stream: false,
            system: this.composeSystem(originalSystem),
            messages: compactMessages
        });

        const headers: Record<string, string> = {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(Buffer.byteLength(body, 'utf-8')),
            'anthropic-version': '2023-06-01'
        };
        this.applyAuth(headers, provider);

        try {
            const result = await this.doRequest(upstreamUrl, headers, body);
            if (result.status >= 400) {
                return { ok: false, error: `上游返回 HTTP ${result.status}：${this.truncate(result.body)}` };
            }
            const summaryText = this.extractText(result.body);
            if (!summaryText || summaryText.length < MIN_VALID_LENGTH) {
                return { ok: false, error: `压缩响应过短或为空（长度=${summaryText.length}）` };
            }
            return { ok: true, summaryText, wrapped: `<summ>${summaryText}</summ>` };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget.compactor] 压缩请求失败：${message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * 通过 OpenAI Chat Completions 协议发起压缩请求。
     *
     * 将 Anthropic messages 粗略转换为 OpenAI messages：system prompt 放首条
     * system，user/assistant 文本内容保留，非文本块 JSON.stringify 后拼接。
     *
     * @param input 压缩请求入参。
     * @returns 压缩结果。
     */
    private async runOpenAIChat(input: CompactionRunInput): Promise<CompactionResult> {
        const { provider, modelId, messages, originalSystem } = input;
        let upstreamUrl: URL;
        try {
            upstreamUrl = this.buildOpenAIChatUrl(provider.baseUrl);
        } catch (err) {
            return {
                ok: false,
                error: `provider.baseUrl 不合法：${err instanceof Error ? err.message : String(err)}`
            };
        }
        const compactMessages = [this.buildSingleUserContextMessage(messages)];
        const openMessages = [
            { role: 'system', content: this.stringifySystem(this.composeSystem(originalSystem)) },
            ...compactMessages.map((message) => this.convertAnthropicMessageToOpenAI(message))
        ];
        const body = JSON.stringify({
            model: modelId,
            messages: openMessages,
            stream: false,
            max_tokens: COMPACT_MAX_TOKENS
        });
        const headers = buildOpenAIForwardHeaders(provider, {});
        headers['content-length'] = String(Buffer.byteLength(body, 'utf-8'));
        try {
            const result = await this.doRequest(upstreamUrl, headers, body);
            if (result.status >= 400) {
                return { ok: false, error: `上游返回 HTTP ${result.status}：${this.truncate(result.body)}` };
            }
            const summaryText = this.extractOpenAIChatText(result.body);
            if (!summaryText || summaryText.length < MIN_VALID_LENGTH) {
                return { ok: false, error: `压缩响应过短或为空（长度=${summaryText.length}）` };
            }
            return { ok: true, summaryText, wrapped: `<summ>${summaryText}</summ>` };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget.compactor] OpenAI 压缩请求失败：${message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * 通过 OpenAI Responses 协议发起压缩请求。
     *
     * @param input 压缩请求入参。
     * @returns 压缩结果。
     */
    private async runOpenAIResponses(input: CompactionRunInput): Promise<CompactionResult> {
        const { provider, modelId, messages, originalSystem } = input;
        let upstreamUrl: URL;
        try {
            upstreamUrl = this.buildOpenAIResponsesUrl(provider.baseUrl);
        } catch (err) {
            return {
                ok: false,
                error: `provider.baseUrl 不合法：${err instanceof Error ? err.message : String(err)}`
            };
        }
        const anthropicBody = {
            model: modelId,
            max_tokens: COMPACT_MAX_TOKENS,
            stream: false,
            system: this.composeSystem(originalSystem),
            messages: [this.buildSingleUserContextMessage(messages)]
        };
        const converted = convertAnthropicToOpenAIResponses(anthropicBody);
        const body = JSON.stringify(converted.body);
        const headers = buildOpenAIForwardHeaders(provider, {});
        headers['content-length'] = String(Buffer.byteLength(body, 'utf-8'));
        try {
            const result = await this.doRequest(upstreamUrl, headers, body);
            if (result.status >= 400) {
                return { ok: false, error: `上游返回 HTTP ${result.status}：${this.truncate(result.body)}` };
            }
            const summaryText = this.extractOpenAIResponsesText(result.body);
            if (!summaryText || summaryText.length < MIN_VALID_LENGTH) {
                return { ok: false, error: `压缩响应过短或为空（长度=${summaryText.length}）` };
            }
            return { ok: true, summaryText, wrapped: `<summ>${summaryText}</summ>` };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[tokenBudget.compactor] OpenAI Responses 压缩请求失败：${message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * 拼接最终下发到上游的 system 字段。
     *
     * 优先把压缩用的固定 prompt 放在最前面（强约束），原 system 作为附加上下文
     * 拼在后面。
     *
     * @param originalSystem 原请求里的 system 字段。
     * @returns 字符串或 ContentBlock 数组。
     */
    private composeSystem(originalSystem: unknown): unknown {
        if (typeof originalSystem === 'string' && originalSystem.trim()) {
            return `${COMPACT_SYSTEM_PROMPT}\n\n---\n\n原始 system 提示（仅供参考）：\n${originalSystem}`;
        }
        if (Array.isArray(originalSystem) && originalSystem.length > 0) {
            return [
                { type: 'text', text: COMPACT_SYSTEM_PROMPT },
                ...originalSystem
            ];
        }
        return COMPACT_SYSTEM_PROMPT;
    }

    /**
     * 拼接 provider.baseUrl 与 /messages 路径。
     *
     * @param baseUrl provider 的 baseUrl。
     * @returns 最终请求 URL。
     */
    private buildUrl(baseUrl: string): URL {
        const trimmed = (baseUrl || '').trim();
        if (!trimmed) throw new Error('provider.baseUrl 为空');
        const url = new URL(trimmed);
        if (url.pathname.endsWith('/messages')) return url;
        const base = url.pathname.replace(/\/+$/, '');
        url.pathname = `${base}/messages`;
        return url;
    }

    /**
     * 按 provider.authMode 注入鉴权请求头。
     *
     * @param headers  待修改的请求头。
     * @param provider provider 完整配置。
     */
    private applyAuth(headers: Record<string, string>, provider: ProviderConfig): void {
        const apiKey = (provider.apiKey || '').trim();
        if (!apiKey) return;
        switch (provider.authMode) {
            case 'api_key':
                headers['x-api-key'] = apiKey;
                break;
            case 'auth_token':
                headers['authorization'] = `Bearer ${apiKey}`;
                break;
            case 'none':
            default:
                break;
        }
    }

    /**
     * 真正发起一次 HTTP 请求并聚合响应体。
     *
     * @param url     上游 URL。
     * @param headers 请求头。
     * @param body    请求体字符串。
     * @returns 状态码 + 响应体字符串。
     */
    private doRequest(
        url: URL,
        headers: Record<string, string>,
        body: string
    ): Promise<{ status: number; body: string }> {
        return new Promise((resolve, reject) => {
            const transport = url.protocol === 'http:' ? http : https;
            const options: http.RequestOptions = {
                method: 'POST',
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'http:' ? 80 : 443),
                path: `${url.pathname}${url.search}`,
                headers,
                timeout: COMPACT_TIMEOUT_MS
            };
            const req = transport.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer | string) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                });
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf-8')
                    });
                });
                res.on('error', (err) => reject(err));
            });
            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy(new Error(`compaction 请求超时（${Math.round(COMPACT_TIMEOUT_MS / 1000)}s）`));
            });
            req.write(body);
            req.end();
        });
    }

    /**
     * 从 Anthropic 非流式响应中提取最终文本内容。
     *
     * 响应结构：`{ content: [{ type:'text', text:'...' }, ...] }`。
     *
     * @param bodyText 响应体字符串。
     * @returns 拼接后的纯文本；解析失败返回空串。
     */
    private extractText(bodyText: string): string {
        try {
            const parsed = JSON.parse(bodyText) as { content?: unknown };
            const content = parsed.content;
            if (!Array.isArray(content)) return '';
            const parts: string[] = [];
            for (const block of content) {
                if (block && typeof block === 'object'
                    && (block as { type?: unknown }).type === 'text'
                    && typeof (block as { text?: unknown }).text === 'string') {
                    parts.push((block as { text: string }).text);
                }
            }
            return parts.join('\n').trim();
        } catch {
            return '';
        }
    }

    /**
     * 拼接 provider.baseUrl 与 OpenAI Chat Completions 路径。
     *
     * @param baseUrl provider 的 baseUrl。
     * @returns 最终请求 URL。
     */
    private buildOpenAIChatUrl(baseUrl: string): URL {
        const trimmed = (baseUrl || '').trim();
        if (!trimmed) throw new Error('provider.baseUrl 为空');
        const url = new URL(trimmed);
        if (url.pathname.endsWith('/chat/completions')) return url;
        const base = url.pathname.replace(/\/+$/, '');
        url.pathname = `${base}/chat/completions`;
        return url;
    }

    /**
     * 把多轮历史压成一个 user 消息，并丢弃工具调用和工具结果。
     *
     * @param messages 原 Anthropic messages。
     * @returns 供摘要模型读取的单条 user 消息。
     */
    private buildSingleUserContextMessage(messages: unknown[]): { role: 'user'; content: Array<{ type: 'text'; text: string }> } {
        const flattened = messages
            .map((message, index) => this.stringifyMessageForCompaction(message, index))
            .filter(Boolean)
            .join('\n\n---\n\n');
        return {
            role: 'user',
            content: [{ type: 'text', text: flattened || '当前对话没有可压缩的纯文本内容。' }]
        };
    }

    /**
     * 把单条 Anthropic message 转为摘要用文本。
     *
     * @param message Anthropic message。
     * @param index   消息序号。
     * @returns 去工具块后的文本。
     */
    private stringifyMessageForCompaction(message: unknown, index: number): string {
        const record = message && typeof message === 'object' ? message as Record<string, unknown> : {};
        const role = record.role === 'assistant' ? 'assistant' : 'user';
        const text = this.stringifyContentForCompaction(record.content).trim();
        if (!text) return '';
        return `## ${index + 1}. ${role}\n${text}`;
    }

    /**
     * 把 content 转为摘要用文本，跳过 tool_use/tool_result。
     *
     * @param content Anthropic content 字段。
     * @returns 文本内容。
     */
    private stringifyContentForCompaction(content: unknown): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map((block) => {
                if (block && typeof block === 'object') {
                    const rec = block as Record<string, unknown>;
                    if (rec.type === 'tool_use' || rec.type === 'tool_result') return '';
                    if (typeof rec.text === 'string') return rec.text;
                }
                return '';
            }).filter(Boolean).join('\n');
        }
        return '';
    }

    /**
     * 把 Anthropic system 字段转为 OpenAI system.content 字符串。
     *
     * @param system Anthropic system 字段。
     * @returns OpenAI system content。
     */
    private stringifySystem(system: unknown): string {
        if (typeof system === 'string') return system;
        if (Array.isArray(system)) {
            return system.map((block) => {
                if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
                    return (block as { text: string }).text;
                }
                return JSON.stringify(block);
            }).join('\n');
        }
        return JSON.stringify(system ?? '');
    }

    /**
     * 把 Anthropic message 粗略转换为 OpenAI Chat message。
     *
     * @param message Anthropic message。
     * @returns OpenAI Chat message。
     */
    private convertAnthropicMessageToOpenAI(message: unknown): { role: 'user' | 'assistant'; content: string } {
        const record = message && typeof message === 'object' ? message as Record<string, unknown> : {};
        const role = record.role === 'assistant' ? 'assistant' : 'user';
        return { role, content: this.stringifyContent(record.content) };
    }

    /**
     * 把 Anthropic content 字段转为纯文本字符串。
     *
     * @param content Anthropic content 字段。
     * @returns 文本内容。
     */
    private stringifyContent(content: unknown): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map((block) => {
                if (block && typeof block === 'object') {
                    const rec = block as Record<string, unknown>;
                    if (typeof rec.text === 'string') return rec.text;
                    if (rec.type === 'tool_use') return JSON.stringify({ tool_use: rec });
                    if (rec.type === 'tool_result') return JSON.stringify({ tool_result: rec.content ?? rec });
                }
                return JSON.stringify(block);
            }).join('\n');
        }
        return JSON.stringify(content ?? '');
    }

    /**
     * 从 OpenAI Chat Completions 非流式响应中提取正文。
     *
     * @param bodyText 响应体字符串。
     * @returns choices[0].message.content 或空字符串。
     */
    private extractOpenAIChatText(bodyText: string): string {
        try {
            const parsed = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: unknown } }> };
            const content = parsed.choices?.[0]?.message?.content;
            return typeof content === 'string' ? content.trim() : '';
        } catch {
            return '';
        }
    }
    /**
     * 拼接 provider.baseUrl 与 OpenAI Responses 路径。
     *
     * @param baseUrl provider 的 baseUrl。
     * @returns 最终请求 URL。
     */
    private buildOpenAIResponsesUrl(baseUrl: string): URL {
        const trimmed = (baseUrl || '').trim();
        if (!trimmed) throw new Error('provider.baseUrl 为空');
        const url = new URL(trimmed);
        if (url.pathname.endsWith('/responses')) return url;
        const base = url.pathname.replace(/\/+$/, '');
        url.pathname = `${base}/responses`;
        return url;
    }

    /**
     * 从 OpenAI Responses 非流式响应中提取正文。
     *
     * @param bodyText 响应体字符串。
     * @returns Anthropic 文本块或空字符串。
     */
    private extractOpenAIResponsesText(bodyText: string): string {
        try {
            const converted = convertResponsesJsonToAnthropic(JSON.parse(bodyText) as unknown);
            const parts: string[] = [];
            for (const block of converted.body.content) {
                if (block.type === 'text') parts.push(block.text);
            }
            return parts.join('\n').trim();
        } catch {
            return '';
        }
    }

    /**
     * 截断长字符串用于错误日志，避免日志暴涨。
     *
     * @param text 原字符串。
     * @returns 截断后字符串（最多 300 字符）。
     */
    private truncate(text: string): string {
        if (text.length <= 300) return text;
        return `${text.slice(0, 300)}...（截断）`;
    }
}
