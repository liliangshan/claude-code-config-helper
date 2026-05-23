/** @file Chat 流式解析器入口。 */

import type { ChatSegment } from '../protocol';
import { scanDiff } from './diffScanner';
import { scanFileRefs } from './fileRefScanner';
import {
    chunkMarkdown,
    createMarkdownChunkerState,
    flushMarkdown,
    type MarkdownChunkerState
} from './markdownChunker';

/** Chat 解析器状态。 */
export interface ChatParserState {
    /** Markdown 切块状态。 */
    markdown: MarkdownChunkerState;
}

/** Chat 解析器 chunk 输入。 */
export interface ChatParserChunk {
    /** 原始文本内容。 */
    text: string;
    /** 文本来源，用于把 stderr 标记为错误段。 */
    source?: 'stdout' | 'stderr';
}

/** Chat 解析器返回值。 */
export interface ChatParserResult {
    /** 更新后的状态。 */
    state: ChatParserState;
    /** 本次解析产生的片段。 */
    segments: ChatSegment[];
}

/**
 * 创建 ChatParser 初始状态。
 *
 * @returns 初始解析器状态。
 */
export function createChatParserState(): ChatParserState {
    return { markdown: createMarkdownChunkerState() };
}

/**
 * 解析一个流式文本 chunk。
 *
 * 当前支持：stderr → error、Markdown 普通段、fenced code block、diff、fileRef 候选。
 * fileRef 会作为附加片段追加在对应 markdown 段之后，点击时再由扩展宿主校验路径。
 *
 * @param state 上一次解析后的状态。
 * @param chunk 当前文本 chunk。
 * @returns 更新后的状态和片段列表。
 */
export function parseChunk(state: ChatParserState, chunk: ChatParserChunk): ChatParserResult {
    if (chunk.source === 'stderr') {
        return {
            state,
            segments: [{ kind: 'error', text: chunk.text }, ...scanFileRefs(chunk.text)]
        };
    }
    const result = chunkMarkdown(state.markdown, chunk.text);
    return {
        state: { markdown: result.state },
        segments: enrichWithFileRefs(result.segments)
    };
}

/**
 * 刷新解析器中尚未输出的缓冲内容。
 *
 * @param state 当前解析器状态。
 * @returns 刷新出的片段列表。
 */
export function flushParser(state: ChatParserState): ChatSegment[] {
    return enrichWithFileRefs(flushMarkdown(state.markdown));
}

/**
 * 为 markdown/error 段追加文件引用候选片段。
 *
 * @param segments 原始片段列表。
 * @returns 带 fileRef 候选的片段列表。
 */
function enrichWithFileRefs(segments: ChatSegment[]): ChatSegment[] {
    const enriched: ChatSegment[] = [];
    for (const segment of segments) {
        const diffSegment = segment.kind === 'markdown' && segment.text ? scanDiff(segment.text) : undefined;
        enriched.push(diffSegment ?? segment);
        if ((segment.kind === 'markdown' || segment.kind === 'error') && segment.text) {
            enriched.push(...scanFileRefs(segment.text));
        }
    }
    return enriched;
}
