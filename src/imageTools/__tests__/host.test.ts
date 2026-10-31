/** @file Host authorization, task ownership and capability tests with stubbed VS Code and mock generation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { forwardImageTool } from '../transport';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import type { ConfigManager } from '../../configManager';
import { defaultImageConfig, type ImageTask } from '../types';
import { ImageTaskStore } from '../taskStore';
import { imageResultMessage } from '../results';

installVscodeStub({ values: {} });
const vscode = require('vscode');
const { ImageToolHost } = require('../imageToolHost') as typeof import('../imageToolHost');

/** Supply only provider APIs and disposable notifications required by image configuration. */
function manager(): ConfigManager {
    return { listProviders: () => [], onDidChange: () => ({ dispose() {} }), getResolvedUiLanguage: () => 'en' } as unknown as ConfigManager;
}
/** Context isolates global files, identity records and a nonpersistent secret vault. */
function context(root: string): import('vscode').ExtensionContext {
    const secrets = new Map<string, string>(), state = new Map<string, unknown>();
    return { globalStorageUri: { fsPath: root }, secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } },
        workspaceState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } } } as unknown as import('vscode').ExtensionContext;
}

test('host submits generation and editing without billing dialogs while preserving validation and deduplication', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-host-')); const host = new ImageToolHost(context(root), manager());
    vscode.workspace.isTrusted = true;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, get: () => [{ uri: { fsPath: root, scheme: 'file' } }] });
    let submissions = 0, confirmations = 0; const tasks: ImageTask[] = [];
    const previousWarning = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async () => { confirmations++; throw new Error('Image submission must not show a billing dialog'); };
    (host as any).queue = async () => ({ configure() {}, submit: async (scopeId: string, snapshot: any, input: any, admit?: () => Promise<void>) => {
        await admit?.();
        submissions++; const task = { taskId: randomUUID(), scopeId, status: 'queued', createdAt: Date.now(), model: snapshot.config.modelId, prompt: input.prompt, size: input.size } as ImageTask; tasks.push(task); return task;
    } });
    const scope = { cwd: root, id: 'a'.repeat(64), title: 'Left' };
    try {
        await host.initialize(); await host.config.save({ expectedRevision: 0, config: { ...defaultImageConfig(), enabled: true, modelId: 'test-image', baseUrl: 'https://example.com', authMode: 'none' }, keyAction: 'keep' });
        const id = randomUUID(); const result = await host.execute(scope, 'openapi_generate_image', { prompt: 'draw', size: '1536x1024' }, id, () => true);
        assert.ok(!result.isError); assert.equal(submissions, 1); assert.equal(tasks[0].size, '1536x1024');
        const accepted = JSON.parse((result.content[0] as { text: string }).text);
        assert.equal(accepted.completionNotification, 'automatic'); assert.equal(accepted.pollingRequired, false); assert.equal(accepted.pollAfterMs, undefined);
        assert.equal((await host.execute(scope, 'openapi_generate_image', { prompt: 'missing size' }, randomUUID(), () => true)).isError, true);
        assert.equal(submissions, 1, 'A model must provide the image size; no configured fallback is allowed');
        assert.deepEqual(await host.execute(scope, 'openapi_generate_image', { prompt: 'draw', size: '1536x1024' }, id, () => true), result); assert.equal(submissions, 1);
        const edited = await host.execute(scope, 'openapi_edit_image', { prompt: 'edit', size: '1024x1024', image: 'iVBORw0KGgo=' }, randomUUID(), () => true);
        assert.ok(!edited.isError); assert.equal(submissions, 2);
        assert.equal((await host.execute(scope, 'openapi_generate_image', { prompt: 'draw', cwd: '/other' }, randomUUID(), () => true)).isError, true);
        assert.equal((await host.execute(scope, 'openapi_generate_image', { prompt: 'draw', size: '1536x1024' }, randomUUID(), () => false)).isError, true);
        const config = await host.config.read(); let reads = 0;
        const changedConfig = t.mock.method(host.config, 'read', async () => ++reads === 1 ? config : { ...config, revision: config.revision + 1 });
        try {
            const stale = await host.execute(scope, 'openapi_generate_image', { prompt: 'draw again', size: '1024x1536' }, randomUUID(), () => true);
            assert.equal(stale.isError, true); assert.ok(JSON.stringify(stale).includes('IMAGE_CONFIG_CONFLICT')); assert.equal(submissions, 2);
        } finally { changedConfig.mock.restore(); }
        await host.config.save({ expectedRevision: config.revision, config: { ...config, enabled: false }, keyAction: 'keep' });
        const disabled = await host.execute(scope, 'openapi_generate_image', { prompt: 'disabled', size: '1024x1024' }, randomUUID(), () => true);
        assert.ok(JSON.stringify(disabled).includes('IMAGE_CONFIG_REQUIRED')); assert.equal(submissions, 2);
        assert.equal(confirmations, 0, 'The extension no longer requires per-call or per-session billing consent');
    } finally { vscode.window.showWarningMessage = previousWarning; await host.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('closing a chat with active image work still offers background execution or a local stop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-close-choice-')); const host = new ImageToolHost(context(root), manager());
    let stopped = 0; const choices: string[][] = [];
    const previousWarning = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async (_message: string, _options: unknown, ...buttons: string[]) => { choices.push(buttons); return buttons[1]; };
    (host as any).queues.set(await fs.realpath(root), { hasPending: () => true, interruptScope: async () => { stopped++; }, close: async () => {} });
    try {
        await host.closing({ cwd: root, id: 'a'.repeat(64), title: 'Main' });
        assert.deepEqual(choices, [['Continue in background', 'Stop locally']]); assert.equal(stopped, 1);
    } finally { vscode.window.showWarningMessage = previousWarning; await host.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('global configuration does not merge history scopes; capabilities revoke on process restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-identity-'));
    const entry = require('../entry') as typeof import('../entry');
    try {
        await entry.configureImages(context(root), manager());
        const fresh = await entry.imageScope(root, 'main', undefined, 'Chat');
        const bound = await entry.imageScope(root, 'main', 'native-session-a', 'Chat'); assert.equal(fresh.id, bound.id);
        const another = await entry.imageScope(root, 'left-conversation', 'native-session-b', 'Chat'); assert.notEqual(another.id, bound.id);
        await entry.resetImageIdentity(root, 'main');
        const newHistory = await entry.imageScope(root, 'main', undefined, 'Chat'); assert.notEqual(newHistory.id, bound.id);
        await entry.resetImageIdentity(root, 'main');
        assert.equal((await entry.imageScope(root, 'main', 'native-session-a', 'Chat')).id, bound.id);
        const subscription = entry.attachImageView('main', { scope: async () => bound, post() {} });
        const old = entry.issueImageCapability('main', root); assert.ok(entry.imageCapability(old));
        assert.equal(entry.currentImageCapability('main', root), old, 'Reading config must not revoke a running CLI capability');
        const next = entry.issueImageCapability('main', root); assert.equal(entry.imageCapability(old), undefined); assert.ok(entry.imageCapability(next));
        subscription.dispose(); assert.equal(entry.imageCapability(next), undefined);
    } finally { await entry.shutdownImages(); await fs.rm(root, { recursive: true, force: true }); }
});

test('image results push only to the owning chat, deduplicate updates and replay after returning to its history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-result-push-')); const host = new ImageToolHost(context(root), manager());
    vscode.workspace.isTrusted = true;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, get: () => [{ uri: { fsPath: root, scheme: 'file' } }] });
    const store = new ImageTaskStore(root); const scopeA = { cwd: root, id: 'a'.repeat(64), title: 'A' }, scopeB = { cwd: root, id: 'b'.repeat(64), title: 'B' };
    const messages: any[] = [], otherMessages: any[] = [], updates: any[] = []; let current = scopeA;
    const binding = { scope: async () => current, post: (message: any) => updates.push(message), complete: async (_scope: unknown, task: ImageTask) => {
        const result = imageResultMessage(task, 'en'); if (!messages.some(item => item.id === result.id)) messages.push(result); return true;
    } };
    const other = { scope: async () => scopeB, post() {}, complete: async (_scope: unknown, task: ImageTask) => { otherMessages.push(task); return true; } };
    try {
        await host.initialize(); host.attach(binding); host.attach(other); await store.acquire();
        const task: ImageTask = { version: 1, taskId: `20261002T081530123Z_${randomUUID()}`, scopeId: scopeA.id, operation: 'generate', prompt: 'draw', model: 'test', size: '1x1', configRevision: 1, status: 'queued', createdAt: 1, images: [] };
        await store.save(task, true);
        await (host as any).notifyTasks(await fs.realpath(root), scopeA.id); assert.equal(messages.length, 0);
        task.status = 'succeeded'; task.finishedAt = 2; await store.save(task);
        await Promise.all([(host as any).notifyTasks(await fs.realpath(root), scopeA.id), (host as any).notifyTasks(await fs.realpath(root), scopeA.id)]);
        assert.equal(messages.length, 1); assert.equal(otherMessages.length, 0);
        await (host as any).notifyTasks(await fs.realpath(root), scopeA.id); assert.equal(messages.length, 1);
        current = scopeB; messages.length = 0;
        await (host as any).notifyTasks(await fs.realpath(root), scopeA.id); assert.equal(messages.length, 0);
        current = scopeA;
        await host.receive({ type: 'imageGeneration/tasksList', requestId: 'history-ready' }, binding);
        assert.equal(messages.length, 1, 'Ready/refresh supplements a result absent from restored CLI history');
        await host.receive({ type: 'imageGeneration/tasksList', requestId: 'duplicate-ready' }, binding); assert.equal(messages.length, 1);
        let calls = 0; const racing = { scope: async () => ++calls === 1 ? scopeA : scopeB, post() { throw new Error('Should not post stale tasks'); }, complete: async () => { throw new Error('Should not append to another history'); } };
        host.attach(racing); await (host as any).notifyTasks(await fs.realpath(root), scopeA.id);
        assert.ok(updates.some(message => message.type === 'imageGeneration/taskUpdate'));
    } finally { await store.release(); await host.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('image completion waits for its chat to become idle without requiring model polling', { timeout: 10000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-idle-notify-')); const host = new ImageToolHost(context(root), manager());
    const store = new ImageTaskStore(root); const scope = { cwd: root, id: 'c'.repeat(64), title: 'Chat' };
    let busy = true, attempts = 0, finish!: () => void; const delivered = new Promise<void>(resolve => { finish = resolve; });
    try {
        await host.initialize(); await store.acquire();
        const task: ImageTask = { version: 1, taskId: `20261002T081530123Z_${randomUUID()}`, scopeId: scope.id, operation: 'generate', prompt: 'draw', model: 'test', size: '1x1', configRevision: 1, status: 'succeeded', createdAt: 1, finishedAt: 2, images: [] };
        await store.save(task, true);
        host.attach({ scope: async () => scope, post() {}, complete: async () => { attempts++; if (busy) return false; finish(); return true; } });
        await (host as any).notifyTasks(await fs.realpath(root), scope.id); assert.equal(attempts, 1);
        busy = false; await delivered; assert.equal(attempts, 2);
    } finally { await store.release(); await host.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a real asynchronous image queue pushes completion without opening a dialog or polling a task', { timeout: 10000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-auto-complete-')); const host = new ImageToolHost(context(root), manager());
    vscode.workspace.isTrusted = true;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, get: () => [{ uri: { fsPath: root, scheme: 'file' } }] });
    const scope = { cwd: root, id: 'a'.repeat(64), title: 'Main' }; let finish!: (task: ImageTask) => void;
    const completed = new Promise<ImageTask>(resolve => { finish = resolve; });
    const previousWarning = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async () => { throw new Error('Background generation must not request billing confirmation'); };
    try {
        await host.initialize();
        await host.config.save({ expectedRevision: 0, config: { ...defaultImageConfig(), enabled: true, modelId: 'test-image', baseUrl: 'https://example.com', authMode: 'none' }, keyAction: 'keep' });
        host.attach({ scope: async () => scope, post() {}, complete: async (_scope, task) => { finish(task); return true; } });
        const queue = await (host as any).queue(root);
        queue.client.generate = async () => [{}]; queue.client.load = async () => Buffer.from('89504e470d0a1a0a', 'hex');
        const accepted = await host.execute(scope, 'openapi_generate_image', { prompt: 'draw', size: '1024x1024' }, randomUUID(), () => true);
        assert.ok(!accepted.isError, JSON.stringify(accepted));
        const task = await completed; assert.equal(task.status, 'succeeded'); assert.equal(task.images.length, 1);
        assert.equal(task.scopeId, scope.id); await queue.idle();
    } finally { vscode.window.showWarningMessage = previousWarning; await host.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('main chat defers image continuations while busy, sends once as a user and preserves drafts', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-main-notice-'));
    const entry = require('../entry') as typeof import('../entry');
    const runtime = require('../../runtime') as typeof import('../../runtime');
    const { ChatViewHost } = require('../../chat/chatViewHost') as typeof import('../../chat/chatViewHost');
    const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');
    const lifecycle = require('../../chatRuntime/cliLifecycle') as typeof import('../../chatRuntime/cliLifecycle');
    const messaging = require('../../chatRuntime/chatMessaging') as typeof import('../../chatRuntime/chatMessaging');
    const { chatSessionState } = require('../../chatRuntime/chatSession') as typeof import('../../chatRuntime/chatSession');
    const { routes } = require('../../chatRuntime/routeState') as typeof import('../../chatRuntime/routeState');
    const ctx = context(root); const previous = { messages: chatSessionState.messages, sessionId: chatSessionState.sessionId, cwd: chatSessionState.cwd, active: chatSessionState.activeAssistantMessageId,
        route: routes.normal.sessionId, pending: routes.normal.pendingTurns, busy: routes.normal.busy, taskBusy: routes.taskFlow.busy };
    const host = new ChatViewHost(ctx), sent: any[] = [], delivered: string[] = [];
    const originalConfig = ChatCliConfigService.prototype.getConfig;
    ChatCliConfigService.prototype.getConfig = () => ({ cwd: root, cliEnv: {} } as any);
    t.mock.method(messaging, 'sendUserMessageToCli', async (text: string, options: Parameters<typeof messaging.sendUserMessageToCli>[1] = {}) => { await options.beforeSend?.(); assert.equal(options.isTargetCurrent?.(), true); delivered.push(text); });
    try {
        runtime.setExtensionContext(ctx); lifecycle.createCliLifecycleServices(new ChatCliConfigService()); await entry.configureImages(ctx, manager());
        const sessionId = randomUUID(); routes.normal.sessionId = sessionId; chatSessionState.sessionId = sessionId; chatSessionState.cwd = root;
        routes.normal.pendingTurns = 1; routes.normal.busy = false; routes.taskFlow.busy = false;
        chatSessionState.messages = [{ id: 'active-assistant', role: 'assistant', pending: true, createdAt: 1, segments: [{ kind: 'text', text: 'Still working' }] }];
        chatSessionState.activeAssistantMessageId = 'active-assistant';
        (host as any).target = { webview: { postMessage: async (message: unknown) => { sent.push(message); return true; } } };
        const scope = await entry.imageScope(root, 'main', sessionId, 'Main');
        const imageId = randomUUID();
        const task: ImageTask = { version: 1, taskId: `20261002T081530123Z_${randomUUID()}`, scopeId: scope.id, operation: 'generate', prompt: 'draw', model: 'test', size: '1x1', configRevision: 1, status: 'succeeded', createdAt: 1, finishedAt: 2,
            images: [{ id: imageId, relativePath: `images/${imageId}.png`, mimeType: 'image/png', bytes: 8 }] };
        assert.equal(await (host as any).appendImageResult(scope, task), false); assert.equal(delivered.length, 0);
        routes.normal.pendingTurns = 0; chatSessionState.messages[0].pending = false; chatSessionState.activeAssistantMessageId = undefined;
        assert.equal(await (host as any).appendImageResult(scope, task), true);
        assert.equal(await (host as any).appendImageResult(scope, task), true);
        assert.equal(chatSessionState.messages.length, 2); assert.equal(chatSessionState.messages[1].role, 'user');
        assert.equal(delivered.length, 1); assert.match(delivered[0], /\[image-generation-result\]/);
        const event = JSON.parse(delivered[0].slice('[image-generation-result]\n'.length));
        assert.equal(event.workspacePath, root); assert.equal(event.images[0].path, `.LLSOAI/openapi-image-generation/images/${imageId}.png`);
        assert.equal(event.images[0].absolutePath, path.join(root, '.LLSOAI/openapi-image-generation/images', `${imageId}.png`));
        assert.equal(event.images[0].fileUri, require('node:url').pathToFileURL(event.images[0].absolutePath).toString());
        assert.ok(sent.every(item => ['message/append', 'message/patch'].includes(item.message.type)));
        assert.equal(await (host as any).appendImageResult({ ...scope, id: 'f'.repeat(64) }, task), false);
        const persisted = (ctx.workspaceState as any).get('claudeRouter.chat.session.v1', {});
        assert.ok(persisted.messages.some((message: any) => message.id === `image-result-${task.taskId}`));
        const reopened = new ChatViewHost(ctx); (reopened as any).target = (host as any).target;
        assert.equal(await (reopened as any).appendImageResult(scope, task), true); assert.equal(delivered.length, 1); reopened.dispose();
        const uncertainTask = { ...task, taskId: `20261002T081530124Z_${randomUUID()}` };
        const uncertainSend = t.mock.method(messaging, 'sendUserMessageToCli', async (_text: string, options: Parameters<typeof messaging.sendUserMessageToCli>[1] = {}) => {
            await options.beforeSend?.(); throw new Error('stdin delivery unknown');
        });
        try {
            assert.equal(await (host as any).appendImageResult(scope, uncertainTask), true);
            assert.equal(await (host as any).appendImageResult(scope, uncertainTask), true);
            assert.equal(uncertainSend.mock.callCount(), 1, 'Unknown delivery never automatically replays the result turn');
        } finally { uncertainSend.mock.restore(); }
    } finally {
        host.dispose(); routes.normal.process?.dispose(); routes.normal.process = undefined; lifecycle.disposeCliLifecycleServices();
        ChatCliConfigService.prototype.getConfig = originalConfig; runtime.setExtensionContext(undefined);
        chatSessionState.messages = previous.messages; chatSessionState.sessionId = previous.sessionId; chatSessionState.cwd = previous.cwd; chatSessionState.activeAssistantMessageId = previous.active;
        routes.normal.sessionId = previous.route; routes.normal.pendingTurns = previous.pending; routes.normal.busy = previous.busy; routes.taskFlow.busy = previous.taskBusy;
        await entry.shutdownImages(); await fs.rm(root, { recursive: true, force: true });
    }
});

test('real main relay accepts only the capability-bound scope and returns no secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-relay-'));
    const entry = require('../entry') as typeof import('../entry');
    const { handleImageRelay } = require('../httpBridge') as typeof import('../httpBridge');
    const server = http.createServer((req, res) => { void handleImageRelay(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    try {
        await entry.configureImages(context(root), manager());
        const scope = await entry.imageScope(root, 'main', 'native-session', 'Main');
        const subscription = entry.attachImageView('main', { scope: async () => scope, post() {} });
        const token = entry.issueImageCapability('main', root);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/llsccai/image-tool/`;
        const result = await forwardImageTool(new URL(base + token), 'openapi_image_generation_info', {});
        assert.ok(!result.isError); assert.ok(!JSON.stringify(result).includes('secretRef')); assert.ok(!JSON.stringify(result).includes('authorization'));
        await assert.rejects(forwardImageTool(new URL(base + randomUUID()), 'openapi_image_generation_info', {}));
        entry.issueImageCapability('main', root);
        await assert.rejects(forwardImageTool(new URL(base + token), 'openapi_image_generation_info', {}));
        subscription.dispose();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await entry.shutdownImages(); await fs.rm(root, { recursive: true, force: true }); }
});
