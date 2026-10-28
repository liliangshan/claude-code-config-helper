/** @file Editor chat panel ownership and smart open/create list. */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { ChatCliConfigService } from '../chat/cli/cliConfig';
import { independentChatDefaults } from './defaults';
import { EditorConversationStore, type EditorConversation, type EditorSettings } from './store';
import { editorSessionLimit, unopenedEditorHistory } from './history';
import { EditorChatRuntime } from './runtime';

/** Manager tracks opening/closing slots as well as visible panels to avoid duplicate CLI processes. */
export class EditorChatManager {
    private readonly active = new Map<string, { panel: vscode.WebviewPanel; runtime?: EditorChatRuntime; closing?: Promise<void> }>();
    private operations: Promise<void> = Promise.resolve();
    private disposed = false;
    /** @param context Resource and state owner. @param manager Shared provider/credential service. */
    public constructor(private readonly context: vscode.ExtensionContext, private readonly manager: ConfigManager) {}
    /** Serialize smart-entry decisions and reserve process capacity before creating new panels. */
    public open(alwaysList = false): Promise<void> {
        const action = this.operations.then(() => this.choose(alwaysList)); this.operations = action.catch(() => {}); return action;
    }
    /** Snapshot main-area configuration once; persisted editor settings do not dynamically inherit. */
    private defaults(): EditorSettings {
        return independentChatDefaults(this.context, this.manager);
    }
    /** Reuse the next saved UUID without prompting; only the explicit history command opens a picker. */
    private async choose(alwaysList: boolean): Promise<void> {
        if (!await (await import('../setup/gate')).requireSetup()) return;
        if (this.disposed) return;
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting a CLI');
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) throw new Error('Open a workspace folder first');
        const folder = !alwaysList
            ? (vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined) ?? folders[0]
            : folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
        if (!folder) return;
        const max = this.maximumOpen();
        if (!alwaysList && this.active.size >= max) throw new Error(this.limitMessage(max));
        const cwd = await fs.realpath(folder.uri.fsPath);
        const entries = await EditorConversationStore.list(cwd);
        let existing: EditorConversation | undefined;
        if (alwaysList) {
            const choices = [{ label: '$(add) 创建并行任务 / New parallel task', id: '', description: '复制主区配置 / Copy main settings' }, ...entries.map(item => ({
                label: item.conversation?.title ?? item.id, id: item.id,
                description: item.error ?? (this.active.get(item.id)?.closing ? '正在关闭 / Closing' : this.active.has(item.id) ? '已打开 / Open' : item.occupied ? '已占用 / In use' : '未打开 / Closed'),
                detail: item.conversation ? `${item.conversation.settings.normalModel} · ${item.conversation.settings.reasoningEffort}` : ''
            }))];
            const choice = await vscode.window.showQuickPick(choices, { title: '任务会话 / Task sessions', matchOnDescription: true }); if (!choice) return;
            if (choice.id) {
                const opened = this.active.get(choice.id);
                if (opened) { if (opened.closing) throw new Error('Conversation is still closing'); opened.panel.reveal(); return; }
                const entry = entries.find(item => item.id === choice.id)!;
                if (entry.error) throw new Error(entry.error);
                if (entry.occupied) {
                    await new EditorConversationStore(cwd, entry.id).recover();
                }
                existing = entry.conversation;
            }
        } else {
            const unopened = unopenedEditorHistory(entries, new Set(this.active.keys()));
            const blocked: string[] = [];
            for (const entry of unopened) {
                if (entry.occupied) {
                    try { await new EditorConversationStore(cwd, entry.id).recover(); }
                    catch (error) { blocked.push(`${entry.conversation!.title}: ${String(error)}`); continue; }
                }
                existing = entry.conversation; break;
            }
            if (!existing && blocked.length) throw new Error(`未打开的任务会话正在被占用，未创建新会话 / Unopened task sessions are in use:\n${blocked.join('\n')}`);
            if (!existing && entries.some(entry => !this.active.has(entry.id) && entry.error)) throw new Error('历史任务会话损坏，请通过“任务会话”检查；未创建新会话 / Check damaged task history in Task sessions');
        }
        if (this.active.size >= max) throw new Error(this.limitMessage(max));
        const settings = existing?.settings ?? this.defaults();
        if (!new ChatCliConfigService(this.manager).getConfig().cliPath || !settings.normalModel) {
            await vscode.commands.executeCommand('claudeRouter.openConfigPanel'); throw new Error('请先在主区选择 CLI 和模型');
        }
        if (existing?.cliSessionId) {
            const { routes } = await import('../chatRuntime/routeState');
            if (Object.values(routes).some(route => route.sessionId === existing!.cliSessionId && route.process?.isRunning())) throw new Error('This CLI history is already open in the sidebar');
            if ([...this.active.values()].some(entry => entry.runtime?.data.cliSessionId === existing!.cliSessionId)) throw new Error('This CLI history is already open in another editor');
        }
        const id = existing?.conversationId ?? randomUUID();
        const data: EditorConversation = existing ?? { version: 1, conversationId: id, cwd, title: `Chat ${new Date().toLocaleTimeString()}`,
            createdAt: Date.now(), updatedAt: Date.now(), revision: 0, settings, messages: [], lastRunState: 'idle' };
        const store = new EditorConversationStore(cwd, id); await store.acquire();
        try { if (!existing) await store.save(data); } catch (error) { await store.release(); throw error; }
        await this.createPanel(data, store);
    }
    /** Enforce the same one-to-three task-slot policy for new tabs, saved UUIDs and reload restoration. */
    private maximumOpen(): number {
        return editorSessionLimit(vscode.workspace.getConfiguration('claudeCodeConfigHelper').get<number>('chat.editorSessions.maxOpen', 3));
    }
    /** Report the reached task limit without instructing users to close an existing task. */
    private limitMessage(max: number): string {
        const labels: Record<string, string> = {
            en: `Parallel task limit reached (${max} tabs, excluding the main chat).`,
            'zh-cn': `并行任务区已达上限（${max} 个，不含主聊天）。`,
            'zh-tw': `並行任務區已達上限（${max} 個，不含主聊天）。`,
            ja: `並行タスク数が上限に達しました（${max} 件、メインチャットを除く）。`,
            ko: `병렬 작업 수가 한도에 도달했습니다 (${max}개, 기본 채팅 제외).`,
            fr: `Limite de tâches parallèles atteinte (${max} onglets, hors chat principal).`,
            de: `Obergrenze für parallele Aufgaben erreicht (${max} Tabs, ohne Hauptchat).`
        };
        return labels[this.manager.getResolvedUiLanguage()] || labels.en;
    }
    /** Restore only validated workspace-owned history; no pending prompt is replayed. */
    public async restore(panel: vscode.WebviewPanel, state: { editorConversationId?: string; cwd?: string }): Promise<void> {
        const action = this.operations.then(async () => {
            if (!await (await import('../setup/gate')).requireSetup()) { panel.dispose(); return; }
            if (!state.editorConversationId || !state.cwd || !vscode.workspace.isTrusted) { panel.dispose(); return; }
            const cwd = await fs.realpath(state.cwd);
            const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => fs.realpath(folder.uri.fsPath)));
            if (!roots.includes(cwd)) throw new Error('Restored conversation is outside this workspace');
            const existing = this.active.get(state.editorConversationId);
            if (existing) { panel.dispose(); existing.panel.reveal(); return; }
            const maximum = this.maximumOpen();
            if (this.active.size >= maximum) throw new Error(this.limitMessage(maximum));
            const store = new EditorConversationStore(cwd, state.editorConversationId); const data = await store.load();
            try { await store.acquire(); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                await store.recover();
                await store.acquire();
            }
            await this.createPanel(data, store, panel);
        });
        this.operations = action.catch(() => {});
        try { await action; } catch (error) { panel.dispose(); void vscode.window.showWarningMessage(`无法恢复任务会话，请从列表检查占用后恢复：${String(error)}`); }
    }
    /** Reuse the exact original chat assets in an independent editor document. */
    private async createPanel(data: EditorConversation, store: EditorConversationStore, restoredPanel?: vscode.WebviewPanel): Promise<void> {
        const panel = restoredPanel ?? vscode.window.createWebviewPanel('claudeRouter.editorChat', data.title, vscode.ViewColumn.Active, {
            enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        });
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
        const runtime = new EditorChatRuntime(data, store, panel, this.manager, () => this.open(), () => this.open(true));
        const entry = { panel, runtime, closing: undefined as Promise<void> | undefined }; this.active.set(data.conversationId, entry);
        panel.onDidDispose(() => {
            if (this.disposed) return; // VS Code owns tab restoration during window reload.
            entry.closing ??= runtime.close().then(() => { this.active.delete(data.conversationId); }).catch(error => { void vscode.window.showErrorMessage(`关闭会话失败 / Close failed: ${String(error)}`); });
        });
        panel.webview.onDidReceiveMessage((message: any) => {
            if (message?.type === 'clipboard/write') {
                void (async () => {
                    let ok = false;
                    try { if (typeof message.text === 'string' && message.text.length <= 10 * 1024 * 1024) { await vscode.env.clipboard.writeText(message.text); ok = true; } } catch { /* Reply accurately without logging copied text. */ }
                    await panel.webview.postMessage({ type: 'from-extension', message: { type: 'clipboard/result', requestId: message.requestId, ok } });
                })().catch(() => {}); return;
            }
            void runtime.receive(message).catch(error => { void panel.webview.postMessage({ type: 'from-extension', message: { type: 'toast', level: 'error', text: String(error) } }); });
        });
        try {
            const root = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat');
            let html = await fs.readFile(vscode.Uri.joinPath(root, 'index.html').fsPath, 'utf8');
            const replacements: Record<string, string> = { cspSource: panel.webview.cspSource, nonce: randomUUID().replace(/-/g, '') };
            for (const [key, file] of Object.entries({ styleUri: 'style.css', bridgeUri: 'bridge.js', cacheSolutionScriptUri: 'cacheSolution.js', clipboardUri: 'clipboard.js', scriptUri: 'main.js' })) replacements[key] = String(panel.webview.asWebviewUri(vscode.Uri.joinPath(root, file)));
            html = html.replace(/{{(\w+)}}/g, (match, key: string) => replacements[key] ?? match);
            // Persist identity before asynchronous CLI startup or an early window reload.
            const identity = JSON.stringify({ editorConversationId: data.conversationId, cwd: data.cwd }).replace(/</g, '\\u003c');
            const bootstrap = `<script nonce="${replacements.nonce}">const api=acquireVsCodeApi();api.setState(${identity});window.acquireVsCodeApi=()=>api;</script>`;
            html = html.replace('<body>', '<body>' + bootstrap);
            if (entry.closing) return; panel.webview.html = html;
            await runtime.start();
        } catch (error) {
            if (!entry.closing) { void panel.webview.postMessage({ type: 'from-extension', message: { type: 'message/error', error: String(error) } }); }
            // Keep an error panel available for settings/restart while retaining ownership.
            throw error;
        }
    }
    /** Stop every currently running editor CLI, collecting failures without closing tabs. */
    public async prepareCliUpdate(): Promise<{ resume: (path: string) => Promise<string[]>; errors: string[] }> {
        const runtimes: EditorChatRuntime[] = []; const errors: string[] = [];
        for (const entry of this.active.values()) {
            if (entry.closing || !entry.runtime) continue;
            try { if (await entry.runtime.prepareCliUpdate()) runtimes.push(entry.runtime); }
            catch (error) { errors.push(`${entry.panel.title}: ${String(error)}`); }
        }
        return { errors, resume: async cliPath => {
            const restartErrors: string[] = [];
            for (const runtime of runtimes) try { await runtime.applyCliUpdate(cliPath); } catch (error) { restartErrors.push(`${runtime.data.title}: ${String(error)}`); }
            return restartErrors;
        } };
    }
    /** Stop and flush all owned runtimes before provider services are disposed. */
    public async shutdown(): Promise<void> {
        this.disposed = true;
        await this.operations;
        // Do not dispose panels during deactivation: VS Code serializes their identity for reload.
        await Promise.all([...this.active.values()].map(async entry => { await (entry.closing ?? entry.runtime?.close()); }));
        this.active.clear();
    }
}
