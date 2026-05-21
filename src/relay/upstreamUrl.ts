/**
 * @file 上游 URL 安全拼接工具。
 *
 * 使用 WHATWG URL API 处理 baseUrl 与协议路径拼接，避免简单字符串拼接造成
 * 双斜杠、漏斜杠或重复追加目标路径等问题。
 */

import { URL } from 'url';

import { Logger } from '../logger';

/**
 * 安全拼接 provider.baseUrl 与目标上游路径。
 *
 * 规则：
 * - `path` 必须以 `/` 开头；
 * - 若 baseUrl 已以目标 path 结尾，则原样保留 pathname；
 * - 否则去掉 baseUrl pathname 末尾斜杠后追加目标 path；
 * - 保留 baseUrl 自带 query；hash 会按 HTTP 请求语义留在 URL 对象中但调用方通常不发送。
 *
 * @param baseUrl provider 配置中的 baseUrl。
 * @param path 目标路径，例如 `/chat/completions` 或 `/responses`。
 * @returns 拼接后的 URL 对象。
 * @throws 当 baseUrl 或 path 非法时抛出。
 */
export function joinUpstreamUrl(baseUrl: string, path: string): URL {
    const trimmedBaseUrl = (baseUrl || '').trim();
    if (!trimmedBaseUrl) {
        throw new Error('provider.baseUrl 为空');
    }
    if (!path.startsWith('/')) {
        throw new Error(`上游 path 必须以 / 开头：${path}`);
    }
    const url = new URL(trimmedBaseUrl);
    const normalizedPath = path.replace(/\/+$/, '') || '/';
    const pathname = url.pathname.replace(/\/+$/, '') || '';
    if (pathname === normalizedPath || pathname.endsWith(normalizedPath)) {
        Logger.warn(`[Relay] baseUrl 已包含目标路径 ${normalizedPath}，将按原路径转发：${url.toString()}`);
        return url;
    }
    url.pathname = `${pathname}${normalizedPath}`;
    return url;
}
