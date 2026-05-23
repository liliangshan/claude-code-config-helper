/** @file 扫描 Chat 文本中的 workspace 文件引用候选。 */

import type { ChatSegment } from '../protocol';

/** Markdown 链接文件引用正则，匹配 [label](path#L10-L20)。 */
const MARKDOWN_LINK_REF = /\[([^\]]+)\]\((?!https?:\/\/|mailto:|javascript:|command:|data:)([^)#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?\)/g;

/** 明确路径文件引用正则，匹配 src/foo.ts:42:3 这类带扩展名路径。 */
const PLAIN_PATH_REF = /((?:[A-Za-z]:)?(?:\.{1,2}[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z0-9]+)(?::(\d+)(?::(\d+))?)?/g;

/** URL 候选正则，用于过滤明显不是本地文件的文本。 */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/** 文本中完整 URL 范围正则，用于普通路径扫描前排除外链。 */
const URL_RANGE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * 在文本中扫描文件引用候选并生成 fileRef segment。
 *
 * 该扫描器只负责候选识别，不访问文件系统；真正的 workspace allowlist、exists
 * 校验和跳转由扩展宿主在点击时完成。
 *
 * @param text 待扫描文本。
 * @returns 文件引用片段列表。
 */
export function scanFileRefs(text: string): ChatSegment[] {
    const markdownRefs = scanMarkdownLinks(text);
    const excludedRanges = [...collectMarkdownLinkRanges(text), ...collectUrlRanges(text)];
    return [...markdownRefs, ...scanPlainPaths(text, excludedRanges)];
}

/**
 * 扫描 Markdown 链接形式的文件引用。
 *
 * @param text 待扫描文本。
 * @returns 文件引用片段列表。
 */
function scanMarkdownLinks(text: string): ChatSegment[] {
    const segments: ChatSegment[] = [];
    for (const match of text.matchAll(MARKDOWN_LINK_REF)) {
        const label = match[1] || match[2];
        const filePath = match[2];
        if (!filePath || isUnsafePath(filePath)) continue;
        segments.push({
            kind: 'fileRef',
            text: label,
            filePath,
            startLine: toPositiveInt(match[3]),
            endLine: toPositiveInt(match[4]),
            sourceText: match[0],
            confidence: 'high'
        });
    }
    return segments;
}

/**
 * 扫描普通 path/to/file.ts:42:3 形式的文件引用。
 *
 * @param text 待扫描文本。
 * @returns 文件引用片段列表。
 */
function scanPlainPaths(text: string, excludedRanges: Array<[number, number]> = []): ChatSegment[] {
    const segments: ChatSegment[] = [];
    for (const match of text.matchAll(PLAIN_PATH_REF)) {
        if (isIndexInRanges(match.index ?? -1, excludedRanges)) continue;
        const filePath = match[1];
        if (!filePath || isUnsafePath(filePath) || looksLikeVersion(filePath)) continue;
        segments.push({
            kind: 'fileRef',
            text: match[0],
            filePath,
            startLine: toPositiveInt(match[2]),
            startColumn: toPositiveInt(match[3]),
            sourceText: match[0],
            confidence: filePath.includes('/') || filePath.includes('\\') ? 'medium' : 'low'
        });
    }
    return segments;
}

/**
 * 收集 Markdown 链接在原文中的字符范围。
 *
 * 普通路径扫描会跳过这些范围，避免把 `[label](src/a.ts)` 内部的 `src/a.ts`
 * 再识别成第二个 fileRef。
 *
 * @param text 待扫描文本。
 * @returns Markdown 链接的半开区间列表。
 */
function collectMarkdownLinkRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const match of text.matchAll(MARKDOWN_LINK_REF)) {
        const start = match.index ?? -1;
        if (start < 0) continue;
        ranges.push([start, start + match[0].length]);
    }
    return ranges;
}

/**
 * 收集外链 URL 在原文中的字符范围。
 *
 * @param text 待扫描文本。
 * @returns URL 的半开区间列表。
 */
function collectUrlRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const match of text.matchAll(URL_RANGE)) {
        const start = match.index ?? -1;
        if (start < 0) continue;
        ranges.push([start, start + match[0].length]);
    }
    return ranges;
}

/**
 * 判断字符位置是否落在任一半开区间内。
 *
 * @param index 字符位置。
 * @param ranges 半开区间列表。
 * @returns 命中任一区间时返回 true。
 */
function isIndexInRanges(index: number, ranges: Array<[number, number]>): boolean {
    return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * 判断路径候选是否属于危险 URI 或明显外链。
 *
 * @param filePath 文件路径候选。
 * @returns 不应作为本地文件引用时返回 true。
 */
function isUnsafePath(filePath: string): boolean {
    return URL_LIKE.test(filePath) && !/^[A-Za-z]:/.test(filePath);
}

/**
 * 判断候选是否更像版本号而不是文件路径。
 *
 * @param filePath 文件路径候选。
 * @returns 类似 1.2.3 或 v2.0 时返回 true。
 */
function looksLikeVersion(filePath: string): boolean {
    return /^v?\d+(?:\.\d+)+$/i.test(filePath);
}

/**
 * 将字符串转为正整数。
 *
 * @param value 原始数字字符串。
 * @returns 正整数；无效时返回 undefined。
 */
function toPositiveInt(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
