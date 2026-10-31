/** @file Independent left-side conversation ownership; hiding or detaching its UI never stops a task. */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { COMMANDS } from '../constants';
import { ChatCliConfigService } from '../chat/cli/cliConfig';
import { independentChatDefaults } from './defaults';
import { leftSessionLabels } from './leftLabels';
import { EditorChatRuntime, type IndependentChatHost } from './runtime';
import { EditorConversationStore } from './store';

const LEFT_SESSION_KEY = 'claudeRouter.leftConversation.v1';

/** One independent runtime serves the left view; presentation attachment is separate from process ownership. */
export class LeftChatSession {
    private runtime?: EditorChatRuntime;
    private host?: IndependentChatHost;
    private operations: Promise<void> = Promise.resolve();
    private closing = false;
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;

    /** Bind shared providers while retaining private conversation settings, identity and history. */
    public constructor(private readonly context: vscode.ExtensionContext, private readonly manager: ConfigManager,
        private readonly showList: () => Promise<void>) {}

    /** Return the active conversation identity, independent of which Webview is currently visible. */
    public get activeId(): string | undefined { return this.runtime?.data.conversationId; }

    /** Return the saved left-side selection without creating a process. */
    public saved(): { cwd: string; id: string } | undefined {
        return this.context.workspaceState.get<{ cwd: string; id: string }>(LEFT_SESSION_KEY);
    }

    /** Open the existing left conversation, its saved selection, or the first history without showing a picker. */
    public openFirst(): Promise<void> {
        const action = this.operations.then(async () => {
            if (this.closing || this.runtime) return;
            if (!await (await import('../setup/gate')).requireSetup()) return;
            if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting a CLI');
            const folders = vscode.workspace.workspaceFolders ?? [];
            const roots = await Promise.all(folders.map(folder => fs.realpath(folder.uri.fsPath)));
            const saved = this.saved();
            if (saved && typeof saved.cwd === 'string' && typeof saved.id === 'string') {
                let cwd: string | undefined;
                try { cwd = await fs.realpath(saved.cwd); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                if (cwd && roots.includes(cwd)) {
                    const entries = await EditorConversationStore.list(cwd);
                    if (entries.some(entry => entry.id === saved.id)) { await this.activate(cwd, saved.id); return; }
                }
            }
            const folder = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
            const cwd = (folder ?? folders[0])?.uri.fsPath;
            if (!cwd) throw new Error('Open a workspace folder first');
            const entries = await EditorConversationStore.list(cwd);
            const first = entries.filter(entry => !entry.error && entry.conversation)
                .sort((a, b) => (a.conversation!.createdAt - b.conversation!.createdAt) || a.id.localeCompare(b.id))[0];
            if (!first && entries.some(entry => entry.error)) throw new Error('Saved conversation is unavailable; history was preserved');
            await this.activate(cwd, first?.id);
        });
        this.operations = action.catch(() => {}); return action;
    }

    /** Validate workspace membership, then serialize switching so two clicks cannot start duplicate owners. */
    public open(cwd: string, id?: string): Promise<void> {
        const action = this.operations.then(() => this.activate(cwd, id));
        this.operations = action.catch(() => {}); return action;
    }

    /** Restore one selected history or create a new conversation, never replaying an interrupted prompt. */
    private async activate(cwd: string, id?: string): Promise<void> {
        if (this.closing || !await (await import('../setup/gate')).requireSetup()) return;
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting a CLI');
        cwd = await fs.realpath(cwd);
        const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => fs.realpath(folder.uri.fsPath)));
        if (!roots.includes(cwd)) throw new Error('Conversation is outside this workspace');
        if (id && this.runtime?.data.conversationId === id) { await this.runtime.ready(); return; }
        if (this.runtime?.isBusy()) throw new Error(leftSessionLabels(this.manager.getResolvedUiLanguage()).switchBusy);
        const store = new EditorConversationStore(cwd, id ?? randomUUID());
        const data = id ? await store.load() : { version: 1 as const, conversationId: store.id, cwd, title: 'Chat',
            createdAt: Date.now(), updatedAt: Date.now(), revision: 0, settings: independentChatDefaults(this.context, this.manager),
            messages: [], lastRunState: 'idle' as const };
        if (!new ChatCliConfigService(this.manager).getConfig().cliPath || !data.settings.normalModel) {
            await vscode.commands.executeCommand('claudeRouter.openConfigPanel'); throw new Error('Configure CLI and model first');
        }
        if (data.cliSessionId) {
            const { routes } = await import('../chatRuntime/routeState');
            if (Object.values(routes).some(route => route.sessionId === data.cliSessionId && route.process?.isRunning())) throw new Error('CLI history is already active in the main chat');
            const entries = await EditorConversationStore.list(cwd);
            if (entries.some(entry => entry.id !== data.conversationId && entry.occupied && entry.conversation?.cliSessionId === data.cliSessionId)) throw new Error('CLI history is already active in another conversation');
        }
        try { await store.acquire(); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            await store.recover(); await store.acquire();
        }
        try {
            if (this.closing) { await store.release(); return; }
            if (this.runtime?.isBusy()) throw new Error(leftSessionLabels(this.manager.getResolvedUiLanguage()).switchBusy);
            if (!id) await store.save(data);
            await this.runtime?.close(); this.runtime = undefined;
        } catch (error) { await store.release(); throw error; }
        const owner = this;
        const presentation: IndependentChatHost = {
            get title() { return data.title; },
            set title(value: string) { if (owner.host) owner.host.title = value; owner.changed.fire(); },
            webview: { postMessage: message => owner.host?.webview.postMessage(message) ?? Promise.resolve(false) }
        };
        this.runtime = new EditorChatRuntime(data, store, presentation, this.manager, this.showList, this.showList);
        await this.context.workspaceState.update(LEFT_SESSION_KEY, { cwd, id: data.conversationId });
        this.changed.fire();
        await this.runtime.start();
    }

    /** Attach the current page without rebuilding or restarting the conversation. */
    public async attach(host: IndependentChatHost): Promise<void> {
        this.host = host;
        if (this.runtime) { host.title = this.runtime.data.title; await this.runtime.ready(); }
    }

    /** Open the shared title dialog for this left conversation, without targeting the right main session. */
    public async editTitle(): Promise<void> {
        const data = this.runtime?.data;
        if (data) await this.host?.webview.postMessage({ type: 'from-extension', message: {
            type: 'session/edit-title', title: data.title, sessionId: data.conversationId
        } });
    }

    /** Detach a hidden list/settings page without cancelling the independent CLI. */
    public detach(): void { this.host = undefined; }

    /** Serialize conversation changes while global image settings and help remain immediately accessible. */
    public receive(message: Record<string, any>): Promise<void> {
        if (message.type?.startsWith('imageGeneration/')) return this.runtime?.receive(message) ?? Promise.resolve();
        if (message.type === 'help/open') return Promise.resolve(vscode.commands.executeCommand(COMMANDS.openHelp)).then(() => {});
        const runtime = this.runtime;
        const action = this.operations.then(async () => { if (this.runtime === runtime) await runtime?.receive(message); });
        this.operations = action.catch(() => {}); return action;
    }

    /** Pause the left runtime during an explicitly confirmed shared CLI update. */
    public async prepareCliUpdate(): Promise<{ resume: (path: string) => Promise<string[]>; errors: string[] }> {
        await this.operations;
        const runtime = this.runtime;
        try {
            const stopped = runtime ? await runtime.prepareCliUpdate() : false;
            return { errors: [], resume: async cliPath => {
                if (!runtime || !stopped) return [];
                try { await runtime.applyCliUpdate(cliPath); return []; }
                catch (error) { return [`${runtime.data.title}: ${String(error)}`]; }
            } };
        } catch (error) { return { errors: [String(error)], resume: async () => [] }; }
    }

    /** Flush and release ownership only on explicit shutdown, never when the sidebar is hidden. */
    public async shutdown(): Promise<void> {
        this.closing = true; this.detach(); await this.operations;
        await this.runtime?.close(); this.runtime = undefined; this.changed.dispose();
    }
}
