/** @file Private per-editor relay reusing the existing protocol converters and workflow interception. */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { Logger } from '../logger';
import { AnthropicProxyAdapter } from '../relay/anthropicProxy';
import { OpenAIChatProxyAdapter } from '../relay/openaiChatProxy';
import { OpenAIResponsesProxyAdapter } from '../relay/openaiResponsesProxy';
import { readRequestBody, parseModelField } from '../relay/router';
import { isClaudeCompactCommandRequest } from '../relay/summCommand';
import { CompactionFailureGuard, forwardDedicatedCompaction, writeCompactionFailure } from '../relay/compactionFailure';
import { isLlsCcaiTaskTriggered } from '../llsTask/detector';
import { RequestOutcomeReporter, type RelayRequestOutcome } from '../relay/requestOutcome';
import { RequestUsageRegistry } from '../chatRuntime/requestUsage';
import { createRequestUsageContext } from '../relay/requestUsage';
import type { UsageReport } from '../relay/usageReporter';
import type { LlsTaskService } from '../llsTask/service';
import type { EditorContinuation } from './continuation';
import { readImageRequest } from '../imageTools/transport';
import { refreshImageToolsForRequest } from '../imageTools/entry';
import { readHttpToolRequest } from '../httpTools/transport';
import type { EditorSettings } from './store';

/** One authenticated network listener belongs to one runtime; closing it never affects the sidebar. */
export class EditorRelay {
    public readonly usageRegistry = new RequestUsageRegistry();
    public readonly compactionFailures = new CompactionFailureGuard();
    private server?: http.Server;
    private token = randomUUID();
    private settings?: EditorSettings;
    /** Whether the owning CLI capability is usable; idle UI state must not revoke a live CLI. */
    public active = false;
    public sessionId = '';
    public inFlight = 0;
    public onIdle?: () => void;
    public onRequest?: (id: string) => void;
    public onOutcome?: (outcome: RelayRequestOutcome) => void;
    public toolHandler?: (bridge: string, name: string, args: Record<string, unknown>, requestId?: string, signal?: AbortSignal) => Promise<unknown>;
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
    /**
     * Report a local capability rejection without exposing URL tokens or pretending it is a provider login failure.
     * @param res Response to complete with an Anthropic-shaped, non-retryable permission error.
     * @param code Allowlisted local lifecycle rejection code.
     * @returns Nothing; no provider request or authentication bypass is performed.
     */
    private rejectRequest(res: http.ServerResponse, code: 'EDITOR_RELAY_REJECTED' | 'EDITOR_RELAY_INACTIVE' | 'EDITOR_RELAY_REVOKED'): void {
        if (res.destroyed || res.writableEnded) return;
        Logger.warn(`[editor-relay] rejected code=${code}`);
        res.writeHead(403, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', code,
            message: `Local independent-chat relay rejected this request (${code}); this is not an account-login endpoint.` } }));
    }
    /**
     * Freeze request ownership and preserve normal routing while rejecting missing, stale or stopped capabilities.
     * @param req Owned loopback request with a capability-prefixed route.
     * @param res Downstream response used by that same CLI generation.
     * @returns Completion after dispatch or a local, structured rejection.
     */
    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (req.method !== 'POST' || ![`/${this.token}/v1/messages`, `/${this.token}/tools`, `/${this.token}/tools/image`, `/${this.token}/tools/http`].includes(pathname) || !this.settings) {
            this.rejectRequest(res, 'EDITOR_RELAY_REJECTED'); return;
        }
        if (!this.active) { this.rejectRequest(res, 'EDITOR_RELAY_INACTIVE'); return; }
        const sessionId = this.sessionId;
        const settings = this.settings;
        const generationToken = this.token;
        const usageGeneration = this.usageRegistry.generationToken();
        this.inFlight++;
        try {
            const imageRequest = pathname.endsWith('/tools/image');
            const httpRequest = pathname.endsWith('/tools/http');
            const rawBody = await (imageRequest ? readImageRequest(req) : httpRequest ? readHttpToolRequest(req) : readRequestBody(req));
            let body = JSON.parse(rawBody) as Record<string, unknown>;
            if (generationToken !== this.token || !this.active) { this.rejectRequest(res, 'EDITOR_RELAY_REVOKED'); return; }
            if (pathname.endsWith('/tools') || imageRequest || httpRequest) {
                if (!this.toolHandler) throw new Error('Editor tools unavailable');
                if ((body.bridge === 'llsccaiHttp') !== httpRequest) throw new Error('HTTP_RELAY_REJECTED');
                if ((body.bridge === 'llsccaiImage') !== imageRequest) throw new Error('IMAGE_PERMISSION_DENIED');
                if (body.bridge === 'llsccaiImage' && (Buffer.byteLength(rawBody) > 4 * 1024 * 1024 || typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId))) throw new Error('IMAGE_PAYLOAD_TOO_LARGE');
                if (httpRequest) {
                    const controller = new AbortController();
                    const abort = () => { if (!res.writableEnded) controller.abort(); };
                    res.once('close', abort);
                    try {
                        const result = await this.toolHandler(String(body.bridge), String(body.name), (body.arguments ?? {}) as Record<string, unknown>, undefined, controller.signal);
                        if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
                    } finally { res.off('close', abort); }
                    return;
                }
                const result = await this.toolHandler(String(body.bridge), String(body.name), (body.arguments ?? {}) as Record<string, unknown>, typeof body.requestId === 'string' ? body.requestId : undefined);
                res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
            }
            const triggered = !this.service.hasActiveWorkflow() && isLlsCcaiTaskTriggered(body.messages);
            if (triggered) this.service.markWorkflowCreationPending();
            const compact = isClaudeCompactCommandRequest(body);
            const dedicatedCompaction = compact && !!settings.compactionModel;
            const model = parseModelField({ model: dedicatedCompaction ? settings.compactionModel : settings.normalModel });
            /** Surface configuration failures as terminal outcomes before returning the non-retryable API error. */
            const failCompaction = (reason: string): void => {
                this.compactionFailures.fail(sessionId);
                const usageContext = createRequestUsageContext({ metadata: { session_id: sessionId } }, 'normal', model?.providerId ?? '', model?.modelId ?? '', true);
                const outcome = new RequestOutcomeReporter(usageContext, this.onOutcome);
                this.onRequest?.(usageContext.requestId);
                this.continuation.notifyRequestStarted();
                try { writeCompactionFailure(res, reason, outcome); }
                finally { outcome.end(res.statusCode); }
            };
            if (compact && this.compactionFailures.hasFailed(sessionId)) {
                failCompaction('This compaction already failed; automatic upstream retries are disabled.'); return;
            }
            if (!model) {
                if (dedicatedCompaction) { failCompaction('The configured compaction model is invalid.'); return; }
                throw new Error('Select an editor session model');
            }
            let provider;
            try { provider = await this.manager.getProviderWithSecret(model.providerId); }
            catch (error) {
                if (dedicatedCompaction) { failCompaction('Could not read the compaction provider.'); return; }
                throw error;
            }
            if (!provider || provider.enabled === false || !this.manager.isModelEnabled(this.manager.getProviderModel(model.providerId, model.modelId))) {
                if (dedicatedCompaction) { failCompaction('The configured compaction model is unavailable.'); return; }
                throw new Error('Selected model unavailable');
            }
            body.model = model.modelId;
            body.metadata = { ...(body.metadata as object ?? {}), session_id: sessionId };
            req.headers = { 'content-type': 'application/json' };
            const scopedManager = new Proxy(this.manager, { get: (target, key) => {
                if (key === 'getChatSubagentsEnabled') return () => settings.subagentsEnabled;
                if (key === 'getChatCacheTtl') return () => settings.cacheTtl;
                const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
            } });
            const deps = { configManager: scopedManager, llsTaskService: this.service, autoContinueScheduler: this.continuation };
            const adapters = [new AnthropicProxyAdapter(undefined, deps, this.usage), new OpenAIChatProxyAdapter(undefined, deps, this.usage), new OpenAIResponsesProxyAdapter(undefined, deps, this.usage)];
            const adapter = adapters.find(item => item.apiType === provider.apiType);
            if (!adapter) {
                if (dedicatedCompaction) { failCompaction('The compaction provider protocol is unsupported.'); return; }
                throw new Error('Unsupported provider protocol');
            }
            this.continuation.notifyRequestStarted();
            const usageContext = createRequestUsageContext(body, 'normal', model.providerId, model.modelId, compact, provider.apiType);
            const outcome = new RequestOutcomeReporter(usageContext, this.onOutcome); this.onRequest?.(usageContext.requestId);
            try {
                body = await refreshImageToolsForRequest(body) as Record<string, unknown>;
                const context = { req, res, provider, modelId: model.modelId, rawBody: JSON.stringify(body), parsedBody: body,
                    llsTaskCreateTriggered: triggered, compactCommandTriggered: compact, reasoningEffort: compact || settings.reasoningEffort === 'auto' ? undefined : settings.reasoningEffort,
                    usageContext, usageRegistry: this.usageRegistry, usageGeneration, outcome };
                if (dedicatedCompaction) await this.compactionFailures.forward(sessionId, res, outcome, () => forwardDedicatedCompaction(adapter, context));
                else await adapter.handle(context);
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
