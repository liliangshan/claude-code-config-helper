/** @file Private per-editor relay reusing the existing protocol converters and workflow interception. */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { AnthropicProxyAdapter } from '../relay/anthropicProxy';
import { OpenAIChatProxyAdapter } from '../relay/openaiChatProxy';
import { OpenAIResponsesProxyAdapter } from '../relay/openaiResponsesProxy';
import { readRequestBody, parseModelField } from '../relay/router';
import { isClaudeCompactCommandRequest } from '../relay/summCommand';
import { isLlsCcaiTaskTriggered } from '../llsTask/detector';
import { RequestOutcomeReporter, type RelayRequestOutcome } from '../relay/requestOutcome';
import { RequestUsageRegistry } from '../chatRuntime/requestUsage';
import { createRequestUsageContext } from '../relay/requestUsage';
import type { UsageReport } from '../relay/usageReporter';
import type { LlsTaskService } from '../llsTask/service';
import type { EditorContinuation } from './continuation';
import type { EditorSettings } from './store';

/** One authenticated network listener belongs to one runtime; closing it never affects the sidebar. */
export class EditorRelay {
    public readonly usageRegistry = new RequestUsageRegistry();
    private server?: http.Server;
    private token = randomUUID();
    private settings?: EditorSettings;
    public active = false;
    public sessionId = '';
    public inFlight = 0;
    public onIdle?: () => void;
    public onRequest?: (id: string) => void;
    public onOutcome?: (outcome: RelayRequestOutcome) => void;
    public toolHandler?: (bridge: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
    public url = '';
    /** Inject provider access, isolated workflow state and a session-specific usage sink. */
    public constructor(private readonly manager: ConfigManager, private readonly service: LlsTaskService,
        private readonly continuation: EditorContinuation, private readonly usage: (report: UsageReport) => void) {}
    /** Start loopback listener and route only requests carrying its capability URL. */
    public async start(): Promise<void> {
        this.server = http.createServer((req, res) => { void this.handle(req, res).catch(error => {
            if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
            if (!res.writableEnded) res.end(JSON.stringify({ error: { message: String(error) } }));
        }); });
        await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
        this.url = `http://127.0.0.1:${(this.server.address() as import('node:net').AddressInfo).port}/${this.token}`;
    }
    /** Freeze settings for a CLI generation and revoke the preceding capability. */
    public configure(settings: EditorSettings): string {
        this.settings = { ...settings }; this.token = randomUUID();
        this.url = this.url.substring(0, this.url.lastIndexOf('/') + 1) + this.token;
        return this.url;
    }
    /** Resolve a trusted model snapshot, never the currently focused window's settings. */
    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (req.method !== 'POST' || ![`/${this.token}/v1/messages`, `/${this.token}/tools`].includes(pathname) || !this.settings || !this.active) { res.writeHead(403); res.end(); return; }
        this.inFlight++;
        try {
            const body = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
            if (pathname.endsWith('/tools')) {
                if (!this.toolHandler) throw new Error('Editor tools unavailable');
                const result = await this.toolHandler(String(body.bridge), String(body.name), (body.arguments ?? {}) as Record<string, unknown>);
                res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
            }
            const triggered = !this.service.hasActiveWorkflow() && isLlsCcaiTaskTriggered(body.messages);
            if (triggered) this.service.markWorkflowCreationPending();
            const compact = isClaudeCompactCommandRequest(body);
            const settings = this.settings;
            const model = parseModelField({ model: compact && settings.compactionModel ? settings.compactionModel : settings.normalModel });
            if (!model) throw new Error('Select an editor session model');
            const provider = await this.manager.getProviderWithSecret(model.providerId);
            if (!provider || provider.enabled === false || !this.manager.isModelEnabled(this.manager.getProviderModel(model.providerId, model.modelId))) throw new Error('Selected model unavailable');
            body.model = model.modelId;
            body.metadata = { ...(body.metadata as object ?? {}), session_id: this.sessionId };
            req.headers = { 'content-type': 'application/json' };
            const scopedManager = new Proxy(this.manager, { get: (target, key) => {
                if (key === 'getChatSubagentsEnabled') return () => settings.subagentsEnabled;
                if (key === 'getChatCacheTtl') return () => settings.cacheTtl;
                const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
            } });
            const deps = { configManager: scopedManager, llsTaskService: this.service, autoContinueScheduler: this.continuation };
            const adapters = [new AnthropicProxyAdapter(undefined, deps, this.usage), new OpenAIChatProxyAdapter(undefined, deps, this.usage), new OpenAIResponsesProxyAdapter(undefined, deps, this.usage)];
            const adapter = adapters.find(item => item.apiType === provider.apiType);
            if (!adapter) throw new Error('Unsupported provider protocol');
            this.continuation.notifyRequestStarted();
            const usageContext = createRequestUsageContext(body, 'normal', model.providerId, model.modelId, compact, provider.apiType);
            const outcome = new RequestOutcomeReporter(usageContext, this.onOutcome); this.onRequest?.(usageContext.requestId);
            try {
                await adapter.handle({ req, res, provider, modelId: model.modelId, rawBody: JSON.stringify(body), parsedBody: body,
                    llsTaskCreateTriggered: triggered, compactCommandTriggered: compact, reasoningEffort: compact || settings.reasoningEffort === 'auto' ? undefined : settings.reasoningEffort,
                    usageContext, usageRegistry: this.usageRegistry, outcome });
            } catch (error) { outcome.fail('upstream_connect', (error as NodeJS.ErrnoException).code); throw error; }
            finally { outcome.end(res.statusCode); }
        } finally { this.inFlight--; if (!this.inFlight) this.onIdle?.(); }
    }
    /** Abort only this editor's upstream transports through downstream connection closure. */
    public abort(): void { this.active = false; this.server?.closeAllConnections(); }
    /** Restart this listener, reporting the boundary between confirmed shutdown and the new listen operation. */
    public async restart(beforeStart?: () => Promise<void>): Promise<void> {
        const server = this.server;
        this.abort(); this.server = undefined; this.token = randomUUID();
        if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await beforeStart?.();
        await this.start();
    }
    /** Close all owned sockets and permanently revoke the capability. */
    public dispose(): void { this.abort(); this.server?.close(); this.server = undefined; }
}
