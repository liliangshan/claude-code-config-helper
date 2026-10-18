/** @file 工具 JSON 异常响应归档的本地 HTTP 集成回归；不连接真实上游。 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { after, test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import type { ToolJsonErrorSnapshot } from '../debugRecorder';
import type { ProviderConfig } from '../../types';

const root = mkdtempSync(path.join(os.tmpdir(), 'ccai-tool-json-'));
const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} }, workspaceFolderFsPath: root });
const { DebugRecorder } = require('../debugRecorder') as typeof import('../debugRecorder');
const { OpenAIResponsesProxyAdapter } = require('../openaiResponsesProxy') as typeof import('../openaiResponsesProxy');
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** 监听随机本地端口，避免影响实际工作区的服务。 */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** 构造完整 SSE 帧。 */
function event(payload: Record<string, unknown>): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 扫描本次假工作区的错误快照，不把聊天审计文件算入。 */
async function listSnapshots(workspace: string): Promise<string[]> {
    const dir = path.join(workspace, '.LLSOAI', 'error');
    const entries = await fs.readdir(dir, { recursive: true }).catch(() => []);
    return entries.filter(name => name.endsWith('.json')).map(name => path.join(dir, name));
}

/** 构造不含真实凭据的本地上游配置。 */
function provider(port: number): ProviderConfig {
    return { id: 'fixture', name: 'fixture', baseUrl: `http://127.0.0.1:${port}`, apiType: 'v1-response', apiKey: 'do-not-save-test-key', authMode: 'api_key', customHeaders: [], models: [], enabled: true, autoFetchModels: false, createdAt: 0, updatedAt: 0 };
}

for (const scenario of ['valid', 'invalid_complete', 'truncated_end', 'aborted', 'client_closed', 'invalid_utf8', 'final_replaces_delta', 'wrapped_invalid', 'late_delta', 'valid_chunked'] as const) {
    test(`Responses ${scenario}: 错误才归档，完整保留已收到的原始响应`, { timeout: 10000 }, async () => {
        const workspace = path.join(root, scenario);
        stub.workspaceFolderFsPath = workspace;
        const valid = scenario === 'valid' || scenario === 'valid_chunked';
        const argument = valid || scenario === 'late_delta' ? '{"file_path":"/test","content":"中文🙂"}'
            : scenario === 'wrapped_invalid' ? JSON.stringify({ __unparsedToolInput: { raw: '{"content":"test"}e}', len: 19 } })
            : scenario === 'final_replaces_delta' ? '{"file_path":"/test","content":"x'
            : '{"file_path":"/test","content":"中文🙂';
        const finalArgument = scenario === 'final_replaces_delta' ? '{"file_path":"/test","content":"中文🙂"}' : argument;
        const prefix = event({ type: 'response.created', response: { id: 'resp_fixture', model: 'fixture' } })
            + event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'Write', arguments: '' } })
            + (scenario === 'valid_chunked' ? [argument.slice(0, 10), argument.slice(10)].map(delta => event({ type: 'response.function_call_arguments.delta', output_index: 0, delta })).join('')
                : event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: argument }));
        const suffix = valid || ['invalid_complete', 'final_replaces_delta', 'wrapped_invalid', 'late_delta'].includes(scenario)
            ? event({ type: 'response.function_call_arguments.done', output_index: 0, arguments: finalArgument })
                + event({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: finalArgument } })
                + (scenario === 'late_delta' ? event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'e}' }) : '')
                + event({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } }) : '';
        const rawSse = prefix + suffix;
        const rawBytes = scenario === 'invalid_utf8' ? Buffer.concat([Buffer.from(rawSse), Buffer.from([0xe4])]) : Buffer.from(rawSse);
        let upstreamSocket: import('node:net').Socket | undefined;
        const upstream = http.createServer((req, res) => {
            req.resume();
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            if (scenario === 'aborted' || scenario === 'client_closed') {
                upstreamSocket = res.socket ?? undefined;
                res.write(rawBytes);
            } else {
                res.end(rawBytes);
            }
        });
        const upstreamPort = await listen(upstream);
        const recorder = new DebugRecorder(() => false);
        let failure: unknown;
        let finish!: () => void;
        const finished = new Promise<void>(resolve => { finish = resolve; });
        const relay = http.createServer((req, res) => {
            req.resume();
            const parsedBody = { model: 'fixture', max_tokens: 32000, stream: true, messages: [{ role: 'user', content: 'test' }] };
            void new OpenAIResponsesProxyAdapter(recorder).handle({ req, res, provider: provider(upstreamPort), modelId: 'fixture', parsedBody, rawBody: JSON.stringify(parsedBody), reasoningEffort: 'xhigh' })
                .catch(error => { failure = error; res.end(); }).finally(finish);
        });
        try {
            const port = await listen(relay);
            await new Promise<void>((resolve, reject) => {
                const req = http.request({ hostname: '127.0.0.1', port, method: 'POST' }, res => {
                    res.on('data', () => {
                        if (scenario === 'aborted') upstreamSocket?.destroy();
                        if (scenario === 'client_closed') { res.destroy(); resolve(); }
                    });
                    res.on('end', resolve);
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.end('{}');
            });
            await finished;
            assert.equal(failure, undefined);
            const files = await listSnapshots(workspace);
            if (valid) {
                assert.equal(files.length, 0);
                return;
            }
            assert.equal(files.length, 1);
            assert.match(files[0], /error[/\\]\d{4}-\d{2}-\d{2}[/\\]error-tooljson-\d+-[a-z0-9]+\.json$/);
            const text = await fs.readFile(files[0], 'utf8');
            const saved = JSON.parse(text) as ToolJsonErrorSnapshot;
            assert.equal(saved.upstreamResponseBody, rawBytes.toString('utf8'));
            assert.equal(saved.upstreamResponseBytes, rawBytes.length);
            if (scenario === 'invalid_utf8') assert.deepEqual(Buffer.from(saved.upstreamResponseBase64!, 'base64'), rawBytes);
            assert.equal(saved.requestParameters.max_output_tokens, 32000);
            assert.deepEqual(saved.requestParameters.reasoning, { effort: 'xhigh', summary: 'auto' });
            assert.ok(saved.diagnostics.some(item => item.includes('call_fixture')));
            if (scenario === 'wrapped_invalid') assert.ok(saved.diagnostics.some(item => item.includes('__unparsedToolInput')));
            if (scenario === 'final_replaces_delta' || scenario === 'late_delta') {
                assert.ok(saved.diagnostics.some(item => item.includes(scenario === 'late_delta' ? 'delta after tool block closed' : 'emitted arguments differ')));
                assert.ok(saved.diagnostics.some(item => item.includes('emittedArgumentsRaw')));
            }
            assert.ok(saved.responseBody.includes('input_json_delta'));
            assert.equal(text.includes('do-not-save-test-key'), false);
            if (scenario === 'aborted') {
                assert.match(saved.reason, /http_error|upstream_closed/);
                assert.equal(saved.httpComplete, false);
            } else if (scenario === 'client_closed') {
                assert.equal(saved.reason, 'client_closed');
                assert.equal(saved.httpComplete, false);
            } else {
                assert.equal(saved.reason, 'http_end');
                assert.equal(saved.httpComplete, true);
            }
        } finally {
            relay.closeAllConnections();
            upstream.closeAllConnections();
            await Promise.all([new Promise<void>(resolve => relay.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
        }
    });
}

test('完整响应不截断，跨日清理及并发保存后最多保留 20 份', async () => {
    const workspace = path.join(root, 'retention');
    stub.workspaceFolderFsPath = workspace;
    const old = path.join(workspace, '.LLSOAI', 'error', '2000-01-01');
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, 'error-tooljson-1-old.json'), '{}');
    const raw = '中文响应🙂'.repeat(16000);
    const sample: ToolJsonErrorSnapshot = {
        protocol: 'responses', providerId: 'fixture', modelId: 'fixture', startedAt: 1, endedAt: 2,
        reason: 'http_end', httpStatus: 200, httpComplete: true, readableEnded: true, destroyed: false,
        requestParameters: { max_output_tokens: 32000 }, upstreamResponseBytes: Buffer.byteLength(raw),
        upstreamResponseBody: raw, responseBody: raw, diagnostics: ['invalid arguments'], warnings: []
    };
    const recorder = new DebugRecorder(() => false);
    await Promise.all(Array.from({ length: 22 }, () => recorder.recordToolJsonError(sample)));
    const files = await listSnapshots(workspace);
    assert.equal(files.length, 20);
    assert.ok(files.every(file => !file.includes('2000-01-01')));
    const saved = JSON.parse(await fs.readFile(files[0], 'utf8')) as ToolJsonErrorSnapshot;
    assert.equal(saved.upstreamResponseBody, raw);
    assert.equal(saved.responseBody, raw);
    if (process.platform !== 'win32') assert.equal((await fs.stat(files[0])).mode & 0o777, 0o600);
});

test('CLI 下轮解析失败关联上一轮完整响应，历史重放和普通工具失败不重复落盘', async () => {
    const workspace = path.join(root, 'cli-feedback');
    stub.workspaceFolderFsPath = workspace;
    const recorder = new DebugRecorder(() => false);
    const evidence: ToolJsonErrorSnapshot = {
        protocol: 'responses', providerId: 'fixture', modelId: 'fixture', sessionId: 'session-1', startedAt: 1, endedAt: 2,
        reason: 'http_end', httpStatus: 200, httpComplete: true, readableEnded: true, destroyed: false,
        requestParameters: { max_output_tokens: 32000 }, upstreamResponseBytes: 16, upstreamResponseBody: 'original raw SSE',
        responseBody: 'original converted SSE', diagnostics: [], warnings: []
    };
    recorder.rememberToolResponse(evidence, ['call_late']);
    const identity = { providerId: 'fixture', modelId: 'fixture', sessionId: 'session-1' };
    const message = 'InputValidationError: Edit was called with input that could not be parsed as JSON.';
    const body = { messages: [{ role: 'assistant', content: [] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_late', is_error: true, content: message }] }] };
    await recorder.recordCliToolJsonErrors(body, identity);
    await recorder.recordCliToolJsonErrors(body, identity);
    const files = await listSnapshots(workspace);
    assert.equal(files.length, 1);
    const saved = JSON.parse(await fs.readFile(files[0], 'utf8')) as ToolJsonErrorSnapshot;
    assert.equal(saved.upstreamResponseBody, evidence.upstreamResponseBody);
    assert.equal(saved.responseBody, evidence.responseBody);
    assert.equal(saved.cliToolErrors?.[0].toolUseId, 'call_late');
    assert.equal(saved.originalResponseUnavailable, undefined);
    await recorder.recordCliToolJsonErrors({ messages: [...body.messages, { role: 'assistant', content: [] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ordinary', is_error: true, content: 'File not found' }] }] }, identity);
    assert.equal((await listSnapshots(workspace)).length, 1);
    const missing = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_missing', is_error: true, content: [{ type: 'text', text: message }] }] }] };
    await recorder.recordCliToolJsonErrors(missing, identity);
    const snapshots = await Promise.all((await listSnapshots(workspace)).map(async file => JSON.parse(await fs.readFile(file, 'utf8')) as ToolJsonErrorSnapshot));
    const fallback = snapshots.find(item => item.originalResponseUnavailable);
    assert.equal(snapshots.length, 2);
    assert.equal(fallback?.upstreamResponseBody, '');
    assert.equal(fallback?.cliToolErrors?.[0].toolUseId, 'call_missing');
});

test('目录不可写时记录器吞掉 IO 异常，不打断主请求', async () => {
    const workspace = path.join(root, 'blocked');
    await fs.writeFile(workspace, 'not a directory');
    stub.workspaceFolderFsPath = workspace;
    await assert.doesNotReject(new DebugRecorder(() => false).recordToolJsonError({
        protocol: 'responses', providerId: 'fixture', modelId: 'fixture', startedAt: 1, endedAt: 2,
        reason: 'http_end', httpComplete: true, readableEnded: true, destroyed: false,
        requestParameters: {}, upstreamResponseBytes: 0, upstreamResponseBody: '', responseBody: '', diagnostics: ['bad'], warnings: []
    }));
});
