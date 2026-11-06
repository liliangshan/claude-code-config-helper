/** @file Production protocol regressions for reused provider IDs, out-of-order usage and exact CLI identity. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { createRequestUsageContext } from '../requestUsage';
import { RequestUsageRegistry } from '../../chatRuntime/requestUsage';
import { requestUsageMessageId, bindJsonResponseIdentity, ResponseIdentityStream } from '../responseIdentity';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import type { UpstreamAdapter } from '../router';
import type { UsageReport } from '../usageReporter';
import type { ChatSegment } from '../../chat/protocol';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { StreamJsonCliAdapter } = require('../../chat/cli/cliAdapter') as typeof import('../../chat/cli/cliAdapter');

/** Bind a loopback-only fixture without paid providers. */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** Release fixture sockets on assertion failures. */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Produce repeated upstream IDs but distinct request usage for every supported response format. */
function respond(res: http.ServerResponse, protocol: string, stream: boolean, n: number): void {
    const tool = { type: 'tool_use', id: 'reused-call', name: 'lookup', input: { n } };
    const usage = { input_tokens: n, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const text = `reply-${n}`;
    const message = { id: 'reused-message', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }, tool], usage, stop_reason: 'tool_use' };
    const chat = { id: 'reused-message', model: 'm', choices: [{ message: { content: text, tool_calls: [{ id: 'reused-call', type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ n }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: n, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } } };
    const responses = { id: 'reused-message', model: 'm', status: 'completed', output: [{ type: 'message', id: 'output', role: 'assistant', content: [{ type: 'output_text', text }] }, { type: 'function_call', id: 'fc', call_id: 'reused-call', name: 'lookup', arguments: JSON.stringify({ n }) }], usage: { input_tokens: n, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } };
    if (!stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(protocol === 'anthropic' ? message : protocol === 'chat' ? chat : responses)); return; }
    res.setHeader('content-type', 'text/event-stream');
    const send = (value: any) => res.write(`${value.type ? `event: ${value.type}\n` : ''}data: ${JSON.stringify(value)}\n\n`);
    if (protocol === 'anthropic') {
        send({ type: 'message_start', message: { ...message, content: [] } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }); send({ type: 'content_block_stop', index: 0 });
        send({ type: 'content_block_start', index: 1, content_block: { ...tool, input: {} } });
        send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ n }) } }); send({ type: 'content_block_stop', index: 1 });
        send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage }); send({ type: 'message_stop' });
    } else if (protocol === 'chat') {
        send({ id: chat.id, model: 'm', choices: [{ delta: { ...chat.choices[0].message, tool_calls: chat.choices[0].message.tool_calls.map((call, index) => ({ ...call, index })) }, finish_reason: 'tool_calls' }], usage: chat.usage });
        res.write('data: [DONE]\n\n');
    } else {
        send({ type: 'response.created', response: { id: responses.id, model: 'm' } });
        send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text });
        send({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc', call_id: 'reused-call', name: 'lookup', arguments: '' } });
        send({ type: 'response.function_call_arguments.delta', output_index: 1, delta: JSON.stringify({ n }) });
        send({ type: 'response.function_call_arguments.done', output_index: 1, arguments: JSON.stringify({ n }) });
        send({ type: 'response.completed', response: responses });
    }
    res.end();
}

for (const protocol of ['anthropic', 'chat', 'responses']) for (const stream of [false, true]) {
    test(`${protocol} stream=${stream}: reused IDs remain request-scoped and tool IDs stay unchanged`, async () => {
        let hits = 0;
        const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => respond(res, protocol, stream, ++hits * 10)); });
        const port = await listen(upstream);
        const registry = new RequestUsageRegistry(), reports: UsageReport[] = [], contexts: ReturnType<typeof createRequestUsageContext>[] = [];
        const adapters = await Promise.all([import('../anthropicProxy'), import('../openaiChatProxy'), import('../openaiResponsesProxy')]);
        const Adapter = protocol === 'anthropic' ? adapters[0].AnthropicProxyAdapter : protocol === 'chat' ? adapters[1].OpenAIChatProxyAdapter : adapters[2].OpenAIResponsesProxyAdapter;
        const adapter: UpstreamAdapter = new Adapter(undefined, undefined, report => reports.push(report));
        const relay = http.createServer((req, res) => {
            req.resume();
            const body = { model: 'm', stream, messages: [] };
            const context = createRequestUsageContext({ metadata: { session_id: 'session' } }, 'normal', 'p', 'm', false, adapter.apiType); contexts.push(context);
            void adapter.handle({ req, res, provider: { id: 'p', apiType: adapter.apiType, baseUrl: `http://127.0.0.1:${port}`, authMode: 'none', models: [] } as any, modelId: 'm', parsedBody: body, rawBody: JSON.stringify(body), usageContext: context, usageRegistry: registry }).catch(error => res.destroy(error));
        });
        const cli = new StreamJsonCliAdapter({ onChunk: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), getCwd: () => '/tmp' } as any);
        const all: ChatSegment[][] = [];
        try {
            const relayPort = await listen(relay);
            for (let n = 1; n <= 2; n++) {
                const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, { method: 'POST', body: '{}' });
                assert.equal(response.status, 200); const body = await response.text();
                const records = stream ? body.split('\n\n').flatMap(frame => {
                    const line = frame.split('\n').find(row => row.startsWith('data:')); return line ? [{ type: 'stream_event', event: JSON.parse(line.slice(5)) }] : [];
                }) : [{ type: 'assistant', message: JSON.parse(body) }];
                const segments: ChatSegment[] = [];
                for (const record of records) for (const event of cli.parseOutput({ source: 'stdout', text: JSON.stringify(record) + '\n', receivedAt: Date.now() })) {
                    if (event.type === 'segments') for (const segment of event.segments) { registry.bindSegment('session', segment); segments.push(JSON.parse(JSON.stringify(segment))); }
                }
                assert.ok(segments.some(segment => segment.text?.includes(`reply-${n * 10}`)), 'New response text cannot be hidden by reused provider IDs');
                assert.ok(segments.some(segment => segment.responseCallId === 'reused-call'));
                for (const segment of segments) {
                    assert.equal(segment.responseMessageId, requestUsageMessageId(contexts[n - 1]));
                    assert.equal(segment.requestId, contexts[n - 1].requestId); assert.equal(segment.requestUsage?.inputTokens, n * 10);
                }
                all.push(segments);
            }
            assert.notEqual(all[0][0].responseMessageId, all[1][0].responseMessageId);
            for (const segment of all[0]) { registry.bindSegment('session', segment); assert.equal(segment.requestUsage?.inputTokens, 10); }
            assert.equal(reports.length, 2);
            assert.equal(registry.resolveRequestForSegment('other-session', all[1][0].responseMessageId), undefined);
            assert.equal(registry.resolveRequestForSegment('session', undefined, 'reused-call'), undefined);
        } finally { cli.dispose(); await close(relay); await close(upstream); }
    });
}

for (const protocol of ['anthropic', 'chat', 'responses']) for (const stream of [false, true]) {
    test(`${protocol} stream=${stream}: concurrent repeated IDs survive reverse response completion`, async () => {
        let releaseFirst: (() => void) | undefined;
        const upstream = http.createServer((req, res) => {
            let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
                const body = JSON.parse(raw);
                if (body.model === 'first') releaseFirst = () => { releaseFirst = undefined; respond(res, protocol, stream, 10); };
                else { respond(res, protocol, stream, 20); releaseFirst?.(); }
            });
        });
        const port = await listen(upstream), registry = new RequestUsageRegistry();
        const reports: UsageReport[] = [], contexts = new Map<string, ReturnType<typeof createRequestUsageContext>>();
        const { AnthropicProxyAdapter } = await import('../anthropicProxy');
        const { OpenAIChatProxyAdapter } = await import('../openaiChatProxy');
        const { OpenAIResponsesProxyAdapter } = await import('../openaiResponsesProxy');
        const Adapter = protocol === 'anthropic' ? AnthropicProxyAdapter : protocol === 'chat' ? OpenAIChatProxyAdapter : OpenAIResponsesProxyAdapter;
        const adapter = new Adapter(undefined, undefined, report => reports.push(report));
        const relay = http.createServer((req, res) => {
            req.resume(); const model = req.url === '/first' ? 'first' : 'second';
            const body = { model, stream, messages: [] };
            const context = createRequestUsageContext({ metadata: { session_id: 'same-session' } }, 'normal', 'p', model, false, adapter.apiType);
            contexts.set(model, context);
            void adapter.handle({ req, res, provider: { id: 'p', apiType: adapter.apiType, baseUrl: `http://127.0.0.1:${port}`, authMode: 'none', models: [] } as any,
                modelId: model, parsedBody: body, rawBody: JSON.stringify(body), usageContext: context, usageRegistry: registry }).catch(error => res.destroy(error));
        });
        try {
            const relayPort = await listen(relay);
            const first = fetch(`http://127.0.0.1:${relayPort}/first`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) });
            const deadline = Date.now() + 3000;
            while (!releaseFirst && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            assert.ok(releaseFirst, 'First request reached upstream before the second was dispatched');
            const second = fetch(`http://127.0.0.1:${relayPort}/second`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) });
            for (const [name, pending, tokens] of [['first', first, 10], ['second', second, 20]] as const) {
                const response = await pending, wire = await response.text(); assert.equal(response.status, 200);
                const context = contexts.get(name)!; assert.ok(wire.includes(requestUsageMessageId(context)));
                assert.equal(registry.resolveRequestForSegment('same-session', requestUsageMessageId(context))?.requestId, context.requestId);
                assert.equal(registry.getSummary(context.requestId)?.inputTokens, tokens);
            }
            assert.equal(reports.length, 2);
            assert.equal(registry.resolveRequestForSegment('same-session', undefined, 'reused-call'), undefined);
        } finally { releaseFirst?.(); await close(relay); await close(upstream); }
    });
}

/** Response identity framing is split-safe and must not rewrite tool IDs, signatures, contents or compact responses. */
test('identity forwarding preserves payloads and signature bytes across CRLF fragments and JSON', () => {
    const context = createRequestUsageContext({ metadata: { session_id: 'owned' } }, 'normal', 'p', 'm');
    const message = { id: 'upstream', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'visible', signature: 'opaque-signature' }, { type: 'tool_use', id: 'tool-original', name: 'Read', input: { file_path: '/tmp/字🙂' } }], usage: { input_tokens: 7 } };
    const rewritten = JSON.parse(bindJsonResponseIdentity(JSON.stringify(message), context));
    assert.equal(rewritten.id, requestUsageMessageId(context));
    assert.deepEqual({ ...rewritten, id: message.id }, message);
    const stream = new ResponseIdentityStream(context);
    const start = { type: 'message_start', message };
    const delta = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-signature"}}\r\n\r\n';
    const raw = String.fromCharCode(0xFEFF) + `event: message_start\r\ndata: ${JSON.stringify(start)}\r\n\r\n` + delta;
    let out = ''; for (const char of raw) out += stream.feed(char); out += stream.end();
    assert.ok(out.includes(requestUsageMessageId(context))); assert.ok(out.endsWith(delta)); assert.ok(out.includes('tool-original'));
    const compact = { ...context, compactCommandTriggered: true };
    assert.equal(bindJsonResponseIdentity(JSON.stringify(message), compact), JSON.stringify(message));
    const pass = new ResponseIdentityStream(compact); assert.equal(pass.feed(raw) + pass.end(), raw);
});
