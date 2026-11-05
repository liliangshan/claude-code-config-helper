/** @file Stale native-history image schemas must not hide current GIF fields from any upstream protocol. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { refreshImageRequestSchemas } from '../requestSchemas';
import { imageToolSchemas } from '../tools';
import { convertAnthropicToOpenAIResponses } from '../../relay/converters/anthropicToOpenAIResponses';
import { convertAnthropicToOpenAIChat } from '../../relay/converters/anthropicToOpenAIChat';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

/** Construct the exact old tool shape a resumed CLI can replay, preserving metadata used by deferred loading. */
function request() {
    return { model: 'p/m', messages: [{ role: 'user', content: 'Use the image tool' }], tools: [
        ...imageToolSchemas(false).slice(0, 2).map(schema => ({ name: `mcp__llsccaiImage__${schema.name}`, description: schema.description, input_schema: schema.inputSchema, defer_loading: true, cache_control: { type: 'ephemeral' } })),
        { name: 'mcp__externalImage__openapi_generate_image', description: 'external provider', input_schema: { type: 'object', properties: { external: { type: 'string' } } } }
    ] };
}

/** Update only the owned existing tools, keep all history and unrelated definitions, and handle capability removal. */
test('stale image tool snapshots are refreshed without changing history or adding tools', () => {
    const old = request(), before = JSON.stringify(old);
    const fresh = refreshImageRequestSchemas(old, true) as ReturnType<typeof request>;
    assert.notEqual(fresh, old); assert.equal(JSON.stringify(old), before);
    assert.equal(fresh.messages, old.messages); assert.equal(fresh.tools[2], old.tools[2]);
    for (const tool of fresh.tools.slice(0, 2)) {
        assert.ok('output_format' in tool.input_schema.properties);
        assert.match(tool.description, /MUST submit output_format="gif"/);
        assert.ok('defer_loading' in tool); assert.ok('cache_control' in tool);
        assert.equal(tool.defer_loading, true); assert.deepEqual(tool.cache_control, { type: 'ephemeral' });
    }
    assert.equal(refreshImageRequestSchemas(fresh, true), fresh);
    const disabled = refreshImageRequestSchemas(fresh, false) as typeof fresh;
    assert.equal('output_format' in disabled.tools[0].input_schema.properties, false);
    assert.equal(refreshImageRequestSchemas(old, undefined), old);
    const noTools = { messages: old.messages }; assert.equal(refreshImageRequestSchemas(noTools, true), noTools);
    const none = { tools: [old.tools[2]] }; assert.equal(refreshImageRequestSchemas(none, true), none);
});

/** Both OpenAI conversions preserve the updated description and exact public animation fields. */
test('refreshed GIF schemas reach Responses and Chat upstreams', () => {
    const fresh = refreshImageRequestSchemas(request(), true);
    const responses = convertAnthropicToOpenAIResponses(fresh as any).body;
    const chat = convertAnthropicToOpenAIChat(fresh as any).body;
    for (const tools of [responses.tools, chat.tools?.map(tool => tool.function)]) {
        for (const tool of tools!.filter(tool => tool?.name?.startsWith('mcp__llsccaiImage__'))) {
            assert.ok(tool && 'parameters' in tool && 'description' in tool);
            const params = tool.parameters as any;
            assert.deepEqual(params.properties.output_format.enum, ['gif']);
            assert.equal(params.properties.frame_count.default, 9);
            assert.equal(params.properties.frame_duration_ms.default, 200);
            assert.match(tool!.description!, /animated GIF/);
        }
    }
});

/** Both production relay paths must apply synchronization before handing bodies to protocol adapters. */
test('main and independent relays synchronize schemas before upstream dispatch', async t => {
    installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
    const entry = await import('../entry');
    t.mock.method(entry, 'refreshImageToolsForRequest', async (body: unknown) => refreshImageRequestSchemas(body, true));
    const { createRelayRouter } = await import('../../relay/router');
    const { EditorRelay } = await import('../../editorChat/relay');
    const { AnthropicProxyAdapter } = await import('../../relay/anthropicProxy');
    const received: any[] = [];
    const adapter = { apiType: 'anthropic' as const, handle: async (ctx: any) => { received.push(ctx.parsedBody); assert.deepEqual(JSON.parse(ctx.rawBody), ctx.parsedBody); ctx.res.end('{}'); } };
    t.mock.method(AnthropicProxyAdapter.prototype, 'handle', adapter.handle);
    const manager = { getProviderWithSecret: async () => ({ id: 'p', enabled: true, apiType: 'anthropic', baseUrl: 'https://unused.example', models: [] }), getProviderModel: () => ({}), isModelEnabled: () => true } as any;
    const router = createRelayRouter({ configManager: manager, adapters: [adapter] });
    const main = http.createServer((req, res) => { void router(req, res); });
    const editor = new EditorRelay(manager, { hasActiveWorkflow: () => false } as any, { notifyRequestStarted() {} } as any, () => {});
    try {
        await new Promise<void>(resolve => main.listen(0, '127.0.0.1', resolve)); await editor.start();
        editor.configure({ normalModel: 'p/m', compactionModel: '', reasoningEffort: 'auto' } as any); editor.active = true;
        const port = (main.address() as import('node:net').AddressInfo).port;
        for (const url of [`http://127.0.0.1:${port}`, editor.url]) {
            const response = await fetch(url + '/v1/messages', { method: 'POST', body: JSON.stringify(request()) });
            assert.equal(response.status, 200); await response.text();
        }
        assert.equal(received.length, 2);
        for (const body of received) assert.ok(body.tools[0].input_schema.properties.frame_count);
    } finally { editor.dispose(); main.closeAllConnections(); await new Promise<void>(resolve => main.close(() => resolve())); }
});
