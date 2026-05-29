/**
 * @file CliAdapter 对 ask_expert 委托工具的拦截行为单元测试。
 *
 * 按需专家方案下，主 CLI 调用 `mcp__askExpert__ask_expert` 时不应渲染普通工具卡片，
 * 而应：
 * - 在 content_block_start 静默隐藏（不产出工具 segment）；
 * - 累积 input_json_delta 得到完整 question；
 * - 在 content_block_stop 发出 `expert/subturn/started` 事件并携带 question。
 *
 * 通过最小化 CliProcess mock 直接驱动 StreamJsonCliAdapter.parseOutput，
 * 逐行喂入 Anthropic SSE 风格的 stream-json 事件。
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

/**
 * 构造最小 CliProcess 替身，只暴露事件订阅入口供 adapter 注册。
 */
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

/**
 * 把一行 JSON 包成 stream-json 顶层 SSE 事件喂给 adapter。
 *
 * Claude CLI 的 stream-json 把 Anthropic SSE 事件包在 `{type:'stream_event', event:{...}}`
 * 中；adapter.parseSdkWrapperEvent 负责解包。这里直接喂解包前的顶层行。
 *
 * @param adapter 目标 adapter。
 * @param event   SSE 内层事件对象。
 */
function feedStreamEvent(
    adapter: InstanceType<typeof StreamJsonCliAdapter>,
    event: Record<string, unknown>
): ParsedCliEvent[] {
    const line = JSON.stringify({ type: 'stream_event', event });
    return adapter.parseOutput({ source: 'stdout', text: line + '\n', receivedAt: Date.now() });
}

const ASK_EXPERT_FULL = 'mcp__askExpert__ask_expert';

test('ask_expert tool_use: content_block_start 不产出普通工具卡片 segment', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const events = feedStreamEvent(adapter, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_ask_1', name: ASK_EXPERT_FULL }
    });
    // 不应出现任何带 tool 字段的 segment。
    for (const ev of events) {
        if (ev.type === 'segments') {
            for (const seg of ev.segments) {
                assert.equal((seg as { tool?: unknown }).tool, undefined, 'ask_expert 不应渲染普通工具卡片');
            }
        }
    }
    adapter.dispose();
});

test('ask_expert tool_use: content_block_stop 发出 expert/subturn/started 并携带 question', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_ask_2', name: ASK_EXPERT_FULL }
    });
    feedStreamEvent(adapter, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"question":"Why does migration 42 fail?"}' }
    });
    const stopEvents = feedStreamEvent(adapter, { type: 'content_block_stop', index: 0 });

    const started = stopEvents.find((ev) => ev.type === 'expert/subturn/started');
    assert.ok(started, '应发出 expert/subturn/started 事件');
    if (started && started.type === 'expert/subturn/started') {
        assert.equal(started.toolUseId, 'toolu_ask_2');
        assert.match(started.question, /migration 42/);
    }
    adapter.dispose();
});

test('ask_expert tool_use: 裸名 ask_expert 也被识别为委托工具', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    feedStreamEvent(adapter, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_ask_3', name: 'ask_expert' }
    });
    feedStreamEvent(adapter, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"question":"Q"}' }
    });
    const stopEvents = feedStreamEvent(adapter, { type: 'content_block_stop', index: 0 });
    assert.ok(stopEvents.some((ev) => ev.type === 'expert/subturn/started'));
    adapter.dispose();
});

test('普通工具 tool_use 仍正常渲染工具卡片 segment', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const startEvents = feedStreamEvent(adapter, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_bash_1', name: 'Bash' }
    });
    const hasToolSegment = startEvents.some(
        (ev) => ev.type === 'segments' && ev.segments.some((seg) => (seg as { tool?: unknown }).tool)
    );
    assert.ok(hasToolSegment, '普通工具应渲染工具卡片');
    adapter.dispose();
});
