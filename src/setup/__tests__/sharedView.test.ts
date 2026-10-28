/** @file Single-view routing between installation onboarding and settings, including in-place completion. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { SETUP_KEY, SETUP_COMPLETE_KEY } from '../state';

installVscodeStub({ values: {} });
const vscode = require('vscode');

/** Functional event emitter verifies listener replacement when the shared view changes its page. */
class TestEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    /** Register a listener with explicit release semantics. */
    public readonly event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    /** Notify current listeners only; disposed handlers cannot receive a later setup operation. */
    public fire(value: T): void { for (const listener of this.listeners) listener(value); }
    /** Release registered callbacks during extension shutdown. */
    public dispose(): void { this.listeners.clear(); }
}
Object.assign(vscode, { EventEmitter: TestEmitter, commands: { registerCommand: () => ({ dispose() {} }) } });
Object.assign(vscode.Uri, { joinPath: (...parts: Array<string | { fsPath: string }>) => ({ fsPath: parts.map(part => typeof part === 'string' ? part : part.fsPath).join('/') }) });
const entry = require('../entry') as typeof import('../entry');
const runtime = require('../../runtime') as typeof import('../../runtime');
const { ConfigWebviewViewProvider, ConfigWebviewController } = require('../../views/configView') as typeof import('../../views/configView');
const { SetupController } = require('../controller') as typeof import('../controller');

test('one settings view loads wizard for missing global state and switches in place after completion', async t => {
    t.mock.method(ConfigWebviewController.prototype as any, 'loadAd', async () => {});
    t.mock.method(ConfigWebviewController.prototype as any, 'registerVisibilityRefresh', () => {});
    const values = new Map<string, unknown>(); const posted: any[] = []; const changed = new TestEmitter<void>(); const incoming = new TestEmitter<any>();
    const commands: string[] = []; let opened = 0;
    Object.assign(vscode.window, { createWebviewPanel: () => assert.fail('No separate setup panel is allowed') });
    Object.assign(vscode.commands, { executeCommand: async (command: string) => { commands.push(command); } });
    const context = { subscriptions: [], workspaceState: { get: (key: string, fallback?: unknown) => key === 'claudeRouter.sidebarLayout.rightChat.v1' ? true : fallback, update: async () => {} }, extensionUri: { fsPath: '/extension' }, globalStorageUri: { fsPath: '/storage' }, globalState: {
        get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); }
    } } as unknown as import('vscode').ExtensionContext;
    const probe = require('../../chat/cli/nativeCompactionProbe') as typeof import('../../chat/cli/nativeCompactionProbe');
    t.mock.method(probe, 'probeCliVersion', async () => '2.1.311');
    Object.assign(vscode.workspace, { isTrusted: true });
    const selected = { providerId: 'p', modelId: 'm' };
    const manager = { onDidChange: changed.event, notifyChanged: () => changed.fire(), listProviders: () => [],
        getState: () => ({ providers: [] }), getChatCliPath: () => '/synthetic/claude', getCurrentModel: () => selected,
        getProvider: () => ({ enabled: true }), getProviderModel: () => ({ enabled: true }), isModelEnabled: () => true,
        getConfiguredUiLanguage: () => 'en', getResolvedUiLanguage: () => 'en', getChatReasoningEffort: () => 'auto' } as unknown as import('../../configManager').ConfigManager;
    entry.configureSetup(context, manager);
    const setup = entry.getSetupController()!; const settings = new ConfigWebviewViewProvider(context, manager);
    runtime.setConfigViewProvider(settings); runtime.setChatViewHost({ ensureVisible: async () => { opened++; } } as any);
    const htmlWrites: string[] = []; let currentHtml = '';
    const view = { title: '', visible: true, webview: {
        get html() { return currentHtml; },
        set html(value: string) { htmlWrites.push(value); currentHtml = value; },
        cspSource: 'vscode-webview:', asWebviewUri: (uri: any) => uri.fsPath,
        onDidReceiveMessage: incoming.event, postMessage: async (message: any) => { posted.push(message); return true; } },
        onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) };
    try {
        settings.resolveWebviewView(view as any);
        assert.ok(view.webview.html.includes('setup.js')); assert.equal(setup.needsWizard(), true); assert.equal(opened, 0);
        assert.equal(setup.completed(), false);
        await assert.rejects((setup as any).receive({ type: 'settings' }), /Complete setup/);
        (setup as any).state.lastStep = 3;
        (setup as any).state.cli = { path: '/synthetic/claude', version: '2.1.311', source: 'external', verifiedAt: Date.now() };
        await (setup as any).receive({ type: 'finish' });
        assert.ok(view.webview.html.includes('id="app"')); assert.equal(view.webview.html.includes('setup.js'), false);
        assert.equal(setup.needsWizard(), false);
        const writesBeforeReopen = values.get(SETUP_KEY);
        await setup.show();
        assert.ok(view.webview.html.includes('setup.js')); assert.equal(setup.needsWizard(), true);
        await (setup as any).receive({ type: 'settings' });
        assert.equal(setup.needsWizard(), false); assert.ok(view.webview.html.includes('id="app"'));
        await new Promise(resolve => setImmediate(resolve));
        const readyCount = posted.length;
        incoming.fire({ type: 'ready' }); await new Promise(resolve => setImmediate(resolve));
        assert.ok(posted.slice(readyCount).some(item => item.type === 'cli/update'));
        assert.equal(posted.slice(readyCount).some(item => item.type === 'setup'), false);
        assert.equal(values.get(SETUP_KEY), writesBeforeReopen, 'Reopening and returning never mutate installation completion');
        const { CliInstaller } = require('../../cliInstaller/install') as typeof import('../../cliInstaller/install');
        t.mock.method(CliInstaller.prototype, 'latest', async () => ({ version: '2.1.311', packageName: '@anthropic-ai/claude-code-darwin-arm64', url: 'https://registry.npmjs.org/test.tgz', integrity: 'synthetic' }));
        const htmlCount = htmlWrites.length; const stateCount = posted.filter(item => item.type === 'state').length;
        const commandCount = commands.length;
        await setup.install(true);
        assert.equal(setup.needsWizard(), false, 'A version check never enters onboarding');
        assert.equal(htmlWrites.length, htmlCount, 'Checking must not replace Webview HTML');
        assert.equal(posted.filter(item => item.type === 'state').length, stateCount, 'Checking must not re-render all settings');
        assert.equal(commands.length, commandCount, 'Checking must not focus another page or restart CLI');
        assert.equal(setup.cliUpdateSnapshot().progress?.phase, 'current');
        assert.equal(setup.cliUpdateSnapshot().busy, false);
        t.mock.method(CliInstaller.prototype, 'latest', async () => { throw new Error('registry offline'); });
        await assert.rejects(setup.install(true), /registry offline/);
        assert.equal(setup.cliUpdateSnapshot().progress?.phase, 'error');
        assert.equal(htmlWrites.length, htmlCount);
        assert.equal(posted.filter(item => item.type === 'state').length, stateCount);
        t.mock.method(CliInstaller.prototype, 'latest', async () => ({ version: '2.1.312', packageName: '@anthropic-ai/claude-code-darwin-arm64', url: 'https://registry.npmjs.org/test.tgz', integrity: 'synthetic' }));
        let confirmations = 0; let downloads = 0;
        Object.assign(vscode.window, { showWarningMessage: async () => { confirmations++; return undefined; } });
        t.mock.method(CliInstaller.prototype, 'install', async () => { downloads++; return '/unused'; });
        await setup.install(true);
        assert.equal(confirmations, 1); assert.equal(downloads, 0, 'A newer version is never downloaded without confirmation');
        assert.equal(setup.cliUpdateSnapshot().progress?.phase, 'cancelled');
        assert.equal(htmlWrites.length, htmlCount);
        Object.assign(vscode.commands, { executeCommand: async (command: string) => {
            commands.push(command);
            if (command === 'claudeRouter.setup.update') await setup.install(true);
        } });
        await (settings as any).controller.handleMessage({ type: 'setupAction', action: 'update' });
        assert.equal(posted.filter(item => item.type === 'state').length, stateCount, 'The update command response must not request a full page refresh');
        assert.equal(htmlWrites.length, htmlCount);
        assert.equal(view.webview.html.includes('setup.js'), false);
        assert.equal(values.get(SETUP_COMPLETE_KEY), true); assert.equal((values.get(SETUP_KEY) as any).completed, true);
        assert.ok(commands.includes('claudeRouter.chat.open'));
        assert.equal(values.has(SETUP_KEY), true, 'Only explicit completion writes the installation marker');
    } finally {
        settings.dispose(); runtime.setConfigViewProvider(undefined); runtime.setChatViewHost(undefined);
        for (const subscription of context.subscriptions) subscription.dispose();
    }
});
