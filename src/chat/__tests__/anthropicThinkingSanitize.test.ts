/**
 * @file Anthropic 历史思考块与缓存前缀回归测试。
 * 有签名的原生思考块不随消息变旧而被删除；转换器生成的无效签名块仍过滤。
 * 所有 HTTP 验证仅使用本地假上游，不联系真实提供商。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { installVscodeStub } from './testUtils/vscodeStub';
import type { UsageReport } from '../../relay/usageReporter';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { rewriteRequestBody, AnthropicProxyAdapter } = require('../../relay/anthropicProxy') as typeof import('../../relay/anthropicProxy');

/** 仅用于本地形态校验的合成签名，不代表真实服务商签发。 */
const VALID_SIG = 'EssDCmMIDxgCKk' + 'A'.repeat(80);
/** 旧转换器可能产生的 UUID 伪签名。 */
const BOGUS_SIG = '2f530c48-a031-4006-b393-bec09234406e';

/** 用于逐字段比较的合成消息，不限制工具块的扩展字段。 */
interface FixtureMessage {
    role: string;
    content: Array<Record<string, unknown>> | string;
}

/** 保留未知顶层参数，以验证中转不会改写 thinking 或 context_management。 */
interface FixtureRequest extends Record<string, unknown> {
    model: string;
    messages: FixtureMessage[];
}

/** 将请求交给生产改写函数并解析结果，默认使用同一目标模型。 */
function rewrite(body: Record<string, unknown>): FixtureRequest {
    return JSON.parse(rewriteRequestBody(JSON.stringify(body), body, 'target-model')) as FixtureRequest;
}

/** 构造一组带空可见思考、签名和加密块的工具调用与结果。 */
function toolRound(index: number): FixtureMessage[] {
    return [
        { role: 'assistant', content: [
            { type: 'thinking', thinking: '', signature: VALID_SIG + index },
            { type: 'redacted_thinking', data: `opaque-fixture-${index}` },
            { type: 'tool_use', id: `tu_${index}`, name: 'Read', input: { file_path: `/fixture/${index}` } }
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${index}`, content: `result-${index}` }] }
    ];
}

/** 构造只追加历史、末尾断点正常前移的请求，不携带真实对话内容。 */
function requestWithRounds(count: number, stream = false): FixtureRequest {
    const messages: FixtureMessage[] = [{ role: 'user', content: 'Fixture question' }];
    for (let index = 1; index <= count; index++) messages.push(...toolRound(index));
    const last = messages.at(-1)!.content as Array<Record<string, unknown>>;
    last.at(-1)!.cache_control = { type: 'ephemeral', ttl: '1h' };
    return {
        model: 'provider/target-model', stream, max_tokens: 100,
        system: [{ type: 'text', text: 'Stable fixture system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
        thinking: { type: 'adaptive' },
        context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
        messages
    };
}

/** 序列化历史内容前缀，仅忽略客户端会正常移动的缓存断点。 */
function contentBytes(value: unknown): string {
    return JSON.stringify(value, (key, item: unknown) => key === 'cache_control' ? undefined : item);
}

/** 深度冻结测试输入，确保生产清理只复制被改动的消息而不原地写入。 */
function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
}

/** 已完成回复不应因为没有 tool_use 而丢失签名或加密内容。 */
test('rewriteRequestBody: preserves signed and redacted thinking in completed replies', () => {
    const content = [
        { type: 'thinking', thinking: 'Fixture visible summary\n\n🙂', signature: VALID_SIG },
        { type: 'redacted_thinking', data: 'opaque-completed-fixture' },
        { type: 'text', text: 'Finished' }
    ];
    const body = { model: 'provider/target-model', messages: [
        { role: 'user', content: 'hi' }, { role: 'assistant', content }, { role: 'user', content: 'continue' }
    ] };
    const result = rewrite(body);
    assert.equal(result.model, 'target-model');
    assert.deepEqual(result.messages, body.messages);
});

/** 当前工具轮与早期工具轮采用相同保留规则，包括空文本的 thinking。 */
test('rewriteRequestBody: preserves all native thinking blocks across tool rounds', () => {
    for (const count of [1, 2, 4]) {
        const body = requestWithRounds(count), result = rewrite(body);
        assert.deepEqual(result, { ...body, model: 'target-model' });
    }
});

/** 追加工具调用不得改动上一轮已发送的任何历史内容字节。 */
test('rewriteRequestBody: append-only tool history keeps the cached prefix byte-stable', () => {
    for (const count of [1, 2, 3]) {
        const before = requestWithRounds(count), after = requestWithRounds(count + 1);
        assert.equal(contentBytes(after.messages.slice(0, before.messages.length)), contentBytes(before.messages));
        const previous = rewrite(before), next = rewrite(after);
        assert.equal(contentBytes(next.messages.slice(0, previous.messages.length)), contentBytes(previous.messages));
        assert.deepEqual(next.system, previous.system);
        assert.deepEqual(next.tools, previous.tools);
        assert.deepEqual(next.thinking, after.thinking);
        assert.deepEqual(next.context_management, after.context_management);
    }
});

/** 无签名或明显无效的展示块仍在所有消息位置过滤，真实内容不被连带删除。 */
test('rewriteRequestBody: filters unsigned, short and UUID thinking consistently', () => {
    for (const signature of [undefined, null, '', 'short', 'A'.repeat(63), BOGUS_SIG, 123, {}]) {
        const bad = { type: 'thinking', thinking: 'Converted display-only summary', signature };
        const body = requestWithRounds(2);
        for (const index of [1, 3]) (body.messages[index].content as Array<Record<string, unknown>>).unshift(bad);
        const result = rewrite(body);
        assert.deepEqual(result.messages, requestWithRounds(2).messages);
        assert.deepEqual(rewrite(result), result, 'Filtering remains idempotent');
    }
});

/** 混合清理不允许修改原始请求，也不能以缺少顶层思考配置为由删除有效块。 */
test('rewriteRequestBody: filtering leaves frozen source messages and metadata untouched', () => {
    const original = requestWithRounds(2);
    delete original.thinking;
    (original.messages[1].content as Array<Record<string, unknown>>).unshift({ type: 'thinking', thinking: 'Unsigned' });
    const sourceBytes = JSON.stringify(original);
    freeze(original);
    const result = rewrite(original);
    assert.equal(JSON.stringify(original), sourceBytes);
    const expected = requestWithRounds(2);
    delete expected.thinking;
    assert.deepEqual(result, { ...expected, model: 'target-model' });
});

/** 合法历史重复转发保持幂等，无法解析的输入仍遵循既有原样回退行为。 */
test('rewriteRequestBody: valid history is idempotent and unparsed input passes through', () => {
    const once = rewrite(requestWithRounds(2));
    assert.deepEqual(rewrite(once), once);
    assert.equal(rewriteRequestBody('unparsed-fixture', undefined, 'target-model'), 'unparsed-fixture');
});

/** 绑定仅本机可访问的测试监听端口。 */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** 清理本测试拥有的连接，断言失败时也不遗留 HTTP 服务。 */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const stream of [false, true]) {
    /** 通过生产代理验证实际上行请求，并确认响应统计及签名错误未被改写或重试。 */
    test(`Anthropic proxy stream=${stream}: preserves cached history and forwards genuine signature errors`, async () => {
        const captured: FixtureRequest[] = [], reports: UsageReport[] = [];
        const usage = { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
        const error = { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block (fixture)' } };
        const upstream = http.createServer((req, res) => {
            let raw = '';
            req.on('data', chunk => { raw += chunk; });
            req.on('end', () => {
                captured.push(JSON.parse(raw) as FixtureRequest);
                if (captured.length === 3) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(error));
                    return;
                }
                const message = { id: 'fixture-response', type: 'message', role: 'assistant', model: 'target-model',
                    content: [{ type: 'text', text: 'Fixture reply' }], stop_reason: 'end_turn', usage };
                res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
                res.end(stream
                    ? `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [], usage: { ...usage, output_tokens: 0 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
                    : JSON.stringify(message));
            });
        });
        const upstreamPort = await listen(upstream);
        const adapter = new AnthropicProxyAdapter(undefined, undefined, report => reports.push(report));
        const relay = http.createServer((req, res) => {
            let rawBody = '';
            req.on('data', chunk => { rawBody += chunk; });
            req.on('end', () => {
                void adapter.handle({ req, res, rawBody, parsedBody: JSON.parse(rawBody), modelId: 'target-model',
                    provider: { id: 'fixture', name: 'Local fixture', enabled: true, apiType: 'anthropic',
                        baseUrl: `http://127.0.0.1:${upstreamPort}`, authMode: 'none', apiKey: '', models: [],
                        autoFetchModels: false, createdAt: 0, updatedAt: 0, customHeaders: [] }
                }).catch(err => res.destroy(err));
            });
        });
        try {
            const relayPort = await listen(relay);
            for (const count of [1, 2]) {
                const body = requestWithRounds(count, stream);
                const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
                    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
                });
                assert.equal(response.status, 200, await response.text());
                const sent = captured.at(-1)!;
                assert.equal(sent.model, 'target-model');
                assert.deepEqual(sent.messages, body.messages);
                assert.deepEqual(sent.thinking, body.thinking);
                assert.deepEqual(sent.context_management, body.context_management);
                assert.deepEqual(sent.tools, body.tools);
                assert.deepEqual(sent.system && (sent.system as unknown[])[0], (body.system as unknown[])[0]);
            }
            assert.equal(contentBytes(captured[1].messages.slice(0, captured[0].messages.length)), contentBytes(captured[0].messages));
            assert.deepEqual(captured[1].system, captured[0].system, 'Injected system prefix stays stable too');
            assert.equal(reports.length, 2);
            for (const report of reports) {
                assert.equal(report.inputTokens, usage.input_tokens);
                assert.equal(report.outputTokens, usage.output_tokens);
                assert.equal(report.cacheReadInputTokens, usage.cache_read_input_tokens);
                assert.equal(report.cacheCreationInputTokens, usage.cache_creation_input_tokens);
            }
            const denied = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
                method: 'POST', body: JSON.stringify(requestWithRounds(3, stream)), signal: AbortSignal.timeout(5000)
            });
            assert.equal(denied.status, 400);
            assert.deepEqual(await denied.json(), error);
            assert.equal(captured.length, 3, 'No silent history deletion or retry after an upstream signature error');
            assert.deepEqual(captured[2].messages, requestWithRounds(3, stream).messages);
        } finally { await close(relay); await close(upstream); }
    });
}
