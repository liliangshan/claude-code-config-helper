/** @file 扩展 UA 的版本、合并规则和本地 HTTP 请求回归测试。 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';
import { installVscodeStub } from '../chat/__tests__/testUtils/vscodeStub';
import { applyExtensionUserAgent, EXTENSION_USER_AGENT } from '../userAgent';
import { buildOpenAIForwardHeaders } from '../relay/openAIHeaders';
import type { ProviderConfig } from '../types';
import type { UpstreamAdapter } from '../relay/router';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

/** 构造仅指向本地假服务的提供商，避免使用任何真实凭据。 */
function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        id: 'test', name: 'test', baseUrl: 'http://127.0.0.1', apiType: 'anthropic',
        authMode: 'none', apiKey: '', models: [], enabled: true,
        autoFetchModels: false, createdAt: 0, updatedAt: 0, customHeaders: [],
        ...overrides
    };
}

/** 监听本地随机端口并返回基础 URL。 */
async function listen(server: http.Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

/** 清理本地测试服务器及其存活连接。 */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

test('UA 标识从根目录 package.json 获取名称和版本', () => {
    const manifest = require('../../package.json') as { name: string; version: string };
    assert.equal(EXTENSION_USER_AGENT, `${manifest.name}/${manifest.version}`);
});

test('UA 缺失时补齐，保留原有 UA，忽略键名大小写且不重复追加', () => {
    for (const current of [undefined, '', '   ', 'claude-cli/2.1 (external, cli)']) {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (current !== undefined) headers['User-Agent'] = current;
        applyExtensionUserAgent(headers);
        const expected = current?.trim() ? `${current} ${EXTENSION_USER_AGENT}` : EXTENSION_USER_AGENT;
        assert.equal(headers['user-agent'], expected);
        applyExtensionUserAgent(headers);
        assert.equal(headers['user-agent'], expected);
        assert.equal(headers['User-Agent'], undefined);
        assert.equal(headers.accept, 'application/json');
    }
    const duplicate = { 'User-Agent': 'custom/1', 'USER-AGENT': 'custom/1' } as Record<string, string>;
    applyExtensionUserAgent(duplicate);
    assert.deepEqual(duplicate, { 'user-agent': `custom/1 ${EXTENSION_USER_AGENT}` });
});

test('OpenAI 自定义 UA 覆盖 CLI UA 后仍携带扩展版本', () => {
    const headers = buildOpenAIForwardHeaders(provider({ customHeaders: [{ key: 'USER-AGENT', value: 'gateway/1' }] }), { 'user-agent': 'cli/1' });
    assert.equal(headers['user-agent'], `gateway/1 ${EXTENSION_USER_AGENT}`);
    assert.equal(buildOpenAIForwardHeaders(provider(), {})['user-agent'], EXTENSION_USER_AGENT);
});

test('三个聊天适配器的实际 HTTP 请求包含 CLI 或自定义 UA 和扩展版本', async () => {
    const constructors: Array<new () => UpstreamAdapter> = [
        require('../relay/anthropicProxy').AnthropicProxyAdapter,
        require('../relay/openaiChatProxy').OpenAIChatProxyAdapter,
        require('../relay/openaiResponsesProxy').OpenAIResponsesProxyAdapter
    ];
    const received: Array<string | undefined> = [];
    const upstream = http.createServer((req, res) => {
        received.push(req.headers['user-agent']);
        req.resume();
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'synthetic response' } }));
    });
    const baseUrl = await listen(upstream);
    try {
        for (const Adapter of constructors) {
            for (const custom of [false, true]) {
                let finish!: () => void;
                let failure: unknown;
                const finished = new Promise<void>(resolve => { finish = resolve; });
                const relay = http.createServer((req, res) => {
                    req.resume();
                    const parsedBody = { model: 'test', max_tokens: 10, messages: [{ role: 'user', content: 'test' }] };
                    void new Adapter().handle({
                        req, res, provider: provider({ baseUrl, customHeaders: custom ? [{ key: 'User-Agent', value: 'gateway/1' }] : [] }),
                        modelId: 'test', parsedBody, rawBody: JSON.stringify(parsedBody)
                    }).catch(error => { failure = error; res.end(); }).finally(finish);
                });
                try {
                    const response = await fetch(`${await listen(relay)}/v1/messages`, { method: 'POST', headers: { 'User-Agent': 'cli/1' }, body: '{}' });
                    await response.text();
                    await finished;
                    assert.equal(failure, undefined);
                    assert.equal(received.pop(), `${custom ? 'gateway/1' : 'cli/1'} ${EXTENSION_USER_AGENT}`);
                } finally {
                    await close(relay);
                }
            }
        }
    } finally {
        await close(upstream);
    }
});

test('模型列表请求使用当前版本并保留自定义 UA', async () => {
    const { fetchModels } = require('../modelFetcher') as typeof import('../modelFetcher');
    const received: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
        received.push(req.headers['user-agent']);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    });
    const baseUrl = await listen(server);
    try {
        await fetchModels({ baseUrl, apiType: 'openai-compatible', authMode: 'none' });
        assert.equal(received.pop(), EXTENSION_USER_AGENT);
        await fetchModels({ baseUrl, apiType: 'openai-compatible', authMode: 'none', customHeaders: [{ key: 'user-agent', value: 'custom/1' }] });
        assert.equal(received.pop(), `custom/1 ${EXTENSION_USER_AGENT}`);
    } finally {
        await close(server);
    }
});

test('三个独立压缩协议均在真实请求中附带扩展 UA，且不重复追加', async () => {
    const { CompactionClient } = require('../relay/tokenBudget/compactor') as typeof import('../relay/tokenBudget/compactor');
    const received: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
        received.push(req.headers['user-agent']);
        req.resume();
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{}');
    });
    const baseUrl = await listen(server);
    try {
        for (const apiType of ['anthropic', 'openai-compatible', 'v1-response'] as const) {
            const result = await new CompactionClient().run({ provider: provider({ baseUrl, apiType }), modelId: 'test', messages: [] });
            assert.equal(result.ok, false);
            assert.equal(received.pop(), EXTENSION_USER_AGENT);
        }
    } finally {
        await close(server);
    }
});
