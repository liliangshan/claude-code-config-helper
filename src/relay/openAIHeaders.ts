/**
 * @file OpenAI-compatible / Responses 上游请求头构建工具。
 *
 * OpenAI 风格协议默认使用 `Authorization: Bearer <key>` 鉴权，与 Anthropic
 * `x-api-key + anthropic-version` 规则不同，因此必须独立维护，避免协议串味。
 */

import * as http from 'http';

import type { ProviderConfig } from '../types';
import { buildForwardHeaders, isBlockedForwardHeader } from './forwardHeadersCommon';

/** OpenAI 风格请求默认 Content-Type。 */
const DEFAULT_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** OpenAI 风格 adapter 需要额外剥离的 Anthropic 专属请求头。 */
const OPENAI_EXTRA_HEADER_BLOCKLIST: ReadonlySet<string> = new Set<string>([
    'anthropic-version',
    'anthropic-beta'
]);

/** OpenAI 请求头鉴权诊断结果。 */
export interface OpenAIAuthHeaderDiagnostics {
    /** 当前 provider 的鉴权模式。 */
    authMode: ProviderConfig['authMode'];
    /** SecretStorage 读取出的 provider.apiKey 是否非空。 */
    hasProviderSecret: boolean;
    /** 最终上游请求头是否包含 Authorization。 */
    hasAuthorizationHeader: boolean;
    /** 最终上游请求头是否包含 x-api-key。 */
    hasXApiKeyHeader: boolean;
    /** Authorization 来源。 */
    authorizationSource: 'provider-secret' | 'custom-headers' | 'missing-secret' | 'auth-disabled' | 'none';
}

/**
 * 构建 OpenAI-compatible / Responses 上游请求头。
 *
 * 会过滤 hop-by-hop、敏感鉴权和 Anthropic 专属头，随后应用 provider.customHeaders
 * 与 OpenAI 风格鉴权。customHeaders 可显式覆盖 Authorization，便于接入特殊供应商。
 *
 * @param provider provider 配置。
 * @param incomingHeaders Claude Code 发来的原始请求头。
 * @returns 可直接传给 Node HTTP request 的请求头对象。
 */
export function buildOpenAIForwardHeaders(
    provider: ProviderConfig,
    incomingHeaders: http.IncomingHttpHeaders
): Record<string, string> {
    const headers = buildForwardHeaders(incomingHeaders);
    for (const key of Object.keys(headers)) {
        if (OPENAI_EXTRA_HEADER_BLOCKLIST.has(key.toLowerCase())) {
            delete headers[key];
        }
    }
    applyOpenAICustomHeaders(headers, provider);
    applyOpenAIAuthHeaders(headers, provider);
    headers['content-type'] = headers['content-type'] || DEFAULT_JSON_CONTENT_TYPE;
    return headers;
}

/**
 * 根据 provider.authMode 追加 OpenAI 风格鉴权信息。
 *
 * - `api_key` 与 `auth_token` 都映射为 `Authorization: Bearer <key>`；
 * - `none` 不追加鉴权；
 * - 若 customHeaders 已显式设置 authorization，则保留用户配置。
 *
 * @param headers 待修改的请求头对象。
 * @param provider provider 配置。
 */
export function applyOpenAIAuthHeaders(
    headers: Record<string, string>,
    provider: ProviderConfig
): void {
    if (provider.authMode === 'none') return;
    const apiKey = (provider.apiKey || '').trim();
    if (!apiKey) return;
    if (headers.authorization) return;
    headers.authorization = `Bearer ${apiKey}`;
}

/**
 * 把 provider.customHeaders 合并到 OpenAI 风格上游请求头中。
 *
 * 除通用 blocklist 与 Anthropic 专属头外，用户显式配置优先级较高；这允许特殊
 * OpenAI-compatible 供应商用自定义鉴权头覆盖默认 Bearer 逻辑。
 *
 * @param headers 待修改的请求头对象。
 * @param provider provider 配置。
 */
export function applyOpenAICustomHeaders(
    headers: Record<string, string>,
    provider: ProviderConfig
): void {
    if (!Array.isArray(provider.customHeaders)) return;
    for (const entry of provider.customHeaders) {
        if (!entry || !entry.key) continue;
        const key = entry.key.trim();
        if (!key) continue;
        const lower = key.toLowerCase();
        if (isBlockedForwardHeader(lower) && lower !== 'authorization' && lower !== 'x-api-key') continue;
        if (OPENAI_EXTRA_HEADER_BLOCKLIST.has(lower)) continue;
        headers[lower] = entry.value ?? '';
    }
}

/**
 * 构建 OpenAI-compatible 请求头鉴权诊断信息。
 *
 * 该函数只返回布尔值和来源枚举，不包含真实密钥，可安全写入日志。
 *
 * @param provider provider 配置。
 * @param headers 已构建的上游请求头。
 * @returns 鉴权诊断信息。
 */
export function describeOpenAIAuthHeaders(
    provider: ProviderConfig,
    headers: Record<string, string>
): OpenAIAuthHeaderDiagnostics {
    const hasProviderSecret = (provider.apiKey || '').trim().length > 0;
    const hasAuthorizationHeader = !!headers.authorization;
    const hasXApiKeyHeader = !!headers['x-api-key'];
    return {
        authMode: provider.authMode,
        hasProviderSecret,
        hasAuthorizationHeader,
        hasXApiKeyHeader,
        authorizationSource: resolveAuthorizationSource(provider, headers, hasProviderSecret)
    };
}

/**
 * 推断 Authorization 请求头来源。
 *
 * @param provider provider 配置。
 * @param headers 已构建的上游请求头。
 * @param hasProviderSecret provider 是否存在密钥。
 * @returns Authorization 来源枚举。
 */
function resolveAuthorizationSource(
    provider: ProviderConfig,
    headers: Record<string, string>,
    hasProviderSecret: boolean
): OpenAIAuthHeaderDiagnostics['authorizationSource'] {
    if (provider.authMode === 'none') return headers.authorization ? 'custom-headers' : 'auth-disabled';
    if (headers.authorization && hasProviderSecret && headers.authorization === `Bearer ${provider.apiKey.trim()}`) return 'provider-secret';
    if (headers.authorization) return 'custom-headers';
    if (!hasProviderSecret) return 'missing-secret';
    return 'none';
}
