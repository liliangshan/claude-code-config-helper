/** @file Model/effort routing isolation against a local synthetic upstream. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: {} });
const { EditorRelay } = require('../relay') as typeof import('../relay');
const { EditorContinuation } = require('../continuation') as typeof import('../continuation');
const { LlsTaskService } = require('../../llsTask/service') as typeof import('../../llsTask/service');

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
