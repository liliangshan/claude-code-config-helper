/**
 * @file OpenAI 风格上游错误到 Anthropic 错误响应的映射工具。
 *
 * 供 openai-compatible 与 v1-response 适配器共用，统一处理 HTTP 错误码、
 * 上游错误体解析和敏感信息脱敏。
 */

/** Anthropic 风格错误响应。 */
export interface AnthropicErrorResponse {
    /** 固定 error 类型。 */
    type: 'error';
    /** 错误详情。 */
    error: {
        /** Anthropic 风格错误类型。 */
        type: string;
        /** 已脱敏错误消息。 */
        message: string;
    };
}

/**
 * 将上游 HTTP 状态码和响应体映射为 Anthropic JSON 错误响应。
 *
 * @param statusCode 上游 HTTP 状态码。
 * @param upstreamBody 上游错误响应体。
 * @returns Anthropic 风格错误响应。
 */
export function buildAnthropicErrorFromUpstream(statusCode: number, upstreamBody: string): AnthropicErrorResponse {
    return {
        type: 'error',
        error: {
            type: mapHttpStatusToAnthropicErrorType(statusCode, upstreamBody),
            message: sanitizeErrorMessage(extractUpstreamErrorMessage(upstreamBody) || `上游请求失败：HTTP ${statusCode}`)
        }
    };
}

/**
 * 将 HTTP 状态码映射为 Anthropic 风格错误类型。
 *
 * @param statusCode HTTP 状态码。
 * @param body 上游响应体，用于识别 overloaded 等语义。
 * @returns Anthropic 错误类型。
 */
export function mapHttpStatusToAnthropicErrorType(statusCode: number, body = ''): string {
    const lower = body.toLowerCase();
    if (statusCode === 529 || lower.includes('overloaded')) return 'overloaded_error';
    switch (statusCode) {
        case 400:
            return 'invalid_request_error';
        case 401:
            return 'authentication_error';
        case 403:
            return 'permission_error';
        case 404:
            return 'not_found_error';
        case 408:
            return 'request_timeout';
        case 413:
            return 'request_too_large';
        case 429:
            return 'rate_limit_error';
        case 500:
        case 502:
        case 503:
        case 504:
            return 'api_error';
        default:
            return 'api_error';
    }
}

/**
 * 从上游错误体中提取人类可读错误消息。
 *
 * @param body 上游响应体。
 * @returns 错误消息；无法解析时返回原始文本片段。
 */
export function extractUpstreamErrorMessage(body: string): string {
    const trimmed = body.trim();
    if (!trimmed) return '';
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        const message = readNestedMessage(parsed);
        if (message) return message;
    } catch {
        // 非 JSON 错误体按纯文本处理。
    }
    return trimmed.slice(0, 4000);
}

/**
 * 对错误消息做敏感信息脱敏。
 *
 * @param message 原始错误消息。
 * @returns 已脱敏错误消息。
 */
export function sanitizeErrorMessage(message: string): string {
    return message
        .replace(/(https?:\/\/[^\s?]+)\?[^\s)\]}"']+/gi, '$1?[redacted]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\-/=]+/gi, 'Bearer ***')
        .replace(/(Authorization\s*[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(x-auth-token\s*[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(cookie\s*[:=]\s*)[^\n\r]+/gi, '$1***')
        .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1***');
}

/**
 * 生成 Anthropic SSE 错误事件文本。
 *
 * @param type Anthropic 错误类型。
 * @param message 错误消息。
 * @returns SSE error event 文本。
 */
export function formatAnthropicSseError(type: string, message: string): string {
    return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: sanitizeErrorMessage(message) } })}\n\n`;
}

/**
 * 从常见 OpenAI/兼容服务错误结构中读取 message。
 *
 * @param value 已解析 JSON。
 * @returns message 字符串或空字符串。
 */
function readNestedMessage(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    if (record.error && typeof record.error === 'object') {
        const err = record.error as Record<string, unknown>;
        if (typeof err.message === 'string') return err.message;
        if (typeof err.code === 'string') return err.code;
    }
    return '';
}
