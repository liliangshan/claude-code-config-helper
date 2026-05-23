/** @file 识别 unified diff 文本块。 */

import type { ChatSegment } from '../protocol';

/** unified diff 文件头正则。 */
const DIFF_HEADER = /^---\s+(?:a\/|\/dev\/null|[^\s]+)/m;

/** unified diff 新文件头正则。 */
const DIFF_NEXT_HEADER = /^\+\+\+\s+(?:b\/|\/dev\/null|[^\s]+)/m;

/** unified diff hunk 头正则。 */
const DIFF_HUNK = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;

/**
 * 判断文本是否像 unified diff。
 *
 * @param text 待判断文本。
 * @returns 符合 unified diff 基本特征时返回 true。
 */
export function isUnifiedDiff(text: string): boolean {
    return DIFF_HEADER.test(text) && DIFF_NEXT_HEADER.test(text) && DIFF_HUNK.test(text);
}

/**
 * 尝试将文本转换为 diff segment。
 *
 * @param text 待识别文本。
 * @returns 命中 diff 时返回 segment，否则返回 undefined。
 */
export function scanDiff(text: string): ChatSegment | undefined {
    if (!isUnifiedDiff(text)) return undefined;
    return {
        kind: 'diff',
        text,
        sourceText: text,
        confidence: 'high'
    };
}
