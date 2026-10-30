/** @file Independent editor CLI runtime, reusing the original chat protocol and rendering. */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { COMMANDS } from '../constants';
import { CliProcess } from '../chat/cli/cliProcess';
import { StreamJsonCliAdapter, type ParsedCliEvent } from '../chat/cli/cliAdapter';
import { ChatCliConfigService } from '../chat/cli/cliConfig';
import type { ChatMessage, ChatSegment, ExtensionToWebview, WebviewToExtension } from '../chat/protocol';
import { buildNativeCompactionPolicy, NATIVE_COMPACTION_ENV_KEYS } from '../nativeCompactionPolicy';
import { probeCliVersion } from '../chat/cli/nativeCompactionProbe';
import { LlsTaskService } from '../llsTask/service';
import { TaskFlowStore } from '../llsTask/store';
import { RequestRecoveryController, type RecoveryIdentity } from '../chatRuntime/requestRecovery';
import { EditorContinuation } from './continuation';
import { EditorRelay } from './relay';
import { parseSessionJsonl, extractSessionTitle } from '../chatRuntime/chatSession';
import { editorProjectHistory, listEditorNativeHistory } from './nativeHistory';
import { EditorConversationStore, assertConversationId, type EditorConversation, type EditorSettings } from './store';
import { EditorAutoOpener, extractFilePathFromToolInput } from '../editorAutoOpen';
import { BrowserToolHost } from '../browserTools/browserToolHost';
import { DiagnosticsHost } from '../vscodeTools/diagnosticsHost';
import { WakeupStore } from '../wakeupTools/wakeupStore';
import { WakeupScheduler } from '../wakeupTools/wakeupScheduler';
import { WakeupHost } from '../wakeupTools/wakeupHost';
import { buildPromptWithAttachments, buildUserDisplaySegments, sanitizeUploadFileName, openWorkspaceFileReference } from '../chatRuntime/chatMessaging';
import { readClipboardImage } from '../chatRuntime/clipboardImages';
import type { RequestUsageSummary } from '../relay/requestUsage';
import type { UsageReport } from '../relay/usageReporter';

/** Minimal presentation host shared by preserved editor tabs and the independent left-side conversation. */
export interface IndependentChatHost {
    title?: string;
    webview: Pick<vscode.Webview, 'postMessage'>;
}

/** Each runtime owns its complete lifecycle; no selected-window global is consulted. */
export class EditorChatRuntime {
    public readonly panelInstanceId = randomUUID();
    private cli?: CliProcess;
    private adapter?: StreamJsonCliAdapter;
    private generation = 0;
    private closed = false;
    private closePromise?: Promise<void>;
    private busy = false;
    private assistant?: ChatMessage;
    private events: Promise<void> = Promise.resolve();
    private settingsQueue: Promise<void> = Promise.resolve();
    private overrideCliPath?: string;
    private applied = '';
    private starting?: Promise<void>;
    private restarting = false;
    private continuationTimer?: NodeJS.Timeout;
    private readonly permissions = new Map<string, unknown>();
    private readonly background = new Set<string>();
    private turnFinished = false;
    private turnFailed = false;
    private flowPaused = true;
    private readonly service: LlsTaskService;
    private readonly continuation: EditorContinuation;
    private readonly recovery: RequestRecoveryController;
    private recoveryIdentity?: RecoveryIdentity;
    private readonly requestIdentities = new Map<string, RecoveryIdentity>();
    private readonly relay: EditorRelay;
    private readonly opener: EditorAutoOpener;
    private readonly browser = new BrowserToolHost();
    private readonly diagnostics = new DiagnosticsHost();
    private readonly wakeupStore: WakeupStore;
    private readonly wakeups: WakeupScheduler;
    private readonly wakeupHost: WakeupHost;
    private readonly wakeupQueue: string[] = [];
    private readonly checkpoint = setInterval(() => { if (!this.closed && this.busy) void this.persist().catch(error => this.post({ type: 'toast', level: 'error', text: String(error) })); }, 5000);
    /** Bind immutable conversation identity to its own presentation host and lifecycle. */
    public constructor(public readonly data: EditorConversation, private readonly store: EditorConversationStore,
        private readonly panel: IndependentChatHost, private readonly manager: ConfigManager,
        private readonly openNew: () => Promise<void>, private readonly history: () => Promise<void>) {
        this.opener = new EditorAutoOpener(() => [{ uri: vscode.Uri.file(data.cwd), name: path.basename(data.cwd), index: 0 }], () => !this.closed && data.settings.codePreviewEnabled);
        this.service = new LlsTaskService(manager, new TaskFlowStore(path.join(data.cwd, '.LLSOAI/editor-sessions', data.conversationId, 'task-flow.json')));
        this.wakeupStore = new WakeupStore(path.join(data.cwd, '.LLSOAI/editor-sessions', data.conversationId, 'wakeups.json'));
        this.wakeups = new WakeupScheduler(this.wakeupStore, async job => {
            if (this.closed) return;
            if (this.busy) this.wakeupQueue.push(job.prompt); else await this.send(job.prompt);
        });
        this.wakeupHost = new WakeupHost(this.wakeups);
        this.continuation = new EditorContinuation(this.service);
        this.relay = new EditorRelay(manager, this.service, this.continuation, report => {
            this.queueEvent(async () => { await this.recordUsage(report); });
        });
        this.recovery = new RequestRecoveryController({ now: Date.now, setTimer: (fn, delay) => setTimeout(fn, delay), clearTimer: timer => clearTimeout(timer as NodeJS.Timeout),
            notify: state => this.post({ type: 'request/recovery', state }),
            recover: async (context, signal) => {
                if (this.closed || signal.aborted || this.busy || this.background.size) throw new Error('Editor not safe to recover');
                await this.stopProcess(); await this.ensureCli(); if (this.closed || signal.aborted) return;
                this.recoveryIdentity = context;
                this.busy = true; this.turnFinished = false; this.turnFailed = false; this.relay.active = true;
                this.assistant = { id: randomUUID(), role: 'assistant', createdAt: Date.now(), segments: [], pending: true };
                this.data.messages.push(this.assistant); this.post({ type: 'message/append', message: this.assistant });
                this.post({ type: 'chat/running', running: true });
                this.data.lastRunState = 'running'; await this.persist();
                if (this.closed || signal.aborted) return;
                await this.adapter!.sendUserMessage(context.deliveryState === 'not_sent' ? context.originalPrompt : 'Continue the interrupted request using existing tool results. Do not repeat completed operations.');
            } });
        this.relay.onRequest = id => { if (this.recoveryIdentity) { this.requestIdentities.set(id, this.recoveryIdentity); this.recovery.onRelayRequestStarted(this.recoveryIdentity, id); } };
        this.relay.onOutcome = outcome => { const id = outcome.context?.requestId; const identity = id && this.requestIdentities.get(id); if (!id || !identity) return;
            this.requestIdentities.delete(id); this.recovery.onRelayRequestFinished(identity, id, outcome.status === 'error' ? { status: outcome.upstreamStatus ?? outcome.mappedStatus, code: outcome.code, stage: outcome.stage, retryAfter: outcome.retryAfter } : undefined); };
        this.relay.toolHandler = async (bridge, name, args) => {
            if (this.closed) throw new Error('Editor closed');
            if (bridge === 'llsccaiBrowser') {
                // Force new pages so another conversation's current page is not silently adopted.
                return this.browser.execute(name as any, name === 'browser_open' ? { ...args, forceNew: true } : args);
            }
            if (bridge === 'llsccaiVscode') return this.diagnostics.execute(name as any, args);
            if (bridge === 'llsccaiWakeup') return this.wakeupHost.execute(name as any, args);
            throw new Error('Unknown editor bridge');
        };
        this.relay.onIdle = () => { this.queueEvent(async () => { await this.finishTurn(); }); };
        this.service.onDidChange(() => this.post({ type: 'taskFlow/status', snapshot: this.service.getSnapshot() }));
    }
    /** Open process without replaying an interrupted prompt or restoring automatic workflow execution. */
    public async start(): Promise<void> {
        await this.service.restore(); await this.relay.start();
        if (this.closed) { this.relay.dispose(); return; }
        await this.ensureCli();
        if (this.data.lastRunState === 'running') this.data.lastRunState = 'interrupted';
        await this.persist(); await this.ready();
    }
    /** Safe event delivery to this panel only. */
    private post(message: ExtensionToWebview | Record<string, unknown>): void {
        if (!this.closed) void this.panel.webview.postMessage({ type: 'from-extension', message }).then(undefined, () => {});
    }
    /** Serialize CLI events and safely surface runtime errors. */
    private queueEvent(action: () => Promise<void>): void {
        this.events = this.events.then(async () => { if (!this.closed) await action(); }).catch(error => this.post({ type: 'toast', level: 'error', text: String(error) }));
    }
    /** Commit a detached snapshot before reporting successful settings/session updates. */
    private async persist(): Promise<void> {
        this.data.revision++; this.data.updatedAt = Date.now(); await this.store.save(this.data);
    }
    /** Choose workflow model without mutating the saved normal model or sidebar. */
    private currentSettings(): EditorSettings {
        return { ...this.data.settings, normalModel: !this.flowPaused && this.service.hasActiveWorkflow() && !this.service.isWorkflowCompleted() && this.data.settings.taskFlowModel
            ? this.data.settings.taskFlowModel : this.data.settings.normalModel };
    }
    /** Create or resume this conversation's CLI; only the update coordinator may bypass the update gate. */
    private async ensureCli(forCliUpdate = false): Promise<void> {
        if (!forCliUpdate && (await import('../setup/gate')).isCliUpdateInProgress()) throw new Error('CLI update in progress');
        if (this.starting) return this.starting;
        this.starting = this.startCli(forCliUpdate);
        try { await this.starting; } finally { this.starting = undefined; }
    }
    /** Start an isolated CLI while inheriting the user's MCP discovery policy and workspace configuration. */
    private async startCli(forCliUpdate = false): Promise<void> {
        if (this.closed || this.busy) return;
        const settings = this.currentSettings(); const signature = JSON.stringify(settings);
        if (this.cli?.isRunning() && this.applied === signature) return;
        const claimedSession = this.data.cliSessionId;
        if (claimedSession) {
            const { routes } = await import('../chatRuntime/routeState');
            if (Object.values(routes).some(route => route.sessionId === claimedSession && route.process?.isRunning())) throw new Error('CLI session already active in sidebar');
        }
        const base = new ChatCliConfigService(this.manager).getConfig(this.data.cwd);
        if (this.overrideCliPath) base.cliPath = this.overrideCliPath;
        if (!base.cliPath || !settings.normalModel) throw new Error('请先在主区配置 CLI 和模型');
        if (this.data.cliSessionId && this.data.cliConfigDir && this.data.cliConfigDir !== (base.cliEnv.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))) throw new Error('CLI history directory changed; choose the original configuration before resuming');
        this.data.cliConfigDir = base.cliEnv.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
        const slash = settings.normalModel.indexOf('/');
        const model = this.manager.getProviderModel(settings.normalModel.slice(0, slash), settings.normalModel.slice(slash + 1));
        if (slash < 1 || !this.manager.isModelEnabled(model)) throw new Error('Saved model is unavailable');
        const generationBeforeStop = this.generation;
        await this.stopProcess(); if (this.closed || this.generation !== generationBeforeStop + 1) return;
        const providerConfig = this.manager.getProvider(settings.normalModel.slice(0, slash));
        if (!providerConfig || providerConfig.enabled === false) throw new Error('Saved provider unavailable');
        const configuredArgs = base.cliArgs;
        if (configuredArgs.some(arg => /^(--resume|--continue|--session-id|--fork-session|--model|--mcp-config|--permission-mode|--dangerously-skip-permissions)(=|$)/.test(arg))) {
            throw new Error('Custom CLI arguments override session identity/model/permissions. Remove conflicting arguments before opening independent editors.');
        }
        const inherited = { ...process.env, ...base.cliEnv };
        const version = await probeCliVersion(base.cliPath, { cwd: this.data.cwd, env: inherited });
        const native = buildNativeCompactionPolicy(model?.modelId ?? '', model?.contextLength, settings.autoCompactEnabled, inherited, [], version);
        const env: Record<string, string> = {};
        for (const key of NATIVE_COMPACTION_ENV_KEYS) if (inherited[key] !== undefined) env[key] = inherited[key]!;
        Object.assign(env, native.env);
        if (settings.autoCompactEnabled && native.policy.status !== 'managed') throw new Error(`Auto compact unavailable: ${native.policy.unsupportedReason ?? native.policy.conflicts.join(',')}`);
        const cli = new CliProcess(); const adapter = new StreamJsonCliAdapter(cli); const generation = ++this.generation;
        this.cli = cli; this.adapter = adapter;
        adapter.onParsedEvent(event => this.queueEvent(async () => { if (generation === this.generation) await this.onEvent(event); }));
        cli.onExit(() => { if (!this.closed && generation === this.generation && this.busy) this.queueEvent(async () => {
            this.busy = false; this.flowPaused = true; this.data.lastRunState = 'interrupted';
            this.post({ type: 'chat/running', running: false }); this.post({ type: 'toast', level: 'error', text: 'CLI 已退出；检查副作用后手动重试。' }); await this.persist();
        }); });
        const url = this.relay.configure(settings);
        this.relay.sessionId = this.data.cliSessionId ?? this.data.conversationId;
        // Legacy builtin bridges target the sidebar. Never inject them into an independent editor.
        const mcpServers = Object.fromEntries(Object.entries(base.mcpServers ?? {}).filter(([name]) => !['llsccaiBrowser', 'llsccaiVscode', 'llsccaiWakeup'].includes(name)));
        for (const name of ['llsccaiBrowser', 'llsccaiVscode', 'llsccaiWakeup']) if (base.mcpServers?.[name]) {
            mcpServers[name] = { type: 'stdio', command: process.execPath, args: ['-e', `require(${JSON.stringify(require.resolve('./mcp'))}).startEditorBridge()`],
                env: { ELECTRON_RUN_AS_NODE: '1', LLS_EDITOR_BRIDGE: name, LLS_EDITOR_TOOL_URL: `${url}/tools` } };
        }
        if (this.closed || (!forCliUpdate && (await import('../setup/gate')).isCliUpdateInProgress())) { adapter.dispose(); cli.dispose(); return; }
        await cli.start({ ...base, cwd: this.data.cwd, model: settings.normalModel, permissionMode: settings.permissionMode,
            resumeSessionId: this.data.cliSessionId, mcpServers,
            cliArgs: configuredArgs, appendSystemPrompt: [this.manager.getGlobalSystemPrompt(), this.manager.getWorkspaceSystemPrompt()].filter(Boolean).join('\n\n'),
            cliEnv: { ...base.cliEnv, LLS_EDITOR_PRIVATE_RELAY: '1', CLAUDE_CODE_SKIP_AUTH_LOGIN: '1', CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1', ANTHROPIC_MODEL: settings.normalModel, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'editor-session-local', ANTHROPIC_AUTH_TOKEN: 'editor-session-local', ANTHROPIC_CUSTOM_HEADERS: '', ...native.env },
            nativeCompaction: native.policy, nativeCompactionEnv: env });
        if (this.closed) { await cli.stop(); return; }
        this.applied = signature;
        this.post({ type: 'autoCompact/current', enabled: settings.autoCompactEnabled, policy: native.policy });
        this.post({ type: 'cli/status', status: 'running' });
    }
    /** Stop only the owned generation and its network activity; retain ownership if termination fails. */
    private async stopProcess(): Promise<void> {
        this.generation++; this.relay.abort(); this.permissions.clear();
        this.adapter?.dispose(); this.adapter = undefined;
        const cli = this.cli;
        await cli?.stop();
        if (this.cli === cli) this.cli = undefined;
        cli?.dispose(); this.applied = '';
    }
    /** Bind visible CLI output to exact response or tool identities in this runtime's private registry. */
    private bindSegmentUsage(segment: ChatSegment): void {
        if (segment.kind === 'usage') return;
        const context = this.relay.usageRegistry.resolveRequestForSegment(this.data.cliSessionId ?? this.data.conversationId,
            segment.responseMessageId, segment.responseCallId);
        if (context) {
            segment.requestId = context.requestId;
            segment.requestUsage = this.relay.usageRegistry.getSummary(context.requestId);
        }
    }

    /** Save request statistics on their own output segments so reattachment and reload retain visible usage. */
    private async recordUsage(report: UsageReport): Promise<void> {
        const summary = report.summary; const context = summary?.context;
        if (!summary || !context || context.compactCommandTriggered
            || !this.relay.usageRegistry.recordRequestUsage(summary)) return;
        for (const message of this.data.messages) {
            for (const segment of message.segments) {
                this.bindSegmentUsage(segment);
                if (segment.kind !== 'usage' && segment.requestId === context.requestId) segment.requestUsage = summary;
            }
        }
        this.post({ type: 'request/usage', summary });
        this.publishUsageBudget(summary);
        await this.persist();
    }

    /** Restore the newest actual context usage, including output, without substituting compact-model statistics. */
    private publishUsageBudget(summary?: RequestUsageSummary): void {
        if (!summary) {
            for (let index = this.data.messages.length - 1; index >= 0 && !summary; index--) {
                const summaries = this.data.messages[index].segments.map(segment => segment.requestUsage)
                    .filter((value): value is RequestUsageSummary => !!value && !value.context.compactCommandTriggered
                        && [value.inputTokens, value.outputTokens, value.cacheReadInputTokens, value.cacheCreationInputTokens].some(tokens => tokens !== undefined));
                summary = summaries.sort((a, b) => b.context.startedAt - a.context.startedAt)[0];
            }
        }
        if (!summary || [summary.inputTokens, summary.outputTokens, summary.cacheReadInputTokens, summary.cacheCreationInputTokens].every(value => value === undefined)) return;
        const context = summary.context;
        const limit = this.manager.getProviderModel(context.providerId, context.modelId)?.contextLength ?? 200000;
        const used = (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0) + (summary.cacheReadInputTokens ?? 0) + (summary.cacheCreationInputTokens ?? 0);
        this.post({ type: 'tokenBudget/usage', sessionId: this.data.cliSessionId ?? this.data.conversationId,
            used, limit, threshold: Math.floor(limit * .9), source: 'api' });
    }

    /** Rehydrate this view; explicit history selection can force replacement of a matching cached transcript. */
    public async ready(replace = false): Promise<void> {
        this.post({ type: 'i18n/update', language: this.manager.getResolvedUiLanguage() });
        this.post({ type: 'session/init', messages: this.data.messages, cliPath: new ChatCliConfigService(this.manager).getConfig(this.data.cwd).cliPath, ...(replace ? { replace: true } : {}) });
        this.post({ type: 'session/title', title: this.data.title, sessionId: this.data.conversationId });
        this.post({ type: 'editorSession/mode', conversationId: this.data.conversationId, cwd: this.data.cwd, draft: this.data.draft });
        const recovery = this.recovery.getSnapshot();
        if (recovery) { const { originalPrompt: _prompt, lastFailure: _failure, ...state } = recovery; this.post({ type: 'request/recovery', state }); }
        await this.pushSettings(); this.publishUsageBudget(); this.post({ type: 'chat/running', running: this.busy });
        this.post({ type: 'taskFlow/status', snapshot: this.service.getSnapshot() });
        for (const [requestId, input] of this.permissions) {
            this.post({ type: 'askUser/request', requestId, route: 'normal', questions: (input as { questions: import('../chat/protocol').AskUserQuestionItem[] }).questions });
        }
    }
    /** Render model choices without updating the provider's global selection. */
    private async pushSettings(): Promise<void> {
        const models = this.manager.listProviders().filter(provider => provider.enabled !== false).flatMap(provider => provider.models
            .filter(model => this.manager.isModelEnabled(model) && model.isUserSelectable !== false)
            .map(model => ({ providerId: provider.id, providerName: provider.name, modelId: model.modelId, displayName: model.displayName, selected: `${provider.id}/${model.modelId}` === this.data.settings.normalModel })));
        const s = this.data.settings;
        const split = (value: string) => { const index = value.indexOf('/'); return index > 0 ? { providerId: value.slice(0, index), modelId: value.slice(index + 1) } : null; };
        this.post({ type: 'models/snapshot', normalModels: models, taskFlowModels: models, compactionModels: models,
            currentNormal: split(s.normalModel), currentTaskFlow: { enabled: !!s.taskFlowModel, modelId: s.taskFlowModel }, currentCompaction: { enabled: !!s.compactionModel, modelId: s.compactionModel } });
        this.post({ type: 'permissionMode/current', mode: s.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits' });
        this.post({ type: 'reasoningEffort/current', effort: s.reasoningEffort }); this.post({ type: 'cacheTtl/current', ttl: s.cacheTtl });
        this.post({ type: 'subagents/current', enabled: s.subagentsEnabled });
        this.post({ type: 'autoCompact/current', enabled: s.autoCompactEnabled, pending: this.busy && this.applied !== JSON.stringify(this.currentSettings()) });
        this.post({ type: 'codePreview/current', enabled: s.codePreviewEnabled });
        this.post({ type: 'browser/autoApproveState', supported: false, enabled: false });
    }
    /** Send one prompt to this CLI only; no side effects are replayed on history restoration. */
    public async send(text: string, attachments?: import('../chat/protocol').ChatComposerAttachment[], continuation = false): Promise<void> {
        if ((await import('../setup/gate')).isCliUpdateInProgress()) throw new Error('CLI update in progress; send again after restart');
        if (this.restarting) throw new Error('CLI restart in progress');
        if (this.closed || this.busy) throw new Error('会话忙碌或已关闭');
        if (!text.trim() && !attachments?.length) return;
        const prompt = buildPromptWithAttachments(text, attachments); if (!continuation) this.flowPaused = false;
        await this.ensureCli(); if (this.closed) return;
        const user: ChatMessage = { id: randomUUID(), role: 'user', text: prompt, segments: await buildUserDisplaySegments(prompt, attachments), createdAt: Date.now() };
        this.data.messages.push(user); this.post({ type: 'message/append', message: user });
        this.assistant = { id: randomUUID(), role: 'assistant', segments: [], createdAt: Date.now(), pending: true };
        this.data.messages.push(this.assistant); this.post({ type: 'message/append', message: this.assistant });
        this.recoveryIdentity = this.recovery.beginTurn({ turnId: randomUUID(), sessionId: this.data.cliSessionId ?? '', cliInstanceId: String(this.generation), route: 'normal', originalPrompt: prompt, deliveryState: 'not_sent' });
        this.busy = true; this.turnFinished = false; this.turnFailed = false; this.relay.active = true;
        const requestGeneration = this.generation;
        this.data.draft = { text: '', attachments: [] };
        this.data.lastRunState = 'running'; await this.persist();
        if (this.closed || requestGeneration !== this.generation) return;
        this.post({ type: 'chat/running', running: true });
        try { await this.adapter!.sendUserMessage(prompt); } catch (error) { await this.cancel(); throw error; }
    }
    /** Merge CLI public events into this panel, rejecting stale process generations at the subscription. */
    private async onEvent(event: ParsedCliEvent): Promise<void> {
        if (event.type === 'session/init') {
            this.data.cliSessionId = event.sessionId; this.relay.sessionId = event.sessionId;
            if (this.recoveryIdentity) this.recoveryIdentity = this.recovery.bindSession(this.recoveryIdentity, event.sessionId) ?? this.recoveryIdentity;
            await this.persist();
        }
        if (event.type === 'segments' && this.assistant) {
            for (const segment of event.segments) {
                this.bindSegmentUsage(segment);
                if (segment.tool) {
                    const filePath = extractFilePathFromToolInput(segment.tool.name, segment.tool.input);
                    if (filePath && !this.closed) void this.opener.observeToolUse({ toolName: segment.tool.name, filePath });
                }
                const index = segment.id ? this.assistant.segments.findIndex(item => item.id === segment.id && item.requestId === segment.requestId) : -1;
                if (index >= 0) this.assistant.segments[index] = segment; else this.assistant.segments.push(segment);
            }
            this.post({ type: 'message/patch', id: this.assistant.id, segments: event.segments, pending: true, append: true });
        }
        if (event.type === 'backgroundTasks/snapshot') { this.background.clear(); event.tasks.forEach(task => this.background.add(task.taskId)); }
        if (event.type === 'backgroundTasks/update') {
            if (['completed', 'failed', 'cancelled', 'killed'].includes(String(event.patch.status))) this.background.delete(event.taskId); else this.background.add(event.taskId);
        }
        if (event.type === 'compact/status') {
            const sessionId = this.data.cliSessionId ?? '';
            if (event.status === 'compacting') this.post({ type: 'compaction/started', sessionId, beforeTokens: 0 });
            else if (event.compactError || event.compactResult === 'failed') this.post({ type: 'compaction/failed', sessionId, error: event.compactError ?? 'Compaction failed' });
            else this.post({ type: 'compaction/finished', oldSessionId: sessionId, newSessionId: sessionId, beforeTokens: 0, afterTokens: 0, summary: 'CLI context compacted; visible history preserved.' });
        }
        if (event.type === 'api/retry' && this.recoveryIdentity) this.recovery.onCliApiRetry(this.recoveryIdentity, { status: event.errorStatus, code: event.errorCode });
        if (event.type === 'error') { this.turnFailed = true; this.post({ type: 'message/error', error: event.message }); }
        if (event.type === 'tool/permissionRequest') {
            if (event.toolName === 'AskUserQuestion') {
                this.permissions.set(event.requestId, event.input);
                this.post({ type: 'askUser/request', requestId: event.requestId, route: 'normal', questions: (event.input as { questions: import('../chat/protocol').AskUserQuestionItem[] }).questions });
            } else if (JSON.parse(this.applied || '{}').permissionMode === 'bypassPermissions') this.adapter?.respondToToolPermission(event.requestId, { behavior: 'allow', updatedInput: event.input });
            else {
                const generation = this.generation;
                const allow = await vscode.window.showWarningMessage(`${this.data.title}: ${event.toolName}\n${JSON.stringify(event.input).slice(0, 2000)}`, { modal: true }, 'Allow once');
                if (!this.closed && generation === this.generation) this.adapter?.respondToToolPermission(event.requestId, allow ? { behavior: 'allow', updatedInput: event.input } : { behavior: 'deny', message: 'Not approved' });
            }
        }
        if ((event.type === 'done' || event.type === 'segments') && event.turnFinished) { this.turnFinished = true; this.turnFailed ||= event.turnResult?.isError === true; }
        await this.finishTurn();
    }
    /** Commit turn completion after all tracked work settles, then schedule only this workflow. */
    private async finishTurn(): Promise<void> {
        if (!this.busy || !this.turnFinished || this.background.size || this.relay.inFlight) return;
        this.busy = false; this.relay.active = false; this.data.lastRunState = this.turnFailed ? 'interrupted' : 'idle';
        if (this.assistant) { this.assistant.pending = false; this.post({ type: 'message/patch', id: this.assistant.id, segments: [], pending: false }); }
        this.post({ type: 'chat/running', running: false }); await this.persist();
        if (this.recoveryIdentity) this.recovery.onCliTurnFinished(this.recoveryIdentity, this.turnFailed);
        const wakeup = this.wakeupQueue.shift();
        if (wakeup && !this.closed) { await this.send(wakeup); return; }
        if (!this.flowPaused && !this.turnFailed && !this.recovery.hasPendingRecovery() && this.continuation.consume() && this.service.hasActiveWorkflow() && !this.service.isWorkflowCompleted()) {
            this.continuationTimer = setTimeout(() => { if (!this.closed && !this.busy && !this.flowPaused) void this.send(this.service.buildContinuePrompt(), undefined, true).catch(error => this.post({ type: 'toast', level: 'error', text: String(error) })); }, 500);
        }
    }
    /** Stop only this process and its continuations, preserving history for explicit recovery. */
    public async cancel(): Promise<void> {
        this.recovery.cancelRecovery('editor cancel');
        this.flowPaused = true; if (this.continuationTimer) clearTimeout(this.continuationTimer);
        this.continuation.cancel('editor cancel'); await this.stopProcess(); this.busy = false; this.background.clear();
        this.data.lastRunState = 'interrupted'; if (this.assistant) this.assistant.pending = false;
        await this.persist(); this.post({ type: 'chat/running', running: false });
    }
    /** 在本会话保存重启过程记录，不提交用户消息、不覆盖已有 assistant 回复。 */
    private async appendRestartNotice(text: string): Promise<void> {
        if (this.closed) return;
        const message: ChatMessage = { id: randomUUID(), role: 'assistant', createdAt: Date.now(), route: 'normal',
            modelLabel: this.data.settings.normalModel, pending: false, segments: [{ kind: 'markdown', text: `> ${text}\n` }] };
        this.data.messages.push(message); await this.persist();
        this.post({ type: 'message/append', message });
    }
    /** 重启本实例 CLI 与私有中转，逐阶段显示真实进度，保留身份且不重放中断任务。 */
    private async restartConversation(): Promise<void> {
        const labels: Record<string, string[]> = {
            en: ['Stopping Claude CLI process…', 'Stopping local relay HTTP server…', 'Starting local relay HTTP server…', 'Local relay HTTP server started', 'Starting Claude CLI process…', 'Claude CLI restart completed', 'Claude CLI restart failed'],
            'zh-cn': ['正在停止 Claude CLI 子进程…', '正在停止本地中转 HTTP 服务…', '正在启动本地中转 HTTP 服务…', '本地中转 HTTP 服务已启动', '正在启动 Claude CLI 子进程…', 'Claude CLI 已重启完成', 'Claude CLI 重启失败'],
            'zh-tw': ['正在停止 Claude CLI 子程序…', '正在停止本機中轉 HTTP 服務…', '正在啟動本機中轉 HTTP 服務…', '本機中轉 HTTP 服務已啟動', '正在啟動 Claude CLI 子程序…', 'Claude CLI 已重新啟動完成', 'Claude CLI 重新啟動失敗'],
            ja: ['Claude CLI を停止中…', 'ローカルリレー HTTP サーバーを停止中…', 'ローカルリレー HTTP サーバーを起動中…', 'ローカルリレー HTTP サーバーが起動しました', 'Claude CLI を起動中…', 'Claude CLI の再起動が完了しました', 'Claude CLI の再起動に失敗しました'],
            ko: ['Claude CLI 중지 중…', '로컬 릴레이 HTTP 서버 중지 중…', '로컬 릴레이 HTTP 서버 시작 중…', '로컬 릴레이 HTTP 서버 시작됨', 'Claude CLI 시작 중…', 'Claude CLI 재시작 완료', 'Claude CLI 재시작 실패'],
            fr: ['Arrêt du CLI Claude…', 'Arrêt du relais HTTP local…', 'Démarrage du relais HTTP local…', 'Relais HTTP local démarré', 'Démarrage du CLI Claude…', 'Redémarrage du CLI Claude terminé', 'Échec du redémarrage du CLI Claude'],
            de: ['Claude CLI wird gestoppt…', 'Lokaler HTTP-Relay-Server wird gestoppt…', 'Lokaler HTTP-Relay-Server wird gestartet…', 'Lokaler HTTP-Relay-Server gestartet', 'Claude CLI wird gestartet…', 'Neustart der Claude CLI abgeschlossen', 'Neustart der Claude CLI fehlgeschlagen']
        };
        const text = labels[this.manager.getResolvedUiLanguage()] || labels.en;
        this.restarting = true;
        try {
            await this.appendRestartNotice(text[0]);
            this.wakeupQueue.length = 0;
            await this.cancel();
            if (this.closed) return;
            await this.appendRestartNotice(text[1]);
            await this.relay.restart(async () => {
                if (this.closed) throw new Error('Editor closed');
                await this.appendRestartNotice(text[2]);
            });
            if (this.closed) { this.relay.dispose(); return; }
            await this.appendRestartNotice(`${text[3]}: ${new URL(this.relay.url).origin}`);
            await this.appendRestartNotice(text[4]);
            await this.ensureCli();
            if (!this.closed) await this.appendRestartNotice(text[5]);
        } catch (error) {
            if (!this.closed) await this.appendRestartNotice(`${text[6]}: ${String(error)}`);
            throw error;
        } finally { this.restarting = false; }
    }
    /** Report whether switching this host to another conversation would interrupt active work. */
    public isBusy(): boolean { return this.busy || this.background.size > 0 || !!this.starting || this.restarting; }

    /** Route UI operations to this host; help opens immediately without joining task/settings queues. */
    public async receive(message: WebviewToExtension | Record<string, any>): Promise<void> {
        if (this.closed) return;
        const m = message as Record<string, any>;
        if (m.type === 'help/open') { await vscode.commands.executeCommand(COMMANDS.openHelp); return; }
        if (m.type === 'askUser/answers') {
            const input = this.permissions.get(m.requestId); if (!input) return;
            this.permissions.delete(m.requestId); this.adapter?.respondToToolPermission(m.requestId, { behavior: 'allow', updatedInput: { ...input as object, answers: m.answers, notes: m.notes } }); return;
        }
        if (m.type === 'user/cancel') { await this.cancel(); return; }
        const work = this.settingsQueue.then(async () => { if (!this.closed) await this.dispatch(m); });
        this.settingsQueue = work.catch(() => {}); await work;
    }
    /** Resolve native history from this conversation's saved CLI configuration, not the focused view. */
    private historyConfigDir(): string {
        return this.data.cliConfigDir || new ChatCliConfigService(this.manager).getConfig(this.data.cwd).cliEnv.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    }
    /** Archive the current context before replacing it within this same editor tab. */
    private async archiveContext(): Promise<void> {
        const directory = path.join(await this.store.resolveDirectory(), 'archive');
        await fs.mkdir(directory, { recursive: true });
        if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Archive directory symlink rejected');
        await fs.writeFile(path.join(directory, `${randomUUID()}.json`), JSON.stringify(this.data), { flag: 'wx', mode: 0o600 });
    }
    /** Start fresh in the current tab, retaining its settings and preserving the old history archive. */
    private async newChat(): Promise<void> {
        await this.cancel(); await this.archiveContext();
        this.relay.usageRegistry.clearRequestUsageBindings();
        this.data.cliSessionId = undefined; this.data.messages = []; this.assistant = undefined;
        this.data.draft = { text: '', attachments: [] }; this.data.title = 'Chat'; this.panel.title = this.data.title;
        this.service.clear(); this.data.lastRunState = 'idle';
        await this.persist(); await this.ensureCli(); await this.ready();
    }
    /** Load even the currently selected native history, publish it before CLI startup and never replay a task. */
    private async resumeNativeHistory(sessionId: string): Promise<void> {
        assertConversationId(sessionId);
        if (this.isBusy()) throw new Error('Stop the current task before loading conversation history.');
        const { routes } = await import('../chatRuntime/routeState');
        if (Object.values(routes).some(route => route.sessionId === sessionId && route.process?.isRunning())) throw new Error('该历史正在主区使用，请先停止对应主区会话。');
        const entries = await EditorConversationStore.list(this.data.cwd);
        if (entries.some(entry => entry.id !== this.data.conversationId && entry.occupied && entry.conversation?.cliSessionId === sessionId)) throw new Error('该历史正在其他编辑区使用，请先关闭对应标签。');
        const file = path.join(editorProjectHistory(this.data.cwd, this.historyConfigDir()), `${sessionId}.jsonl`);
        const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid CLI history file');
        await fs.access(file);
        const messages = await parseSessionJsonl(file, { strict: true }); const title = await extractSessionTitle(file) || 'Chat';
        if (this.closed) return;
        await this.cancel(); await this.archiveContext();
        this.relay.usageRegistry.clearRequestUsageBindings();
        this.data.cliSessionId = sessionId; this.data.messages = messages; this.assistant = undefined;
        this.data.title = title; this.panel.title = title; this.data.draft = { text: '', attachments: [] };
        this.service.clear(); this.data.lastRunState = 'idle';
        await this.persist(); await this.ready(true); await this.ensureCli();
    }
    /** Serialize settings and sends; every saved setting belongs only to this conversation. */
    private async dispatch(m: Record<string, any>): Promise<void> {
        if ((await import('../setup/gate')).isCliUpdateInProgress()) throw new Error('CLI update in progress');
        const settings = this.data.settings;
        const modelKey = (selection: any): string => {
            if (!selection) return '';
            if (typeof selection.providerId !== 'string' || typeof selection.modelId !== 'string' || !this.manager.isModelEnabled(this.manager.getProviderModel(selection.providerId, selection.modelId))) throw new Error('Invalid model selection');
            return `${selection.providerId}/${selection.modelId}`;
        };
        switch (m.type) {
            case 'request/retry': if (m.identity) this.recovery.retryManually(m.identity); return;
            case 'webview/ready': await this.ready(); return;
            case 'user/send': await this.send(String(m.text ?? ''), m.attachments); return;
            case 'editorSession/draft': this.data.draft = { text: String(m.text ?? ''), attachments: Array.isArray(m.attachments) ? m.attachments : [] }; await this.persist(); return;
            case 'editorSession/reset': {
                if (this.busy) throw new Error('Stop the current task before resetting context');
                if (!await vscode.window.showWarningMessage('Reset context in this editor? History will be archived; other windows are unaffected.', { modal: true }, 'Reset')) return;
                await this.newChat(); return;
            }
            case 'session/clear': await this.newChat(); return;
            case 'editorSession/new': await this.openNew(); return;
            case 'sessions/list': {
                try { this.post({ type: 'sessions/list/result', sessions: await listEditorNativeHistory(this.data.cwd, this.historyConfigDir()) }); }
                catch (error) { this.post({ type: 'sessions/list/result', sessions: [] }); throw error; }
                return;
            }
            case 'editorSession/list': await this.history(); return;
            case 'session/resume': await this.resumeNativeHistory(String(m.sessionId)); return;
            case 'session/set-title': this.data.title = String(m.title || 'Chat').slice(0, 120); this.panel.title = this.data.title; await this.persist(); this.post({ type: 'session/title', title: this.data.title, sessionId: this.data.conversationId }); return;
            case 'models/applyPair': {
                const normal = modelKey(m.normal), taskFlow = modelKey(m.taskFlow), compaction = modelKey(m.compaction);
                settings.normalModel = normal; settings.taskFlowModel = taskFlow; settings.compactionModel = compaction; break;
            }
            case 'model/select': settings.normalModel = modelKey(m); break;
            case 'taskFlow/model/select': settings.taskFlowModel = String(m.modelId ?? ''); break;
            case 'reasoningEffort/select': if (!['auto','low','medium','high','xhigh'].includes(m.effort)) throw new Error('Invalid effort'); settings.reasoningEffort = m.effort; break;
            case 'permissionMode/select': if (!['acceptEdits','bypassPermissions'].includes(m.mode)) throw new Error('Invalid permissions'); settings.permissionMode = m.mode; break;
            case 'cacheTtl/select': if (!['default','5m','1h'].includes(m.ttl)) throw new Error('Invalid TTL'); settings.cacheTtl = m.ttl; break;
            case 'subagents/select': settings.subagentsEnabled = m.enabled === true; break;
            case 'autoCompact/select': settings.autoCompactEnabled = m.enabled === true; break;
            case 'codePreview/select': settings.codePreviewEnabled = m.enabled === true; break;
            case 'cli/restartOnly': // Compatibility with earlier Webviews; all manual restarts share one flow.
            case 'cli/restart': await this.restartConversation(); return;
            case 'tokenBudget/compactNow': await this.send('/compact', undefined, true); return;
            case 'config/open': await vscode.commands.executeCommand('claudeRouter.openConfigPanel'); return;
            case 'cli/selectPath': await vscode.commands.executeCommand('claudeRouter.chat.selectCli'); return;
            case 'file/open': await openWorkspaceFileReference(path.isAbsolute(String(m.path)) ? String(m.path) : path.join(this.data.cwd, String(m.path)), m.line, m.endLine); return;
            case 'file/pick': {
                const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true });
                if (uris) this.post({ type: 'composer/addAttachments', attachments: uris.map(uri => ({ path: uri.fsPath, name: path.basename(uri.fsPath) })), focus: true }); return;
            }
            case 'file/uploadBlob': {
                const bytes = Buffer.from(String(m.base64 ?? ''), 'base64'); if (bytes.length > 20 * 1024 * 1024) throw new Error('Attachment exceeds 20 MiB');
                const directory = path.join(os.tmpdir(), 'lls-ccai-editor-uploads', this.data.conversationId); await fs.mkdir(directory, { recursive: true });
                const file = path.join(directory, `${randomUUID()}-${sanitizeUploadFileName(String(m.name), String(m.mime))}`); await fs.writeFile(file, bytes);
                this.post({ type: 'composer/replaceAttachment', clientId: m.clientId, attachment: { path: file, name: m.displayName || m.name }, focus: false }); return;
            }
            case 'file/importClipboardImages': {
                const results = [];
                for (const image of (Array.isArray(m.images) ? m.images : []).slice(0, 5)) {
                    try {
                        const data = await readClipboardImage(image.src); const directory = path.join(os.tmpdir(), 'lls-ccai-editor-uploads', this.data.conversationId); await fs.mkdir(directory, { recursive: true });
                        const file = path.join(directory, `${randomUUID()}${data.extension}`); await fs.writeFile(file, data.bytes);
                        results.push({ clientId: image.clientId, attachment: { path: file, name: path.basename(file) } });
                    } catch { results.push({ clientId: image.clientId }); }
                }
                this.post({ type: 'composer/clipboardImagesResult', results }); return;
            }
            case 'taskFlow/open': {
                const action = await vscode.window.showQuickPick(['开始 / Start', '继续 / Continue', '清除 / Clear'], { title: this.data.title });
                if (action?.startsWith('清除')) { this.flowPaused = true; this.continuation.cancel(); this.service.clear(); }
                else if (action?.startsWith('继续')) { this.flowPaused = false; await this.send(this.service.buildContinuePrompt(), undefined, true); }
                else if (action) this.post({ type: 'composer/fill', text: '@llsccai-task ', focus: true }); return;
            }
            case 'taskFlow/retryCreate': await this.send(this.service.retryWorkflowCreation()); return;
            case 'user/resend': {
                const original = this.data.messages.find(item => item.id === m.id && item.role === 'user');
                if (!original) throw new Error('Message not found');
                if (!await vscode.window.showWarningMessage('Resend may repeat file or command side effects. Continue?', { modal: true }, 'Resend')) return;
                await this.send(String(m.text ?? original.text ?? '')); return;
            }
            case 'log': return;
            default: return;
        }
        await this.persist(); await this.pushSettings();
        if (!this.busy) await this.ensureCli();
    }
    /** Drain admitted operations before stopping an active process; never replay interrupted prompts. */
    public async prepareCliUpdate(): Promise<boolean> {
        await this.settingsQueue;
        await this.starting?.catch(() => {});
        if (this.closed || !this.cli?.isRunning()) return false;
        this.wakeupQueue.length = 0;
        await this.cancel(); return true;
    }
    /** Resume the same saved CLI session using the newly verified executable. */
    public async applyCliUpdate(cliPath: string): Promise<void> {
        if (this.closed) return;
        this.overrideCliPath = cliPath; await this.ensureCli(true); await this.ready();
    }
    /** Close is idempotent and immediate admission stop; await process shutdown before unlocking history. */
    public close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true; clearInterval(this.checkpoint); this.recovery.dispose(); this.flowPaused = true; this.continuation.disposeAll(); this.wakeups.dispose(); this.wakeupQueue.length = 0;
        for (const requestId of this.permissions.keys()) this.adapter?.respondToToolPermission(requestId, { behavior: 'deny', message: 'Editor conversation closed', interrupt: true });
        if (this.continuationTimer) clearTimeout(this.continuationTimer);
        this.relay.abort();
        this.closePromise = (async () => {
            await this.starting?.catch(() => {}); await this.stopProcess(); await this.settingsQueue; await this.events;
            this.data.lastRunState = this.busy || this.background.size ? 'interrupted' : 'closed';
            if (this.assistant) this.assistant.pending = false;
            await this.service.flush(); this.service.dispose();
            await this.persist(); await this.wakeupStore.saveAll([]); this.relay.dispose(); await this.store.release();
        })(); return this.closePromise;
    }
}
