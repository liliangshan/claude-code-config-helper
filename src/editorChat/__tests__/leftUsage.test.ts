/** @file Request usage binding and persistence for left-side conversations through a real local proxy. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { EditorConversationStore } from '../store';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const vscode = require('vscode');
const { LeftChatSession } = require('../leftSession') as typeof import('../leftSession');
const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');
const { requestUsageRegistry } = require('../../chatRuntime/requestUsage') as typeof import('../../chatRuntime/requestUsage');

/** Reports must attach by exact upstream IDs, survive hidden settings/reload and never share main-chat bindings. */
test('left chat renders per-request usage and context meter with isolated, persisted response bindings', { timeout: 15000 }, async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'left-usage-'));
    stub.workspaceFolderFsPath = cwd; Object.assign(vscode.workspace, { isTrusted: true });
    const executable = path.join(cwd, 'cli');
    await fs.copyFile(path.resolve(__dirname, '../../../fixtures/editor-chat-cli.cjs'), executable); await fs.chmod(executable, 0o700);
    t.mock.method(ChatCliConfigService.prototype, 'getConfig', () => ({ enabled: true, cliPath: executable, cwd, cliArgs: [],
        cliEnv: { CLAUDE_CONFIG_DIR: path.join(cwd, 'config') }, transport: 'streamJsonStdio' as const }));
    const upstream = http.createServer((req, res) => {
        let body = ''; req.on('data', data => { body += data; }); req.on('end', () => {
            const input = JSON.parse(body);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'shared-response-id', type: 'message', role: 'assistant', model: input.model,
                content: [{ type: 'text', text: 'Usage reply' }], stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 } }));
        });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as import('node:net').AddressInfo).port;
    const manager = { getCurrentModel: () => ({ providerId: 'p', modelId: 'm' }), getChatReasoningEffort: () => 'auto',
        getChatSubagentsEnabled: () => false, getChatCacheTtl: () => 'default', getProvider: () => ({ enabled: true }),
        getProviderWithSecret: async () => ({ id: 'p', enabled: true, apiType: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'synthetic', models: [] }),
        getProviderModel: () => ({ modelId: 'm', contextLength: 200000 }), isModelEnabled: () => true,
        getGlobalSystemPrompt: () => '', getWorkspaceSystemPrompt: () => '', getResolvedUiLanguage: () => 'en', listProviders: () => [] } as any;
    const values = new Map<string, unknown>();
    const context = { workspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as any;
    const left = new LeftChatSession(context, manager, async () => {});
    let restored: InstanceType<typeof LeftChatSession> | undefined;
    const posted: any[] = [];
    const host = { title: '', webview: { postMessage: async (message: any) => { posted.push(message.message); return true; } } };
    try {
        await left.openFirst(); await left.attach(host);
        const owner = (left as any).runtime; const relay = owner.relay;
        const sessionId = owner.data.cliSessionId || owner.data.conversationId;
        owner.assistant = { id: 'assistant-before-usage', role: 'assistant', createdAt: Date.now(), segments: [
            { id: 'text-one', kind: 'markdown', text: 'Usage reply', responseMessageId: 'shared-response-id' }
        ] };
        owner.data.messages.push(owner.assistant);
        relay.active = true;
        const response = await fetch(`${relay.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'p/m', max_tokens: 20,
            messages: [{ role: 'user', content: 'test usage' }] }) });
        assert.equal(response.status, 200); await response.text();
        const deadline = Date.now() + 2000;
        while (!posted.some(message => message.type === 'request/usage') && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
        await owner.events;
        const segment = owner.data.messages[0].segments[0];
        assert.ok(segment.requestId); assert.equal(segment.requestUsage.inputTokens, 10);
        assert.equal(segment.requestUsage.outputTokens, 7); assert.equal(segment.requestUsage.cacheHitRate, 75);
        assert.equal(relay.usageRegistry.resolveRequestForSegment(sessionId, 'shared-response-id')?.requestId, segment.requestId);
        assert.equal(requestUsageRegistry.resolveRequestForSegment(sessionId, 'shared-response-id'), undefined, 'Left requests never enter main-chat bindings');
        requestUsageRegistry.clearRequestUsageBindings();
        assert.equal(relay.usageRegistry.resolveRequestForSegment(sessionId, 'shared-response-id')?.requestId, segment.requestId, 'Main history resets cannot erase left usage');
        assert.ok(posted.some(message => message.type === 'tokenBudget/usage' && message.used === 47));
        await owner.onEvent({ type: 'segments', segments: [{ id: 'text-two', kind: 'markdown', text: 'Later text', responseMessageId: 'shared-response-id' }], done: false });
        assert.equal(owner.assistant.segments.at(-1).requestId, segment.requestId);
        assert.equal(owner.assistant.segments.at(-1).requestUsage.cacheHitRate, 75, 'Usage arriving before text is retained');
        await owner.onEvent({ type: 'segments', segments: [{ id: 'unknown', kind: 'markdown', text: 'Unbound', responseMessageId: 'unrelated' }], done: false });
        assert.equal(owner.assistant.segments.at(-1).requestId, undefined, 'Unknown outputs never borrow active usage');
        const beforeAttach = posted.length; left.detach(); await left.attach(host);
        assert.ok(posted.slice(beforeAttach).some(message => message.type === 'tokenBudget/usage' && message.used === 47));
        const restoredInit = posted.slice(beforeAttach).find(message => message.type === 'session/init');
        assert.equal(restoredInit.messages[0].segments[0].requestUsage.cacheHitRate, 75);
        const beforeCompact = posted.filter(message => message.type === 'tokenBudget/usage').length;
        const compact = { ...segment.requestUsage.context, requestId: 'compact-only', compactCommandTriggered: true };
        relay.usageRegistry.registerRequest(compact);
        await owner.recordUsage({ summary: { ...segment.requestUsage, context: compact } });
        assert.equal(posted.filter(message => message.type === 'tokenBudget/usage').length, beforeCompact, 'Compaction usage cannot replace the main context meter');
        const id = left.activeId!;
        await left.shutdown();
        const saved = await new EditorConversationStore(cwd, id).load();
        assert.equal(saved.messages[0].segments[0].requestUsage?.outputTokens, 7);
        restored = new LeftChatSession(context, manager, async () => {});
        await restored.openFirst(); const beforeRestore = posted.length; await restored.attach(host);
        assert.ok(posted.slice(beforeRestore).some(message => message.type === 'tokenBudget/usage' && message.used === 47));
    } finally {
        await restored?.shutdown(); await left.shutdown(); upstream.closeAllConnections();
        await new Promise<void>(resolve => upstream.close(() => resolve())); await fs.rm(cwd, { recursive: true, force: true });
    }
});
