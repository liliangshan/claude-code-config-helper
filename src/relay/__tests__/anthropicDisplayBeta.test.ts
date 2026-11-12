/** @file CLI Anthropic beta 完整透传回归；所有 HTTP 请求仅连接本地假上游。 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';
import type { ProviderConfig } from '../../types';
import { buildForwardHeaders } from '../forwardHeadersCommon';
import { buildOpenAIForwardHeaders } from '../openAIHeaders';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { applyCliAnthropicBeta, applyCustomHeaders, AnthropicProxyAdapter } = require('../anthropicProxy') as typeof import('../anthropicProxy');
const DISPLAY_BETA = 'thinking-display-updates-2026-08-18';

/** 创建无真实凭据的本地提供商，允许测试覆盖协议及显式自定义头。 */
function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return { id: 'fixture', name: 'Local fixture', baseUrl: 'http://127.0.0.1:1', apiType: 'anthropic',
        models: [], enabled: true, autoFetchModels: false, createdAt: 0, updatedAt: 0,
        authMode: 'none', apiKey: '', customHeaders: [], ...overrides };
}

/** 按生产顺序过滤 CLI 头、合并用户自定义头，再恢复全部 CLI beta。 */
function forward(source: http.IncomingHttpHeaders, config = provider()): Record<string, string> {
    const headers = buildForwardHeaders(source);
    applyCustomHeaders(headers, config);
    applyCliAnthropicBeta(headers, source);
    return headers;
}

/** CLI 未声明时不补造；任意非空 beta 保留内容、顺序和大小写，不使用名称白名单。 */
test('Anthropic beta forwards all CLI values without a whitelist', () => {
    for (const incoming of [undefined, '', '  ', [], [' ', '']]) {
        assert.equal(forward({ 'anthropic-beta': incoming })['anthropic-beta'], undefined);
    }
    for (const incoming of [DISPLAY_BETA, 'other-beta', `${DISPLAY_BETA}-extra`,
        `prefix-${DISPLAY_BETA}`, DISPLAY_BETA.toUpperCase(), 'future-feature-2099-01-01',
        `other-beta,${DISPLAY_BETA}, unrelated-beta`, [` ${DISPLAY_BETA} `, 'other-beta'],
        `${DISPLAY_BETA},${DISPLAY_BETA}`, ' , ']) {
        const source: http.IncomingHttpHeaders = { 'anthropic-beta': incoming, authorization: 'Bearer synthetic-client',
            'x-api-key': 'synthetic-client-key', 'x-stainless-retry-count': '1', 'x-claude-code-session-id': 'fixture', accept: 'application/json' };
        const before = structuredClone(source), headers = forward(source);
        assert.deepEqual(headers, { accept: 'application/json', 'anthropic-beta': Array.isArray(incoming) ? incoming.join(', ') : incoming });
        assert.deepEqual(source, before, 'Incoming headers must not be mutated');
    }
});

/** 自定义 beta 与全部 CLI 标记合并；未请求时不改写配置或沿用上次请求。 */
test('Anthropic beta merges all custom and CLI values without request-to-request leakage', () => {
    const config = provider({ customHeaders: [{ key: 'Anthropic-Beta', value: 'custom-beta, custom-beta' }] });
    assert.equal(forward({ 'anthropic-beta': `other-beta, ${DISPLAY_BETA}, other-beta` }, config)['anthropic-beta'],
        `custom-beta, other-beta, ${DISPLAY_BETA}`);
    assert.equal(forward({}, config)['anthropic-beta'], 'custom-beta, custom-beta');
    assert.equal(forward({ 'anthropic-beta': 'other-beta' })['anthropic-beta'], 'other-beta');
    assert.equal(forward({})['anthropic-beta'], undefined);
    const alreadyConfigured = provider({ customHeaders: [{ key: 'ANTHROPIC-BETA', value: `${DISPLAY_BETA}, custom-beta, ${DISPLAY_BETA}` }] });
    assert.equal(forward({ 'anthropic-beta': [DISPLAY_BETA, 'future-beta', 'custom-beta'] }, alreadyConfigured)['anthropic-beta'],
        `${DISPLAY_BETA}, custom-beta, future-beta`);
    assert.equal(forward({}, alreadyConfigured)['anthropic-beta'], alreadyConfigured.customHeaders[0].value,
        'A manually configured beta is not removed when the CLI omits it');
    const empty = provider({ customHeaders: [{ key: 'anthropic-beta', value: '' }] });
    assert.equal(forward({ 'anthropic-beta': `unknown-beta,${DISPLAY_BETA}` }, empty)['anthropic-beta'], `unknown-beta,${DISPLAY_BETA}`);
});

/** 公共过滤器与两个 OpenAI 协议继续阻止 Anthropic 专属 beta。 */
test('Anthropic beta remains blocked on common and OpenAI header paths', () => {
    const source = { 'anthropic-beta': `${DISPLAY_BETA}, other-beta, future-feature-2099-01-01`, authorization: 'Bearer synthetic-client', accept: 'application/json' };
    assert.equal(buildForwardHeaders(source)['anthropic-beta'], undefined);
    for (const apiType of ['openai-compatible', 'v1-response'] as const) {
        const headers = buildOpenAIForwardHeaders(provider({ apiType, customHeaders: [{ key: 'Anthropic-Beta', value: DISPLAY_BETA }] }), source);
        assert.equal(headers['anthropic-beta'], undefined);
        assert.equal(headers.authorization, undefined);
        assert.equal(headers.accept, 'application/json');
    }
});

/** 启动仅回环地址可访问的 HTTP 测试服务。 */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** 释放当前测试拥有的连接和监听，不影响其他测试服务。 */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const stream of [false, true]) {
    /** 生产代理完整转发 CLI beta，保留 body 并返回不支持 beta 的上游拒绝，不隐式重试。 */
    test(`Anthropic proxy stream=${stream}: forwards all declared beta values without changing thinking`, async () => {
        const captured: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
        const upstreamError = { type: 'error', error: { type: 'invalid_request_error',
            message: "thinking.adaptive.display: Input should be 'summarized', 'omitted'" } };
        const upstream = http.createServer((req, res) => {
            let raw = '';
            req.on('data', chunk => { raw += chunk; });
            req.on('end', () => {
                captured.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
                const body = captured.at(-1)!.body;
                const thinking = body.thinking as { display?: string } | undefined;
                if (body.model === 'reject-fixture' || (thinking?.display === 'updates'
                    && !req.headers['anthropic-beta']?.includes(DISPLAY_BETA))) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(upstreamError));
                    return;
                }
                const message = { id: 'fixture', type: 'message', role: 'assistant', model: body.model,
                    content: [{ type: 'text', text: 'Local fixture response' }], stop_reason: 'end_turn',
                    usage: { input_tokens: 2, output_tokens: 3 } };
                res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
                res.end(stream
                    ? `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
                    : JSON.stringify(message));
            });
        });
        const upstreamPort = await listen(upstream);
        const adapter = new AnthropicProxyAdapter();
        const relay = http.createServer((req, res) => {
            let rawBody = '';
            req.on('data', chunk => { rawBody += chunk; });
            req.on('end', () => {
                const parsedBody = JSON.parse(rawBody) as { model: string };
                void adapter.handle({ req, res, rawBody, parsedBody, modelId: parsedBody.model,
                    provider: provider({ baseUrl: `http://127.0.0.1:${upstreamPort}`,
                        customHeaders: [{ key: 'Anthropic-Beta', value: 'custom-fixture-beta' }] })
                }).catch(error => res.destroy(error));
            });
        });
        try {
            const relayPort = await listen(relay);
            const cases = [
                { display: 'updates', beta: `other-cli-beta, ${DISPLAY_BETA}, future-feature-2099-01-01`, model: 'fixture', status: 200 },
                { display: 'summarized', beta: undefined, model: 'fixture', status: 200 },
                { display: 'omitted', beta: 'other-cli-beta', model: 'fixture', status: 200 },
                { display: undefined, beta: 'future-beta', model: 'fixture', status: 200 },
                { display: undefined, beta: undefined, model: 'fixture', status: 200 },
                { display: 'updates', beta: undefined, model: 'fixture', status: 400 },
                { display: 'updates', beta: DISPLAY_BETA, model: 'reject-fixture', status: 400 }
            ];
            for (const entry of cases) {
                const thinking = { type: 'adaptive', ...(entry.display ? { display: entry.display } : {}) };
                const contextManagement = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
                const messages = [{ role: 'user', content: 'Synthetic fixture only' }, { role: 'assistant', content: [
                    { type: 'thinking', thinking: '', signature: 'A'.repeat(96) }, { type: 'text', text: 'Earlier fixture' }
                ] }, { role: 'user', content: 'Continue fixture' }];
                const before = captured.length;
                const headers: Record<string, string> = { 'content-type': 'application/json', authorization: 'Bearer synthetic-client',
                    'x-api-key': 'synthetic-client-key', 'x-stainless-retry-count': '2' };
                if (entry.beta) headers['Anthropic-Beta'] = entry.beta;
                const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, { method: 'POST', headers,
                    body: JSON.stringify({ model: entry.model, stream, thinking, context_management: contextManagement, messages }),
                    signal: AbortSignal.timeout(5000) });
                const text = await response.text();
                assert.equal(response.status, entry.status, text);
                if (entry.status === 400) assert.deepEqual(JSON.parse(text), upstreamError);
                assert.equal(captured.length, before + 1, 'Never retry or rewrite display after a provider rejection');
                const sent = captured.at(-1)!;
                assert.equal(sent.headers['anthropic-beta'], entry.beta
                    ? `custom-fixture-beta, ${entry.beta}` : 'custom-fixture-beta');
                assert.equal(sent.headers.authorization, undefined);
                assert.equal(sent.headers['x-api-key'], undefined);
                assert.equal(sent.headers['x-stainless-retry-count'], undefined);
                assert.deepEqual(sent.body.thinking, thinking);
                assert.deepEqual(sent.body.context_management, contextManagement);
                assert.deepEqual(sent.body.messages, messages);
            }
        } finally { await close(relay); await close(upstream); }
    });
}
