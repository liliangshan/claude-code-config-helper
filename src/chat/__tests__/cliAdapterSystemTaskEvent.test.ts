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

// cliAdapter 顶层 `import * as vscode from 'vscode'`，必须先装好 stub 再 require。
import { installVscodeStub } from './testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StreamJsonCliAdapter } = require('../cli/cliAdapter') as typeof import('../cli/cliAdapter');
type CliChunk = import('../cli/types').CliChunk;
type CliExitEvent = import('../cli/types').CliExitEvent;
type CliProcessStatus = import('../cli/types').CliProcessStatus;

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
        isRunning: () => true,
        // 测试需要从外部往内部事件总线注入 chunk/exit，暴露 emit 透传。
        emit: (name: string, ...args: unknown[]) => emitter.emit(name, ...args)
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

test('parseSystemTaskEvent 丢弃 compact_boundary', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') assert.equal(events[0].segments.length, 0);
});

test('parseSystemTaskEvent 丢弃 thinking_tokens 计数事件', () => {
    const events = parseSingleStdoutLine(JSON.stringify({
        type: 'system', subtype: 'thinking_tokens', estimated_tokens: 424, estimated_tokens_delta: 2,
        session_id: '5d158354-84f7-47a8-8836-36519adeba98', uuid: '52186497-c0bb-4283-a30e-f9825365c197'
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') assert.equal(events[0].segments.length, 0);
});

test('parseSystemTaskEvent 丢弃 thinking_tokens 计数事件', () => {
    const events = parseSingleStdoutLine(JSON.stringify({
        type: 'system', subtype: 'thinking_tokens', estimated_tokens: 424, estimated_tokens_delta: 2,
        session_id: 's1', uuid: 'u1'
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') assert.equal(events[0].segments.length, 0);
});

test('stream_event 包装的 ping 心跳静默丢弃，不再原文降级', () => {
    const events = parseSingleStdoutLine(JSON.stringify({
        type: 'stream_event', event: { type: 'ping' }, session_id: 's1', parent_tool_use_id: null, uuid: 'u2'
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') assert.equal(events[0].segments.length, 0);
});

test('Bash 与 Agent 的 tool_progress 心跳均静默丢弃', () => {
    for (const toolName of ['Bash', 'Agent']) {
        const events = parseSingleStdoutLine(JSON.stringify({
            type: 'tool_progress',
            tool_use_id: `call-1-heartbeat-${toolName}`,
            tool_name: toolName,
            parent_tool_use_id: 'call-1',
            elapsed_time_seconds: 60,
            heartbeat: true,
            session_id: 'session-1',
            uuid: 'heartbeat-1'
        }));
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'segments');
        if (events[0].type === 'segments') assert.equal(events[0].segments.length, 0);
    }
});

test('嵌套 Agent 的孤立 tool_result 静默丢弃，不新增成功卡片', () => {
    const events = parseSingleStdoutLine(JSON.stringify({
        type: 'user',
        parent_tool_use_id: 'call-outer-agent',
        message: {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: 'call-inner-bash',
                content: '内部命令完成',
                is_error: false
            }]
        }
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') assert.equal(events[0].segments.length, 0);
});

test('嵌套 Agent 中已配对的 tool_result 仍更新原工具卡片', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    adapter.parseOutput({
        source: 'stdout',
        text: JSON.stringify({ type: 'tool_use', id: 'call-inner-bash', name: 'Bash', input: { command: 'pwd' } }) + '\n',
        receivedAt: Date.now()
    });
    const events = adapter.parseOutput({
        source: 'stdout',
        text: JSON.stringify({
            type: 'user',
            parent_tool_use_id: 'call-outer-agent',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'call-inner-bash', content: '', is_error: false }]
            }
        }) + '\n',
        receivedAt: Date.now()
    });
    adapter.dispose();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') {
        assert.equal(events[0].segments.length, 1);
        assert.equal(events[0].segments[0].tool?.name, 'Bash');
        assert.equal(events[0].segments[0].tool?.status, 'success');
    }
});

test('主会话顶层孤立 tool_result 保留兼容卡片', () => {
    const events = parseSingleStdoutLine(JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'call-top-level',
        content: '顶层结果',
        is_error: false
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') {
        assert.equal(events[0].segments.length, 1);
        assert.equal(events[0].segments[0].tool?.name, 'tool_result');
        assert.equal(events[0].segments[0].tool?.status, 'success');
    }
});

test('parseSystemTaskEvent 对未知 subtype 转折叠 System 卡片而非静默吞', () => {
    const events = parseSingleStdoutLine(JSON.stringify({ type: 'system', subtype: 'someUnknownSubtype', payload: {} }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') {
        assert.equal(events[0].segments.length, 1);
        const segment = events[0].segments[0];
        assert.equal(segment.kind, 'tool');
        assert.equal(segment.tool?.name, 'System');
        assert.equal(segment.tool?.summary, 'someUnknownSubtype');
        // detail 保留完整 JSON，点开卡片可查看原文。
        assert.match(String(segment.tool?.detail), /someUnknownSubtype/);
    }
});

/** 不相关系统事件继续展示卡片，后台补丁只返回内部事件。 */
test('api_retry 保留 System 卡片，task_updated 转为内部补丁', () => {
    const retry = parseSingleStdoutLine(JSON.stringify({
        type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 401, error: 'authentication_failed'
    }));
    assert.equal(retry[0].type, 'segments');
    if (retry[0].type === 'segments') {
        assert.equal(retry[0].segments[0].tool?.summary, 'api_retry');
        assert.match(String(retry[0].segments[0].tool?.detail), /authentication_failed/);
    }
    const updated = parseSingleStdoutLine(JSON.stringify({
        type: 'system', subtype: 'task_updated', task_id: 'bkvhac6wt', patch: { status: 'killed' }
    }));
    assert.deepEqual(updated, [{
        type: 'backgroundTasks/update', taskId: 'bkvhac6wt', patch: { status: 'killed' }
    }]);
});

/** 快照允许没有状态，空列表仍是有效的全量快照。 */
test('后台任务快照解析多个无 status 条目及空快照', () => {
    const tasks = [
        { task_id: 'a', task_type: 'local_agent', description: '分析方案' },
        { task_id: 'b', task_type: 'local_bash', description: '执行检查' }
    ];
    assert.deepEqual(parseSingleStdoutLine(JSON.stringify({
        type: 'system', subtype: 'background_tasks_changed', tasks, session_id: 's1'
    })), [{ type: 'backgroundTasks/snapshot', sessionId: 's1', tasks: [
        { taskId: 'a', taskType: 'local_agent', description: '分析方案' },
        { taskId: 'b', taskType: 'local_bash', description: '执行检查' }
    ] }]);
    assert.deepEqual(parseSingleStdoutLine(JSON.stringify({
        type: 'system', subtype: 'background_tasks_changed', tasks: []
    })), [{ type: 'backgroundTasks/snapshot', tasks: [] }]);
});

/** 部分补丁不填默认值，保留终态、空结束时间及未知扩展字段。 */
test('后台任务补丁保留实际字段与来源会话', () => {
    for (const patch of [
        {}, { description: '更新说明' }, { end_time: null }, { end_time: 123 },
        { status: 'completed' }, { status: 'failed' }, { status: 'cancelled' },
        { status: 'canceled' }, { status: 'killed' }, { status: 'future_status', extra: true }
    ]) {
        assert.deepEqual(parseSingleStdoutLine(JSON.stringify({
            type: 'system', subtype: 'task_updated', task_id: 'a', patch, session_id: 's1'
        })), [{ type: 'backgroundTasks/update', taskId: 'a', patch, sessionId: 's1' }]);
    }
});

/** 畸形事件不生成空白任务，也不能误清空有效快照。 */
test('后台任务畸形快照和补丁只消费不展示', () => {
    const invalid = [
        { subtype: 'background_tasks_changed' },
        { subtype: 'background_tasks_changed', tasks: null },
        { subtype: 'background_tasks_changed', tasks: [null] },
        { subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', task_type: 'local_agent', description: ' ' }] },
        { subtype: 'task_updated', patch: {} },
        { subtype: 'task_updated', task_id: ' ', patch: {} },
        { subtype: 'task_updated', task_id: 'a', patch: [] },
        { subtype: 'task_updated', task_id: 'a', patch: { status: null } },
        { subtype: 'task_updated', task_id: 'a', patch: { description: 1 } },
        { subtype: 'task_updated', task_id: 'a', patch: { end_time: '123' } }
    ];
    for (const record of invalid) {
        assert.deepEqual(parseSingleStdoutLine(JSON.stringify({ type: 'system', ...record })), [
            { type: 'segments', segments: [], done: false }
        ]);
    }
});

/** 实际进程事件入口中，嵌入后台事件只广播一次且正文不含卡片或 JSON。 */
test('嵌入正文的后台快照和补丁通过事件总线发送一次', () => {
    const fake = createFakeCliProcess();
    const adapter = new StreamJsonCliAdapter(fake);
    const seen: Array<import('../cli/cliAdapter').ParsedCliEvent> = [];
    adapter.onParsedEvent((event) => seen.push(event));
    const snapshot = JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [
        { task_id: 'a', task_type: 'local_agent', description: '检查 {转义} "文本"' }
    ], session_id: 's1' });
    const update = JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'a', patch: { status: 'completed' }, session_id: 's1' });
    const bus = fake as unknown as { emit(name: string, ...args: unknown[]): boolean };
    bus.emit('chunk', { source: 'stdout', text: JSON.stringify({
        type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: `前文\n${snapshot}${update}\n后文` }] }
    }) + '\n', receivedAt: Date.now() });
    adapter.dispose();
    assert.deepEqual(seen.filter(event => event.type.startsWith('backgroundTasks/')), [
        { type: 'backgroundTasks/snapshot', tasks: [{ taskId: 'a', taskType: 'local_agent', description: '检查 {转义} "文本"' }], sessionId: 's1' },
        { type: 'backgroundTasks/update', taskId: 'a', patch: { status: 'completed' }, sessionId: 's1' }
    ]);
    const segments = seen.flatMap(event => event.type === 'segments' ? event.segments : []);
    assert.equal(segments.some(segment => segment.tool), false);
    const text = segments.map(segment => segment.text ?? '').join('');
    assert.match(text, /前文/);
    assert.match(text, /后文/);
    assert.doesNotMatch(text, /background_tasks_changed|task_updated|task_id/);
});

/** stripEmbeddedSystemTaskEvents 的新返回结构。 */
type StripResult = { text: string; systemSegments: import('../protocol').ChatSegment[] };

test('stripEmbeddedSystemTaskEvents 同时剥离两种写法的嵌入 JSON', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const strip = (text: string): StripResult => (adapter as unknown as { stripEmbeddedSystemTaskEvents: (input: string) => StripResult })
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
            name: 'compact_boundary',
            input: '前文\n{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual"}}\n后文',
            expected: '前文\n后文'
        }
    ];

    for (const sample of cases) {
        const result = strip(sample.input);
        assert.equal(result.text, sample.expected, `case: ${sample.name}`);
        assert.equal(result.systemSegments.length, 0, `case: ${sample.name} 任务事件应静默丢弃`);
    }

    // 非任务类 system 事件：文本剥离 + 产出折叠 System 卡片。
    const generic = strip('前文\n{"type":"system","subtype":"api_retry","attempt":2}\n后文');
    assert.equal(generic.text, '前文\n后文');
    assert.equal(generic.systemSegments.length, 1);
    assert.equal(generic.systemSegments[0].tool?.name, 'System');
    assert.equal(generic.systemSegments[0].tool?.summary, 'api_retry');

    // 长得像但不是合法 JSON 的文本原样保留。
    const broken = strip('见 {"type":"system","subtype":"x" 未闭合');
    assert.equal(broken.text, '见 {"type":"system","subtype":"x" 未闭合');
    assert.equal(broken.systemSegments.length, 0);
    adapter.dispose();
});


// -------------------------------------------------------------------------
// stderr 调试日志过滤（[claude-code:xxx] 行不再渲染为红色错误段）
// -------------------------------------------------------------------------

/**
 * 往 adapter 注入一段 stderr 并返回解析事件列表。
 *
 * @param text 原始 stderr 文本。
 */
function parseStderrChunk(text: string) {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    const events = adapter.parseOutput({ source: 'stderr', text, receivedAt: Date.now() });
    adapter.dispose();
    return events;
}

test('stderr 上 [claude-code:unrecognized_model] 日志行被静默丢弃', () => {
    const events = parseStderrChunk('[claude-code:unrecognized_model] {"model":"1778317248226-fowcqqv4k/qwen3.8-max","query_source":"sdk"}');
    assert.equal(events.length, 0, '调试日志行不应产出任何渲染事件');
});

test('stderr 上普通错误仍然渲染为 error 段', () => {
    const events = parseStderrChunk('ECONNREFUSED 127.0.0.1:1042');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'segments');
    if (events[0].type === 'segments') {
        assert.equal(events[0].segments[0].kind, 'error');
        assert.match(events[0].segments[0].text ?? '', /ECONNREFUSED/);
    }
});

test('退出时残留的 [claude-code: 日志行不会在 flush 阶段漏出', () => {
    const fake = createFakeCliProcess();
    const adapter = new StreamJsonCliAdapter(fake);
    // 通过进程事件总线触发：先发一段不带换行的调试日志（停留在缓冲），再触发 exit 走 flush。
    const seen: Array<import('../cli/cliAdapter').ParsedCliEvent> = [];
    adapter.onParsedEvent((event) => seen.push(event));
    const bus = fake as unknown as { emit(name: string, ...args: unknown[]): boolean };
    bus.emit('chunk', { source: 'stderr', text: '[claude-code:telemetry] {"event":"probe"}', receivedAt: Date.now() });
    bus.emit('exit', { code: 0, signal: undefined });
    adapter.dispose();
    for (const event of seen) {
        if (event.type === 'segments') {
            for (const segment of event.segments) {
                assert.doesNotMatch(String(segment.text ?? ''), /^\[claude-code:/);
            }
        }
    }
});
