/** @file Real-process validation for the left-side conversation, independent of editor presentation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { EditorConversationStore } from '../store';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const vscode = require('vscode');
const { LeftChatSession } = require('../leftSession') as typeof import('../leftSession');
const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');

/** Detaching for list/settings must preserve the same CLI, UUID and live response until reattachment. */
test('left conversation survives hidden UI and reload restoration without creating an editor tab or replaying prompts', { timeout: 15000 }, async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'left-runtime-'));
    const executable = path.join(cwd, 'cli');
    await fs.copyFile(path.resolve(__dirname, '../../../fixtures/editor-chat-cli.cjs'), executable); await fs.chmod(executable, 0o700);
    stub.workspaceFolderFsPath = cwd;
    Object.assign(vscode.workspace, { isTrusted: true });
    Object.assign(vscode.window, { createWebviewPanel: () => assert.fail('Left runtime never creates an editor tab') });
    t.mock.method(ChatCliConfigService.prototype, 'getConfig', () => ({ enabled: true, cliPath: executable, cwd, cliArgs: [], cliEnv: { CLAUDE_CONFIG_DIR: path.join(cwd, 'config') }, transport: 'streamJsonStdio' as const }));
    const values = new Map<string, unknown>();
    const context = { workspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as unknown as import('vscode').ExtensionContext;
    const manager = { getCurrentModel: () => ({ providerId: 'p', modelId: 'm' }), getChatReasoningEffort: () => 'auto', getChatSubagentsEnabled: () => false, getChatCacheTtl: () => 'default',
        getProvider: () => ({ enabled: true }), getProviderModel: (_p: string, id: string) => ({ modelId: id, contextLength: 200000 }), isModelEnabled: () => true,
        getGlobalSystemPrompt: () => '', getWorkspaceSystemPrompt: () => '', getResolvedUiLanguage: () => 'en', listProviders: () => [] } as any;
    const left = new LeftChatSession(context, manager, async () => {});
    let restored: InstanceType<typeof LeftChatSession> | undefined;
    const posted: any[] = [];
    const host = { title: '', webview: { postMessage: async (message: any) => { posted.push(message); return true; } } };
    try {
        await Promise.all([left.openFirst(), left.openFirst(), left.openFirst()]); const id = left.activeId!;
        assert.equal((await EditorConversationStore.list(cwd)).length, 1, 'Rapid entry clicks create only one first conversation');
        await left.attach(host);
        const beforeRename = posted.length; await left.editTitle();
        assert.ok(posted.slice(beforeRename).some(message => message.message.type === 'session/edit-title' && message.message.sessionId === id));
        const owner = (left as any).runtime;
        await left.receive({ type: 'user/send', text: 'slow left' });
        const cli = owner.cli;
        left.detach(); const count = posted.length;
        await left.openFirst(); assert.equal(left.activeId, id, 'An entry click reuses the running left conversation');
        await assert.rejects(left.open(cwd), /running/);
        const deadline = Date.now() + 4000;
        while (owner.data.lastRunState === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(owner.data.lastRunState, 'idle');
        assert.equal(left.activeId, id); assert.equal(owner.cli, cli);
        assert.ok(owner.data.messages.some((message: any) => message.segments.some((segment: any) => segment.text === 'Reply slow left')));
        assert.equal(posted.length, count, 'Detached list/settings receives no chat messages');
        owner.permissions.set('pending-left', { questions: [{ question: 'Continue?', header: 'Confirm', options: [], multiSelect: false }] });
        await left.attach(host);
        assert.ok(posted.slice(count).some(message => message.message.type === 'session/init' && message.message.messages.length > 0));
        assert.ok(posted.slice(count).some(message => message.message.type === 'askUser/request' && message.message.requestId === 'pending-left'));
        owner.permissions.clear();
        const sessionId = owner.data.cliSessionId;
        await left.receive({ type: 'reasoningEffort/select', effort: 'high' });
        await left.shutdown();
        const saved = await new EditorConversationStore(cwd, id).load();
        assert.equal(saved.settings.reasoningEffort, 'high');
        restored = new LeftChatSession(context, manager, async () => {});
        const selection = restored.saved()!; assert.equal(selection.id, id);
        await restored.openFirst();
        assert.equal((restored as any).runtime.data.cliSessionId, sessionId);
        assert.equal((restored as any).runtime.data.messages.filter((message: any) => message.role === 'user').length, 1);
        const update = await restored.prepareCliUpdate(); assert.deepEqual(update.errors, []);
        assert.deepEqual(await update.resume(executable), []);
        assert.equal((restored as any).runtime.data.cliSessionId, sessionId);
        const restoredOwner = (restored as any).runtime;
        await restored.open(cwd, id); assert.equal((restored as any).runtime, restoredOwner);
    } finally { await restored?.shutdown(); await left.shutdown(); await fs.rm(cwd, { recursive: true, force: true }); }
});

/** Initial entry deterministically restores the oldest saved UUID, then keeps its identity on later clicks. */
test('direct left entry selects the first history and never skips an occupied or broken selection by creating another', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'left-first-'));
    stub.workspaceFolderFsPath = cwd;
    Object.assign(vscode.workspace, { isTrusted: true });
    const values = new Map<string, unknown>();
    const context = { workspaceState: {
        get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); }
    } } as unknown as import('vscode').ExtensionContext;
    const manager = {} as any;
    const entries = [{ id: 'second', occupied: false, conversation: { createdAt: 20 } },
        { id: 'first', occupied: false, conversation: { createdAt: 10 } }] as import('../store').EditorHistoryEntry[];
    t.mock.method(EditorConversationStore, 'list', async () => entries);
    const opened: Array<string | undefined> = [];
    const left = new LeftChatSession(context, manager, async () => {});
    const owner = { close: async () => {} };
    t.mock.method(left as any, 'activate', async (_cwd: string, id?: string) => { opened.push(id); (left as any).runtime = owner; });
    try {
        await Promise.all([left.openFirst(), left.openFirst()]);
        assert.deepEqual(opened, ['first']);
        (left as any).runtime = undefined;
        values.set('claudeRouter.leftConversation.v1', { cwd, id: 'second' });
        await left.openFirst(); assert.deepEqual(opened, ['first', 'second'], 'The saved left selection is restored before considering a different history');
        (left as any).runtime = undefined;
        values.set('claudeRouter.leftConversation.v1', { cwd, id: 'removed' });
        await left.openFirst(); assert.equal(opened.at(-1), 'first', 'A removed selection falls back to the first existing history');
        (left as any).runtime = undefined;
        values.clear(); entries[1].occupied = true;
        t.mock.method(left as any, 'activate', async (_cwd: string, id?: string) => { assert.equal(id, 'first'); throw new Error('Session owner is still running'); });
        await assert.rejects(left.openFirst(), /still running/);
        assert.equal(opened.length, 3, 'An occupied first session never silently becomes a new UUID');
        entries.splice(0, entries.length, { id: 'broken', occupied: false, error: 'Invalid metadata' });
        await assert.rejects(left.openFirst(), /history was preserved/);
    } finally { await left.shutdown(); await fs.rm(cwd, { recursive: true, force: true }); }
});
