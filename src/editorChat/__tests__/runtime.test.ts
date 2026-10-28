/** @file Real child-process tests for concurrent editor lifetimes; no paid model or extension installation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { EditorConversationStore, type EditorConversation } from '../store';
const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { EditorChatRuntime } = require('../runtime') as typeof import('../runtime');
const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');

test('parallel editor messages, settings, closing and resume do not affect another CLI', { timeout: 15000 }, async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-cli-'));
    const executable = path.join(cwd, 'cli');
    await fs.copyFile(path.resolve(__dirname, '../../../fixtures/editor-chat-cli.cjs'), executable); await fs.chmod(executable, 0o700);
    stub.workspaceFolderFsPath = cwd;
    t.mock.method(ChatCliConfigService.prototype, 'getConfig', () => ({ enabled: true, cliPath: executable, cwd, cliArgs: [], cliEnv: { CLAUDE_CONFIG_DIR: path.join(cwd, 'config') }, transport: 'streamJsonStdio' as const }));
    const manager = { getProvider: () => ({ enabled: true }), getProviderModel: (_p: string, id: string) => ({ modelId: id, contextLength: 200000 }), isModelEnabled: () => true,
        getGlobalSystemPrompt: () => '', getWorkspaceSystemPrompt: () => '', getResolvedUiLanguage: () => 'en', listProviders: () => [] } as unknown as import('../../configManager').ConfigManager;
    const runtimes: InstanceType<typeof EditorChatRuntime>[] = [];
    const data: EditorConversation[] = [];
    /** Create a detached panel and owned conversation for the test. */
    async function create(existing?: EditorConversation) {
        const value: EditorConversation = existing ?? { version: 1, conversationId: randomUUID(), cwd, title: 'Chat', revision: 0, createdAt: Date.now(), updatedAt: Date.now(), messages: [], lastRunState: 'idle',
            settings: { normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' } };
        const store = new EditorConversationStore(cwd, value.conversationId); await store.acquire(); if (!existing) await store.save(value);
        const received: any[] = [];
        const panel = { title: 'Chat', webview: { postMessage: async (m: unknown) => { received.push(m); return true; } } } as unknown as import('vscode').WebviewPanel;
        const runtime = new EditorChatRuntime(value, store, panel, manager, async () => {}, async () => {});
        runtimes.push(runtime); data.push(value); await runtime.start(); return { runtime, received, store, value };
    }
    /** Wait on an explicit persisted terminal state, not an arbitrary startup delay. */
    async function idle(value: EditorConversation) {
        const end = Date.now() + 4000;
        while (value.lastRunState === 'running' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(value.lastRunState, 'idle');
    }
    try {
        const a = await create(), b = await create();
        await Promise.all([a.runtime.send('A'), b.runtime.send('B')]); await Promise.all([idle(a.value), idle(b.value)]);
        assert.notEqual(a.value.cliSessionId, b.value.cliSessionId);
        assert.ok(a.value.messages.some(m => m.segments.some(s => s.text === 'Reply A')));
        assert.ok(!a.value.messages.some(m => m.segments.some(s => s.text === 'Reply B')));
        await a.runtime.receive({ type: 'reasoningEffort/select', effort: 'high' }); assert.equal(b.value.settings.reasoningEffort, 'auto');
        await Promise.all([a.runtime.send('slow A'), b.runtime.send('slow B')]); await a.runtime.close(); await idle(b.value);
        assert.ok(b.value.messages.some(m => m.segments.some(s => s.text === 'Reply slow B')));
        const loaded = await new EditorConversationStore(cwd, a.value.conversationId).load();
        assert.equal(loaded.settings.reasoningEffort, 'high'); assert.equal(loaded.lastRunState, 'interrupted');
        const restored = await create(loaded); assert.equal(restored.value.cliSessionId, loaded.cliSessionId);
        await restored.runtime.send('Restored'); await idle(restored.value);
        const conversationId = restored.value.conversationId, previousCli = restored.value.cliSessionId;
        const otherHistory = JSON.stringify(b.value.messages);
        const bProcess = (b.runtime as any).cli;
        const beforeRestart = JSON.stringify(restored.value.messages);
        const oldServer = (restored.runtime as any).relay.server;
        const visibleBefore = restored.received.length;
        await restored.runtime.receive({ type: 'cli/restart' });
        assert.notEqual((restored.runtime as any).relay.server, oldServer, 'Restart uses the owned relay-and-CLI flow');
        assert.equal(restored.value.cliSessionId, previousCli);
        assert.equal(JSON.stringify(restored.value.messages.slice(0, -6)), beforeRestart, 'Previous conversation messages are preserved');
        const notices = restored.value.messages.slice(-6).map(message => message.segments[0].text || '');
        assert.match(notices[0], /Stopping Claude CLI/);
        assert.match(notices[1], /Stopping local relay/);
        assert.match(notices[2], /Starting local relay/);
        assert.match(notices[3], /Local relay HTTP server started/);
        assert.match(notices[4], /Starting Claude CLI/);
        assert.match(notices[5], /restart completed/);
        assert.equal(notices.some(text => text.includes((restored.runtime as any).relay.url.split('/').at(-1))), false, 'Progress never exposes the relay capability');
        assert.equal(restored.received.slice(visibleBefore).filter(item => item.message.type === 'message/append').length, 6);
        assert.equal((b.runtime as any).cli, bProcess, 'Restarting A never replaces B CLI');
        assert.equal(JSON.stringify(b.value.messages), otherHistory);
        const relayAfterRestart = (restored.runtime as any).relay.server;
        const stopFailure = t.mock.method(restored.runtime as any, 'cancel', async () => { throw new Error('synthetic stop failure'); });
        const beforeFailure = restored.value.messages.length;
        try {
            await assert.rejects(restored.runtime.receive({ type: 'cli/restart' }), /synthetic stop failure/);
            const failures = restored.value.messages.slice(beforeFailure).map(message => message.segments[0].text || '');
            assert.equal(failures.some(text => text.includes('restart completed')), false);
            assert.ok(failures.some(text => text.includes('restart failed')));
            assert.equal((restored.runtime as any).relay.server, relayAfterRestart, 'Stop failure cannot start a replacement relay');
        } finally { stopFailure.mock.restore(); }
        await b.runtime.send('B after A restart'); await idle(b.value);
        const bHistoryAfterRestart = JSON.stringify(b.value.messages);
        await restored.runtime.receive({ type: 'session/clear' });
        assert.equal(restored.value.conversationId, conversationId, 'New chat stays in the same tab');
        assert.equal(restored.value.settings.reasoningEffort, 'high');
        assert.equal(restored.value.messages.length, 0);
        await restored.runtime.send('Fresh'); await idle(restored.value);
        assert.notEqual(restored.value.cliSessionId, previousCli);
        const sid = randomUUID();
        const dir = path.join(cwd, 'config', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${sid}.jsonl`), [JSON.stringify({ type: 'custom-title', customTitle: 'Saved history' }), JSON.stringify({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'old question' }] } })].join('\n'));
        await restored.runtime.receive({ type: 'sessions/list' });
        assert.ok(restored.received.some(item => item.message.type === 'sessions/list/result' && item.message.sessions.some((entry: any) => entry.sessionId === sid)));
        await restored.runtime.receive({ type: 'session/resume', sessionId: sid });
        assert.equal(restored.value.cliSessionId, sid);
        assert.ok(restored.value.messages.some(message => message.text === 'old question'));
        assert.equal(restored.value.conversationId, conversationId);
        assert.equal(JSON.stringify(b.value.messages), bHistoryAfterRestart);
        const { setCliUpdateInProgress } = await import('../../setup/gate');
        const beforeUpdate = restored.value.cliSessionId;
        const settingsBeforeUpdate = JSON.stringify(restored.value.settings);
        await restored.runtime.send('slow update');
        setCliUpdateInProgress(true);
        try {
            assert.equal(await restored.runtime.prepareCliUpdate(), true);
            assert.equal(restored.value.lastRunState, 'interrupted');
            await assert.rejects(restored.runtime.send('blocked during update'), /update in progress/);
            const countBeforeRestart = restored.value.messages.length;
            await restored.runtime.applyCliUpdate(executable);
            assert.equal(restored.value.cliSessionId, beforeUpdate);
            assert.equal(JSON.stringify(restored.value.settings), settingsBeforeUpdate);
            assert.equal(restored.value.messages.length, countBeforeRestart, 'Restart never replays the interrupted prompt');
        } finally { setCliUpdateInProgress(false); }
        await restored.runtime.send('After update'); await idle(restored.value);
        assert.equal(restored.value.cliSessionId, beforeUpdate);
    } finally { await Promise.all(runtimes.map(runtime => runtime.close())); await fs.rm(cwd, { recursive: true, force: true }); }
});

test('actual CLI authenticates through editor runtime without OAuth login', { skip: !process.env.CCAI_EDITOR_TEST_CLI, timeout: 30000 }, async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-auth-'));
    let requests = 0;
    const upstream = http.createServer((req, res) => {
        let body = ''; req.on('data', data => body += data); req.on('end', () => {
            requests++; const input = JSON.parse(body);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: `test-${requests}`, type: 'message', role: 'assistant', model: input.model,
                content: [{ type: 'text', text: 'EDITOR_AUTH_OK' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }));
        });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as import('node:net').AddressInfo).port;
    t.mock.method(ChatCliConfigService.prototype, 'getConfig', () => ({ enabled: true, cliPath: process.env.CCAI_EDITOR_TEST_CLI!, cwd, cliArgs: ['--bare'], cliEnv: { CLAUDE_CONFIG_DIR: cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, transport: 'streamJsonStdio' as const }));
    const manager = { getProvider: () => ({ enabled: true }), getProviderWithSecret: async () => ({ id: 'p', apiType: 'anthropic', enabled: true, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'synthetic', models: [] }),
        getProviderModel: () => ({ modelId: 'synthetic', contextLength: 200000 }), isModelEnabled: () => true, getGlobalSystemPrompt: () => '', getWorkspaceSystemPrompt: () => '', getResolvedUiLanguage: () => 'en', listProviders: () => [] } as unknown as import('../../configManager').ConfigManager;
    const value: EditorConversation = { version: 1, conversationId: randomUUID(), cwd, title: 'Auth', revision: 0, createdAt: Date.now(), updatedAt: Date.now(), messages: [], lastRunState: 'idle',
        settings: { normalModel: 'p/synthetic', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' } };
    const store = new EditorConversationStore(cwd, value.conversationId); await store.acquire();
    const panel = { webview: { postMessage: async () => true } } as unknown as import('vscode').WebviewPanel;
    const runtime = new EditorChatRuntime(value, store, panel, manager, async () => {}, async () => {});
    try {
        await runtime.start(); await runtime.send('hi');
        const deadline = Date.now() + 20000;
        while (value.lastRunState === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(value.lastRunState, 'idle', JSON.stringify(value.messages));
        assert.ok(requests > 0); assert.ok(value.messages.some(m => m.segments.some(s => s.text?.includes('EDITOR_AUTH_OK'))), JSON.stringify(value.messages));
    } finally { await runtime.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await fs.rm(cwd, { recursive: true, force: true }); }
});
