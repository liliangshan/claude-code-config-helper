/** @file Main-chat usage ordering and history restoration without provider calls or CLI startup. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { createRequestUsageContext, normalizeRequestUsage } from '../../relay/requestUsage';
import { requestUsageMessageId } from '../../relay/responseIdentity';
import { requestUsageRegistry } from '../requestUsage';

installVscodeStub({ values: {} });

/** Main history keeps per-request usage across ordering, persistence and native transcript rereads. */
test('main request usage stays isolated across late reports and history restoration', async () => {
    const hostRuntime = await import('../../runtime');
    const sessions = await import('../chatSession');
    const { routes } = await import('../routeState');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'main-usage-history-'));
    const sessionId = randomUUID(), values = new Map<string, any>(), posted: any[] = [];
    hostRuntime.setExtensionContext({ workspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as any);
    hostRuntime.setChatViewHost({ postMessage: async (message: unknown) => { posted.push(message); return true; } } as any);
    routes.normal.sessionId = sessionId; sessions.chatSessionState.sessionId = sessionId; sessions.chatSessionState.cwd = cwd;
    const a = createRequestUsageContext({ metadata: { session_id: sessionId } }, 'normal', 'p', 'a');
    const b = createRequestUsageContext({ metadata: { session_id: sessionId } }, 'normal', 'p', 'b');
    const first: import('../../chat/protocol').ChatSegment = { kind: 'markdown', text: 'first', responseMessageId: requestUsageMessageId(a) };
    const second: import('../../chat/protocol').ChatSegment = { kind: 'markdown', text: 'second', responseMessageId: requestUsageMessageId(b) };
    sessions.chatSessionState.messages = [{ id: 'one', role: 'assistant', createdAt: 1, segments: [first] }, { id: 'two', role: 'assistant', createdAt: 2, segments: [second] }];
    try {
        requestUsageRegistry.registerRequest(a); requestUsageRegistry.registerRequest(b);
        requestUsageRegistry.bindResponseMessage(a.requestId, sessionId, requestUsageMessageId(a));
        requestUsageRegistry.bindResponseMessage(b.requestId, sessionId, requestUsageMessageId(b));
        await sessions.recordChatRequestUsage(normalizeRequestUsage(b, { inputTokens: 20 }, 'completed'));
        await sessions.recordChatRequestUsage(normalizeRequestUsage(a, { inputTokens: 10 }, 'completed'));
        assert.equal(first.requestUsage?.inputTokens, 10); assert.equal(second.requestUsage?.inputTokens, 20);
        await sessions.flushPersistedChatSession(); sessions.restorePersistedChatSession();
        assert.equal(sessions.chatSessionState.messages[0].segments[0].requestUsage?.inputTokens, 10);
        const file = path.join(cwd, 'history.jsonl');
        await fs.writeFile(file, [a, b].map((context, index) => JSON.stringify({ type: 'assistant', uuid: randomUUID(), sessionId,
            message: { id: requestUsageMessageId(context), role: 'assistant', content: [{ type: 'text', text: `history-${index}` }] } })).join('\n'));
        const restored = await sessions.parseSessionJsonl(file);
        requestUsageRegistry.restoreSegmentUsage(sessionId, restored, sessions.chatSessionState.messages);
        assert.equal(restored[0].segments[0].requestUsage?.inputTokens, 10); assert.equal(restored[1].segments[0].requestUsage?.inputTokens, 20);
        const before = JSON.stringify(sessions.chatSessionState.messages), count = posted.length;
        routes.normal.sessionId = randomUUID();
        await sessions.recordChatRequestUsage(normalizeRequestUsage(a, { inputTokens: 999 }, 'completed'));
        assert.equal(JSON.stringify(sessions.chatSessionState.messages), before); assert.equal(posted.length, count);
        const generation = requestUsageRegistry.generationToken(); requestUsageRegistry.clearRequestUsageBindings();
        requestUsageRegistry.registerRequest(a, generation);
        assert.equal(requestUsageRegistry.bindResponseMessage(a.requestId, sessionId, requestUsageMessageId(a)), false);
    } finally {
        await sessions.flushPersistedChatSession(); sessions.chatSessionState.messages = []; sessions.chatSessionState.sessionId = undefined;
        routes.normal.sessionId = ''; hostRuntime.setExtensionContext(undefined); hostRuntime.setChatViewHost(undefined);
        requestUsageRegistry.clearRequestUsageBindings(); await fs.rm(cwd, { recursive: true, force: true });
    }
});

/** Newer context usage wins even when two requests start within one millisecond or an old history finishes late. */
test('main usage sink rejects stale-session and older same-millisecond meter updates', async () => {
    const { createUsageSink } = await import('../../activation/relayWiring');
    const { routes } = await import('../routeState');
    const { UsageReporter } = await import('../../relay/usageReporter');
    const updates: any[] = [], sink = createUsageSink({ afterRecv: (input: unknown) => updates.push(input) } as any);
    const sessionId = randomUUID(); routes.normal.sessionId = sessionId;
    const a = createRequestUsageContext({ metadata: { session_id: sessionId } }, 'normal', 'p', 'm');
    const b = { ...createRequestUsageContext({ metadata: { session_id: sessionId } }, 'normal', 'p', 'm'), startedAt: a.startedAt };
    const older = new UsageReporter(sink, a), newer = new UsageReporter(sink, b);
    try {
        newer.feedJson('{"id":"b","usage":{"input_tokens":20}}');
        older.feedJson('{"id":"a","usage":{"input_tokens":10}}');
        assert.equal(updates.length, 1); assert.equal(updates[0].usage.inputTokens, 20);
        assert.equal(requestUsageRegistry.getSummary(a.requestId)?.inputTokens, 10);
        routes.normal.sessionId = randomUUID();
        const late = new UsageReporter(sink, createRequestUsageContext({ metadata: { session_id: sessionId } }, 'normal', 'p', 'm'));
        late.feedJson('{"id":"late","usage":{"input_tokens":999}}'); assert.equal(updates.length, 1);
    } finally { routes.normal.sessionId = ''; requestUsageRegistry.clearRequestUsageBindings(); }
});
