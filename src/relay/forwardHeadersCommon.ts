/**
 * @file Relay 上游转发请求头公共工具。
 *
 * 提供 Anthropic 透传与后续 OpenAI-compatible / Responses 适配器共用的
 * header 过滤、标准化与脱敏能力。该模块不包含任何协议专属鉴权逻辑，
 * 避免 Anthropic 的 `x-api-key` 规则与 OpenAI 的 Bearer 规则相互污染。
 */

import * as http from 'http';

/**
 * 转发上游时需要剥离的请求头集合（统一小写）。
 *
 * - host / content-length / connection / accept-encoding：交给 Node 自行重算或控制；
 * - authorization / x-api-key / x-auth-token：忽略 Claude Code 端的鉴权，使用 provider 自带凭据；
 * - proxy-authorization：避免穿透代理凭据。
 * - x-claude-code-* / x-stainless-* / anthropic-* / x-app：避免把 Claude Code、
 *   Anthropic SDK 或 Anthropic 专属诊断头透传给 OpenAI-compatible 上游。
 */
export const HEADER_BLOCKLIST: ReadonlySet<string> = new Set<string>([
    'host',
    'content-length',
    'connection',
    'accept-encoding',
    'authorization',
    'x-api-key',
    'x-auth-token',
    'proxy-authorization',
    'anthropic-dangerous-direct-browser-access',
    'anthropic-beta',
    'anthropic-version',
    'x-app'
]);

/** 转发上游时需要按前缀剥离的请求头集合。 */
const HEADER_BLOCKLIST_PREFIXES: readonly string[] = [
    'x-claude-code-',
    'x-stainless-',
    'x-anthropic-'
];

/** 在日志中需要整体脱敏的请求头名集合。 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set<string>([
    'authorization',
    'x-api-key',
    'x-auth-token',
    'proxy-authorization',
    'cookie',
    'set-cookie'
]);

/**
 * 把任意 header value 标准化为字符串。
 *
 * Node 的 IncomingHttpHeaders 可能给出 string | string[] | undefined，
 * 这里统一为单字符串，便于转发与日志输出。
 *
 * @param value 原始 header value。
 * @returns 拼接后的字符串；undefined 时返回空字符串。
 */
export function normalizeHeaderValue(value: string | string[] | undefined): string {
    if (value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    return value;
}

/**
 * 判断某 header 是否敏感，用于日志输出时脱敏。
 *
 * @param name header 名称（任意大小写）。
 * @returns 是否敏感。
 */
export function isSensitiveHeader(name: string): boolean {
    return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * 判断某请求头是否应从上游转发中剥离。
 *
 * @param name header 名称（任意大小写）。
 * @returns 是否需要剥离。
 */
export function isBlockedForwardHeader(name: string): boolean {
    const lower = name.toLowerCase();
    return HEADER_BLOCKLIST.has(lower) || HEADER_BLOCKLIST_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * 安全地把请求头摘要化为日志可打印的对象，自动脱敏敏感字段。
 *
 * @param headers 待打印的请求头。
 * @returns 适合 Logger 输出的脱敏对象。
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(headers)) {
        out[key] = isSensitiveHeader(key) ? '***' : headers[key];
    }
    return out;
}

/**
 * 从来源端请求头中过滤出可转发的部分。
 *
 * 会自动剥离 {@link HEADER_BLOCKLIST} 中的字段，剩下的全部转小写后保留。
 *
 * @param source 来源端的 IncomingHttpHeaders。
 * @returns 适合发给上游的请求头字典。
 */
export function buildForwardHeaders(source: http.IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawKey of Object.keys(source)) {
        const key = rawKey.toLowerCase();
        if (isBlockedForwardHeader(key)) continue;
        out[key] = normalizeHeaderValue(source[rawKey]);
    }
    return out;
}
