/** @file Production relay WebSearch integration against loopback fixtures, with optional real CLI acceptance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { OpenAIResponsesProxyAdapter } = require('../openaiResponsesProxy') as typeof import('../openaiResponsesProxy');
const { OpenAIChatProxyAdapter } = require('../openaiChatProxy') as typeof import('../openaiChatProxy');

/** Bind an isolated loopback port without contacting an external service. */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** Release test sockets and listeners even after assertion failures. */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Emit real-shaped Responses native search source and citation events, not fake function calls. */
function searchResponse(res: http.ServerResponse, stream: boolean): void {
    const item = { id: 'ws_local', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'TypeScript documentation', sources: [{ type: 'url', url: 'https://www.typescriptlang.org/docs/' }] } };
    const message = { id: 'msg_local', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Official TypeScript documentation.', annotations: [{ type: 'url_citation', title: 'TypeScript documentation', url: 'https://www.typescriptlang.org/docs/' }] }] };
    const response = { id: 'r_search', status: 'completed', model: 'm', output: [item, message], usage: { input_tokens: 20, output_tokens: 10 } };
    if (!stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send('response.created', { response: { id: 'r_search', model: 'm' } });
    send('response.output_item.added', { output_index: 0, item: { id: item.id, type: item.type, status: 'in_progress' } });
    send('response.web_search_call.searching', { output_index: 0, item_id: item.id });
    send('response.output_item.done', { output_index: 0, item });
    send('response.output_text.delta', { output_index: 1, content_index: 0, delta: message.content[0].text });
    send('response.completed', { response }); res.end();
}

for (const scenario of ['stream', 'json', 'ignored-search', 'ignored-json', 'blocked-domain'] as const) {
    test(`production native WebSearch: ${scenario}`, { timeout: 10000 }, async () => {
        let requests = 0, workflowEffects = 0;
        const upstream = http.createServer((req, res) => {
            let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
                requests++;
                const body = JSON.parse(raw);
                if (Object.prototype.hasOwnProperty.call(body, 'max_tool_calls')) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end('{"error":{"message":"Unsupported parameter: max_tool_calls"}}'); return;
                }
                assert.equal(body.tools[0].type, 'web_search'); assert.equal(body.tools[0].parameters, undefined);
                assert.deepEqual(body.tool_choice, { type: 'web_search' });
                assert.ok(body.include.includes('web_search_call.action.sources'));
                if (scenario === 'ignored-json') {
                    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'completed', output: [] }));
                } else if (scenario === 'ignored-search') {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.end('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
                } else searchResponse(res, body.stream === true);
            });
        });
        const deps = { llsTaskService: { hasActiveWorkflow: () => { workflowEffects++; return true; } }, autoContinueScheduler: { schedule: () => { workflowEffects++; } }, configManager: {} } as any;
        const port = await listen(upstream), adapter = new OpenAIResponsesProxyAdapter(undefined, deps);
        const body = { model: 'm', stream: scenario !== 'json', max_tokens: 1000, messages: [{ role: 'user', content: 'Search TypeScript docs' }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8, ...(scenario === 'blocked-domain' ? { blocked_domains: ['example.com'] } : {}) }], tool_choice: { type: 'tool', name: 'web_search' } };
        const relay = http.createServer((req, res) => {
            req.resume();
            void adapter.handle({ req, res, provider: { id: 'p', baseUrl: `http://127.0.0.1:${port}`, apiType: adapter.apiType, authMode: 'none', models: [] } as any, modelId: 'm', parsedBody: body, rawBody: JSON.stringify(body) }).catch(error => res.destroy(error));
        });
        try {
            const response = await fetch(`http://127.0.0.1:${await listen(relay)}/v1/messages`, { method: 'POST', body: '{}' });
            const wire = await response.text();
            assert.equal(workflowEffects, 0, 'Native search must not inject or continue a workflow');
            if (scenario === 'blocked-domain') {
                assert.equal(response.status, 400); assert.equal(requests, 0); assert.ok(JSON.parse(wire).error.message.includes('blocked_domains'));
            } else if (scenario === 'ignored-json') {
                assert.equal(response.status, 502); assert.ok(JSON.parse(wire).error.message.includes('no native web-search result'));
            } else if (scenario === 'ignored-search') {
                assert.ok(wire.includes('Native web search did not return')); assert.equal(wire.includes('message_stop'), false);
            } else {
                assert.equal(response.status, 200); assert.equal(requests, 1);
                assert.ok(wire.includes('web_search_tool_result')); assert.ok(wire.includes('https://www.typescriptlang.org/docs/')); assert.ok(wire.includes('TypeScript documentation'));
            }
        } finally { await close(relay); await close(upstream); }
    });
}


/** Emit gateway Chat search responses with either structured citations or only provider answer text. */
function chatSearchResponse(res: http.ServerResponse, stream: boolean, structured: boolean): void {
    const content = 'Official [TypeScript documentation](https://www.typescriptlang.org/docs/).';
    const annotations = [{ type: 'url_citation', url_citation: { url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript documentation' } }];
    if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chat_search', choices: [{ message: { content, ...(structured ? { annotations } : {}) }, finish_reason: 'stop' }] })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'chat_search', choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    if (structured) res.write(`data: ${JSON.stringify({ choices: [], annotations })}\n\n`);
    res.end('data: [DONE]\n\n');
}

for (const scenario of ['chat-text-stream', 'chat-sources-stream', 'chat-text-json', 'chat-sources-json', 'chat-empty', 'chat-unsupported', 'chat-blocked'] as const) {
    test(`production Chat native WebSearch: ${scenario}`, { timeout: 10000 }, async () => {
        let requests = 0, effects = 0;
        const upstream = http.createServer((req, res) => {
            let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
                requests++; const body = JSON.parse(raw);
                assert.equal(req.url, '/chat/completions');
                if (Object.prototype.hasOwnProperty.call(body, 'max_tool_calls')) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end('{"error":{"message":"Unsupported parameter: max_tool_calls"}}'); return;
                }
                assert.deepEqual(body.tools[0], { type: 'web_search' }); assert.equal(body.tool_choice, 'required');
                if (scenario === 'chat-unsupported') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"web_search is unsupported"}}'); return; }
                if (scenario === 'chat-empty') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return; }
                chatSearchResponse(res, body.stream === true, scenario.includes('sources'));
            });
        });
        const deps = { llsTaskService: { hasActiveWorkflow: () => { effects++; return true; } }, autoContinueScheduler: { schedule: () => { effects++; } }, configManager: {} } as any;
        const adapter = new OpenAIChatProxyAdapter(undefined, deps);
        const port = await listen(upstream);
        const body = { model: 'm', stream: !scenario.includes('json'), messages: [{ role: 'user', content: 'Perform a web search for the query: TypeScript docs' }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8, ...(scenario === 'chat-blocked' ? { blocked_domains: ['example.com'] } : {}) }], tool_choice: { type: 'tool', name: 'web_search' } };
        const relay = http.createServer((req, res) => {
            req.resume();
            void adapter.handle({ req, res, provider: { id: 'p', baseUrl: `http://127.0.0.1:${port}`, apiType: adapter.apiType, authMode: 'none', models: [] } as any, modelId: 'm', parsedBody: body, rawBody: JSON.stringify(body) }).catch(error => res.destroy(error));
        });
        try {
            const response = await fetch(`http://127.0.0.1:${await listen(relay)}/v1/messages`, { method: 'POST', body: '{}' });
            const wire = await response.text(); assert.equal(effects, 0);
            if (scenario === 'chat-blocked') { assert.equal(response.status, 400); assert.equal(requests, 0); }
            else if (scenario === 'chat-unsupported') { assert.equal(response.status, 400); assert.ok(wire.includes('unsupported')); }
            else if (scenario === 'chat-empty') { assert.ok(wire.includes('neither search sources nor answer')); assert.equal(wire.includes('message_stop'), false); }
            else {
                assert.equal(response.status, 200); assert.equal(requests, 1); assert.ok(wire.includes('https://www.typescriptlang.org/docs/'));
                assert.equal(wire.includes('web_search_tool_result'), scenario.includes('sources'));
                assert.equal(wire.includes('not independently verified'), scenario.includes('text'));
            }
        } finally { await close(relay); await close(upstream); }
    });
}

/** Real CLI executes its built-in WebSearch subrequest through the production adapter and consumes sources or provenance. */
for (const protocol of ['responses', 'chat-text', 'chat-sources'] as const) test(`real CLI WebSearch receives nonempty links from ${protocol}`, { skip: !process.env.CCAI_NATIVE_TEST_CLI, timeout: 40000 }, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ccai-websearch-cli-'));
    const adapter = protocol === 'responses' ? new OpenAIResponsesProxyAdapter() : new OpenAIChatProxyAdapter();
    let searches = 0, ordinary = 0, resultReceived = false;
    let child: ReturnType<typeof spawn> | undefined;
    const received: Array<Record<string, any>> = [];
    const upstream = http.createServer((req, res) => {
        let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
            const body = JSON.parse(raw);
            if (body.tools?.some((tool: any) => tool.type === 'web_search')) {
                searches++;
                assert.equal(Object.prototype.hasOwnProperty.call(body, 'max_tool_calls'), false, 'Neither search protocol should send unsupported call budgets');
                if (protocol === 'responses') searchResponse(res, true);
                else chatSearchResponse(res, true, protocol === 'chat-sources');
                return;
            }
            ordinary++;
            const output = protocol === 'responses' ? body.input?.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.output).join('\n') ?? ''
                : body.messages?.filter((item: any) => item.role === 'tool').map((item: any) => item.content).join('\n') ?? '';
            if (output) {
                assert.ok(output.includes('https://www.typescriptlang.org/docs/'), output);
                assert.ok(output.includes('TypeScript'), output);
                assert.ok(!output.includes('Web search error:'), output);
                if (protocol === 'chat-text') assert.ok(output.includes('not independently verified'), output);
            }
            if (protocol !== 'responses') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const delta = ordinary === 1 ? { tool_calls: [{ index: 0, id: 'call_web', type: 'function', function: { name: 'WebSearch', arguments: JSON.stringify({ query: 'TypeScript official documentation' }) } }] }
                    : { content: 'WEBSEARCH_OK https://www.typescriptlang.org/docs/' };
                res.write(`data: ${JSON.stringify({ id: 'chat_main', choices: [{ delta, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: ordinary === 1 ? 'tool_calls' : 'stop' }] })}\n\n`);
                res.end('data: [DONE]\n\n'); return;
            }
            const item = ordinary === 1 ? { id: 'fc_web', type: 'function_call', call_id: 'call_web', name: 'WebSearch', arguments: JSON.stringify({ query: 'TypeScript official documentation' }) }
                : { id: 'msg_final', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'WEBSEARCH_OK https://www.typescriptlang.org/docs/' }] };
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
            send('response.created', { response: { id: 'r_main', model: 'm' } });
            if (ordinary === 1) send('response.output_item.done', { output_index: 0, item });
            else send('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'WEBSEARCH_OK https://www.typescriptlang.org/docs/' });
            send('response.completed', { response: { id: 'r_main', model: 'm', status: 'completed', output: [item] } }); res.end();
        });
    });
    const upstreamPort = await listen(upstream);
    const relay = http.createServer((req, res) => {
        let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
            let body: any;
            try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
            void adapter.handle({ req, res, provider: { id: 'p', baseUrl: `http://127.0.0.1:${upstreamPort}`, apiType: 'v1-response', authMode: 'none', models: [] } as any, modelId: 'm', parsedBody: body, rawBody: raw }).catch(error => res.destroy(error));
        });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const relayPort = await listen(relay);
        const env = { ...process.env, CLAUDE_CONFIG_DIR: cwd, ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayPort}`, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_AUTH_TOKEN: 'local-fixture-only', CLAUDE_CODE_SKIP_AUTH_LOGIN: '1', CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTO_COMPACT: '1' };
        child = spawn(process.env.CCAI_NATIVE_TEST_CLI!, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', 'p/m', '--permission-mode', 'acceptEdits', '--allowedTools', 'WebSearch', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''], { cwd, env, stdio: 'pipe' });
        let buffer = '', stderr = '';
        child.stderr!.on('data', chunk => stderr += chunk);
        child.stdout!.on('data', chunk => {
            buffer += chunk;
            let index: number;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
                try {
                    const event = JSON.parse(line); received.push(event);
                    if (event.type === 'result') { resultReceived = true; child!.stdin!.end(); }
                } catch { /* Ignore non-JSON CLI diagnostics. */ }
            }
        });
        const exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('exit', () => resolve()); });
        timer = setTimeout(() => child!.kill('SIGKILL'), 25000);
        child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use WebSearch to find the official TypeScript documentation, then return its URL.' } }) + '\n');
        await exited;
        assert.equal(resultReceived, true, stderr); assert.equal(searches, 1); assert.ok(ordinary >= 2);
        const toolResults = received.filter(event => event.type === 'user' && event.tool_use_result);
        const text = JSON.stringify(received);
        assert.ok(text.includes('https://www.typescriptlang.org/docs/'));
        assert.ok(text.includes('WEBSEARCH_OK'));
        const structured = received.map(event => event.tool_use_result).filter(Boolean);
        if (protocol === 'chat-text') assert.ok(structured.some(value => value.searchCount === 0 && JSON.stringify(value.results).includes('not independently verified')), JSON.stringify(toolResults));
        else assert.ok(structured.some(value => value.searchCount === 1 && JSON.stringify(value.results).includes('typescriptlang.org')), JSON.stringify(toolResults));
    } finally {
        if (timer) clearTimeout(timer); child?.kill('SIGKILL');
        await close(relay); await close(upstream); await fs.rm(cwd, { recursive: true, force: true });
    }
});
