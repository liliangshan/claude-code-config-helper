/** @file Reload recovery of the main chat from its exact CLI history, without prompt replay. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: {} });
const runtime = require('../../runtime') as typeof import('../../runtime');
const lifecycle = require('../cliLifecycle') as typeof import('../cliLifecycle');
const sessions = require('../chatSession') as typeof import('../chatSession');
const messages = require('../webviewMessages') as typeof import('../webviewMessages');
const { ChatCliSessionStore } = require('../../chat/cli/sessionStore') as typeof import('../../chat/cli/sessionStore');
const { ChatViewHost } = require('../../chat/chatViewHost') as typeof import('../../chat/chatViewHost');
const { routes } = require('../routeState') as typeof import('../routeState');

test('empty cache reloads native history and manual resume persists identity before another reload', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sidebar-restore-'));
    const configDir = path.join(cwd, 'private-config'); const sid = randomUUID(); const second = randomUUID();
    const state = new Map<string, any>([['claudeRouter.chat.session.v1', { version: 1, updatedAt: Date.now(), messages: [] }]]);
    const context = { workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } } as unknown as import('vscode').ExtensionContext;
    const store = new ChatCliSessionStore(); const posted: any[] = [];
    const host = new ChatViewHost(context); (host as any).target = { view: { title: '' }, webview: { postMessage: async (message: any) => { posted.push(message.message); return true; } } };
    runtime.setExtensionContext(context); runtime.setChatViewHost(host);
    t.mock.method(lifecycle, 'getChatCliConfigService', () => ({ getConfig: () => ({ cwd, cliPath: '/synthetic/cli', cliEnv: { CLAUDE_CONFIG_DIR: configDir } }) } as any));
    t.mock.method(lifecycle, 'getChatCliSessionStore', () => store);
    let stopped = 0; let restarted = 0;
    t.mock.method(lifecycle, 'stopSidebarForHistorySwitch', async () => { stopped++; });
    t.mock.method(lifecycle, 'restartChatCliPair', async () => { restarted++; });
    const directory = sessions.resolveClaudeProjectDir(cwd, configDir); await fs.mkdir(directory, { recursive: true });
    /** Create isolated native history; it never invokes a CLI or upstream API. */
    const history = (title: string) => [
        { type: 'custom-title', customTitle: title },
        { type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'saved question' }] } },
        { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'saved answer' }] } }
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    try {
        await fs.writeFile(path.join(directory, `${sid}.jsonl`), history('Original task'));
        await fs.writeFile(path.join(directory, `${second}.jsonl`), history('Second task'));
        await store.writeSessionId(cwd, sid);
        routes.normal.sessionId = ''; routes.taskFlow.sessionId = '';
        sessions.restorePersistedChatSession(); assert.equal(sessions.chatSessionState.messages.length, 0);
        await Promise.all([sessions.ensureSidebarHistoryRestored(), sessions.ensureSidebarHistoryRestored()]);
        assert.equal(sessions.chatSessionState.messages.length, 2);
        assert.equal(sessions.chatSessionState.sessionId, sid);
        assert.equal(host.getSessionTitle().title, 'Original task');
        assert.equal(state.get('claudeRouter.chat.session.v1').sessionId, sid);
        assert.equal(state.get('claudeRouter.chat.session.v1').messages.length, 2);
        const cached = sessions.chatSessionState.messages;
        await sessions.ensureSidebarHistoryRestored(); assert.equal(sessions.chatSessionState.messages, cached, 'Do not reset a populated matching cache');
        messages.configureWebviewMessages({ clearHttpExpectation: () => {}, cancelPendingResend: () => {} } as any);
        await messages.handleChatWebviewMessage({ type: 'session/resume', sessionId: second });
        assert.equal(state.get('claudeRouter.chat.session.v1').sessionId, second);
        assert.equal(state.get('claudeRouter.chat.session.v1').messages.length, 2);
        assert.equal(posted.filter(item => item.type === 'session/title').at(-1)?.title, 'Second task');
        assert.equal(posted.filter(item => item.type === 'session/init').at(-1)?.replace, true);
        assert.equal(stopped, 1); assert.equal(restarted, 1);
        const originalMessages = sessions.chatSessionState.messages;
        const stopFailure = t.mock.method(lifecycle, 'stopSidebarForHistorySwitch', async () => { throw new Error('synthetic history stop failure'); });
        try {
            await assert.rejects(messages.handleChatWebviewMessage({ type: 'session/resume', sessionId: sid }), /synthetic history stop failure/);
            assert.equal(sessions.chatSessionState.messages, originalMessages);
            assert.equal(await store.readSessionId(cwd, 'normal'), second, 'A failed stop cannot publish or persist another session');
        } finally { stopFailure.mock.restore(); }
        await assert.rejects(messages.handleChatWebviewMessage({ type: 'session/resume', sessionId: randomUUID() }), { code: 'ENOENT' });
        assert.equal(sessions.chatSessionState.messages, originalMessages); assert.equal(stopped, 1);
        assert.equal(await store.readSessionId(cwd, 'normal'), second, 'Failed reads preserve the previous persisted history');
        await messages.handleChatWebviewMessage({ type: 'session/resume', sessionId: second });
        assert.equal(stopped, 2); assert.equal(restarted, 2, 'Selecting the same native history reloads it instead of returning early');
        sessions.restorePersistedChatSession(); await sessions.ensureSidebarHistoryRestored();
        assert.equal(sessions.chatSessionState.sessionId, second); assert.equal(sessions.chatSessionState.messages.length, 2);
        const stale = state.get('claudeRouter.chat.session.v1'); stale.sessionId = sid;
        sessions.restorePersistedChatSession(); await sessions.ensureSidebarHistoryRestored();
        assert.equal(sessions.chatSessionState.sessionId, second, 'Native resume identity wins over an unrelated message cache');
    } finally {
        sessions.chatSessionState.messages = []; sessions.chatSessionState.sessionId = undefined; sessions.chatSessionState.cwd = undefined;
        routes.normal.sessionId = ''; routes.taskFlow.sessionId = '';
        runtime.setExtensionContext(undefined); runtime.setChatViewHost(undefined); host.dispose(); await fs.rm(cwd, { recursive: true, force: true });
    }
});
