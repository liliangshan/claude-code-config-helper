/** @file 基础 Markdown 流式切块器，支持跨 chunk fenced code block。 */

import type { ChatSegment } from '../protocol';

/** fenced code block 开始或结束行正则。 */
const FENCE_LINE = /^```\s*([\w#+.-]*)\s*$/;

/** Markdown 切块器状态。 */
export interface MarkdownChunkerState {
    /** 是否处于 fenced code block 内。 */
    inCodeBlock: boolean;
    /** 当前 fenced code block 语言。 */
    codeLanguage?: string;
    /** 尚未遇到换行的半行缓冲。 */
    pendingLine: string;
    /** 当前普通 Markdown 缓冲。 */
    markdownBuffer: string;
    /** 当前代码块缓冲。 */
    codeBuffer: string;
}

/** Markdown 切块结果。 */
export interface MarkdownChunkResult {
    /** 更新后的状态。 */
    state: MarkdownChunkerState;
    /** 本次 chunk 产生的片段。 */
    segments: ChatSegment[];
}

/**
 * 创建初始 Markdown 切块状态。
 *
 * @returns 初始状态对象。
 */
export function createMarkdownChunkerState(): MarkdownChunkerState {
    return {
        inCodeBlock: false,
        pendingLine: '',
        markdownBuffer: '',
        codeBuffer: ''
    };
}

/**
 * 流式解析 Markdown 文本 chunk。
 *
 * @param state 上一次解析后的状态。
 * @param text 新到达的文本。
 * @returns 新状态和本次产生的 markdown/code 片段。
 */
export function chunkMarkdown(state: MarkdownChunkerState, text: string): MarkdownChunkResult {
    const nextState: MarkdownChunkerState = { ...state };
    const segments: ChatSegment[] = [];
    const combined = nextState.pendingLine + text;
    const lines = combined.split(/(\n)/);
    nextState.pendingLine = '';

    let currentLine = '';
    for (const part of lines) {
        if (part === '\n') {
            processLine(nextState, currentLine + part, segments);
            currentLine = '';
        } else {
            currentLine += part;
        }
    }
    nextState.pendingLine = currentLine;
    flushIncremental(nextState, segments, false);
    return { state: nextState, segments };
}

/**
 * 刷新状态中尚未输出的完整片段。
 *
 * @param state 当前状态。
 * @returns 刷新出的片段列表。
 */
export function flushMarkdown(state: MarkdownChunkerState): ChatSegment[] {
    const segments: ChatSegment[] = [];
    if (state.pendingLine) {
        processLine(state, state.pendingLine, segments);
        state.pendingLine = '';
    }
    flushIncremental(state, segments, true);
    return segments;
}

/**
 * 处理一行文本并维护 fenced code block 状态。
 *
 * @param state 当前状态。
 * @param line 包含可选换行符的一行。
 * @param segments 输出片段数组。
 */
function processLine(state: MarkdownChunkerState, line: string, segments: ChatSegment[]): void {
    const trimmed = line.trim();
    const fence = FENCE_LINE.exec(trimmed);
    if (fence) {
        if (state.inCodeBlock) {
            flushCode(state, segments);
            state.inCodeBlock = false;
            state.codeLanguage = undefined;
        } else {
            flushMarkdownBuffer(state, segments);
            state.inCodeBlock = true;
            state.codeLanguage = fence[1] || undefined;
            state.codeBuffer = '';
        }
        return;
    }
    if (state.inCodeBlock) {
        state.codeBuffer += line;
    } else {
        state.markdownBuffer += line;
    }
}

/**
 * 增量刷新当前缓冲内容。
 *
 * @param state 当前状态。
 * @param segments 输出片段数组。
 * @param force 是否强制刷新未闭合代码块。
 */
function flushIncremental(state: MarkdownChunkerState, segments: ChatSegment[], force: boolean): void {
    if (state.inCodeBlock) {
        if (force) flushCode(state, segments);
        return;
    }
    flushMarkdownBuffer(state, segments);
}

/**
 * 刷新普通 Markdown 缓冲。
 *
 * @param state 当前状态。
 * @param segments 输出片段数组。
 */
function flushMarkdownBuffer(state: MarkdownChunkerState, segments: ChatSegment[]): void {
    if (!state.markdownBuffer) return;
    segments.push({ kind: 'markdown', text: state.markdownBuffer });
    state.markdownBuffer = '';
}

/**
 * 刷新代码块缓冲。
 *
 * @param state 当前状态。
 * @param segments 输出片段数组。
 */
function flushCode(state: MarkdownChunkerState, segments: ChatSegment[]): void {
    segments.push({ kind: 'code', language: state.codeLanguage, text: state.codeBuffer });
    state.codeBuffer = '';
}
