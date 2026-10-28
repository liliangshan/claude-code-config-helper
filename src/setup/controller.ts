/** @file Onboarding and explicit CLI installation/update controller. */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { CliInstaller } from '../cliInstaller/install';
import { isCliInstallSource, type CliInstallSource } from '../cliInstaller/sources';
import { probeCliVersion, clearCliVersionCache } from '../chat/cli/nativeCompactionProbe';
import { ChatCliConfigService } from '../chat/cli/cliConfig';
import { SETUP_KEY, SETUP_COMPLETE_KEY, isSetupComplete, compareVersions, type SetupState } from './state';
import { ConfigWebviewController } from '../views/configView';
import { getConfigViewProvider } from '../runtime';
import { Logger } from '../logger';
import { readEffectiveCompactionModelSelection, readEffectiveTaskFlowModelSelection, saveCompactionModelSelection, saveTaskFlowModelSelection } from '../chatRuntime/modelSelection';
import { setSetupChecker, setCliUpdateInProgress } from './gate';

/** Seven-language host prompts; technical errors remain intact beneath the localized summary. */
const setupMessages = {
    en: ['Claude Code setup', 'Setup operation failed', 'Select existing CLI', 'Download official Claude CLI', 'Install / Update', 'Already up to date', 'All active CLI sessions will restart after installation. Running tasks may be interrupted and will not be replayed. Detached or remote processes may still be running; check them before retrying. External installations are not overwritten.', 'CLI ready; active sessions restarted. Interrupted tasks were not replayed.', 'CLI switch or session restart failed', 'Rollback', 'Restore the previous CLI? All active sessions will restart. Running tasks may be interrupted and will not be replayed.'],
    'zh-cn': ['Claude Code 安装引导', '安装配置操作失败', '选择已有 CLI', '下载官方 Claude CLI', '安装 / 更新', '已是最新版本', '安装成功后所有已启动 CLI 会话将自动重启。当前任务可能中断，不会自动重跑。远端或脱离 CLI 的后台进程可能仍在运行，重试前请核查。不会覆盖外部安装。', 'CLI 已就绪，已启动会话已重启；中断任务未自动重跑。', 'CLI 切换或会话重启失败', '回退版本', '恢复上一版本 CLI？所有活动会话将自动重启，当前任务可能中断且不会自动重跑。'],
    'zh-tw': ['Claude Code 安裝引導', '安裝設定操作失敗', '選擇既有 CLI', '下載官方 Claude CLI', '安裝 / 更新', '已是最新版本', '安裝後所有活動 CLI 會話將重新啟動，任務可能中斷且不會自動重跑。遠端或背景程序可能仍在執行，重試前請確認。不覆蓋外部安裝。', 'CLI 已就緒，活動會話已重新啟動；中斷任務未重跑。', 'CLI 切換或會話重啟失敗', '回退版本', '恢復上一版本 CLI？所有活動會話將重新啟動，任務可能中斷且不會重跑。'],
    ja: ['Claude Code の設定', '設定操作に失敗しました', '既存 CLI を選択', '公式 Claude CLI をダウンロード', 'インストール / 更新', '最新バージョンです', 'インストール後、すべての起動中 CLI を再起動します。作業は中断される場合があり、自動再実行しません。リモートやバックグラウンドの処理は継続する場合があります。再試行前に確認してください。外部インストールは上書きしません。', 'CLI の準備とセッションの再起動が完了しました。中断された作業は再実行していません。', 'CLI 切り替えまたは再起動に失敗しました', '以前のバージョン', '以前の CLI に戻しますか？起動中のセッションを再起動します。作業は中断される場合があり、再実行しません。'],
    ko: ['Claude Code 설정', '설정 작업 실패', '기존 CLI 선택', '공식 Claude CLI 다운로드', '설치 / 업데이트', '최신 버전입니다', '설치 후 모든 활성 CLI 세션이 다시 시작됩니다. 작업이 중단될 수 있으며 자동 재실행하지 않습니다. 원격 또는 백그라운드 작업은 계속 실행될 수 있으니 확인하세요. 외부 설치는 덮어쓰지 않습니다.', 'CLI 준비 및 세션 재시작 완료. 중단된 작업은 재실행하지 않았습니다.', 'CLI 전환 또는 세션 재시작 실패', '이전 버전 복원', '이전 CLI를 복원할까요? 모든 활성 세션이 다시 시작됩니다. 작업이 중단될 수 있으며 재실행하지 않습니다.'],
    fr: ['Configuration Claude Code', 'Échec de la configuration', 'Choisir un CLI existant', 'Télécharger le CLI Claude officiel', 'Installer / Mettre à jour', 'Déjà à jour', 'Tous les CLI actifs redémarreront. Les tâches peuvent être interrompues et ne seront pas relancées. Les processus distants ou détachés peuvent continuer : vérifiez-les avant de réessayer. Les installations externes sont conservées.', 'CLI prêt ; sessions redémarrées. Aucune tâche interrompue n’a été relancée.', 'Échec du changement de CLI ou du redémarrage', 'Version précédente', 'Restaurer le CLI précédent ? Toutes les sessions actives redémarreront. Les tâches peuvent être interrompues et ne seront pas relancées.'],
    de: ['Claude Code einrichten', 'Einrichtung fehlgeschlagen', 'Vorhandene CLI auswählen', 'Offizielle Claude CLI herunterladen', 'Installieren / Aktualisieren', 'Bereits aktuell', 'Alle aktiven CLI-Sitzungen starten neu. Aufgaben können unterbrochen werden und werden nicht wiederholt. Remote- oder Hintergrundprozesse können weiterlaufen; vor erneutem Versuch prüfen. Externe Installationen bleiben unverändert.', 'CLI bereit; Sitzungen neu gestartet. Unterbrochene Aufgaben wurden nicht wiederholt.', 'CLI-Wechsel oder Sitzungsneustart fehlgeschlagen', 'Vorherige Version', 'Vorherige CLI wiederherstellen? Alle aktiven Sitzungen starten neu. Aufgaben können unterbrochen werden und werden nicht wiederholt.']
};

/** Transient operation state sent to the wizard; never persisted as installation completion. */
export interface SetupProgress {
    phase: 'checking' | 'confirming' | 'downloading' | 'verifying' | 'switching' | 'complete' | 'cancelled' | 'error' | 'current';
    bytes?: number;
    total?: number;
    version?: string;
    error?: string;
}

/** Display-only update state shared by the wizard and the settings CLI card. */
export interface CliUpdateState {
    busy: boolean;
    progress?: SetupProgress;
    version?: string;
}

/** Environment-bound three-step setup; no CLI execution tasks are launched by visiting the page. */
export class SetupController {
    private view?: vscode.WebviewView;
    private wizardRequested = false;
    private showing?: Promise<void>;
    private readonly pageEmitter = new vscode.EventEmitter<void>();
    /** Notify the shared settings host only when its page mode needs reevaluation. */
    public readonly onDidChangePage = this.pageEmitter.event;
    private readonly updateEmitter = new vscode.EventEmitter<CliUpdateState>();
    /** Publish lightweight CLI update events without replacing the current settings page. */
    public readonly onDidChangeCliUpdate = this.updateEmitter.event;
    private busy = false;
    private abort?: AbortController;
    private progress?: SetupProgress;
    private progressPublishedAt = 0;
    private readonly environmentId = `${vscode.env.remoteName ?? 'local'}:${process.platform}:${process.arch}`;
    private state: SetupState;
    /** Restore only explicit setup state; never infer completion from legacy paths. */
    public constructor(private readonly context: vscode.ExtensionContext, private readonly manager: ConfigManager) {
        const saved = context.globalState.get<SetupState>(SETUP_KEY);
        this.state = saved?.schemaVersion === 1 && saved.environmentId === this.environmentId ? saved : { schemaVersion: 1, completed: false, lastStep: 1, environmentId: this.environmentId };
        setSetupChecker(() => this.ensureReady());
        context.subscriptions.push(manager.onDidChange(() => this.publish()));
        for (const [command, action] of Object.entries({
            'claudeRouter.setup.open': () => this.show(), 'claudeRouter.setup.reset': () => this.reset(),
            'claudeRouter.setup.verify': () => this.verifyExisting(),
            'claudeRouter.setup.update': () => this.install(true), 'claudeRouter.setup.download': () => this.install(false),
            'claudeRouter.setup.rollback': () => this.rollback()
        })) context.subscriptions.push(vscode.commands.registerCommand(command, async () => { try { await action(); } catch (error) { await vscode.window.showErrorMessage(`${this.text(1)}: ${String(error)}`); } }));
        const release = () => { this.abort?.abort(); this.view = undefined; this.pageEmitter.dispose(); this.updateEmitter.dispose(); };
        context.subscriptions.push({ dispose: release });
    }
    /** Resolve host UI text using the current extension language with English fallback. */
    private text(index: number): string { return (setupMessages[this.manager.getResolvedUiLanguage()] || setupMessages.en)[index]; }
    /** Expose non-secret status for the shared settings page. */
    public snapshot(): SetupState { return JSON.parse(JSON.stringify(this.state)); }
    /** Return detached card state so another settings view can show an in-flight update immediately. */
    public cliUpdateSnapshot(): CliUpdateState {
        return { busy: this.busy, progress: this.progress ? { ...this.progress } : undefined, version: this.state.cli?.version };
    }
    /** Broadcast card-only state; provider editors and expanded model rows are left untouched. */
    private publishCliUpdate(): void { this.updateEmitter.fire(this.cliUpdateSnapshot()); }
    /** Return true only when both global completion records belong to this extension host. */
    public completed(): boolean {
        return isSetupComplete(this.context.globalState.get(SETUP_COMPLETE_KEY), this.state, this.environmentId);
    }
    /** Select the page without probing executables or fabricating completion from existing configuration. */
    public needsWizard(): boolean { return this.wizardRequested || !this.completed(); }
    /** Activate the shared wizard for either chat entry before any CLI probing or task admission. */
    public async ensureReady(): Promise<boolean> {
        if (!this.completed()) { await this.show(); return false; }
        if (!vscode.workspace.isTrusted) { await this.show(); return false; }
        const cli = new ChatCliConfigService(this.manager).getConfig().cliPath;
        const model = this.manager.getCurrentModel();
        if (!cli || !await probeCliVersion(cli)) { this.state.lastStep = 1; await this.show(); return false; }
        if (!model || !this.manager.getProvider(model.providerId) || this.manager.getProvider(model.providerId)?.enabled === false || !this.manager.isModelEnabled(this.manager.getProviderModel(model.providerId, model.modelId))) { this.state.lastStep = 2; await this.show(); return false; }
        return true;
    }
    private saveQueue: Promise<void> = Promise.resolve();
    /** Persist setup flags in order; quiet version checks do not trigger a full settings refresh. */
    private async save(notifyManager = true): Promise<void> {
        const snapshot = JSON.parse(JSON.stringify(this.state)) as SetupState;
        const action = this.saveQueue.then(async () => {
            await this.context.globalState.update(SETUP_KEY, snapshot);
            await this.context.globalState.update(SETUP_COMPLETE_KEY, snapshot.completed);
        });
        this.saveQueue = action.catch(() => {}); await action;
        if (notifyManager) this.manager.notifyChanged();
        this.publish();
    }
    /** Reveal and focus one shared wizard, coalescing simultaneous left/right entry requests. */
    public show(): Promise<void> {
        this.wizardRequested = true;
        this.pageEmitter.fire(); this.publish();
        if (this.showing) return this.showing;
        const action = Promise.resolve().then(async () => { await getConfigViewProvider()?.focus(); })
            .catch(error => { void vscode.window.showErrorMessage(`${this.text(1)}: ${String(error)}`); });
        this.showing = action;
        void action.then(() => { if (this.showing === action) this.showing = undefined; });
        return action;
    }
    /** Clear only onboarding records through VS Code's live state API, retaining CLI files, settings and histories. */
    public async reset(): Promise<void> {
        if (this.busy) throw new Error('CLI operation in progress');
        this.busy = true;
        this.state = { schemaVersion: 1, completed: false, lastStep: 1, environmentId: this.environmentId };
        this.wizardRequested = true;
        try {
            const action = this.saveQueue.then(async () => {
                await this.context.globalState.update(SETUP_COMPLETE_KEY, undefined);
                await this.context.globalState.update(SETUP_KEY, undefined);
            });
            this.saveQueue = action.catch(() => {});
            await action;
            this.progress = undefined; this.publishCliUpdate();
            Logger.info('[setup/reset] 已通过扩展 API 清除安装状态；保留 CLI、配置、密钥和历史。');
        } finally { this.busy = false; }
        await this.show();
    }

    /** Attach wizard content to the existing settings view; disposal releases listeners, not installation state. */
    public attach(view: vscode.WebviewView): vscode.Disposable {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
        const providerController = new ConfigWebviewController(this.context, this.manager, view, undefined, { providersOnly: true, embedded: true });
        const messages = view.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => { const detail = `${this.text(1)}: ${String(error)}`; this.publish(detail); }); });
        const nonce = randomUUID().replace(/-/g, '');
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'setup.js'));
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'setup.css'));
        const providerScript = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'configView.js'));
        const providerStyle = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'configView.css'));
        view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.webview.cspSource};"><link rel="stylesheet" href="${providerStyle}"><link rel="stylesheet" href="${style}"></head><body><main class="setup-shell"><header class="setup-header"><span class="brand">LLS CCAI <span class="brand-divider">/</span> SETUP</span><h1 id="title"></h1><p id="environment"></p></header><div id="page"></div><p id="error" role="alert"></p></main><script nonce="${nonce}" src="${script}"></script><script nonce="${nonce}" src="${providerScript}"></script></body></html>`;
        return { dispose: () => { messages.dispose(); providerController.dispose(); if (this.view === view) this.view = undefined; } };
    }
    /** Publish only display-safe setup and selected-model data. */
    private publish(error = ''): void {
        if (!this.view) return;
        const view = this.view;
        view.title = this.text(0);
        const models = this.manager.listProviders().filter(p => p.enabled !== false).flatMap(p => p.models.filter(m => this.manager.isModelEnabled(m)).map(m => ({ providerId: p.id, modelId: m.modelId, label: `${p.name}: ${m.displayName}` })));
        const providers = this.manager.listProviders().map(p => ({ id: p.id, name: p.name, enabled: p.enabled !== false, apiType: p.apiType, modelCount: p.models.filter(m => this.manager.isModelEnabled(m)).length }));
        void view.webview.postMessage({ type: 'setup', providers, state: this.state, busy: this.busy, language: this.manager.getResolvedUiLanguage(),
            cliPath: this.manager.getChatCliPath(), configuredLanguage: this.manager.getConfiguredUiLanguage(), permissionMode: new ChatCliConfigService(this.manager).getConfig().permissionMode,
            installRoot: this.resolveInstallRoot(), installSource: this.installSource(), progress: this.progress, models, current: this.manager.getCurrentModel(),
            taskFlowModel: readEffectiveTaskFlowModelSelection(), compactionModel: readEffectiveCompactionModelSelection(), reasoningEffort: this.manager.getChatReasoningEffort(), canReturnToSettings: this.completed(), error });
    }
    /** Resolve a safe default when older state has no source or contains an invalid value. */
    private installSource(): CliInstallSource { return isCliInstallSource(this.state.installSource) ? this.state.installSource : 'official'; }
    /** Push lightweight progress without rebuilding the form or losing keyboard focus. */
    private reportProgress(progress: SetupProgress): void {
        const previousPhase = this.progress?.phase;
        this.progress = progress;
        const now = Date.now();
        if (previousPhase === progress.phase && progress.phase === 'downloading' && now - this.progressPublishedAt < 150 && progress.bytes !== progress.total) return;
        this.progressPublishedAt = now;
        this.publishCliUpdate();
        void this.view?.webview.postMessage({ type: 'setup/progress', progress });
    }
    /** Handle explicit wizard actions without launching unapproved model requests. */
    private async receive(message: { type: string; value?: string; providerId?: string; modelId?: string }): Promise<void> {
        if (message.type === 'setup/providers') return;
        if (message.type === 'ready') { this.publish(); return; }
        if (message.type === 'cancelDownload') { this.abort?.abort(); return; }
        if (this.busy) throw new Error('CLI operation in progress');
        switch (message.type) {
            case 'language': {
                if (!['auto','en','zh-cn','zh-tw','ja','ko','fr','de'].includes(message.value ?? '')) throw new Error('Invalid language');
                await this.manager.updateUiLanguage(message.value as import('../types').AppLanguage); break;
            }
            case 'installSource': {
                if (!isCliInstallSource(message.value)) throw new Error('Invalid CLI installation source');
                this.state.installSource = message.value; this.progress = undefined; await this.save(); break;
            }
            case 'verifyCurrent': {
                await this.verifyCurrent(); break;
            }
            case 'pick': await this.verifyExisting(); break;
            case 'download': await this.install(false); break;
            case 'update': await this.install(true); break;
            case 'root': {
                const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(this.resolveInstallRoot()) });
                if (selected?.[0]) { this.state.installRoot = selected[0].fsPath; await this.save(); } break;
            }
            case 'next': {
                await this.verifyCurrent();
                this.state.lastStep = 2; await this.save(); break;
            }
            case 'back': this.state.lastStep = this.state.lastStep === 3 ? 2 : 1; await this.save(); break;
            case 'settings': {
                if (!this.completed()) throw new Error('Complete setup before opening settings');
                this.wizardRequested = false; this.pageEmitter.fire(); return;
            }
            case 'models': this.state.lastStep = 2; await this.save(); break;
            case 'selectModel': {
                if (this.state.lastStep !== 3) throw new Error('Choose the workspace model in step three');
                const provider = message.providerId ? this.manager.getProvider(message.providerId) : undefined;
                if (!message.providerId || !message.modelId || !provider || provider.enabled === false || !this.manager.isModelEnabled(this.manager.getProviderModel(message.providerId, message.modelId))) throw new Error('Select an enabled model');
                await this.manager.setCurrentModel({ providerId: message.providerId, modelId: message.modelId }); break;
            }
            case 'selectTaskFlowModel':
            case 'selectCompactionModel': {
                if (this.state.lastStep !== 3) throw new Error('Choose workspace models in step three');
                if (message.value !== '') {
                    const provider = message.providerId ? this.manager.getProvider(message.providerId) : undefined;
                    if (!message.providerId || !message.modelId || !provider || provider.enabled === false || !this.manager.isModelEnabled(this.manager.getProviderModel(message.providerId, message.modelId))) throw new Error('Select an enabled model');
                }
                const modelId = message.value === '' ? '' : `${message.providerId}/${message.modelId}`;
                if (message.type === 'selectTaskFlowModel') await saveTaskFlowModelSelection(modelId);
                else await saveCompactionModelSelection(modelId, { workspaceOnly: true });
                this.manager.notifyChanged(); break;
            }
            case 'reasoningEffort': {
                if (this.state.lastStep !== 3) throw new Error('Choose reasoning effort in step three');
                if (!['auto', 'low', 'medium', 'high', 'xhigh'].includes(message.value ?? '')) throw new Error('Invalid reasoning effort');
                await this.manager.setChatReasoningEffort(message.value!); this.manager.notifyChanged(); break;
            }
            case 'review': {
                if (this.state.lastStep !== 2 || !this.state.cli) throw new Error('Complete CLI verification before model confirmation');
                const available = this.manager.listProviders().some(provider => provider.enabled !== false && provider.models.some(model => this.manager.isModelEnabled(model)));
                if (!available) throw new Error('Add an enabled provider and model first');
                this.state.lastStep = 3; await this.save(); break;
            }
            case 'finish': {
                if (this.state.lastStep !== 3) throw new Error('Complete the preceding setup steps first');
                this.assertTrusted();
                const cli = this.state.cli, model = this.manager.getCurrentModel();
                if (!cli || !await probeCliVersion(cli.path) || !model || !this.manager.getProvider(model.providerId) || this.manager.getProvider(model.providerId)?.enabled === false || !this.manager.isModelEnabled(this.manager.getProviderModel(model.providerId, model.modelId))) throw new Error('CLI or model is not configured');
                if (this.manager.getChatCliPath() !== cli.path) throw new Error('CLI path changed; validate it again');
                this.state = { ...this.state, completed: true, lastStep: 3, defaultModel: model, completedAt: Date.now() }; await this.save();
                this.wizardRequested = false; this.pageEmitter.fire();
                const { restoreTaskFlowSafelyForSetup } = await import('./finish');
                await restoreTaskFlowSafelyForSetup();
                const { restorePreferredSidebarLayout } = await import('../activation/sidebarLayout');
                await restorePreferredSidebarLayout(this.context);
                await vscode.commands.executeCommand('claudeRouter.chat.open'); break;
            }
        }
        this.publish();
    }
    /** Share the persisted download destination between the page, confirmation dialog and installer. */
    private resolveInstallRoot(): string {
        return this.state.installRoot || this.state.cli?.installRoot || path.join(this.context.globalStorageUri.fsPath, 'cli');
    }
    /** Require trust before downloads, executing binaries or replacing runtime settings. */
    private assertTrusted(): void { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before configuring executable software'); }
    /** Validate the prefilled executable on explicit verification or Next without adding another required click. */
    private async verifyCurrent(): Promise<void> {
        this.assertTrusted();
        const cliPath = this.manager.getChatCliPath(); clearCliVersionCache();
        const version = cliPath ? await probeCliVersion(cliPath) : undefined;
        if (!version) throw new Error('Current CLI path failed verification');
        this.state.cli = { ...this.state.cli, path: cliPath, version, source: this.state.cli?.path === cliPath ? this.state.cli.source : 'external', verifiedAt: Date.now() };
        await this.save();
    }
    /** Verify and select an existing executable without marking onboarding complete. */
    public async verifyExisting(): Promise<void> {
        this.assertTrusted();
        const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: this.text(2) });
        if (!selected?.[0]) return;
        const cliPath = selected[0].fsPath; clearCliVersionCache();
        const version = await probeCliVersion(cliPath); if (!version) throw new Error('Selected CLI failed --version verification');
        await this.setPath(cliPath);
        this.state.cli = { path: cliPath, version, source: 'external', verifiedAt: Date.now() }; await this.save();
    }
    /** Update global path and align existing current-workspace overrides. */
    private async setPath(cliPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('claudeCodeConfigHelper');
        await new ChatCliConfigService(this.manager).updateCliPath(cliPath);
        const inspection = config.inspect<string>('chat.cliPath');
        if (inspection?.workspaceValue !== undefined) await config.update('chat.cliPath', cliPath, vscode.ConfigurationTarget.Workspace);
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const scoped = vscode.workspace.getConfiguration('claudeCodeConfigHelper', folder.uri);
            if (scoped.inspect<string>('chat.cliPath')?.workspaceFolderValue !== undefined) await scoped.update('chat.cliPath', cliPath, vscode.ConfigurationTarget.WorkspaceFolder);
        }
    }
    /** Check and update CLI in the current page; only incomplete installations need the wizard. */
    public async install(checkOnly: boolean): Promise<void> {
        this.assertTrusted(); if (this.busy) throw new Error('CLI operation already running');
        if (!this.completed()) void this.show();
        this.busy = true; this.abort = new AbortController();
        this.reportProgress({ phase: 'checking' }); this.publish();
        const signal = this.abort.signal;
        try {
            const installer = new CliInstaller();
            const currentPath = this.manager.getChatCliPath();
            clearCliVersionCache();
            const current = currentPath ? await probeCliVersion(currentPath) : undefined;
            if (checkOnly && current) {
                this.state.cli = { ...this.state.cli, path: currentPath, version: current, source: this.state.cli?.path === currentPath ? this.state.cli.source : 'external', verifiedAt: Date.now() };
                await this.save(false); this.publishCliUpdate();
            }
            const release = await installer.latest(signal, undefined, this.installSource());
            if (signal.aborted) throw new Error('Installation cancelled');
            if (checkOnly && current && compareVersions(release.version, current) <= 0) {
                this.reportProgress({ phase: 'current', version: current }); return;
            }
            const root = this.resolveInstallRoot();
            this.reportProgress({ phase: 'confirming', version: release.version });
            const choice = await vscode.window.showWarningMessage(`Claude CLI ${current ?? '—'} → ${release.version}\n${release.packageName}\n${this.installSource() === 'china' ? 'npmmirror (third-party mirror)' : 'registry.npmjs.org'}\n${root}\n${this.text(6)}`, { modal: true }, this.text(4));
            if (!choice || signal.aborted) { this.reportProgress({ phase: 'cancelled' }); return; }
            this.reportProgress({ phase: 'downloading', bytes: 0, version: release.version });
            const executable = await installer.install(release, root, signal,
                (bytes, total) => this.reportProgress({ phase: 'downloading', bytes, total, version: release.version }),
                () => this.reportProgress({ phase: 'verifying', version: release.version }));
            if (signal.aborted) throw new Error('Installation cancelled');
            this.reportProgress({ phase: 'switching', version: release.version });
            const switched = await this.switchCli({ path: executable, version: release.version, source: 'managed', installRoot: root, verifiedAt: Date.now() });
            this.reportProgress({ phase: switched ? 'complete' : 'error', version: release.version, error: switched ? undefined : this.text(8) });
        } catch (error) {
            this.reportProgress({ phase: signal.aborted ? 'cancelled' : 'error', error: signal.aborted ? undefined : String(error) });
            if (!signal.aborted) throw error;
        } finally {
            this.abort = undefined; this.busy = false; this.publish(); this.publishCliUpdate();
        }
    }
    /** Restart previously live processes with their existing session identities after validation succeeds. */
    private async switchCli(cli: NonNullable<SetupState['cli']>): Promise<boolean> {
        const { prepareEditorCliUpdate } = await import('../editorChat/entry');
        const { prepareSidebarCliUpdate } = await import('../chatRuntime/cliLifecycle');
        const { cancelPendingResend } = await import('../chatRuntime/selfHealing');
        const { getAutoContinueScheduler } = await import('../taskFlow/taskFlowCommands');
        const { flushPersistedChatSession } = await import('../chatRuntime/chatSession');
        setCliUpdateInProgress(true);
        let sidebarStopped = false;
        const errors: string[] = [];
        try {
            getAutoContinueScheduler()?.cancel('CLI update'); cancelPendingResend('CLI update');
            await flushPersistedChatSession();
            const editors = await prepareEditorCliUpdate(); errors.push(...editors.errors);
            try { sidebarStopped = await prepareSidebarCliUpdate(); } catch (error) { errors.push(`Sidebar stop: ${String(error)}`); }
            await this.flushAndSwitch(cli, editors, sidebarStopped, errors);
        } finally { setCliUpdateInProgress(false); }
        return this.reportSwitchResult(cli.version, errors);
    }
    /** Notify without awaiting dismissal; informational UI must never hold installation or rollback busy. */
    private reportSwitchResult(version: string, errors: string[]): boolean {
        if (errors.length) void vscode.window.showWarningMessage(`${this.text(8)}:\n${errors.join('\n')}`);
        else void vscode.window.showInformationMessage(`CLI ${version}: ${this.text(7)}`);
        return errors.length === 0;
    }
    /** Persist the new selection; if settings fail, recover the stopped processes on the previous executable. */
    private async flushAndSwitch(cli: NonNullable<SetupState['cli']>, editors: { resume: (path: string) => Promise<string[]> }, sidebarStopped: boolean, errors: string[]): Promise<void> {
        const { restartSidebarAfterCliUpdate } = await import('../chatRuntime/cliLifecycle');
        const oldPath = this.manager.getChatCliPath(); const oldState = this.snapshot();
        try {
            await this.setPath(cli.path);
            this.state.previousCli = this.state.cli; this.state.cli = cli; await this.save();
        } catch (error) {
            errors.push(`Settings switch: ${String(error)}`); this.state = oldState;
            if (oldPath) {
                try { await this.setPath(oldPath); await this.save(); } catch (rollback) { errors.push(`Settings rollback: ${String(rollback)}`); }
                errors.push(...await editors.resume(oldPath));
                if (sidebarStopped) try { await restartSidebarAfterCliUpdate(); } catch (restart) { errors.push(`Sidebar recovery: ${String(restart)}`); }
            }
            return;
        }
        errors.push(...await editors.resume(cli.path));
        if (sidebarStopped) try { await restartSidebarAfterCliUpdate(); } catch (error) { errors.push(`Sidebar restart: ${String(error)}`); }
    }
    /** Roll back to a retained verified path, never deleting external installations. */
    public async rollback(): Promise<void> {
        this.assertTrusted(); if (this.busy) throw new Error('CLI operation in progress');
        const previous = this.state.previousCli;
        if (!previous || await probeCliVersion(previous.path) !== previous.version) throw new Error('Previous CLI is unavailable');
        if (!await vscode.window.showWarningMessage(`${previous.version}\n${this.text(10)}`, { modal: true }, this.text(9))) return;
        this.busy = true; try { await this.switchCli(previous); } finally { this.busy = false; this.publish(); }
    }
}
