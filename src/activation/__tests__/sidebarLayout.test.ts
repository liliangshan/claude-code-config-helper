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
    assert.deepEqual(moves.slice(2).map(item => item.command), ['workbench.view.extension.claudeRouter', 'claudeRouter.providersView.focus']);
    settings.dispose();
});

test('Activity Bar settings visibility also reveals main chat without requiring the settings command', async t => {
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
        settings.resolveWebviewView(view as any); assert.equal(shown, 1);
        view.visible = false; visibility(); assert.equal(shown, 1);
        view.visible = true; visibility(); assert.equal(shown, 2);
    } finally { runtime.setChatViewHost(undefined); settings.dispose(); }
});

test('opening settings reveals the main chat first and returns focus to settings even when reveal fails', async () => {
    const calls: string[] = []; let fail = false;
    Object.assign(vscode.commands, { executeCommand: async (command: string) => { calls.push(command); } });
    runtime.setChatViewHost({ ensureVisible: async (preserve: boolean) => { assert.equal(preserve, true); calls.push('reveal-main-chat'); if (fail) throw new Error('view unavailable'); } } as any);
    const settings = new ConfigWebviewViewProvider({} as never, {} as never);
    try {
        await settings.focus();
        assert.deepEqual(calls, ['reveal-main-chat', 'workbench.view.extension.claudeRouter', 'claudeRouter.providersView.focus']);
        calls.length = 0; fail = true;
        await settings.focus();
        assert.deepEqual(calls, ['reveal-main-chat', 'workbench.view.extension.claudeRouter', 'claudeRouter.providersView.focus']);
    } finally { runtime.setChatViewHost(undefined); settings.dispose(); }
});
