/** @file Opt-in real CLI acceptance using only isolated local synthetic upstreams. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} }, inspect: { claudeCodeConfigHelper: {} } });
const { createRelayRouter } = require('../router') as typeof import('../router');
const { AnthropicProxyAdapter } = require('../anthropicProxy') as typeof import('../anthropicProxy');
const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');
const { buildCliChildEnv, NATIVE_COMPACTION_ENV_KEYS } = require('../../nativeCompactionPolicy') as typeof import('../../nativeCompactionPolicy');
/** Test-process isolation only; production code never mutates the host environment. */
const inherited = Object.fromEntries(NATIVE_COMPACTION_ENV_KEYS.map(key => [key, process.env[key]]));
before(() => { for (const key of NATIVE_COMPACTION_ENV_KEYS) delete process.env[key]; });
after(() => { for (const key of NATIVE_COMPACTION_ENV_KEYS) { if (inherited[key] === undefined) delete process.env[key]; else process.env[key] = inherited[key]; } });
const CLI = process.env.CCAI_NATIVE_TEST_CLI;

/** Listen on an ephemeral loopback port. */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
}

/** Close an isolated HTTP server after the CLI exits. */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Exercise real stream-json tool turns, the production Relay, model routing and snapshot storage. */
async function exercise(window: number, failure?: number | 'disconnect' | 'timeout' | 'stream-interrupt', enabled = true): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccai-native-relay-'));
    const configDir = path.join(root, 'config');
    await fs.mkdir(configDir);
    await fs.writeFile(path.join(root, 'probe.txt'), 'isolated probe');
    stub.workspaceFolderFsPath = root;
    let normalRequests = 0;
    let summaryRequests = 0;
    let resultCount = 0;
    let resumed = false;
    const events: Array<Record<string, unknown>> = [];
    const upstream = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => raw += chunk);
        req.on('end', () => {
            const body = JSON.parse(raw || '{}');
            const summary = body.model === 'summary';
            if (summary) {
                summaryRequests++;
                assert.equal(resultCount, 0, 'native compaction must precede full-turn result');
                if (failure === 'disconnect') { res.destroy(); return; }
                if (failure === 'timeout') return;
                if (failure === 'stream-interrupt') {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'truncated', type: 'message', role: 'assistant', model: 'summary', content: [], usage: { input_tokens: 1000, output_tokens: 0 } } }) + '\n\n');
                    setTimeout(() => res.destroy(), 20);
                    return;
                }
                if (typeof failure === 'number') {
                    res.writeHead(failure, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ type: 'error', error: { type: failure === 429 ? 'rate_limit_error' : 'invalid_request_error', message: `synthetic summary ${failure}` } }));
                    return;
                }
            } else if (body.model === 'main') {
                normalRequests++;
                if (summaryRequests && !failure) resumed = true;
            }
            const tool = body.model === 'main' && !resumed && normalRequests < 5;
            const block = tool ? { type: 'tool_use', id: `probe_${normalRequests}`, name: 'Read', input: { file_path: path.join(root, 'probe.txt') } }
                : { type: 'text', text: summary ? '<summary>The isolated probe read probe.txt. Continue and reply PROBE_DONE.</summary>' : 'PROBE_DONE' };
            const usage = { input_tokens: tool ? (normalRequests === 1 ? 1000 : Math.floor(window * 0.95)) : 1000, output_tokens: 30 };
            const stop = tool ? 'tool_use' : 'end_turn';
            if (!body.stream) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
            send('message_start', { message: { id: `msg_${normalRequests}_${summaryRequests}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
            send('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
            send('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
            send('content_block_stop', { index: 0 });
            send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } });
            send('message_stop', {});
            res.end();
        });
    });
    const port = await listen(upstream);
    const provider = { id: 'p', name: 'synthetic', baseUrl: `http://127.0.0.1:${port}`, apiType: 'anthropic', apiKey: 'synthetic', authMode: 'api_key', customHeaders: [], enabled: true, models: [{ modelId: 'main', contextLength: window }, { modelId: 'summary', contextLength: 128000 }] };
    const manager = { getCurrentModel: () => ({ providerId: 'p', modelId: 'main' }), getProviderModel: (_provider: string, id: string) => provider.models.find(model => model.modelId === id), getProviderWithSecret: async () => provider };
    stub.values.claudeCodeConfigHelper = { 'chat.cliPath': CLI, 'chat.cliCwd': root, 'chat.autoCompact.enabled': enabled, 'chat.cliEnv': { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '500' }, 'chat.compactionMode.project.enabled': true, 'chat.compactionMode.project.model': 'p/summary' };
    stub.inspect = { claudeCodeConfigHelper: { 'chat.compactionMode.project.enabled': { workspaceValue: true }, 'chat.compactionMode.project.model': { workspaceValue: 'p/summary' } } };
    const router = createRelayRouter({ configManager: manager as never, adapters: [new AnthropicProxyAdapter()] });
    const relay = http.createServer((req, res) => { void Promise.resolve(router(req, res)).catch(error => { res.statusCode = 500; res.end(String(error)); }); });
    const relayPort = await listen(relay);
    const config = await new ChatCliConfigService(manager as never).getConfigWithRelayEnv(relayPort);
    assert.equal(config.nativeCompaction?.status, enabled ? 'managed' : 'disabled');
    const child = spawn(CLI!, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', 'p/main', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', '--settings', JSON.stringify({ autoCompactEnabled: true, precomputeCompactionEnabled: false }), '--setting-sources', ''], { cwd: root, env: buildCliChildEnv(process.env, config.cliEnv, config.nativeCompactionEnv), stdio: 'pipe' });
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', chunk => stderr += chunk);
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
                const event = JSON.parse(line);
                if (event.type === 'system' && event.subtype === 'status') events.push(event);
                if (event.type === 'result') { resultCount++; child.stdin.end(); }
            } catch { /* Non-JSON diagnostics are not native events. */ }
        }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    try {
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read probe.txt repeatedly until the local endpoint replies PROBE_DONE.' } }) + '\n');
        await new Promise<void>((resolve, reject) => { child.on('exit', () => resolve()); child.on('error', reject); });
        assert.equal(resultCount, 1, stderr);
        if (!enabled) {
            assert.equal(summaryRequests, 0);
            assert.equal(events.some(event => event.status === 'compacting'), false);
        } else if (failure) {
            assert.ok(summaryRequests > 0 && summaryRequests <= 4, 'native retries must be bounded');
            assert.equal(events.some(event => event.compact_result === 'success'), false);
            assert.ok(events.some(event => event.compact_result === 'failed'));
        } else {
            assert.equal(summaryRequests, 1);
            assert.ok(events.some(event => event.compact_result === 'success'));
            assert.ok(resumed, 'normal model must continue after summary');
        }
        if (summaryRequests) {
            const dates = await fs.readdir(path.join(root, '.LLSOAI', 'chat'));
            const snapshots = (await Promise.all(dates.map(date => fs.readdir(path.join(root, '.LLSOAI', 'chat', date))))).flat().filter(file => file.startsWith('compact-request-'));
            assert.ok(snapshots.length, 'production Relay must preserve dated raw compact snapshots');
        }
    } finally {
        clearTimeout(timer); child.kill('SIGKILL');
        await close(relay); await close(upstream);
    }
}

for (const window of [200000, 500000, 1000000]) {
    test(`real CLI ${window}: native compact before result, routed summary, continued task`, { skip: !CLI, timeout: 90000 }, () => exercise(window));
}
for (const failure of [402, 429, 400, 'disconnect', 'timeout', 'stream-interrupt'] as const) {
    test(`real CLI summary ${failure}: failure is not success, bounded retries`, { skip: !CLI, timeout: 90000 }, () => exercise(200000, failure));
}
test('real CLI disabled: no automatic compaction during tool loop', { skip: !CLI, timeout: 90000 }, () => exercise(200000, undefined, false));
