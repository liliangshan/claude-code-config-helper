/** @file Native sidebar title synchronization and rename command tests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installVscodeStub } from './testUtils/vscodeStub';
installVscodeStub({ values: {} });
const vscode = require('vscode');
Object.assign(vscode, { commands: {} });
const { ChatViewHost } = require('../chatViewHost') as typeof import('../chatViewHost');
const runtime = require('../../runtime') as typeof import('../../runtime');
const lifecycle = require('../../chatRuntime/cliLifecycle') as typeof import('../../chatRuntime/cliLifecycle');
const messages = require('../../chatRuntime/webviewMessages') as typeof import('../../chatRuntime/webviewMessages');
const sessions = require('../../chatRuntime/chatSession') as typeof import('../../chatRuntime/chatSession');
const { routes } = require('../../chatRuntime/routeState') as typeof import('../../chatRuntime/routeState');

test('session titles reach the native sidebar before and after the webview resolves', async () => {
    const host = new ChatViewHost({} as import('vscode').ExtensionContext);
    assert.equal(await host.postMessage({ type: 'session/title', title: 'Saved task', sessionId: 'one' }), false);
    assert.deepEqual(host.getSessionTitle(), { title: 'Saved task', sessionId: 'one' });
    const view = { title: '' }; const sent: any[] = [];
    (host as any).target = { view, webview: { postMessage: async (message: any) => { sent.push(message); return true; } } };
    (host as any).updateNativeTitle(); assert.equal(view.title, 'Saved task');
    await host.postMessage({ type: 'session/title', title: 'Renamed task', sessionId: 'one' });
    assert.equal(view.title, 'Renamed task'); assert.equal(sent[0].message.title, 'Renamed task');
    await host.postMessage({ type: 'session/title', title: '', sessionId: '' });
    assert.equal(view.title, 'LLS CLAUDE CHAT'); assert.equal(host.getSessionTitle().sessionId, '');
    const css = readFileSync(resolve(__dirname, '../../../media/chat/style.css'), 'utf8');
    assert.doesNotMatch(css, /\.sidebar-chat \[data-role="session-title"\]\s*\{[^}]*display: none;/);
    assert.doesNotMatch(css, /\.sidebar-chat \.chat-header__main\s*\{[^}]*display: none;/);
    assert.match(css, /\.sidebar-chat \.chat-header__main\s*\{[^}]*flex: 1 0 72px;/);
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'));
    const nativeActions = manifest.contributes.menus['view/title'].filter((item: any) => item.when === 'view == claudeRouter.chatSidebarSecondary');
    assert.deepEqual(nativeActions.map((item: any) => item.command), ['claudeRouter.chat.rename', 'claudeRouter.chat.openParallelSessions', 'claudeRouter.openConfigPanel', 'claudeRouter.chat.restart', 'claudeRouter.help.open']);
    host.dispose();
});

test('sidebar initialization retains supplied history even when resolving a setup placeholder first', async t => {
    const host = new ChatViewHost({} as import('vscode').ExtensionContext);
    const history = [{ id: 'saved', role: 'user', segments: [{ kind: 'markdown', text: 'previous question' }], createdAt: 1 }] as import('../protocol').ChatMessage[];
    await host.postMessage({ type: 'session/init', messages: history, cliPath: '/saved/cli' });
    assert.equal((host as any).initialMessages, history);
    const sent: any[] = []; const pending = {};
    (host as any).pendingSetupView = pending;
    t.mock.method(host, 'resolveWebviewView', async () => {
        assert.equal((host as any).initialMessages, history);
        assert.equal((host as any).cliPath, '/saved/cli');
        (host as any).pendingSetupView = undefined;
        (host as any).target = { view: { show: () => {} }, webview: { postMessage: async (value: any) => { sent.push(value.message); return true; } } };
    });
    await host.open(history, '/saved/cli');
    assert.equal(sent[0].messages, history); host.dispose();
});

test('revealing main chat preserves focus and history without duplicate initialization or CLI commands', async () => {
    const commands: any[] = []; const shown: boolean[] = []; const posted: any[] = [];
    Object.assign(vscode.commands, { executeCommand: async (...args: unknown[]) => { commands.push(args); } });
    const host = new ChatViewHost({} as import('vscode').ExtensionContext);
    try {
        await host.ensureVisible();
        assert.deepEqual(commands, [['claudeRouter.chatSidebarSecondary.focus', { preserveFocus: true }]]);
        const history = [{ id: 'original', role: 'user', segments: [], createdAt: 1 }] as import('../protocol').ChatMessage[];
        (host as any).initialMessages = history;
        const view = { visible: false, show: (preserve: boolean) => { shown.push(preserve); view.visible = true; } };
        (host as any).target = { view, webview: { postMessage: async (value: any) => { posted.push(value); return true; } } };
        await host.ensureVisible(); await host.ensureVisible();
        assert.deepEqual(shown, [true]); assert.equal(commands.length, 1);
        assert.equal((host as any).initialMessages, history); assert.equal(posted.length, 0);
    } finally { host.dispose(); }
});

test('main chat restart button and legacy alias reuse the original toolbar relay-and-CLI restart', async t => {
    let cliRestarts = 0; let fullRestarts = 0;
    const cancelled: string[] = [];
    t.mock.method(lifecycle, 'restartChatCli', async () => { cliRestarts++; });
    t.mock.method(lifecycle, 'restartChatRelayAndCli', async () => { fullRestarts++; });
    messages.configureWebviewMessages({ cancelAutoContinue: (reason: string) => cancelled.push(reason), clearHttpExpectation: () => {} } as any);
    await messages.handleChatWebviewMessage({ type: 'cli/restartOnly' });
    assert.equal(cliRestarts, 0); assert.equal(fullRestarts, 1);
    assert.deepEqual(cancelled, ['manual_cli_restart']);
    await messages.handleChatWebviewMessage({ type: 'cli/restart' });
    assert.equal(cliRestarts, 0); assert.equal(fullRestarts, 2);
});

test('rename command opens the shared chat dialog and stale title submissions cannot rename a new session', async t => {
    const host = new ChatViewHost({} as import('vscode').ExtensionContext);
    const posted: any[] = [];
    (host as any).target = { view: { title: '' }, webview: { postMessage: async (value: any) => { posted.push(value.message); return true; } } };
    runtime.setChatViewHost(host);
    const writes: Array<{ cwd: string; sessionId: string; title: string }> = [];
    t.mock.method(lifecycle, 'getChatCliConfigService', () => ({ getConfig: () => ({ cwd: '/synthetic' }) } as any));
    t.mock.method(sessions, 'writeSessionCustomTitle', async (cwd: string, sessionId: string, title: string) => { writes.push({ cwd, sessionId, title }); });
    try {
        await host.postMessage({ type: 'session/title', title: 'Old', sessionId: 'one' }); routes.normal.sessionId = 'one';
        Object.assign(vscode.window, { showInputBox: () => assert.fail('Use the shared Webview dialog') });
        await messages.renameSidebarChat();
        assert.deepEqual(posted.at(-1), { type: 'session/edit-title', title: 'Old', sessionId: 'one' });
        await messages.handleChatWebviewMessage({ type: 'session/set-title', title: 'New title', sessionId: 'one' });
        assert.deepEqual(writes, [{ cwd: '/synthetic', sessionId: 'one', title: 'New title' }]);
        routes.normal.sessionId = 'two';
        await messages.handleChatWebviewMessage({ type: 'session/set-title', title: 'Stale title', sessionId: 'one' });
        assert.equal(writes.length, 1);
    } finally { routes.normal.sessionId = ''; runtime.setChatViewHost(undefined); host.dispose(); }
});

/** New and legacy parallel entries must directly reveal the left conversation without opening editor tabs. */
test('main chat routes parallel and legacy plus messages to the direct left conversation command', async t => {
    const commands: string[] = []; let listener: (message: any) => void = () => {};
    Object.assign(vscode.commands, { executeCommand: async (command: string) => { commands.push(command); } });
    const host = new ChatViewHost({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    t.mock.method(host as any, 'buildHtml', async () => '<chat>');
    const view = { title: '', webview: { options: {}, html: '', postMessage: async () => true,
        onDidReceiveMessage: (callback: (message: any) => void) => { listener = callback; return { dispose() {} }; }
    }, onDidDispose: () => ({ dispose() {} }) };
    Object.assign(vscode.Uri, { joinPath: () => ({ fsPath: '/synthetic/media' }) });
    try {
        await host.resolveWebviewView(view as any);
        for (const type of ['leftSessions/show', 'leftSessions/list', 'editorSession/new', 'editorSession/list']) listener({ type });
        assert.deepEqual(commands, Array(4).fill('claudeRouter.chat.openParallelSessions'));
    } finally { host.dispose(); }
});
