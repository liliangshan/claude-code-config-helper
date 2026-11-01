/** @file Dedicated summary failures return once and never inherit retry semantics from ordinary chat. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { createRequestUsageContext } from '../requestUsage';
import { RequestOutcomeReporter, type RelayRequestOutcome } from '../requestOutcome';
import { CompactionFailureGuard, forwardDedicatedCompaction, writeCompactionFailure } from '../compactionFailure';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} }, inspect: { claudeCodeConfigHelper: {} } });
const { createRelayRouter } = require('../router') as typeof import('../router');
const { EditorRelay } = require('../../editorChat/relay') as typeof import('../../editorChat/relay');
const { EditorContinuation } = require('../../editorChat/continuation') as typeof import('../../editorChat/continuation');
const { LlsTaskService } = require('../../llsTask/service') as typeof import('../../llsTask/service');

/** Bind only loopback synthetic services; no billable requests or credentials are used. */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as import('node:net').AddressInfo).port;
}
/** Release local test connections regardless of a failed assertion. */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

const constructors = [
    () => new (require('../anthropicProxy').AnthropicProxyAdapter)(),
    () => new (require('../openaiChatProxy').OpenAIChatProxyAdapter)(),
    () => new (require('../openaiResponsesProxy').OpenAIResponsesProxyAdapter)()
];

for (const [index, makeAdapter] of constructors.entries()) {
    for (const scenario of ['http429', 'http503', 'inline-json', 'sse-error', 'disconnect', 'truncated', 'empty-summary', 'missing-terminal', 'first-byte-timeout', 'stream-idle-timeout'] as const) {
        test(`dedicated compaction adapter ${index}: ${scenario} returns one non-retryable error`, { timeout: 10000 }, async () => {
            const timeouts = require('../upstreamTimeouts');
            const original = { first: timeouts.UPSTREAM_FIRST_BYTE_TIMEOUT_MS, idle: timeouts.UPSTREAM_STREAM_IDLE_TIMEOUT_MS };
            timeouts.UPSTREAM_FIRST_BYTE_TIMEOUT_MS = 100;
            timeouts.UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 100;
            let requests = 0, automaticContinues = 0; const reports: RelayRequestOutcome[] = [];
            const upstream = http.createServer((req, res) => {
                req.resume(); requests++;
                if (scenario === 'disconnect') { res.destroy(); return; }
                if (scenario === 'http429' || scenario === 'http503') {
                    res.writeHead(scenario === 'http429' ? 429 : 503, { 'content-type': 'application/json', 'retry-after': '300', 'x-should-retry': 'true' });
                    res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'synthetic summary failure' } })); return;
                }
                if (scenario === 'inline-json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { message: 'synthetic inline failure' } })); return; }
                if (scenario === 'first-byte-timeout') return;
                if (scenario === 'empty-summary') {
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify(index === 0 ? { type: 'message', content: [] } : index === 1 ? { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } : { status: 'completed', output: [] })); return;
                }
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                if (scenario === 'stream-idle-timeout') { res.write(': heartbeat\n\n'); return; }
                if (scenario === 'missing-terminal') {
                    res.end(index === 0 ? 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial summary"}}\n\n'
                        : index === 1 ? 'data: {"choices":[{"index":0,"delta":{"content":"Partial summary"},"finish_reason":null}]}\n\n'
                            : 'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Partial summary"}\n\n'); return;
                }
                if (scenario === 'truncated') {
                    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"partial","content":[]}}\n\n');
                    setImmediate(() => res.destroy()); return;
                }
                res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"synthetic stream failure"}}\n\n');
            });
            const port = await listen(upstream), adapter = makeAdapter(); let finished!: () => void;
            const done = new Promise<void>(resolve => { finished = resolve; });
            const relay = http.createServer((req, res) => {
                req.resume();
                const parsedBody = { model: 'summary', max_tokens: 100, stream: scenario.includes('sse') || scenario === 'truncated', messages: [{ role: 'user', content: '/compact' }], metadata: { session_id: 'session' } };
                const outcome = new RequestOutcomeReporter(createRequestUsageContext(parsedBody, 'normal', 'p', 'summary', true, adapter.apiType), report => reports.push(report));
                void forwardDedicatedCompaction(adapter, { req, res, provider: { id: 'p', name: 'synthetic', apiType: adapter.apiType, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-only', enabled: true, authMode: 'api_key', customHeaders: [], models: [] } as any,
                    modelId: 'summary', parsedBody, rawBody: JSON.stringify(parsedBody), compactCommandTriggered: true, outcome, onUpstreamTimeout: () => { automaticContinues++; } })
                    .catch(error => { res.statusCode = 599; res.end(String(error)); }).finally(() => { outcome.end(res.statusCode); finished(); });
            });
            try {
                const response = await fetch(`http://127.0.0.1:${await listen(relay)}/v1/messages`, { method: 'POST', body: '{}' });
                const body = await response.json() as any; await done;
                assert.equal(response.status, 400, JSON.stringify(body)); assert.equal(response.headers.get('x-should-retry'), 'false');
                assert.equal(response.headers.get('retry-after'), null); assert.equal(body.type, 'error'); assert.equal(body.error.code, 'dedicated_compaction_failed');
                assert.equal(requests, 1); assert.equal(reports.length, 1); assert.equal(reports[0].retryable, false);
                assert.equal(reports[0].status, 'error'); assert.equal(automaticContinues, 0);
                if (scenario.startsWith('http')) assert.equal(reports[0].upstreamStatus, scenario === 'http429' ? 429 : 503);
            } finally {
                timeouts.UPSTREAM_FIRST_BYTE_TIMEOUT_MS = original.first;
                timeouts.UPSTREAM_STREAM_IDLE_TIMEOUT_MS = original.idle;
                await close(relay); await close(upstream);
            }
        });
    }
}

for (const [index, makeAdapter] of constructors.entries()) {
    for (const streaming of [false, true]) test(`dedicated compaction adapter ${index}: successful ${streaming ? 'stream' : 'JSON'} summary stays successful`, { timeout: 10000 }, async () => {
        const adapter = makeAdapter(); let requests = 0;
        const upstream = http.createServer((req, res) => {
            req.resume(); requests++;
            if (!streaming) {
                const payload = index === 0 ? { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Valid summary' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }
                    : index === 1 ? { id: 'm', choices: [{ message: { role: 'assistant', content: 'Valid summary' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
                    : { id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Valid summary' }] }], usage: { input_tokens: 5, output_tokens: 2 } };
                res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); return;
            }
            res.setHeader('content-type', 'text/event-stream');
            const event = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
            if (index === 0) {
                event('message_start', { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } });
                event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Valid summary' } });
                event('content_block_stop', { type: 'content_block_stop', index: 0 });
                event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
                event('message_stop', { type: 'message_stop' });
            } else if (index === 1) {
                res.write('data: ' + JSON.stringify({ id: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Valid summary' }, finish_reason: null }] }) + '\n\n');
                res.write('data: ' + JSON.stringify({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'); res.write('data: [DONE]\n\n');
            } else {
                event('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Valid summary' });
                event('response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Valid summary' }] }], usage: { input_tokens: 5, output_tokens: 2 } } });
            }
            res.end();
        });
        const port = await listen(upstream); let final!: () => void; const done = new Promise<void>(resolve => { final = resolve; });
        const reports: RelayRequestOutcome[] = [];
        const relay = http.createServer((req, res) => {
            req.resume(); const body = { model: 'summary', max_tokens: 100, stream: streaming, messages: [{ role: 'user', content: '/compact' }] };
            const outcome = new RequestOutcomeReporter(undefined, report => reports.push(report));
            void forwardDedicatedCompaction(adapter, { req, res, provider: { id: 'p', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test', models: [] } as any, modelId: 'summary', rawBody: JSON.stringify(body), parsedBody: body, compactCommandTriggered: true, outcome })
                .finally(() => { outcome.end(res.statusCode); final(); });
        });
        try {
            const response = await fetch(`http://127.0.0.1:${await listen(relay)}/v1/messages`, { method: 'POST', body: '{}' });
            const body = await response.text(); await done;
            assert.equal(response.status, 200, body); assert.ok(body.includes('Valid summary')); assert.equal(requests, 1);
            assert.equal(reports[0].status, 'completed'); assert.equal(reports[0].retryable, undefined);
        } finally { await close(relay); await close(upstream); }
    });
}

test('main and independent routes fail dedicated compaction once while ordinary chat keeps its HTTP retry evidence', { timeout: 10000 }, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-routing-'));
    stub.workspaceFolderFsPath = cwd;
    stub.inspect = { claudeCodeConfigHelper: { 'chat.compactionMode.project.enabled': { workspaceValue: true }, 'chat.compactionMode.project.model': { workspaceValue: 'p/summary' } } };
    const models: string[] = [], reports: RelayRequestOutcome[] = [];
    const upstream = http.createServer((req, res) => {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            models.push(JSON.parse(body).model); res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '300' });
            res.end('{"type":"error","error":{"type":"overloaded_error","message":"synthetic overload"}}');
        });
    });
    const port = await listen(upstream);
    const provider = { id: 'p', name: 'local', baseUrl: `http://127.0.0.1:${port}`, apiType: 'anthropic', apiKey: 'test', authMode: 'api_key', enabled: true, customHeaders: [], models: [{ modelId: 'main' }, { modelId: 'summary' }] };
    const manager = { getCurrentModel: () => ({ providerId: 'p', modelId: 'main' }), getProviderWithSecret: async () => provider,
        getProviderModel: (_p: string, id: string) => provider.models.find(item => item.modelId === id), isModelEnabled: () => true,
        getGlobalSystemPrompt: () => '', getWorkspaceSystemPrompt: () => '' } as any;
    const router = createRelayRouter({ configManager: manager, adapters: [constructors[0]()], onUpstreamRequestOutcome: report => reports.push(report) });
    const main = http.createServer((req, res) => { void Promise.resolve(router(req, res)); });
    const service = new LlsTaskService(manager); const independent = new EditorRelay(manager, service, new EditorContinuation(service), () => {});
    try {
        await independent.start(); independent.active = true; independent.sessionId = 'independent';
        independent.configure({ normalModel: 'p/main', taskFlowModel: '', compactionModel: 'p/summary', reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' });
        independent.onOutcome = report => reports.push(report);
        const mainUrl = `http://127.0.0.1:${await listen(main)}/v1/messages`;
        for (const url of [mainUrl, `${independent.url}/v1/messages`]) {
            const send = (text: string) => fetch(url, { method: 'POST', body: JSON.stringify({ model: 'p/main', max_tokens: 100, stream: false, messages: [{ role: 'user', content: text }], metadata: { session_id: 'main-session' } }) });
            const failed = await send('/compact'); assert.equal(failed.status, 400); assert.equal(failed.headers.get('x-should-retry'), 'false'); await failed.text();
            const repeated = await send('/compact'); assert.equal(repeated.status, 400); assert.equal(repeated.headers.get('x-should-retry'), 'false'); await repeated.text();
            const ordinary = await send('hello'); assert.equal(ordinary.status, 503); await ordinary.text();
        }
        assert.deepEqual(models, ['summary', 'main', 'summary', 'main']);
        assert.equal(reports.filter(report => report.retryable === false).length, 4);
        assert.equal(reports.filter(report => !report.context?.compactCommandTriggered && report.upstreamStatus === 503).length, 2);
    } finally {
        independent.dispose(); service.dispose(); await close(main); await close(upstream);
        await new Promise<void>(resolve => setImmediate(resolve)); await fs.rm(cwd, { recursive: true, force: true });
        stub.inspect = { claudeCodeConfigHelper: {} }; stub.workspaceFolderFsPath = undefined;
    }
});

/** Invalid dedicated settings fail before transport and still release the owning recovery/compaction lifecycle. */
test('main and independent compaction configuration failures publish one non-retryable outcome', { timeout: 10000 }, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-preflight-'));
    stub.workspaceFolderFsPath = cwd;
    let scenario = '', forwarded = 0;
    const reports: RelayRequestOutcome[] = [], started: string[] = [], ended: string[] = [];
    const manager = {
        getCurrentModel: () => ({ providerId: 'p', modelId: 'main' }),
        getProviderWithSecret: async () => {
            if (scenario === 'provider-error') throw new Error('synthetic credential read error');
            if (scenario === 'missing-provider') return undefined;
            return { id: 'p', apiType: scenario === 'unsupported-protocol' ? 'unsupported' : 'anthropic', enabled: scenario !== 'disabled-provider' };
        },
        getProviderModel: () => scenario === 'missing-model' ? undefined : { modelId: 'summary', enabled: scenario !== 'disabled-model' },
        isModelEnabled: (model: { enabled?: boolean } | undefined) => !!model && model.enabled !== false
    } as any;
    const compactionFailures = new CompactionFailureGuard();
    const router = createRelayRouter({ configManager: manager, compactionFailures, adapters: [{ apiType: 'anthropic', handle: async () => { forwarded++; } }],
        onUpstreamRequestStart: info => started.push(info.usageContext!.requestId),
        onUpstreamRequestEnd: info => ended.push(info.usageContext!.requestId),
        onUpstreamRequestOutcome: report => reports.push(report) });
    const main = http.createServer((req, res) => { void Promise.resolve(router(req, res)); });
    const service = new LlsTaskService(manager), independent = new EditorRelay(manager, service, new EditorContinuation(service), () => {});
    independent.onOutcome = report => reports.push(report);
    independent.onRequest = id => started.push(id);
    try {
        await independent.start(); independent.active = true; independent.sessionId = 'independent';
        const mainUrl = `http://127.0.0.1:${await listen(main)}/v1/messages`;
        for (scenario of ['invalid-model', 'provider-error', 'missing-provider', 'disabled-provider', 'missing-model', 'disabled-model', 'unsupported-protocol']) {
            const compactionModel = scenario === 'invalid-model' ? 'invalid' : 'p/summary';
            compactionFailures.reset('main-session'); independent.compactionFailures.reset('independent');
            stub.inspect = { claudeCodeConfigHelper: { 'chat.compactionMode.project.enabled': { workspaceValue: true }, 'chat.compactionMode.project.model': { workspaceValue: compactionModel } } };
            independent.configure({ normalModel: 'p/main', taskFlowModel: '', compactionModel, reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' });
            for (const url of [mainUrl, `${independent.url}/v1/messages`]) {
                const before = reports.length;
                const response = await fetch(url, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '/compact' }], metadata: { session_id: 'main-session' } }) });
                const body = await response.json() as any;
                assert.equal(response.status, 400, scenario); assert.equal(response.headers.get('x-should-retry'), 'false');
                assert.equal(body.error.code, 'dedicated_compaction_failed'); assert.equal(reports.length, before + 1, scenario);
                assert.equal(reports[before].retryable, false); assert.equal(reports[before].context?.compactCommandTriggered, true);
                assert.equal(reports[before].context?.sessionId, url === mainUrl ? 'main-session' : 'independent');
                assert.equal(reports[before].status, 'error');
            }
        }
        assert.equal(forwarded, 0); assert.equal(started.length, reports.length); assert.equal(ended.length, reports.length / 2);
    } finally {
        independent.dispose(); service.dispose(); await close(main);
        stub.inspect = { claudeCodeConfigHelper: {} }; stub.workspaceFolderFsPath = undefined;
        await fs.rm(cwd, { recursive: true, force: true });
    }
});

/** CLI fallback requests may differ in body, but failure stays latched to the owning session until explicit input. */
test('failure guard prevents repeated and concurrent upstream attempts, isolates sessions and resets manually', async () => {
    const guard = new CompactionFailureGuard();
    const response = () => new http.ServerResponse({ method: 'POST', httpVersionMajor: 1, httpVersionMinor: 1 } as http.IncomingMessage);
    let sends = 0, release!: () => void;
    const firstOutcome = new RequestOutcomeReporter(), first = response();
    const run = guard.forward('s', first, firstOutcome, async () => {
        sends++; await new Promise<void>(resolve => { release = resolve; });
        writeCompactionFailure(first, 'synthetic failure', firstOutcome);
    });
    const duplicateOutcome = new RequestOutcomeReporter(), duplicate = response();
    const duplicateRun = guard.forward('s', duplicate, duplicateOutcome, async () => { sends++; });
    release(); await Promise.all([run, duplicateRun]);
    assert.equal(sends, 1); assert.equal(duplicate.statusCode, 400); assert.equal(duplicateOutcome.snapshot().retryable, false);
    const third = new RequestOutcomeReporter();
    await guard.forward('s', response(), third, async () => { sends++; });
    assert.equal(sends, 1); assert.equal(third.snapshot().retryable, false);
    await guard.forward('other-session', response(), new RequestOutcomeReporter(), async () => { sends++; });
    assert.equal(sends, 2);
    guard.reset('s');
    await guard.forward('s', response(), new RequestOutcomeReporter(), async () => { sends++; });
    assert.equal(sends, 3); assert.equal(guard.hasFailed('s'), false);
    const oldOutcome = new RequestOutcomeReporter(), oldResponse = response();
    const pending = guard.forward('s', oldResponse, oldOutcome, async () => {
        await new Promise<void>(resolve => { release = resolve; });
        writeCompactionFailure(oldResponse, 'old turn failed after a new submission', oldOutcome);
    });
    guard.reset('s'); release(); await pending;
    assert.equal(guard.hasFailed('s'), false, 'Old in-flight errors cannot relatch a newly submitted turn');
});
