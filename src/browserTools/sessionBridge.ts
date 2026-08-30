/** @file 通过 run_playwright_code 在内置浏览器页面内导出/注入登录态的脚本与结果解析。 */

import { Logger } from '../logger';
import { sanitizeCookies, type BrowserSessionSnapshot } from './sessionStore';

/** 导出脚本在页面状态未落定时返回的跳过标记。 */
export const SKIP_MARKER = 'not-complete';

/**
 * 导出当前页 cookie 与 storage 的 Playwright 脚本。
 *
 * 必须走 CDP：VS Code 内置浏览器未实现 Storage.getCookies，
 * context.storageState() / context.cookies() 均不可用。
 */
export const EXPORT_SCRIPT = `
const ready = await page.evaluate(() => document.readyState);
if (ready !== 'complete') {
    return JSON.stringify({ skip: '${SKIP_MARKER}' });
}
const cdp = await page.context().newCDPSession(page);
const cookies = (await cdp.send('Network.getAllCookies')).cookies;
const storage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage)
}));
return JSON.stringify({
    url: page.url(),
    cookies,
    localStorage: storage.local,
    sessionStorage: storage.session
});
`.trim();

/**
 * 生成把快照灌回页面的 Playwright 脚本。
 *
 * 脚本内不做导航：cookie 必须先于目标页首屏请求写入，
 * 否则站点接口会抢跑在凭证生效之前（导航由调用方在注入完成后单独发起）。
 */
export function buildImportScript(snapshot: BrowserSessionSnapshot): string {
    const cookies = JSON.stringify(snapshot.cookies);
    const local = JSON.stringify(snapshot.localStorage);
    const session = JSON.stringify(snapshot.sessionStorage);
    return `
const cdp = await page.context().newCDPSession(page);
const cookies = ${cookies};
if (cookies.length > 0) {
    await cdp.send('Network.setCookies', { cookies });
}
await page.evaluate((data) => {
    for (const [k, v] of data.local) { localStorage.setItem(k, v); }
    for (const [k, v] of data.session) { sessionStorage.setItem(k, v); }
}, { local: ${local}, session: ${session} });
return JSON.stringify({ restored: cookies.length });
`.trim();
}

/** 导出脚本解析结果：拿到有效负载，或因页面状态未落定而跳过。 */
export interface ExportPayload {
    /** 快照采集时的页面 URL。 */
    url: string;
    /** 原始 CDP cookie 数组，已裁剪为可回灌字段。 */
    cookies: BrowserSessionSnapshot['cookies'];
    /** localStorage 键值对。 */
    localStorage: [string, string][];
    /** sessionStorage 键值对。 */
    sessionStorage: [string, string][];
}

/**
 * 解析 run_playwright_code 的返回文本。
 *
 * 返回文本形如 `Result: "<json>"`，其后可能跟 Page Title / Snapshot 等段落；
 * 且 JSON 被序列化了两层（外层字符串字面量、内层对象）。
 * 页面未加载完成（skip 标记）或解析失败时返回 undefined。
 */
export function parseExportResult(text: string): ExportPayload | undefined {
    const raw = extractResultLiteral(text);
    if (raw === undefined) {
        return undefined;
    }
    try {
        const outer = JSON.parse(raw) as unknown;
        const inner = typeof outer === 'string' ? JSON.parse(outer) as unknown : outer;
        if (!inner || typeof inner !== 'object') {
            return undefined;
        }
        const payload = inner as Record<string, unknown>;
        if (typeof payload.url !== 'string') {
            return undefined;
        }
        return {
            url: payload.url,
            cookies: sanitizeCookies(Array.isArray(payload.cookies) ? payload.cookies : []),
            localStorage: toEntries(payload.localStorage),
            sessionStorage: toEntries(payload.sessionStorage)
        };
    } catch (err) {
        Logger.warn('浏览器会话导出结果解析失败。', err);
        return undefined;
    }
}

/** 从返回文本中截出 `Result:` 后的 JSON 字面量（到行尾）。 */
function extractResultLiteral(text: string): string | undefined {
    const idx = text.indexOf('Result:');
    if (idx < 0) {
        return undefined;
    }
    const rest = text.slice(idx + 'Result:'.length);
    const lineEnd = rest.indexOf('\n');
    const literal = (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
    return literal.length > 0 ? literal : undefined;
}

/** 把未知值收敛为 [string, string][]，非法项丢弃。 */
function toEntries(value: unknown): [string, string][] {
    if (!Array.isArray(value)) {
        return [];
    }
    const result: [string, string][] = [];
    for (const item of value) {
        if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
            result.push([item[0], item[1]]);
        }
    }
    return result;
}
