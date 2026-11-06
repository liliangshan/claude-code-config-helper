/** @file Real CLI round-trip acceptance for request-scoped response IDs, repeated provider IDs and tool results. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import type { UsageReport } from '../usageReporter';
import { requestUsageMessageId } from '../responseIdentity';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

/** Listen only on an ephemeral loopback port; no real provider endpoint is used. */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** Both ordinary responses and a Read tool round trip retain identities in real CLI output/history. */
for (const protocol of ['anthropic', 'chat', 'responses'] as const) test(`real CLI ${protocol}: repeated provider response IDs preserve usage across a tool turn`, { skip: !process.env.CCAI_NATIVE_TEST_CLI, timeout: 30000 }, async () => {
    const { createRelayRouter } = await import('../router');
    const { AnthropicProxyAdapter } = await import('../anthropicProxy');
    const { OpenAIChatProxyAdapter } = await import('../openaiChatProxy');
    const { OpenAIResponsesProxyAdapter } = await import('../openaiResponsesProxy');
    const { requestUsageRegistry } = await import('../../chatRuntime/requestUsage');
    const { StreamJsonCliAdapter } = await import('../../chat/cli/cliAdapter');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-cli-')));
    const file = path.join(root, 'probe.txt'); await fs.writeFile(file, 'USAGE_READ_OK');
    let requests = 0; const captured: any[] = [], reports: UsageReport[] = [];
    const upstream = http.createServer((req, res) => {
        let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
            const body = JSON.parse(raw); captured.push(body); requests++;
            const tool = requests === 1, text = 'USAGE_CLI_DONE';
            const args = JSON.stringify({ file_path: file });
            res.setHeader('content-type', 'text/event-stream');
            const send = (value: any) => res.write(`${value.type ? `event: ${value.type}\n` : ''}data: ${JSON.stringify(value)}\n\n`);
            if (protocol === 'anthropic') {
                send({ type: 'message_start', message: { id: 'provider-repeated', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: requests * 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
                send({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'original-call', name: 'Read', input: {} } : { type: 'text', text: '' } });
                send({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: args } : { type: 'text_delta', text } });
                send({ type: 'content_block_stop', index: 0 });
                send({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }); send({ type: 'message_stop' });
            } else if (protocol === 'chat') {
                send({ id: 'provider-repeated', model: 'fixture', choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'original-call', type: 'function', function: { name: 'Read', arguments: args } }] } : { content: text }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: requests * 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } });
                res.write('data: [DONE]\n\n');
            } else {
                const item = tool ? { type: 'function_call', id: 'fc', call_id: 'original-call', name: 'Read', arguments: args }
                    : { type: 'message', id: 'output', role: 'assistant', content: [{ type: 'output_text', text }] };
                send({ type: 'response.created', response: { id: 'provider-repeated', model: 'fixture' } });
                if (tool) send({ type: 'response.output_item.done', output_index: 0, item });
                else send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text });
                send({ type: 'response.completed', response: { id: 'provider-repeated', model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: requests * 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } });
            }
            res.end();
        });
    });
    const port = await listen(upstream), Adapter = protocol === 'anthropic' ? AnthropicProxyAdapter : protocol === 'chat' ? OpenAIChatProxyAdapter : OpenAIResponsesProxyAdapter;
    const adapter = new Adapter(undefined, undefined, report => reports.push(report));
    const provider = { id: 'p', apiType: adapter.apiType, baseUrl: `http://127.0.0.1:${port}`, authMode: 'none', enabled: true, models: [] };
    const router = createRelayRouter({ configManager: { getProviderWithSecret: async () => provider } as any, adapters: [adapter] });
    const relay = http.createServer((req, res) => { void Promise.resolve(router(req, res)).catch(error => res.destroy(error)); });
    const relayPort = await listen(relay);
    const child = spawn(process.env.CCAI_NATIVE_TEST_CLI!, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', 'p/fixture', '--allowedTools', 'Read', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''], {
        cwd: root, stdio: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'config'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayPort}`, ANTHROPIC_API_KEY: 'local-fixture', ANTHROPIC_AUTH_TOKEN: 'local-fixture', CLAUDE_CODE_SKIP_AUTH_LOGIN: '1', CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTO_COMPACT: '1' }
    });
    const parser = new StreamJsonCliAdapter({ onChunk: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), getCwd: () => root } as any);
    const segments: import('../../chat/protocol').ChatSegment[] = [], records: any[] = [];
    let buffer = '', stderr = '', session = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
        buffer += chunk; let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
                const record = JSON.parse(line); records.push(record);
                if (record.type === 'system' && record.subtype === 'init') session = record.session_id;
                for (const event of parser.parseOutput({ source: 'stdout', text: line + '\n', receivedAt: Date.now() })) if (event.type === 'segments') {
                    for (const segment of event.segments) { requestUsageRegistry.bindSegment(session, segment); segments.push(JSON.parse(JSON.stringify(segment))); }
                }
                if (record.type === 'result') child.stdin.end();
            } catch { /* Non-JSON diagnostics are not parsed as response identities. */ }
        }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
        const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read probe.txt once, then reply USAGE_CLI_DONE.' } }) + '\n');
        assert.equal(await exited, 0, stderr); assert.equal(requests, 2); assert.equal(reports.length, 2);
        assert.ok(JSON.stringify(captured[1]).includes('USAGE_READ_OK')); assert.ok(JSON.stringify(captured[1]).includes('original-call'));
        assert.ok(records.some(record => record.type === 'result' && !record.is_error));
        const ids = reports.map(report => requestUsageMessageId(report.context!)); assert.notEqual(ids[0], ids[1]);
        for (let index = 0; index < 2; index++) {
            const owned = segments.filter(segment => segment.responseMessageId === ids[index]); assert.ok(owned.length, `CLI output missing request ${index}`);
            for (const segment of owned) { requestUsageRegistry.bindSegment(session, segment); assert.equal(segment.requestUsage?.inputTokens, (index + 1) * 10); }
        }
        const historyRoot = path.join(root, 'config', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
        const history = await fs.readFile(path.join(historyRoot, `${session}.jsonl`), 'utf8');
        assert.ok(history.includes(ids[0])); assert.ok(history.includes(ids[1]));
    } finally {
        clearTimeout(timer); child.kill('SIGKILL'); parser.dispose(); requestUsageRegistry.clearRequestUsageBindings();
        for (const server of [relay, upstream]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        await fs.rm(root, { recursive: true, force: true });
    }
});
