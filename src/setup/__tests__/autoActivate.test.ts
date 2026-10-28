/** @file Both chat sides automatically focus the shared wizard when environment-local installation is incomplete. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { SETUP_KEY, SETUP_COMPLETE_KEY } from '../state';

installVscodeStub({ values: {} });
const vscode = require('vscode');
Object.assign(vscode, { commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} } });
Object.assign(vscode.Uri, { joinPath: (...parts: Array<string | { fsPath: string }>) => ({ fsPath: parts.map(part => typeof part === 'string' ? part : part.fsPath).join('/') }) });
const setupEntry = require('../entry') as typeof import('../entry');
const runtime = require('../../runtime') as typeof import('../../runtime');
const { ChatViewHost } = require('../../chat/chatViewHost') as typeof import('../../chat/chatViewHost');
const { LeftChatView } = require('../../editorChat/leftView') as typeof import('../../editorChat/leftView');
const { ConfigWebviewViewProvider } = require('../../views/configView') as typeof import('../../views/configView');

/** Reopening either side must require no placeholder-button click and must never launch software before completion. */
test('right view, left parallel entry and left visibility automatically focus incomplete onboarding', async t => {
    const values = new Map<string, unknown>(); const writes: string[] = [];
    const context = { subscriptions: [], extensionUri: { fsPath: '/extension' }, globalStorageUri: { fsPath: '/storage' },
        workspaceState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => {} },
        globalState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { writes.push(key); values.set(key, value); } }
    } as unknown as import('vscode').ExtensionContext;
    const manager = { getResolvedUiLanguage: () => 'en', onDidChange: () => ({ dispose() {} }) } as any;
    const cli = require('../../chat/cli/cliProcess') as typeof import('../../chat/cli/cliProcess');
    const installer = require('../../cliInstaller/install') as typeof import('../../cliInstaller/install');
    t.mock.method(cli.CliProcess.prototype, 'start', async () => assert.fail('Incomplete setup cannot start either chat CLI'));
    t.mock.method(installer.CliInstaller.prototype, 'install', async () => assert.fail('Wizard activation cannot automatically install software'));
    setupEntry.configureSetup(context, manager);
    const setup = setupEntry.getSetupController()!;
    let focused = 0; const commands: string[] = [];
    Object.assign(vscode.commands, { executeCommand: async (command: string) => { commands.push(command); } });
    runtime.setConfigViewProvider({ focus: async () => { focused++; } } as any);
    const right = new ChatViewHost(context);
    const left = new LeftChatView(context, manager);
    let rightVisibility: (() => void) | undefined; let disposed = 0;
    const view = { visible: true, webview: { options: {}, html: '',
        onDidReceiveMessage: () => ({ dispose() { disposed++; } }), postMessage: async () => true },
        onDidChangeVisibility: (listener: () => void) => { rightVisibility = listener; return { dispose() { rightVisibility = undefined; disposed++; } }; },
        onDidDispose: () => ({ dispose() {} }) };
    try {
        await right.resolveWebviewView(view as any);
        assert.equal(focused, 1, 'Right chat activates onboarding before displaying a waiting placeholder');
        await left.showConversation();
        assert.equal(focused, 2, 'Parallel entry activates the same wizard instead of starting a left session');
        assert.equal(left.session.activeId, undefined);
        rightVisibility!(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(focused, 3, 'Returning to the unresolved right chat automatically focuses onboarding again');
        const provider = new ConfigWebviewViewProvider(context, manager);
        t.mock.method(setup, 'attach', () => ({ dispose() {} }));
        let leftVisibility: (() => void) | undefined;
        const leftView = { visible: true,
            onDidChangeVisibility: (listener: () => void) => { leftVisibility = listener; return { dispose() {} }; },
            onDidDispose: () => ({ dispose() {} }) };
        try {
            provider.resolveWebviewView(leftView as any); await new Promise(resolve => setImmediate(resolve));
            assert.equal(focused, 4, 'Opening the left Activity Bar view activates the wizard directly');
            leftView.visible = false; leftVisibility!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(focused, 4);
            leftView.visible = true; leftVisibility!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(focused, 5);
            assert.equal(commands.includes('claudeRouter.chat.open'), false);
            assert.deepEqual(writes, []); assert.equal(values.has(SETUP_KEY), false); assert.equal(values.has(SETUP_COMPLETE_KEY), false);
        } finally { provider.dispose(); }
        right.dispose(); assert.equal(rightVisibility, undefined); assert.equal(disposed, 2);
    } finally {
        runtime.setConfigViewProvider(undefined); right.dispose(); left.dispose(); await left.session.shutdown();
        (await import('../gate')).setSetupChecker(async () => true);
        for (const subscription of context.subscriptions) subscription.dispose();
    }
});

/** Initial sidebar placement must be established before startup focuses onboarding, including on a clean profile. */
test('activation registers and positions both views before checking the global setup gate', () => {
    const source = readFileSync(resolve(__dirname, '../../../src/extension.ts'), 'utf8');
    const registered = source.indexOf('    registerDisposables(context, services);');
    const layout = source.indexOf('    await restorePreferredSidebarLayout(context);', registered);
    const gate = source.indexOf('    const setupReady = await requireSetup();', layout);
    assert.ok(registered >= 0 && layout > registered && gate > layout);
    assert.equal(source.slice(gate).includes('await restorePreferredSidebarLayout(context);'), false, 'Layout must not depend on setup already being complete');
});
