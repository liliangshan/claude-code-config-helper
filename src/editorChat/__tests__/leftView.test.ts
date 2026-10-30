/** @file Direct left conversation routing, safe presentation replacement and legacy editor preservation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import type { EditorConversation } from '../store';
import { leftSessionLabels } from '../leftLabels';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const vscode = require('vscode');
Object.assign(vscode, { commands: {} });
Object.assign(vscode.Uri, { joinPath: (...parts: Array<string | { fsPath: string }>) => ({ fsPath: parts.map(part => typeof part === 'string' ? part : part.fsPath).join('/') }) });
const { LeftChatView } = require('../leftView') as typeof import('../leftView');
const { ConfigWebviewViewProvider } = require('../../views/configView') as typeof import('../../views/configView');
const runtime = require('../../runtime') as typeof import('../../runtime');

/** Each locale supplies all list actions and safe-switch guidance, without falling back to mixed-language UI. */
test('left conversation list has complete labels in seven languages and the plus action no longer creates editor tabs', () => {
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        for (const value of Object.values(leftSessionLabels(language))) assert.ok(value);
    }
    assert.equal(leftSessionLabels('zh-cn').title, '并行会话');
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const actions = manifest.contributes.menus['view/title'].filter((item: any) => item.when === 'view == claudeRouter.chatSidebarSecondary');
    assert.ok(actions.some((item: any) => item.command === 'claudeRouter.chat.openParallelSessions'));
    const leftActions = manifest.contributes.menus['view/title'].filter((item: any) => item.when === 'view == claudeRouter.providersView && claudeRouter.leftChatActive');
    assert.deepEqual(leftActions.map((item: any) => item.command), ['claudeRouter.chat.left.rename', 'claudeRouter.openConfigPanel', 'claudeRouter.chat.left.restart', 'claudeRouter.help.open']);
    const commands = manifest.contributes.commands;
    assert.deepEqual(leftActions.map((item: any) => commands.find((command: any) => command.command === item.command).icon), ['$(edit)', '$(settings-gear)', '$(refresh)', '$(question)']);
    assert.equal(leftActions.some((item: any) => item.command === 'claudeRouter.chat.openParallelSessions'), false);
    assert.equal(actions.some((item: any) => item.command === 'claudeRouter.chat.newEditorSession'), false);
    for (const command of ['claudeRouter.chat.newEditorSession', 'claudeRouter.chat.openEditorHistory']) {
        assert.ok(manifest.contributes.commands.some((item: any) => item.command === command));
        assert.ok(manifest.contributes.menus.commandPalette.some((item: any) => item.command === command && item.when === 'false'));
    }
});

/** Both entry points show the conversation directly; settings replacement never stops its runtime. */
test('left entry opens chat directly with its own history drawer and repeated clicks preserve the current page', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'left-chat-'));
    stub.workspaceFolderFsPath = cwd;
    const data: EditorConversation = { version: 1, conversationId: randomUUID(), cwd, title: 'Saved left chat',
        revision: 0, createdAt: 1, updatedAt: 1, messages: [], lastRunState: 'closed', settings: {
            normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto', permissionMode: 'acceptEdits',
            subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default'
        } };
    const commands: string[] = []; const values = new Map<string, unknown>();
    const context = { extensionUri: { fsPath: path.resolve(__dirname, '../../..') }, workspaceState: {
        get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { values.set(key, value); }
    } } as unknown as import('vscode').ExtensionContext;
    const manager = { getResolvedUiLanguage: () => 'zh-cn', onDidChange: () => ({ dispose() {} }) } as any;
    const left = new LeftChatView(context, manager);
    const config = new ConfigWebviewViewProvider(context, manager);
    Object.assign(vscode.commands, { executeCommand: async (command: string) => { commands.push(command); } });
    Object.assign(vscode.window, { createWebviewPanel: () => assert.fail('Left entry must not create an editor tab') });
    let closed = 0; let opened = 0; let html = ''; let htmlWrites = 0;
    const owner = { data, close: async () => { closed++; }, ready: async () => {} };
    t.mock.method(left.session, 'openFirst', async () => {
        if (!(left.session as any).runtime) { opened++; (left.session as any).runtime = owner; }
    });
    t.mock.method(left as any, 'renderList', async () => assert.fail('No intermediate list page is allowed'));
    runtime.setConfigViewProvider(config);
    let incoming: ((message: any) => void) | undefined;
    const view = { title: '', webview: {
        get html() { return html; }, set html(value: string) { html = value; htmlWrites++; },
        cspSource: 'vscode-webview:', options: {}, asWebviewUri: (uri: any) => uri.fsPath,
        postMessage: async () => true,
        onDidReceiveMessage: (listener: (message: any) => void) => { incoming = listener; return { dispose() { incoming = undefined; } }; }
    } };
    let mount: import('vscode').Disposable | undefined;
    try {
        await left.showConversation();
        assert.deepEqual(commands, ['claudeRouter.providersView.focus']);
        mount = left.mount(view as any); await (left as any).rendering;
        assert.equal(left.session.activeId, data.conversationId);
        assert.ok(html.includes('<body class="left-chat">'));
        assert.equal(html.includes('data-role="left-session-list"'), false, 'Do not restore the intermediate independent-session list');
        for (const role of ['open-sessions', 'session-list']) assert.equal((html.match(new RegExp(`data-role="${role}"`, 'g')) || []).length, 1);
        assert.equal(html.includes('leftSessions.js'), false);
        assert.equal(/{{\w+}}/.test(html), false, 'Every shared chat resource must resolve for the left host');
        const writes = htmlWrites;
        await Promise.all([left.showConversation(), left.showConversation()]);
        await (left as any).receive({ type: 'leftSessions/list' });
        assert.equal(opened, 1); assert.equal(htmlWrites, writes); assert.equal(closed, 0);
        mount.dispose(); mount = undefined;
        assert.equal(closed, 0); assert.equal(incoming, undefined);
        assert.equal(left.session.activeId, data.conversationId);
        mount = left.mount(view as any); await (left as any).rendering;
        assert.equal(opened, 1); assert.equal(htmlWrites, writes + 1, 'Returning from settings reattaches the same chat');
        const toolbarActions: string[] = [];
        t.mock.method(left.session, 'editTitle', async () => { toolbarActions.push('left-rename'); });
        t.mock.method(left.session, 'receive', async (message: { type: string }) => { toolbarActions.push(message.type); });
        await left.runToolbarAction('rename'); await left.runToolbarAction('restart');
        assert.deepEqual(toolbarActions, ['left-rename', 'cli/restart']);
        const commandsBeforeHistory = commands.length;
        await (left as any).receive({ type: 'sessions/list' });
        await (left as any).receive({ type: 'session/resume', sessionId: 'saved-left' });
        assert.deepEqual(toolbarActions, ['left-rename', 'cli/restart', 'sessions/list', 'session/resume']);
        assert.equal(commands.length, commandsBeforeHistory, 'Native history stays in the left runtime instead of reopening a list or the main chat');
        mount.dispose(); mount = undefined;
        await left.runToolbarAction('restart');
        assert.deepEqual(toolbarActions, ['left-rename', 'cli/restart', 'sessions/list', 'session/resume'], 'Settings mode cannot dispatch a hidden chat action');
    } finally {
        mount?.dispose(); left.dispose(); config.dispose(); runtime.setConfigViewProvider(undefined);
        await left.session.shutdown(); await fs.rm(cwd, { recursive: true, force: true });
    }
});

/** Replacing settings with chat releases page listeners, not session ownership or the main chat. */
test('shared left provider switches between settings and chat without touching the main chat lifecycle', async t => {
    const entry = require('../entry') as typeof import('../entry');
    const { ConfigWebviewController } = require('../../views/configView') as typeof import('../../views/configView');
    let mounts = 0; let detached = 0; let reveals = 0;
    t.mock.method(entry, 'getLeftChatView', () => ({ mount: () => { mounts++; return { dispose: () => { detached++; } }; } } as any));
    t.mock.method(ConfigWebviewController.prototype as any, 'configureWebview', () => {});
    t.mock.method(ConfigWebviewController.prototype as any, 'renderHtml', () => '<settings>');
    t.mock.method(ConfigWebviewController.prototype as any, 'loadAd', async () => {});
    t.mock.method(ConfigWebviewController.prototype as any, 'registerVisibilityRefresh', () => {});
    const context = { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } } as any;
    const manager = { getState: () => ({ providers: [] }), onDidChange: () => ({ dispose() {} }) } as any;
    const provider = new ConfigWebviewViewProvider(context, manager);
    const view = { visible: true, show: () => {}, webview: { html: '', onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true },
        onDidDispose: () => ({ dispose() {} }), onDidChangeVisibility: () => ({ dispose() {} }) };
    runtime.setChatViewHost({ ensureVisible: async () => { reveals++; } } as any);
    const toolbarContexts: unknown[][] = [];
    Object.assign(vscode.commands, { executeCommand: async (...args: unknown[]) => { if (args[0] === 'setContext') toolbarContexts.push(args); } });
    try {
        provider.resolveWebviewView(view as any); assert.equal(view.webview.html, '<settings>');
        assert.deepEqual(toolbarContexts.at(-1), ['setContext', 'claudeRouter.leftChatActive', false]);
        await provider.showSessions(); assert.equal(mounts, 1);
        assert.deepEqual(toolbarContexts.at(-1), ['setContext', 'claudeRouter.leftChatActive', true]);
        await provider.showSessions(); assert.equal(mounts, 1, 'Repeated entry never duplicates a left host');
        await provider.focus(); assert.equal(detached, 1); assert.equal(view.webview.html, '<settings>');
        assert.deepEqual(toolbarContexts.at(-1), ['setContext', 'claudeRouter.leftChatActive', false]);
        assert.ok(reveals > 0);
    } finally { provider.dispose(); runtime.setChatViewHost(undefined); }
});
