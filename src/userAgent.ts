/** @file 为上游请求统一追加扩展 User-Agent 标识，版本跟随 package.json。 */

// src 与编译后的 out 均位于扩展根目录下一层；避免静态 JSON import 改变输出目录结构。
const manifest = require('../package.json') as { name: string; version: string };

/** 当前扩展的 HTTP product/version 标识。 */
export const EXTENSION_USER_AGENT = `${manifest.name}/${manifest.version}`;

/**
 * 在原有 CLI 或自定义 UA 后追加扩展标识，并合并大小写不同的 UA 键。
 *
 * 重复调用不会重复追加；未提供 UA 时仅使用扩展标识。
 * @param headers 将发送给上游的请求头，原地更新。
 * @returns 无返回值。
 */
export function applyExtensionUserAgent(headers: Record<string, string>): void {
    const values: string[] = [];
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== 'user-agent') continue;
        const value = headers[key].trim();
        if (value && !values.includes(value)) values.push(value);
        delete headers[key];
    }
    const current = values.join(' ');
    headers['user-agent'] = current.split(/\s+/).includes(EXTENSION_USER_AGENT)
        ? current
        : [current, EXTENSION_USER_AGENT].filter(Boolean).join(' ');
}
