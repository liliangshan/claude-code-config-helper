/** @file Left settings/right chat contributions and one-time view migration tests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: {} });
const vscode = require('vscode');
Object.assign(vscode, { commands: {} });
const runtime = require('../../runtime') as typeof import('../../runtime');
const { restorePreferredSidebarLayout } = require('../sidebarLayout') as typeof import('../sidebarLayout');
const { ConfigWebviewViewProvider } = require('../../views/configView') as typeof import('../../views/configView');

test('main chat and settings register in separate right and left containers', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'));
    assert.equal(manifest.contributes.views.claudeRouter[0].id, 'claudeRouter.providersView');
    assert.equal(manifest.contributes.views.claudeRouterChatSecondary[0].id, 'claudeRouter.chatSidebarSecondary');
    assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, 'claudeRouterChatSecondary');
    const constants = require('../../constants') as typeof import('../../constants');
    assert.equal(constants.CHAT_SECONDARY_CONTAINER_ID, 'claudeRouterChatSecondary');
    const actions = manifest.contributes.menus['view/title'].filter((item: any) => item.when === 'view == claudeRouter.chatSidebarSecondary');
    assert.deepEqual(actions.map((item: any) => item.command), ['claudeRouter.chat.rename', 'claudeRouter.chat.openParallelSessions', 'claudeRouter.openConfigPanel', 'claudeRouter.chat.restart', 'claudeRouter.help.open']);
    assert.equal(manifest.contributes.commands.find((item: any) => item.command === 'claudeRouter.chat.openParallelSessions').icon, '$(add)');
});

test('view layout moves once, preserves later customization and settings focus opens the left view', async () => {
    const moves: Array<{ command: string; args: any }> = []; const values = new Map<string, unknown>();
    Object.assign(vscode.commands, {
        getCommands: async () => ['vscode.moveViews'],
        executeCommand: async (command: string, args: unknown) => { moves.push({ command, args }); }
    });
    const context = { workspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as unknown as import('vscode').ExtensionContext;
    await Promise.all([restorePreferredSidebarLayout(context), restorePreferredSidebarLayout(context)]);
    assert.deepEqual(moves, [
        { command: 'vscode.moveViews', args: { viewIds: ['claudeRouter.providersView'], destinationId: 'claudeRouter' } },
        { command: 'vscode.moveViews', args: { viewIds: ['claudeRouter.chatSidebarSecondary'], destinationId: 'claudeRouterChatSecondary' } }
    ]);
    await restorePreferredSidebarLayout(context); assert.equal(moves.length, 2);
    const settings = new ConfigWebviewViewProvider(context, {} as never);
    await settings.focus();
    assert.deepEqual(moves.slice(2).map(item => item.command), ['claudeRouter.providersView.focus']);
    settings.dispose();
});

test('manual settings-view visibility never activates a sibling main chat after moving either sidebar', async t => {
    const { ConfigWebviewController } = require('../../views/configView') as typeof import('../../views/configView');
    t.mock.method(ConfigWebviewController.prototype as any, 'configureWebview', () => {});
    t.mock.method(ConfigWebviewController.prototype as any, 'renderHtml', () => '<settings>');
    t.mock.method(ConfigWebviewController.prototype as any, 'loadAd', async () => {});
    t.mock.method(ConfigWebviewController.prototype as any, 'registerVisibilityRefresh', () => {});
    let visibility!: () => void; let shown = 0;
    runtime.setChatViewHost({ ensureVisible: async (preserve: boolean) => { assert.equal(preserve, true); shown++; } } as any);
    const view = {
        visible: true,
        webview: { html: '', onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true },
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeVisibility: (listener: () => void) => { visibility = listener; return { dispose() {} }; }
    };
    const manager = { onDidChange: () => ({ dispose() {} }), getState: () => ({ providers: [] }) };
    const settings = new ConfigWebviewViewProvider({} as never, manager as any);
    try {
        settings.resolveWebviewView(view as any); assert.equal(shown, 0);
        view.visible = false; visibility(); assert.equal(shown, 0);
        view.visible = true; visibility(); assert.equal(shown, 0, 'Selecting the moved view must not switch to the main chat');
    } finally { runtime.setChatViewHost(undefined); settings.dispose(); }
});

test('opening settings reveals the main chat first and returns focus to settings even when reveal fails', async () => {
    const calls: string[] = []; let fail = false;
    Object.assign(vscode.commands, { executeCommand: async (command: string) => { calls.push(command); } });
    runtime.setChatViewHost({ ensureVisible: async (preserve: boolean) => { assert.equal(preserve, true); calls.push('reveal-main-chat'); if (fail) throw new Error('view unavailable'); } } as any);
    const settings = new ConfigWebviewViewProvider({} as never, {} as never);
    try {
        await settings.focus();
        assert.deepEqual(calls, ['reveal-main-chat', 'claudeRouter.providersView.focus']);
        calls.length = 0; fail = true;
        await settings.focus();
        assert.deepEqual(calls, ['reveal-main-chat', 'claudeRouter.providersView.focus']);
    } finally { runtime.setChatViewHost(undefined); settings.dispose(); }
});

/** Simulate shared-sidebar tabs and swapped containers without conflating view placement with session identity. */
test('moved main and parallel views remain independently selectable without resetting runtime or saved layout', async t => {
    const { ChatViewHost } = require('../../chat/chatViewHost') as typeof import('../../chat/chatViewHost');
    const editorEntry = require('../../editorChat/entry') as typeof import('../../editorChat/entry');
    const { ConfigWebviewController } = require('../../views/configView') as typeof import('../../views/configView');
    t.mock.method(ConfigWebviewController.prototype as any, 'configureWebview', () => {});
    t.mock.method(ConfigWebviewController.prototype as any, 'renderHtml', () => '<settings>');
    t.mock.method(ConfigWebviewController.prototype as any, 'loadAd', async () => {});
    t.mock.method(ConfigWebviewController.prototype as any, 'registerVisibilityRefresh', () => {});
    for (const placement of ['same-secondary-sidebar', 'main-left-parallel-right']) {
        let active = ''; let visibility: (() => void) | undefined; let mounts = 0; let detached = 0;
        const commands: string[] = []; const shown: string[] = []; const posted: unknown[] = [];
        const savedLayout = new Map<string, unknown>([['claudeRouter.sidebarLayout.rightChat.v1', true]]);
        const context = { workspaceState: { get: (key: string, fallback?: unknown) => savedLayout.get(key) ?? fallback,
            update: async (key: string, value: unknown) => { savedLayout.set(key, value); } } } as any;
        const manager = { onDidChange: () => ({ dispose() {} }), getState: () => ({ providers: [] }) } as any;
        const main = new ChatViewHost(context);
        const mainMessages = [{ id: 'main-history', role: 'user', segments: [], createdAt: 1 }] as import('../../chat/protocol').ChatMessage[];
        const parallelIdentity = { conversationId: 'parallel-identity', cliSessionId: 'parallel-cli', messages: ['original history'] };
        t.mock.method(editorEntry, 'getLeftChatView', () => ({ mount: () => {
            mounts++; return { dispose: () => { detached++; } };
        }, session: parallelIdentity } as any));
        const mainView = { visible: true, show: (preserve: boolean) => {
            shown.push(`main:${preserve}`); mainView.visible = true; active = 'main';
            if (placement === 'same-secondary-sidebar') { parallelView.visible = false; visibility?.(); }
        } };
        const parallelView = { visible: false, show: (preserve: boolean) => {
            shown.push(`parallel:${preserve}`); parallelView.visible = true; active = 'parallel';
            if (placement === 'same-secondary-sidebar') mainView.visible = false;
            visibility?.();
        }, webview: { html: '', onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true },
            onDidDispose: () => ({ dispose() {} }),
            onDidChangeVisibility: (listener: () => void) => { visibility = listener; return { dispose() {} }; } };
        (main as any).target = { view: mainView, webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } };
        (main as any).initialMessages = mainMessages;
        runtime.setChatViewHost(main);
        Object.assign(vscode.commands, { executeCommand: async (command: string) => {
            commands.push(command);
            assert.equal(command.startsWith('workbench.view.extension.'), false, 'Never activate an original container after a move');
            assert.notEqual(command, 'vscode.moveViews', 'Opening a conversation cannot move either view');
        } });
        const provider = new ConfigWebviewViewProvider(context, manager);
        try {
            provider.resolveWebviewView(parallelView as any);
            await provider.showSessions(); await new Promise(resolve => setImmediate(resolve));
            assert.equal(active, 'parallel', placement); assert.equal(mounts, 1); assert.equal(detached, 0);
            if (placement === 'main-left-parallel-right') mainView.visible = false;
            await main.ensureVisible(false); assert.equal(active, 'main');
            parallelView.show(false); await new Promise(resolve => setImmediate(resolve));
            assert.equal(active, 'parallel', 'Manual selection cannot reveal main through a visibility callback');
            await provider.showSessions(); await new Promise(resolve => setImmediate(resolve));
            assert.equal(active, 'parallel'); assert.equal(mounts, 1); assert.equal(detached, 0);
            assert.equal((main as any).initialMessages, mainMessages); assert.deepEqual(posted, []);
            assert.deepEqual(parallelIdentity, { conversationId: 'parallel-identity', cliSessionId: 'parallel-cli', messages: ['original history'] });
            assert.equal(savedLayout.get('claudeRouter.sidebarLayout.rightChat.v1'), true);
            await provider.focus(); await new Promise(resolve => setImmediate(resolve));
            assert.equal(active, 'parallel', 'Explicit settings ends at its current view, not the default side');
            assert.equal(parallelView.webview.html, '<settings>'); assert.ok(shown.includes('parallel:false'));
        } finally { provider.dispose(); main.dispose(); runtime.setChatViewHost(undefined); }
    }
});
