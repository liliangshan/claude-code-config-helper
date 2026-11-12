/** @file Independent-chat completion regressions run the real CLI parser and composer state handlers. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { EditorConversationStore, type EditorConversation } from '../store';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { EditorChatRuntime } = require('../runtime') as typeof import('../runtime');
const { StreamJsonCliAdapter } = require('../../chat/cli/cliAdapter') as typeof import('../../chat/cli/cliAdapter');
const source = readFileSync(path.resolve(__dirname, '../../../media/chat/main.js'), 'utf8');

/** Minimal composer control for running the production button-state functions. */
class ComposerControl {
    public dataset: Record<string, string> = {};
    public classList = { toggle() {} };
    public textContent = '';
    /** DOM attributes are not needed to observe the send/stop button transition. */
    public setAttribute(): void {}
}

/** Create an isolated owned runtime and connect its posted state to the actual composer implementation. */
async function fixture() {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-completion-'));
    const data: EditorConversation = { version: 1, conversationId: randomUUID(), cliSessionId: randomUUID(), cwd, title: 'Completion fixture',
        revision: 0, createdAt: Date.now(), updatedAt: Date.now(), lastRunState: 'idle', messages: [],
        settings: { normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto', permissionMode: 'acceptEdits',
            subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' } };
    const store = new EditorConversationStore(cwd, data.conversationId); await store.acquire();
    const button = new ComposerControl();
    const state = { chatRunning: false, backendRunning: false, compacting: false };
    const start = source.indexOf('    function setChatRunning(running) {');
    const end = source.indexOf('\n    /**', source.indexOf('    function setChatPendingFromMessage(', start));
    assert.ok(start > 0 && end > start);
    const ui = runInNewContext(source.slice(start, end) + '\n({setChatRunning,setChatPendingFromMessage});', {
        composerState: state, document: { querySelector: () => null }, HTMLElement: ComposerControl, HTMLButtonElement: ComposerControl,
        composerShellEl: null, globalPendingEl: null, tokenMeterWrapEl: null, sendEl: button, applyRunningDisabledControls() {},
        closeTokenMeterPopover() {}, t: (key: string) => key
    });
    const posted: any[] = [];
    const runtime = new EditorChatRuntime(data, store, { webview: { postMessage: async (envelope: any) => {
        const message = envelope.message; posted.push(message);
        if (message.type === 'chat/running') { state.backendRunning = message.running; ui.setChatRunning(message.running); }
        if (message.type === 'message/patch') ui.setChatPendingFromMessage(message.pending);
        return true;
    } } }, { getResolvedUiLanguage: () => 'en' } as any, async () => {}, async () => {});
    const owned = runtime as any;
    const adapter = new StreamJsonCliAdapter({ onChunk: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), getCwd: () => cwd } as any);
    /** Begin a fresh local turn without spawning a CLI or contacting any provider. */
    function begin() {
        owned.busy = true; owned.turnFinished = false; owned.turnFailed = false; owned.relay.active = true;
        owned.assistant = { id: randomUUID(), role: 'assistant', createdAt: Date.now(), segments: [], pending: true };
        data.messages.push(owned.assistant); data.lastRunState = 'running'; state.backendRunning = true; ui.setChatRunning(true);
    }
    /** Parse real stdout records before delivering serialized events to the independent runtime. */
    async function feed(record: Record<string, unknown>) {
        for (const event of adapter.parseOutput({ source: 'stdout', text: JSON.stringify(record) + '\n', receivedAt: Date.now() })) await owned.onEvent(event);
    }
    /** Complete one CLI turn with explicit success; stream message_stop alone is not sufficient. */
    async function result() { await feed({ type: 'result', subtype: 'success', is_error: false, result: 'Finished', session_id: data.cliSessionId }); }
    /** Send an authoritative running-task list, including a valid empty snapshot. */
    async function snapshot(ids: string[], sessionId = data.cliSessionId) {
        await feed({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId,
            tasks: ids.map(task_id => ({ task_id, task_type: 'local_bash', description: 'Local fixture task' })) });
    }
    /** Send a partial background update without inventing missing status fields. */
    async function update(taskId: string, patch: Record<string, unknown>, sessionId = data.cliSessionId) {
        await feed({ type: 'system', subtype: 'task_updated', task_id: taskId, patch, session_id: sessionId });
    }
    /** Release only this test's runtime and temporary files, even after a failed assertion. */
    async function close() {
        adapter.dispose();
        try { await runtime.close(); } finally { await fs.rm(cwd, { recursive: true, force: true }); }
    }
    begin();
    return { runtime, owned, data, store, state, button, posted, begin, feed, result, snapshot, update, close };
}

/** A completed turn must not revoke a still-running CLI's private relay capability. */
test('completed left chat accepts late CLI messages without reopening the finished turn', async t => {
    const f = await fixture();
    const { AnthropicProxyAdapter } = await import('../../relay/anthropicProxy');
    const relay = f.owned.relay as import('../relay').EditorRelay;
    let forwarded = 0, upstreamStatus = 200;
    Object.assign(f.owned.manager, {
        getProviderWithSecret: async () => ({ id: 'p', enabled: true, apiType: 'anthropic', baseUrl: 'https://example.invalid' }),
        getProviderModel: () => ({}), isModelEnabled: () => true
    });
    t.mock.method(AnthropicProxyAdapter.prototype, 'handle', async (context: Parameters<InstanceType<typeof AnthropicProxyAdapter>['handle']>[0]) => {
        forwarded++;
        context.res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
        context.res.end(JSON.stringify(upstreamStatus === 200 ? { type: 'message', content: [{ type: 'text', text: 'late fixture response' }] }
            : { error: { type: 'permission_error', message: 'Real provider refusal' } }));
    });
    try {
        await relay.start(); relay.configure(f.data.settings); relay.active = true; relay.sessionId = f.data.cliSessionId!;
        const originalUrl = relay.url;
        await f.result();
        assert.equal(f.owned.busy, false); assert.equal(f.button.textContent, '↑');
        const transcript = JSON.stringify(f.data.messages);
        const request = await fetch(`${originalUrl}/v1/messages?beta=true`, { method: 'POST', body: JSON.stringify({
            model: 'p/m', system: 'Generate a concise, sentence-case title for this conversation.',
            messages: [{ role: 'user', content: 'Summarize the finished local fixture.' }], max_tokens: 10
        }) });
        const body = await request.text();
        assert.equal(request.status, 200, body); assert.equal(forwarded, 1);
        await f.owned.events;
        assert.equal(relay.url, originalUrl); assert.equal(f.owned.busy, false);
        assert.equal(f.button.textContent, '↑'); assert.equal(f.owned.assistant.pending, false);
        assert.equal(f.data.lastRunState, 'idle'); assert.equal(f.owned.turnFailed, false);
        assert.equal(JSON.stringify(f.data.messages), transcript);
        assert.equal(f.posted.some(message => message.type === 'message/error'), false);
        upstreamStatus = 403;
        const upstreamDenied = await fetch(`${originalUrl}/v1/messages`, { method: 'POST', headers: { connection: 'close' }, body: '{}' });
        assert.equal(upstreamDenied.status, 403); assert.equal((await upstreamDenied.json() as any).error.message, 'Real provider refusal');
        assert.equal(forwarded, 2, 'A genuine upstream permission failure must not be hidden or converted to success');
        await f.runtime.cancel();
        const denied = await fetch(`${originalUrl}/v1/messages`, { method: 'POST', headers: { connection: 'close' }, body: '{}' });
        assert.equal(denied.status, 403); await denied.text(); assert.equal(forwarded, 2);
    } finally { await f.close(); }
});

/** A completed turn must not become visually active when titles, heartbeats or ignored records arrive later. */
test('completed independent chat ignores empty segments from late CLI notifications', async () => {
    const f = await fixture();
    try {
        await f.result(); assert.equal(f.button.textContent, '↑');
        const count = f.posted.length;
        for (const record of [
            { type: 'system', subtype: 'session_title_changed', title: 'Finished' },
            { type: 'stream_event', event: { type: 'ping' } },
            { type: 'system', subtype: 'status', status: null },
            { type: 'system', subtype: 'task_notification', task_id: 'old-task', status: 'completed' },
            { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 20 },
            { type: 'tool_progress', heartbeat: true, tool_use_id: 'old-heartbeat', tool_name: 'Bash' }
        ]) await f.feed(record);
        assert.equal(f.posted.length, count, 'Silent adapter events must not publish pending=true patches');
        assert.equal(f.owned.busy, false); assert.equal(f.state.chatRunning, false); assert.equal(f.button.textContent, '↑');
        assert.equal(f.owned.assistant.pending, false);
        assert.equal((await f.store.load()).messages.at(-1)?.pending, false);
        f.begin(); await f.owned.onEvent({ type: 'segments', segments: [{ kind: 'markdown', text: 'Next turn' }] });
        assert.equal(f.button.textContent, '■', 'A real new turn must still display the stop button');
    } finally { await f.close(); }
});

/** Late visible content is still rendered without resurrecting the completed assistant's pending state. */
test('late nonempty patches preserve completed pending state and another conversation stays running', async () => {
    const f = await fixture(), other = await fixture();
    try {
        await f.result();
        const segment = { id: 'late-metadata', kind: 'markdown', text: 'Final metadata' };
        await f.owned.onEvent({ type: 'segments', segments: [segment], done: false });
        assert.deepEqual(f.owned.assistant.segments.at(-1), segment);
        assert.equal(f.posted.at(-1).pending, false); assert.equal(f.button.textContent, '↑');
        assert.equal(other.owned.busy, true); assert.equal(other.button.textContent, '■');
    } finally { await f.close(); await other.close(); }
});

/** Completion still waits for actual background work, explicit CLI result and owned relay drain. */
test('independent completion waits for result, active tasks and relay drain in either event order', async () => {
    const f = await fixture();
    try {
        await f.feed({ type: 'message_stop' }); assert.equal(f.owned.busy, true);
        await f.snapshot(['one', 'two']); await f.result();
        assert.equal(f.owned.busy, true); assert.equal(f.button.textContent, '■');
        await f.update('one', { status: 'completed' }); assert.equal(f.owned.busy, true);
        await f.update('two', { description: 'Still working' }); assert.equal(f.owned.busy, true);
        f.owned.relay.inFlight = 1;
        await f.update('two', { status: 'completed' }); assert.equal(f.owned.busy, true);
        f.owned.relay.inFlight = 0; f.owned.relay.onIdle(); await f.owned.events;
        assert.equal(f.owned.busy, false); assert.equal(f.button.textContent, '↑');
        f.begin(); await f.snapshot(['three']); await f.update('three', { status: 'completed' });
        assert.equal(f.owned.busy, true, 'Task completion is not the end of the CLI turn');
        await f.result(); assert.equal(f.button.textContent, '↑');
        f.begin(); await f.snapshot(['four']); await f.result(); await f.snapshot([]);
        assert.equal(f.button.textContent, '↑', 'An authoritative empty snapshot releases background waiting');
    } finally { await f.close(); }
});

/** Description-only patches do not create tasks; both cancellation spellings and explicit end times settle work. */
test('background partial updates do not resurrect finished tasks or invent active work', async () => {
    const f = await fixture();
    try {
        for (const patch of [{}, { description: 'metadata' }, { end_time: null }, { status: 'future_status' }]) await f.update('unknown', patch);
        assert.equal(f.owned.background.size, 0);
        for (const status of ['running', 'pending', 'queued']) {
            await f.update('active', { status }); assert.equal(f.owned.background.has('active'), true);
            await f.update('active', { description: 'update', end_time: null }); assert.equal(f.owned.background.has('active'), true);
            await f.update('active', { status: 'future_status' }); assert.equal(f.owned.background.has('active'), true);
            await f.update('active', { end_time: 123 }); assert.equal(f.owned.background.size, 0);
        }
        for (const terminal of [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }, { status: 'canceled' }, { status: 'killed' }, { end_time: 0 }, { end_time: 123 }]) {
            await f.snapshot(['finished']); await f.update('finished', terminal);
            await f.update('finished', { description: 'Final metadata' }); await f.update('finished', { end_time: null });
            assert.equal(f.owned.background.size, 0, JSON.stringify(terminal));
        }
        await f.result(); assert.equal(f.owned.busy, false); assert.equal(f.button.textContent, '↑');
        await f.update('finished', { description: 'Late metadata' }); assert.equal(f.owned.isBusy(), false);
    } finally { await f.close(); }
});

/** Session-tagged events from another conversation must neither create nor remove this runtime's blockers. */
test('foreign-session background snapshots and patches cannot change independent completion', async () => {
    const f = await fixture();
    try {
        const foreign = randomUUID();
        await f.snapshot(['foreign'], foreign); await f.update('foreign', { status: 'running' }, foreign);
        assert.equal(f.owned.background.size, 0);
        await f.snapshot(['owned']); await f.result();
        await f.snapshot([], foreign); await f.update('owned', { status: 'completed' }, foreign);
        assert.equal(f.owned.busy, true); assert.equal(f.owned.background.has('owned'), true);
        await f.update('owned', { end_time: 123 }); assert.equal(f.button.textContent, '↑');
    } finally { await f.close(); }
});
