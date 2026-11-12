/** @file Model/effort routing isolation against a local synthetic upstream. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: {} });
const { EditorRelay } = require('../relay') as typeof import('../relay');
const { EditorContinuation } = require('../continuation') as typeof import('../continuation');
const { LlsTaskService } = require('../../llsTask/service') as typeof import('../../llsTask/service');

/** Local lifecycle errors remain explicit and cannot be used to reach another or revoked CLI capability. */
test('independent relay denies wrong paths, old tokens and stopped generations with nonempty errors', async () => {
    let providers = 0;
    const manager = { getProviderWithSecret: async () => { providers++; throw new Error('Must not reach provider'); } } as any;
    const service = new LlsTaskService(manager);
    const relay = new EditorRelay(manager, service, new EditorContinuation(service), () => {});
    const settings = { normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto' as const,
        permissionMode: 'acceptEdits' as const, subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' as const };
    let tools = 0;
    relay.toolHandler = async () => { tools++; return { content: [] }; };
    /** Assert a structured rejection without publishing private URLs or silently accepting a request. */
    async function rejected(url: string, code: string, method = 'POST'): Promise<void> {
        const response = await fetch(url, { method, headers: { connection: 'close' }, ...(method === 'POST' ? { body: '{}' } : {}) });
        const body = await response.text();
        assert.equal(response.status, 403); assert.equal(response.headers.get('x-should-retry'), 'false');
        assert.equal(JSON.parse(body).error.code, code); assert.match(body, /not an account-login endpoint/);
        assert.equal(body.includes(new URL(relay.url).pathname.slice(1)), false);
    }
    try {
        await relay.start(); relay.configure(settings);
        await rejected(`${relay.url}/v1/messages`, 'EDITOR_RELAY_INACTIVE');
        relay.active = true;
        await rejected(`${new URL(relay.url).origin}/${randomUUID()}/v1/messages`, 'EDITOR_RELAY_REJECTED');
        await rejected(`${relay.url}/login`, 'EDITOR_RELAY_REJECTED');
        await rejected(`${relay.url}/v1/messages`, 'EDITOR_RELAY_REJECTED', 'GET');
        const previous = relay.url; relay.configure(settings);
        await rejected(`${previous}/v1/messages`, 'EDITOR_RELAY_REJECTED');
        relay.abort();
        await rejected(`${relay.url}/v1/messages`, 'EDITOR_RELAY_INACTIVE');
        await rejected(`${relay.url}/tools`, 'EDITOR_RELAY_INACTIVE');
        assert.equal(providers, 0); assert.equal(tools, 0);
    } finally { relay.dispose(); service.dispose(); }
});

/** Capability rotation during body streaming must not let the old request enter the new generation. */
test('independent relay rechecks generation after asynchronous request-body reads', async () => {
    const manager = {} as any, service = new LlsTaskService(manager);
    const relay = new EditorRelay(manager, service, new EditorContinuation(service), () => {});
    const settings = { normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto' as const,
        permissionMode: 'acceptEdits' as const, subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' as const };
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    try {
        await relay.start(); relay.configure(settings); relay.active = true;
        (relay as any).server.once('request', entered);
        let request!: http.ClientRequest;
        const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
            request = http.request(`${relay.url}/v1/messages`, { method: 'POST' }, incoming => {
                let body = ''; incoming.on('data', chunk => { body += chunk; });
                incoming.on('end', () => resolve({ status: incoming.statusCode, body })); incoming.on('error', reject);
            });
            request.on('error', reject); request.write('{');
        });
        await reading; relay.configure(settings); request.end('}');
        const result = await response;
        assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).error.code, 'EDITOR_RELAY_REVOKED');
        assert.equal(relay.inFlight, 0);
    } finally { relay.dispose(); service.dispose(); }
});

test('parallel editor relays freeze separate settings and closing A leaves B available', async () => {
    const requests: any[] = [];
    const upstream = http.createServer((req, res) => {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            const value = JSON.parse(body); requests.push(value);
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'same', type: 'message', role: 'assistant', model: value.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
        });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as import('node:net').AddressInfo).port;
    const manager = { getProviderWithSecret: async () => ({ id: 'p', enabled: true, apiType: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'synthetic', models: [] }),
        getProviderModel: () => ({}), isModelEnabled: () => true, getGlobalSystemPrompt: () => '', getWorkspaceSystemPrompt: () => '', getResolvedUiLanguage: () => 'en' } as unknown as import('../../configManager').ConfigManager;
    const services = [new LlsTaskService(manager), new LlsTaskService(manager)];
    const relays = services.map(service => new EditorRelay(manager, service, new EditorContinuation(service), () => {}));
    try {
        await Promise.all(relays.map(relay => relay.start()));
        relays.forEach((relay, i) => { relay.configure({ normalModel: `p/model-${i}`, taskFlowModel: '', compactionModel: 'p/compact', reasoningEffort: i ? 'low' : 'high', permissionMode: 'acceptEdits', subagentsEnabled: !!i, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' }); relay.active = true; relay.sessionId = `session-${i}`; });
        const send = (relay: InstanceType<typeof EditorRelay>, text: string) => fetch(`${relay.url}/v1/messages?beta=true`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: text }], tools: [{ name: 'Agent', input_schema: { type: 'object' } }], model: 'wrong', max_tokens: 20 }) });
        await Promise.all(relays.map(async relay => { const response = await send(relay, 'hello'); assert.equal(response.status, 200); await response.text(); }));
        assert.equal(requests.find(r => r.model === 'model-0').output_config.effort, 'high');
        assert.equal(requests.find(r => r.model === 'model-1').output_config.effort, 'low');
        assert.equal(requests.find(r => r.model === 'model-0').tools.length, 0);
        relays[0].dispose(); const b = await send(relays[1], '/compact'); assert.equal(b.status, 200); await b.text();
        assert.equal(requests[requests.length - 1].model, 'compact');
    } finally { relays.forEach(relay => relay.dispose()); services.forEach(service => service.dispose()); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
