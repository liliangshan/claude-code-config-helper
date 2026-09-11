/** @file 本地假 CLI HTTP 客户端与三种真实 Relay 适配器集成验证。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { RequestOutcomeReporter, type RelayRequestOutcome } from '../requestOutcome';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

/** 使用随机本地端口，不连接真实提供商。 */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** 假 CLI 发起一次模型 HTTP 请求并消费响应。 */
async function request(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages' }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve(body));
            res.on('error', reject);
        });
        req.on('error', reject); req.end('{}');
    });
}

/** JSON HTTP 错误与 SSE 内嵌错误均产生单次故障报告。 */
test('three adapters preserve HTTP and SSE failure evidence over local sockets', async () => {
    const constructors = [require('../anthropicProxy').AnthropicProxyAdapter,
        require('../openaiChatProxy').OpenAIChatProxyAdapter, require('../openaiResponsesProxy').OpenAIResponsesProxyAdapter];
    for (const Adapter of constructors) {
        for (const scenario of ['http429', 'http502', 'sse_error']) {
            const stream = scenario === 'sse_error';
            const status = stream ? 200 : scenario === 'http502' ? 502 : 429;
            const reports: RelayRequestOutcome[] = [];
            const upstream = http.createServer((req, res) => {
                req.resume();
                res.writeHead(status, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'retry-after': '300' });
                const payload = { type: 'error', error: { code: 'rate_limit_exceeded', message: 'synthetic failure' } };
                res.end(stream ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload));
            });
            const port = await listen(upstream);
            let finish!: () => void;
            const finished = new Promise<void>(resolve => { finish = resolve; });
            const relay = http.createServer((req, res) => {
                req.resume();
                const outcome = new RequestOutcomeReporter(undefined, result => reports.push(result));
                const adapter = new Adapter();
                const parsedBody = { model: 'synthetic', max_tokens: 10, messages: [{ role: 'user', content: 'synthetic' }], stream };
                void adapter.handle({ req, res, provider: { id: 'p', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'synthetic', models: [] },
                    modelId: 'synthetic', rawBody: JSON.stringify(parsedBody), parsedBody, outcome })
                    .catch((error: Error) => { outcome.fail('upstream_connect', error.name); res.end(); })
                    .finally(() => { outcome.end(res.statusCode); outcome.end(res.statusCode); finish(); });
            });
            try {
                await request(await listen(relay)); await finished;
                assert.equal(reports.length, 1);
                assert.equal(reports[0].status, 'error');
                assert.equal(reports[0].upstreamStatus, status);
                assert.equal(reports[0].retryAfter, '300');
                assert.equal(reports[0].code, 'rate_limit_exceeded');
            } finally {
                relay.closeAllConnections(); upstream.closeAllConnections();
                await Promise.all([new Promise<void>(resolve => relay.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
            }
        }
    }
});
