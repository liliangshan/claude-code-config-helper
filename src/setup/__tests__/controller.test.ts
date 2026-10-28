/** @file Offline controller tests: absence of state always routes to setup, and model validation never fabricates completion. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { SETUP_COMPLETE_KEY, SETUP_KEY } from '../state';
installVscodeStub({ values: {} });
const vscode = require('vscode');
Object.assign(vscode, { commands: { registerCommand: () => ({ dispose() {} }) } });
const { SetupController } = require('../controller') as typeof import('../controller');

test('legacy valid provider and CLI never auto-complete onboarding without global markers', async t => {
    const values = new Map<string, unknown>(); const writes: string[] = [];
    Object.assign(vscode.commands, { registerCommand: () => ({ dispose() {} }) });
    const context = { subscriptions: [], globalState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { writes.push(key); values.set(key, value); } } } as unknown as import('vscode').ExtensionContext;
    const manager = { onDidChange: () => ({ dispose() {} }), getChatCliPath: () => '/existing/claude', getCurrentModel: () => ({ providerId: 'p', modelId: 'm' }) } as unknown as import('../../configManager').ConfigManager;
    const controller = new SetupController(context, manager); let shown = 0;
    t.mock.method(controller, 'show', async () => { shown++; });
    assert.equal(await controller.ensureReady(), false);
    assert.equal(shown, 1); assert.deepEqual(writes, []);
    assert.equal(values.get(SETUP_COMPLETE_KEY), undefined); assert.equal(values.get(SETUP_KEY), undefined);
});

/** Reset uses the running extension API so renderer and extension-host caches receive the same deletion. */
test('reset command removes only installation state, clears completion in memory and immediately focuses setup', async t => {
    const environmentId = `${vscode.env.remoteName ?? 'local'}:${process.platform}:${process.arch}`;
    const preserved = { provider: { id: 'p' }, history: ['original'], cliPath: '/existing/claude' };
    const values = new Map<string, unknown>([
        [SETUP_COMPLETE_KEY, true], [SETUP_KEY, { schemaVersion: 1, completed: true, lastStep: 3, environmentId,
            cli: { path: '/existing/claude', version: '2.1.311', source: 'external', verifiedAt: 1 } }], ['unrelated', preserved]
    ]);
    const writes: Array<{ key: string; value: unknown }> = []; const commands = new Map<string, () => Promise<void>>();
    t.mock.method(vscode.commands, 'registerCommand', (name: string, action: () => Promise<void>) => {
        commands.set(name, action); return { dispose() {} };
    });
    const context = { subscriptions: [], globalState: {
        get: (key: string) => values.get(key), update: async (key: string, value: unknown) => {
            writes.push({ key, value }); if (value === undefined) values.delete(key); else values.set(key, value);
        }
    } } as unknown as import('vscode').ExtensionContext;
    const manager = { onDidChange: () => ({ dispose() {} }) } as unknown as import('../../configManager').ConfigManager;
    const controller = new SetupController(context, manager); let shown = 0;
    t.mock.method(controller, 'show', async () => { shown++; });
    try {
        assert.equal(controller.completed(), true);
        await commands.get('claudeRouter.setup.reset')!();
        assert.deepEqual(writes, [{ key: SETUP_COMPLETE_KEY, value: undefined }, { key: SETUP_KEY, value: undefined }]);
        assert.equal(values.has(SETUP_COMPLETE_KEY), false); assert.equal(values.has(SETUP_KEY), false);
        assert.equal(values.get('unrelated'), preserved); assert.equal(shown, 1);
        assert.equal(controller.completed(), false); assert.equal(controller.needsWizard(), true);
        assert.equal(controller.snapshot().lastStep, 1); assert.equal(controller.snapshot().cli, undefined);
        assert.equal(await controller.ensureReady(), false); assert.equal(shown, 2);
        const reloaded = new SetupController(context, manager);
        assert.equal(reloaded.completed(), false); assert.equal(reloaded.needsWizard(), true);
        (controller as any).busy = true;
        await assert.rejects(controller.reset(), /CLI operation in progress/);
        assert.equal(writes.length, 2, 'A reset cannot race an installation or version switch');
    } finally {
        (await import('../gate')).setSetupChecker(async () => true);
        for (const subscription of context.subscriptions) subscription.dispose();
    }
});

/** Concurrent chat entries wait for the same focused wizard and never infer installation from old CLI settings. */
test('simultaneous chat gates await one wizard activation without downloading or probing a CLI', async t => {
    const runtime = require('../../runtime') as typeof import('../../runtime');
    const { requireSetup, setSetupChecker } = await import('../gate');
    const values = new Map<string, unknown>(); const writes: string[] = [];
    const context = { subscriptions: [], globalState: {
        get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { writes.push(key); values.set(key, value); }
    } } as unknown as import('vscode').ExtensionContext;
    const manager = { onDidChange: () => ({ dispose() {} }), getChatCliPath: () => '/existing/claude',
        getCurrentModel: () => ({ providerId: 'p', modelId: 'm' }) } as unknown as import('../../configManager').ConfigManager;
    t.mock.method(require('../../chat/cli/nativeCompactionProbe'), 'probeCliVersion', async () => assert.fail('Missing completion must open onboarding before executing a CLI'));
    let focused = 0; let finishFocus!: () => void;
    runtime.setConfigViewProvider({ focus: () => { focused++; return new Promise<void>(resolve => { finishFocus = resolve; }); } } as any);
    const controller = new SetupController(context, manager);
    try {
        let settled = 0;
        const requests = [requireSetup(), requireSetup(), controller.ensureReady()].map(async pending => { const ready = await pending; settled++; return ready; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(focused, 1); assert.equal(settled, 0, 'Chat admission waits until the wizard is activated');
        finishFocus();
        assert.deepEqual(await Promise.all(requests), [false, false, false]);
        assert.equal(controller.needsWizard(), true); assert.deepEqual(writes, []);
        assert.equal(controller.snapshot().lastStep, 1); assert.equal(controller.completed(), false);
    } finally {
        runtime.setConfigViewProvider(undefined); setSetupChecker(async () => true);
        for (const subscription of context.subscriptions) subscription.dispose();
    }
});

test('CLI update blocks admission even when it starts during asynchronous setup verification', async () => {
    const { setSetupChecker, requireSetup, setCliUpdateInProgress } = await import('../gate');
    let complete!: (ready: boolean) => void;
    setSetupChecker(() => new Promise<boolean>(resolve => { complete = resolve; }));
    try {
        const admission = requireSetup();
        setCliUpdateInProgress(true); complete(true);
        assert.equal(await admission, false);
        assert.equal(await requireSetup(), false);
    } finally { setCliUpdateInProgress(false); setSetupChecker(async () => true); }
});

test('wizard streams in-page download progress and retains source choice without marking setup complete', async t => {
    const { CliInstaller } = await import('../../cliInstaller/install');
    const { ChatCliConfigService } = await import('../../chat/cli/cliConfig');
    const values = new Map<string, unknown>(); const posted: any[] = [];
    const context = { subscriptions: [], globalStorageUri: { fsPath: '/synthetic/storage' }, globalState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as unknown as import('vscode').ExtensionContext;
    const manager = { onDidChange: () => ({ dispose() {} }), notifyChanged: () => {}, listProviders: () => [], getChatCliPath: () => '', getCurrentModel: () => undefined,
        getConfiguredUiLanguage: () => 'auto', getResolvedUiLanguage: () => 'zh-tw', getChatReasoningEffort: () => 'auto' } as unknown as import('../../configManager').ConfigManager;
    Object.assign(vscode.workspace, { isTrusted: true });
    Object.assign(vscode.window, { showWarningMessage: async () => 'confirm' });
    t.mock.method(ChatCliConfigService.prototype, 'getConfig', () => ({ cliPath: '' } as any));
    const controller = new SetupController(context, manager);
    const internal = controller as any;
    internal.view = { title: '', webview: { postMessage: async (message: any) => { posted.push(message); } } };
    await internal.receive({ type: 'installSource', value: 'china' });
    assert.equal(controller.snapshot().installSource, 'china');
    await assert.rejects(internal.receive({ type: 'installSource', value: 'https://evil.example' }), /Invalid/);
    t.mock.method(CliInstaller.prototype, 'latest', async (_signal: AbortSignal, _pkg: string | undefined, source: import('../../cliInstaller/sources').CliInstallSource) => {
        assert.equal(source, 'china'); return { version: '2.1.311', packageName: '@anthropic-ai/claude-code-darwin-arm64', url: 'https://registry.npmmirror.com/test.tgz', integrity: 'synthetic', source };
    });
    Object.assign(vscode.window, { showOpenDialog: async () => [{ fsPath: '/custom/cli-downloads' }] });
    await internal.receive({ type: 'root' });
    assert.equal(controller.snapshot().installRoot, '/custom/cli-downloads');
    const restored = new SetupController(context, manager);
    assert.equal((restored as any).resolveInstallRoot(), '/custom/cli-downloads', 'Reload retains the selected directory');
    assert.equal(posted.filter(item => item.type === 'setup').at(-1).installRoot, '/custom/cli-downloads');
    t.mock.method(CliInstaller.prototype, 'install', async (_release: import('../../cliInstaller/install').CliRelease, _root: string, _signal: AbortSignal, progress: (bytes: number, total?: number) => void, onVerify?: () => void) => {
        assert.equal(_root, '/custom/cli-downloads');
        progress(58, 117); progress(117, 117); onVerify?.(); return '/synthetic/claude';
    });
    const notifications: string[] = [];
    Object.assign(vscode.window, { showInformationMessage: (message: string) => { notifications.push(message); return new Promise(() => {}); } });
    t.mock.method(internal, 'switchCli', async () => internal.reportSwitchResult('2.1.311', []));
    await controller.install(false);
    assert.equal(notifications.length, 1, 'An undismissed completion notice cannot block installation');
    assert.equal(internal.busy, false);
    Object.assign(vscode.window, { showWarningMessage: () => new Promise(() => {}) });
    assert.equal(internal.reportSwitchResult('2.1.311', ['restart failed']), false, 'Warnings also return without waiting for dismissal');
    const updates = posted.filter(item => item.type === 'setup/progress').map(item => item.progress);
    assert.deepEqual(updates.map(item => item.phase), ['checking', 'confirming', 'downloading', 'downloading', 'verifying', 'switching', 'complete']);
    assert.ok(updates.some(item => item.bytes === 117 && item.total === 117));
    assert.equal(controller.snapshot().completed, false);
    assert.notEqual(values.get(SETUP_COMPLETE_KEY), true);
    const legacy = new SetupController(context, manager) as any;
    delete legacy.state.installRoot;
    legacy.state.cli = { installRoot: '/previous/managed-cli' };
    assert.equal(legacy.resolveInstallRoot(), '/previous/managed-cli', 'Older managed installations retain their recorded root');
});

test('provider setup advances without a current model and workspace selection only happens in step three', async () => {
    const values = new Map<string, unknown>(); let selection: unknown; const writes: unknown[] = [];
    const provider = { id: 'p', enabled: true, models: [{ modelId: 'm', enabled: true }] };
    const context = { subscriptions: [], globalState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as unknown as import('vscode').ExtensionContext;
    const manager = { onDidChange: () => ({ dispose() {} }), notifyChanged: () => {}, listProviders: () => [provider], getProvider: () => provider,
        getCurrentModel: () => selection, getProviderModel: () => provider.models[0], isModelEnabled: (model: any) => model?.enabled === true,
        setCurrentModel: async (value: unknown) => { selection = value; writes.push(value); } } as unknown as import('../../configManager').ConfigManager;
    const controller = new SetupController(context, manager); const internal = controller as any;
    internal.state.cli = { path: '/synthetic/claude', version: '2.1.311', source: 'external', verifiedAt: Date.now() };
    internal.state.lastStep = 2;
    await assert.rejects(internal.receive({ type: 'selectModel', providerId: 'p', modelId: 'm' }), /step three/);
    await internal.receive({ type: 'review' });
    assert.equal(controller.snapshot().lastStep, 3); assert.equal(selection, undefined); assert.deepEqual(writes, []);
    await internal.receive({ type: 'selectModel', providerId: 'p', modelId: 'm' });
    assert.deepEqual(selection, { providerId: 'p', modelId: 'm' });
    assert.equal(controller.snapshot().completed, false);
    await internal.receive({ type: 'back' }); provider.enabled = false;
    await assert.rejects(internal.receive({ type: 'review' }), /enabled provider/);
});

test('step three saves reasoning and optional models to the workspace without starting CLI or changing global compression defaults', async t => {
    const updates: Array<{ key: string; value: unknown; target: number }> = []; const efforts: string[] = [];
    const provider = { id: 'p', enabled: true, models: [{ modelId: 'm', enabled: true }] };
    const context = { subscriptions: [], globalState: { get: () => undefined } } as unknown as import('vscode').ExtensionContext;
    const manager = { onDidChange: () => ({ dispose() {} }), notifyChanged: () => {}, getProvider: () => provider,
        getProviderModel: () => provider.models[0], isModelEnabled: () => true, setChatReasoningEffort: async (effort: string) => { efforts.push(effort); } } as unknown as import('../../configManager').ConfigManager;
    const controller = new SetupController(context, manager); const internal = controller as any;
    t.mock.method(vscode.workspace, 'getConfiguration', () => ({ update: async (key: string, value: unknown, target: number) => { updates.push({ key, value, target }); } }));
    internal.state.lastStep = 2;
    await assert.rejects(internal.receive({ type: 'reasoningEffort', value: 'high' }), /step three/);
    internal.state.lastStep = 3;
    for (const value of ['auto', 'low', 'medium', 'high', 'xhigh']) await internal.receive({ type: 'reasoningEffort', value });
    await assert.rejects(internal.receive({ type: 'reasoningEffort', value: 'invalid' }), /Invalid reasoning/);
    assert.deepEqual(efforts, ['auto', 'low', 'medium', 'high', 'xhigh']);
    await internal.receive({ type: 'selectTaskFlowModel', providerId: 'p', modelId: 'm' });
    await internal.receive({ type: 'selectCompactionModel', providerId: 'p', modelId: 'm' });
    assert.deepEqual(updates, [
        { key: 'chat.taskFlow.model', value: 'p/m', target: vscode.ConfigurationTarget.Workspace },
        { key: 'chat.compactionMode.project.enabled', value: true, target: vscode.ConfigurationTarget.Workspace },
        { key: 'chat.compactionMode.project.model', value: 'p/m', target: vscode.ConfigurationTarget.Workspace }
    ]);
    await internal.receive({ type: 'selectTaskFlowModel', value: '' });
    await internal.receive({ type: 'selectCompactionModel', value: '' });
    assert.equal(updates.at(-1)?.value, '');
    provider.enabled = false;
    await assert.rejects(internal.receive({ type: 'selectTaskFlowModel', providerId: 'p', modelId: 'm' }), /enabled model/);
    assert.equal(controller.snapshot().completed, false);
});

test('embedded supplier manager reuses CRUD without replacing the wizard or accepting unrelated commands', async () => {
    const { ConfigWebviewController } = await import('../../views/configView');
    let listener!: (message: any) => void; const posted: any[] = []; const saved: unknown[] = [];
    const webview = { html: '<wizard-shell>', onDidReceiveMessage: (handler: typeof listener) => { listener = handler; return { dispose() {} }; }, postMessage: async (message: unknown) => { posted.push(message); return true; } };
    const host = { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as import('vscode').WebviewPanel;
    const manager = { onDidChange: () => ({ dispose() {} }), getState: () => ({ providers: [] }), replaceProviders: async (providers: unknown, secrets: unknown) => { saved.push({ providers, secrets }); } } as unknown as import('../../configManager').ConfigManager;
    const controller = new ConfigWebviewController({} as import('vscode').ExtensionContext, manager, host, undefined, { embedded: true, providersOnly: true });
    try {
        assert.equal(webview.html, '<wizard-shell>');
        listener({ type: 'ready' }); assert.equal(posted.length, 0, 'Plain wizard messages are not handled by the embedded controller');
        listener({ type: 'setup/providers', message: { type: 'ready' } });
        assert.equal(posted[0].type, 'setup/providers'); assert.equal(posted[0].message.providersOnly, true);
        listener({ type: 'setup/providers', message: { type: 'saveProviders', payload: { providers: [{ id: 'p' }], providerApiKeys: { p: 'synthetic-secret' } } } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(saved, [{ providers: [{ id: 'p' }], secrets: { p: 'synthetic-secret' } }]);
        assert.equal(posted.at(-1).message.type, 'toast');
        const count = posted.length;
        listener({ type: 'setup/providers', message: { type: 'reloadWindow' } });
        assert.equal(posted.length, count, 'Unrelated settings actions are rejected');
        assert.equal(webview.html, '<wizard-shell>');
    } finally { controller.dispose(); }
});
