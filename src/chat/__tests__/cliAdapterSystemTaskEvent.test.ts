/**
 * @file CliAdapter 系统任务事件丢弃与嵌入文本剥离的单元测试。
 *
 * 覆盖两套实现路径：
 * 1. {@link StreamJsonCliAdapter.parseOutput} 在 stdout 顶层遇到
 *    `{"type":"system","subtype":"taskstarted" | "task_started" |
 *    "tasknotification" | "task_notification" | "taskprogress" | "task_progress"}` 时应返回空 segments，
 *    避免任务调度事件 raw JSON 漏到聊天区。
 * 2. `stripEmbeddedSystemTaskEvents`（私有方法，通过反射读取）应能识别
 *    嵌入在自由文本中的同一组 subtype 写法并整段剥离。
 *
 * 注：测试通过最小化 `CliProcess` mock 直接构造 StreamJsonCliAdapter，
 * 避免触发真实 spawn 子进程的副作用。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { StreamJsonCliAdapter } from '../cli/cliAdapter';
import type { CliChunk, CliExitEvent, CliProcessStatus } from '../cli/types';

/**
 * 构造一个仅实现 onChunk / onExit / onStatus 的最小 CliProcess 替身。
 *
 * 真实 CliProcess 涉及 spawn 子进程与 vscode.Disposable，这里只暴露事件订阅
 * 入口供 adapter 注册监听，其余对外方法在本组测试中不会被调用。
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
 * 以 stdout 注入一行 JSON 文本，返回解析后的 ParsedCliEvent 数组。
 *
 * @param json 已序列化好的单行 JSON 字符串（不含尾部换行，函数内部统一补上）。
 */
function parseSingleStdoutLine(json: string) {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const events = adapter.parseOutput({ source: 'stdout', text: json + '\n', receivedAt: Date.now() });
    adapter.dispose();
    return events;
}

test('parseSystemTaskEvent 丢弃 taskstarted 紧凑写法', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'taskstarted', payload: { id: 't1' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') {
        assert.equal(events[0].segments.length, 0);
        assert.equal(events[0].done, false);
    }
});

test('parseSystemTaskEvent 丢弃 task_started 下划线写法', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'task_started', payload: { id: 't2' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') {
        assert.equal(events[0].segments.length, 0);
    }
});

test('parseSystemTaskEvent 丢弃 tasknotification 紧凑写法', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'tasknotification', payload: { id: 't3' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
});

test('parseSystemTaskEvent 丢弃 task_notification 下划线写法', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'task_notification', payload: { id: 't4' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
});

test('parseSystemTaskEvent 丢弃 taskprogress 紧凑写法', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'taskprogress', payload: { id: 't5' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
});

test('parseSystemTaskEvent 丢弃 task_progress 下划线写法', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'task_progress', payload: { id: 't6' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
});

test('parseSystemTaskEvent 对未知 subtype 不静默吞', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'someUnknownSubtype', payload: {} }));
    const allEmpty = events.every((event) => event.type === 'segments' && event.segments.length === 0);
    assert.equal(allEmpty, false, '未知 subtype 不应被静默吞，应保留降级渲染或抛出未知事件');
});

test('stripEmbeddedSystemTaskEvents 同时剥离两种写法的嵌入 JSON', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const strip = (text: string): string => (adapter as unknown as { stripEmbeddedSystemTaskEvents: (input: string) => string })
        .stripEmbeddedSystemTaskEvents(text);

    const cases: Array<{ name: string; input: string; expected: string }> = [
        {
            name: 'taskstarted 紧凑写法',
            input: '前文\n{"type":"system","subtype":"taskstarted","id":1}\n后文',
            expected: '前文\n后文'
        },
        {
            name: 'task_started 下划线写法',
            input: '前文\n{"type":"system","subtype":"task_started","id":2}\n后文',
            expected: '前文\n后文'
        },
        {
            name: 'tasknotification 紧凑写法',
            input: '前文\n{"type":"system","subtype":"tasknotification","id":3}\n后文',
            expected: '前文\n后文'
        },
        {
            name: 'task_notification 下划线写法',
            input: '前文\n{"type":"system","subtype":"task_notification","id":4}\n后文',
            expected: '前文\n后文'
        },
        {
            name: 'taskprogress 紧凑写法',
            input: '前文\n{"type":"system","subtype":"taskprogress","id":5}\n后文',
            expected: '前文\n后文'
        },
        {
            name: 'task_progress 下划线写法',
            input: '前文\n{"type":"system","subtype":"task_progress","id":6}\n后文',
            expected: '前文\n后文'
        },
        {
            name: '不是 system 任务事件的 JSON 不会被剥离',
            input: '前文\n{"type":"system","subtype":"unrelated","id":5}\n后文',
            expected: '前文\n{"type":"system","subtype":"unrelated","id":5}\n后文'
        }
    ];

    for (const sample of cases) {
        assert.equal(strip(sample.input), sample.expected, `case: ${sample.name}`);
    }
    adapter.dispose();
});
