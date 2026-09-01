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
    assert.equal(first.id, 'thinking:0');
    assert.equal(second.id, 'thinking:0');
    assert.equal(third.id, 'thinking:0');
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

    assert.equal(a?.id, 'thinking:0');
    assert.equal(b?.id, 'thinking:2');
});
