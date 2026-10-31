/** @file Persistent left-side session list and independent chat presentation, without editor tab creation. */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { EditorConversationStore } from './store';
import { LeftChatSession } from './leftSession';
import { leftSessionLabels } from './leftLabels';

/** Keep the list and chat in one left Webview, with runtime ownership outside the page lifecycle. */
export class LeftChatView {
    public readonly session: LeftChatSession;
    private view?: vscode.WebviewView;
    private incoming?: vscode.Disposable;
    private visible = false;
    private mode: 'list' | 'chat' = 'chat';
    private chatRenderedFor?: vscode.WebviewView;
    private rendering: Promise<void> = Promise.resolve();
    private generation = 0;
    private readonly subscriptions: vscode.Disposable[] = [];

    /** Bind the left conversation and locale updates without exposing a history-list action in chat. */
    public constructor(private readonly context: vscode.ExtensionContext, private readonly manager: ConfigManager) {
        this.session = new LeftChatSession(context, manager, () => this.showConversation());
        this.subscriptions.push(this.session.onDidChange(() => { if (this.visible && this.mode === 'list') void this.refresh().catch(() => {}); }),
            manager.onDidChange(() => {
                if (!this.visible) return;
                if (this.mode === 'list') void this.refresh().catch(() => {});
                else void this.view?.webview.postMessage({ type: 'from-extension', message: { type: 'i18n/update', language: manager.getResolvedUiLanguage() } });
            }));
    }

    /** Mount the left chat directly, restoring its first conversation without an intermediate list page. */
    public mount(view: vscode.WebviewView): vscode.Disposable {
        this.view = view; this.visible = true; this.chatRenderedFor = undefined;
        const generation = ++this.generation;
        this.incoming?.dispose();
        this.incoming = view.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => this.report(error)); });
        void this.refresh().catch(() => {});
        return { dispose: () => {
            if (this.view !== view || this.generation !== generation) return;
            this.generation++; this.visible = false; this.incoming?.dispose(); this.incoming = undefined;
            this.session.detach(); this.view = undefined;
        } };
    }

    /** Focus the first left conversation for either entry; repeated clicks preserve the running UI and CLI. */
    public async showConversation(): Promise<void> {
        if (!await (await import('../setup/gate')).requireSetup()) return;
        this.mode = 'chat';
        const provider = (await import('../runtime')).getConfigViewProvider();
        await provider?.showSessions();
        if (this.visible) await this.refresh();
    }

    /** Dispatch native title-bar actions only to the mounted left conversation. */
    public async runToolbarAction(action: 'rename' | 'restart'): Promise<void> {
        if (!this.visible || this.mode !== 'chat') return;
        await this.rendering;
        if (action === 'rename') await this.session.editTitle();
        else await this.session.receive({ type: 'cli/restart' });
    }

    /** Retain the legacy list implementation without exposing it from the parallel-session or plus actions. */
    public async showList(): Promise<void> {
        if (!await (await import('../setup/gate')).requireSetup()) return;
        this.mode = 'list';
        const provider = (await import('../runtime')).getConfigViewProvider();
        await provider?.showSessions();
        if (this.visible) await this.refresh();
    }

    /** Queue page replacement so fast list/chat clicks cannot bind messages to an older page. */
    private async refresh(): Promise<void> {
        const operation = this.rendering.then(async () => {
            if (!this.visible || !this.view) return;
            if (this.mode === 'chat') {
                const view = this.view; const generation = this.generation;
                await this.session.openFirst();
                if (!this.visible || this.view !== view || this.generation !== generation) return;
                if (this.chatRenderedFor !== view && this.session.activeId) await this.renderChat(view);
            } else await this.renderList(this.view);
        });
        this.rendering = operation.catch(error => this.report(error)); return this.rendering;
    }

    /** Render only validated workspace histories; titles and model identifiers are always escaped. */
    private async renderList(view: vscode.WebviewView): Promise<void> {
        const generation = this.generation;
        this.chatRenderedFor = undefined; this.session.detach();
        const labels = leftSessionLabels(this.manager.getResolvedUiLanguage());
        const entries = (await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async folder =>
            (await EditorConversationStore.list(folder.uri.fsPath)).map(entry => ({ ...entry, cwd: folder.uri.fsPath, folder: folder.name || path.basename(folder.uri.fsPath) }))))).flat()
            .sort((a, b) => (b.conversation?.updatedAt ?? 0) - (a.conversation?.updatedAt ?? 0));
        if (!this.visible || this.view !== view || this.generation !== generation) return;
        const escape = escapeHtml;
        const rows = entries.map(entry => {
            const current = entry.id === this.session.activeId;
            const status = current ? labels.active : entry.error ? labels.unavailable : entry.occupied ? labels.occupied : labels.saved;
            return `<button class="session-card" data-action="open" data-id="${escape(entry.id)}" data-cwd="${escape(entry.cwd)}" ${entry.error ? 'disabled data-unavailable="true"' : ''}>
                <span class="session-card__heading"><strong>${escape(entry.conversation?.title || entry.id)}</strong><small>${escape(status)}</small></span>
                <span class="session-card__detail">${escape(entry.folder)} · ${escape(entry.conversation?.settings.normalModel || '')}</span></button>`;
        }).join('');
        view.title = labels.title;
        const nonce = randomUUID().replace(/-/g, '');
        const root = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [root] };
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'leftSessions.css'));
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'leftSessions.js'));
        view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'">
            <link rel="stylesheet" href="${style}"></head><body><main><header><h1>${escape(labels.title)}</h1><div class="actions">
            <button data-action="refresh">${escape(labels.refresh)}</button><button data-action="settings">${escape(labels.settings)}</button></div></header>
            <p>${escape(labels.intro)}</p><button class="create" data-action="create">＋ ${escape(labels.create)}</button>
            <section>${rows || `<p class="empty">${escape(labels.empty)}</p>`}</section><p role="status" id="status" data-working="${escape(labels.working)}"></p></main>
            <script nonce="${nonce}" src="${script}"></script></body></html>`;
    }

    /** Present the original chat assets using the left session's own runtime and history. */
    private async renderChat(view: vscode.WebviewView): Promise<void> {
        const generation = this.generation;
        const root = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat');
        const nonce = randomUUID().replace(/-/g, '');
        let html = await fs.readFile(vscode.Uri.joinPath(root, 'index.html').fsPath, 'utf8');
        const replacements: Record<string, string> = { cspSource: view.webview.cspSource, nonce };
        for (const [key, file] of Object.entries({ imageStyleUri: 'imageGeneration.css', imageScriptUri: 'imageGeneration.js', styleUri: 'style.css', cacheSolutionScriptUri: 'cacheSolution.js', clipboardUri: 'clipboard.js', scriptUri: 'main.js' })) {
            replacements[key] = String(view.webview.asWebviewUri(vscode.Uri.joinPath(root, file)));
        }
        html = html.replace(/{{(\w+)}}/g, (match, key: string) => replacements[key] ?? match)
            .replace('<body>', '<body class="left-chat">');
        if (!this.visible || this.view !== view || this.generation !== generation) return;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
        view.webview.html = html;
        this.chatRenderedFor = view;
        await this.session.attach(view);
    }

    /** Handle list actions locally; chat messages never enter the right main-chat dispatcher. */
    private async receive(message: Record<string, any>): Promise<void> {
        if (!message || typeof message.type !== 'string') return;
        if (['leftSessions/show', 'leftSessions/list', 'editorSession/new', 'editorSession/list'].includes(message.type)) { await this.showConversation(); return; }
        if (this.mode === 'chat') {
            if (message.type === 'clipboard/write') {
                let ok = false;
                try { if (typeof message.text === 'string' && message.text.length <= 10 * 1024 * 1024) { await vscode.env.clipboard.writeText(message.text); ok = true; } } catch { /* Never log copied text. */ }
                await this.view?.webview.postMessage({ type: 'from-extension', message: { type: 'clipboard/result', requestId: message.requestId, ok } });
                return;
            }
            await this.session.receive(message); return;
        }
        if (message.type === 'leftSessions/ready' || message.type === 'leftSessions/refresh') { await this.refresh(); return; }
        if (message.type === 'leftSessions/settings') { await vscode.commands.executeCommand('claudeRouter.openConfigPanel'); return; }
        if (!['leftSessions/create', 'leftSessions/open'].includes(message.type)) return;
        const folder = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
        const cwd = message.type === 'leftSessions/open' ? message.cwd : (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
        if (typeof cwd !== 'string' || (message.type === 'leftSessions/open' && typeof message.id !== 'string')) throw new Error('Invalid conversation selection');
        const generation = this.generation;
        await this.session.open(cwd, message.type === 'leftSessions/open' ? message.id : undefined);
        if (!this.visible || generation !== this.generation || !this.session.activeId) return;
        this.mode = 'chat'; this.chatRenderedFor = undefined; await this.refresh();
    }

    /** Keep errors visible without destroying the list, changing the main chat or losing a running task. */
    private report(error: unknown): void {
        const text = error instanceof Error ? error.message : String(error);
        if (this.mode === 'list') void this.view?.webview.postMessage({ type: 'leftSessions/error', text });
        else void vscode.window.showErrorMessage(text);
    }

    /** Dispose presentation subscriptions; the coordinator separately awaits session shutdown. */
    public dispose(): void {
        this.visible = false; this.session.detach(); this.incoming?.dispose();
        for (const subscription of this.subscriptions) subscription.dispose();
    }
}

/** Escape all persisted or translated text before inserting it into Webview HTML or attributes. */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
