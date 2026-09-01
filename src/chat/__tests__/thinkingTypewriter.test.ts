/**
 * @file 思考块打字机整块补写的单元测试。
 *
 * 覆盖阶段 4：handleThinkingDelta 每次产出整块累积文本并复用同一 segment id，
 * Webview 侧据此按 id 原地替换、呈现为单个逐字增长的引用块。验证三点：id 稳定
 * 且 text 逐次增长、多行文本的首行/续行前缀、空分片不产出 segment。
 *
 * 通过最小化 CliProcess mock 直接驱动 StreamJsonCliAdapter.parseOutput。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { installVscodeStub } from './testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StreamJsonCliAdapter } = require('../cli/cliAdapter') as typeof import('../cli/cliAdapter');
type CliChunk = import('../cli/types').CliChunk;
type CliExitEvent = import('../cli/types').CliExitEvent;
type CliProcessStatus = import('../cli/types').CliProcessStatus;
type ParsedCliEvent = import('../cli/cliAdapter').ParsedCliEvent;

/** 构造最小 CliProcess 替身，只暴露事件订阅入口供 adapter 注册。 */
function createFakeCliProcess() {
    const emitter = new EventEmitter();
    return {
        onChunk(listener: (chunk: CliChunk) => void) {
            emitter.on('chunk', listener);
            return { dispose: () => emitter.off('chunk', listener) };
        },
        onExit(listener: (event: CliExitEvent) => void) {
            emitter.on('exit', listener);
            return { dispose: () => emitter.off('exit', listener) };
        },
        onStatus(listener: (status: CliProcessStatus) => void) {
            emitter.on('status', listener);
            return { dispose: () => emitter.off('status', listener) };
        },
        getCwd: () => process.cwd(),
        send: () => undefined,
        cancel: () => undefined,
        isRunning: () => true
    } as unknown as ConstructorParameters<typeof StreamJsonCliAdapter>[0];
}

/** 喂一条 stream_event 行并返回解析事件。 */
function feedStreamEvent(
    adapter: InstanceType<typeof StreamJsonCliAdapter>,
    event: Record<string, unknown>
): ParsedCliEvent[] {
    const line = JSON.stringify({ type: 'stream_event', event });
    return adapter.parseOutput({ source: 'stdout', text: line + '\n', receivedAt: Date.now() });
}

/** 喂一个 thinking_delta 分片，返回首个 markdown segment（无则 undefined）。 */
function feedThinking(
    adapter: InstanceType<typeof StreamJsonCliAdapter>,
    thinking: string,
    index = 0
): { id?: string; kind?: string; text?: string } | undefined {
    const events = feedStreamEvent(adapter, {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking }
    });
    for (const ev of events) {
        if (ev.type === 'segments' && ev.segments.length > 0) {
            return ev.segments[0] as { id?: string; kind?: string; text?: string };
        }
    }
    return undefined;
}

test('打字机：连续 3 个 thinking_delta 产出同 id、逐次增长整块 text', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const first = feedThinking(adapter, 'A');
    const second = feedThinking(adapter, 'B');
    const third = feedThinking(adapter, 'C');
    adapter.dispose();

    assert.ok(first && second && third, '三次都应产出 segment');
    assert.equal(first.kind, 'markdown');
    assert.equal(first.id, 'thinking:1:0');
    assert.equal(second.id, 'thinking:1:0');
    assert.equal(third.id, 'thinking:1:0');
    assert.equal(first.text, '> 💭 A');
    assert.equal(second.text, '> 💭 AB');
    assert.equal(third.text, '> 💭 ABC');
});

test('打字机：多行思考首行带 > 💭 前缀、续行仅带 > 前缀', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const seg = feedThinking(adapter, '第一行\n第二行');
    adapter.dispose();

    assert.ok(seg);
    assert.equal(seg.text, '> 💭 第一行\n> 第二行');
});

test('打字机：思考文本中的空行输出裸 > 且不带尾空格', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const seg = feedThinking(adapter, '第一段\n\n第二段');
    adapter.dispose();

    assert.ok(seg);
    // 空行必须是裸 ">"：带尾空格的 "> " 会被 Webview 的 trim 还原成 ">"，
    // 两端不一致会导致空行把思考块劈成两个 blockquote。
    assert.equal(seg.text, '> 💭 第一段\n>\n> 第二段');
});

test('打字机：空 thinking 分片不产出 segment', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const seg = feedThinking(adapter, '');
    adapter.dispose();

    assert.equal(seg, undefined);
});

test('打字机：不同 block index 使用不同的稳定 id', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const a = feedThinking(adapter, 'X', 0);
    const b = feedThinking(adapter, 'Y', 2);
    adapter.dispose();

    assert.equal(a?.id, 'thinking:1:0');
    assert.equal(b?.id, 'thinking:1:2');
});

test('打字机：新一条 message 的思考块拿到全新 id', () => {
    // block index 每条 message 都从 0 重新计数；若 id 只含 index，第二段思考会
    // 命中第一段的 id 被原地替换，表现为「新思考只更新顶部那一块」。
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, { type: 'message_start', message: { id: 'msg_a' } });
    const first = feedThinking(adapter, '第一段思考');
    feedStreamEvent(adapter, { type: 'message_stop' });
    feedStreamEvent(adapter, { type: 'message_start', message: { id: 'msg_b' } });
    const second = feedThinking(adapter, '第二段思考');
    adapter.dispose();

    assert.ok(first?.id && second?.id);
    assert.notEqual(second.id, first.id, '不同 message 的思考块必须是不同 segment');
    assert.equal(second.text, '> 💭 第二段思考', '新思考块不应继承上一段的文本');
});

/** 喂一条顶层 SDK assistant 聚合事件，返回全部产出的 segment。 */
function feedAssistantMessage(
    adapter: InstanceType<typeof StreamJsonCliAdapter>,
    messageId: string,
    text: string
): unknown[] {
    const line = JSON.stringify({
        type: 'assistant',
        message: { id: messageId, content: [{ type: 'text', text }] }
    });
    const events = adapter.parseOutput({ source: 'stdout', text: line + '\n', receivedAt: Date.now() });
    const segments: unknown[] = [];
    for (const ev of events) {
        if (ev.type === 'segments') segments.push(...ev.segments);
    }
    return segments;
}

test('去重：流式渲染过的 message 再收到聚合 assistant 事件时被跳过', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, { type: 'message_start', message: { id: 'msg_1' } });
    feedStreamEvent(adapter, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '正文内容\n' }
    });
    const segments = feedAssistantMessage(adapter, 'msg_1', '正文内容');
    adapter.dispose();

    assert.deepEqual(segments, []);
});

test('去重：未走过流式增量的聚合 assistant 事件仍正常渲染', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const segments = feedAssistantMessage(adapter, 'msg_2', '只有聚合事件');
    adapter.dispose();

    assert.ok(segments.length > 0, '无流式前缀时聚合事件必须照常渲染');
});

/** 喂一个 text_delta 分片，返回本次产出的全部 segment。 */
function feedText(
    adapter: InstanceType<typeof StreamJsonCliAdapter>,
    text: string,
    index = 0
): { kind?: string; text?: string }[] {
    const events = feedStreamEvent(adapter, {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text }
    });
    const segments: { kind?: string; text?: string }[] = [];
    for (const ev of events) {
        if (ev.type === 'segments') segments.push(...(ev.segments as { kind?: string; text?: string }[]));
    }
    return segments;
}

test('正文：不含换行的分片被缓冲，不再逐字产出独立 segment', () => {    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, { type: 'message_start', message: { id: 'msg_t1' } });
    const a = feedText(adapter, 'AI');
    const b = feedText(adapter, '被');
    const c = feedText(adapter, '设定');
    adapter.dispose();

    assert.deepEqual(a, [], '半行分片不应立即产出 segment');
    assert.deepEqual(b, []);
    assert.deepEqual(c, []);
});

test('正文：整行完成时也不产出 segment，正文攒到块结束再整块渲染', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, { type: 'message_start', message: { id: 'msg_t2' } });
    feedText(adapter, 'AI');
    feedText(adapter, '被设定');
    const duringStream = feedText(adapter, '为永远诚实\n');
    const events = feedStreamEvent(adapter, { type: 'content_block_stop', index: 0 });
    adapter.dispose();

    assert.deepEqual(duringStream, [], '整行到达也不应在 delta 阶段产出 segment');
    const segments: { text?: string }[] = [];
    for (const ev of events) {
        if (ev.type === 'segments') segments.push(...(ev.segments as { text?: string }[]));
    }
    const merged = segments.map((s) => s.text).join('');
    assert.ok(merged.includes('AI被设定为永远诚实'), `块结束时应整块产出，实际：${merged}`);
});

test('正文：跨行 Markdown 表格在块结束时作为单个 segment 产出', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, { type: 'message_start', message: { id: 'msg_t4' } });
    feedText(adapter, '| 项目 | 位置 |\n');
    feedText(adapter, '| --- | --- |\n');
    feedText(adapter, '| admin | src/a.ts |\n');
    const events = feedStreamEvent(adapter, { type: 'content_block_stop', index: 0 });
    adapter.dispose();

    const markdown: string[] = [];
    for (const ev of events) {
        if (ev.type !== 'segments') continue;
        for (const seg of ev.segments as { kind?: string; text?: string }[]) {
            if (seg.kind === 'markdown' && seg.text) markdown.push(seg.text);
        }
    }
    assert.equal(markdown.length, 1, `表格必须整块产出，实际拆成 ${markdown.length} 段`);
    assert.ok(markdown[0].includes('| --- | --- |'), '表格分隔行必须与表头同属一段');
});

test('正文：content_block_stop 会 flush 末尾未换行的半行', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, { type: 'message_start', message: { id: 'msg_t3' } });
    feedText(adapter, '没有换行的结尾');
    const events = feedStreamEvent(adapter, { type: 'content_block_stop', index: 0 });
    adapter.dispose();

    const segments: { text?: string }[] = [];
    for (const ev of events) {
        if (ev.type === 'segments') segments.push(...(ev.segments as { text?: string }[]));
    }
    const merged = segments.map((s) => s.text).join('');
    assert.ok(merged.includes('没有换行的结尾'), `末行必须被 flush，实际：${merged}`);
});
