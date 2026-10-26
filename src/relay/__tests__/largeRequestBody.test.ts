/** @file Relay 长请求不受旧 10 MiB 限制，完整解码及中断释放回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { readRequestBody, createRelayRouter } = require('../router') as typeof import('../router');

/** 监听隔离回环端口，不访问真实上游。 */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

for (const chunked of [false, true]) {
    test(`超过 10 MiB 请求完整进入 adapter，chunked=${chunked}`, async () => {
        const text = '中文🙂'.repeat(1100000);
        const body = Buffer.from(JSON.stringify({ model: 'p/m', messages: [{ role: 'user', content: text }] }));
        assert.ok(body.length > 10 * 1024 * 1024);
        let called = 0;
        const router = createRelayRouter({
            configManager: { getProviderWithSecret: async () => ({ id: 'p', apiType: 'anthropic', enabled: true, baseUrl: 'http://example.invalid' }) } as never,
            adapters: [{ apiType: 'anthropic', async handle(ctx) {
                called++;
                assert.equal(ctx.rawBody, body.toString('utf8'));
                assert.equal((ctx.parsedBody as { messages: Array<{ content: string }> }).messages[0].content, text);
                ctx.res.writeHead(200, { 'content-type': 'application/json' });
                ctx.res.end('{"ok":true}');
            } }]
        });
        const server = http.createServer((req, res) => { void Promise.resolve(router(req, res)).catch(error => res.destroy(error)); });
        const port = await listen(server);
        try {
            const result = await new Promise<{ status?: number; text: string }>((resolve, reject) => {
                const req = http.request({ hostname: '127.0.0.1', port, path: '/normal/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', ...(chunked ? {} : { 'content-length': body.length }) } }, res => {
                    let response = '';
                    res.on('data', chunk => response += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, text: response }));
                });
                req.on('error', reject);
                if (chunked) {
                    for (let offset = 0; offset < body.length; offset += 65537) req.write(body.subarray(offset, offset + 65537));
                    req.end();
                } else req.end(body);
            });
            assert.equal(result.status, 200);
            assert.equal(result.text, '{"ok":true}');
            assert.equal(called, 1);
        } finally {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
}

test('中断或流错误释放监听，不调用 destroy，后续 ECONNRESET 不抛出', async () => {
    for (const terminal of ['aborted', 'close', 'error']) {
        const req = Object.assign(new EventEmitter(), { destroy: () => assert.fail('reader must not destroy request') });
        const waiting = readRequestBody(req as unknown as http.IncomingMessage);
        const rejected = assert.rejects(waiting, /中断|synthetic/);
        req.emit('data', Buffer.from('partial'));
        req.emit(terminal, new Error('synthetic'));
        req.emit('error', new Error('late ECONNRESET'));
        await rejected;
        assert.equal(req.listenerCount('data'), 0);
        assert.equal(req.listenerCount('end'), 0);
    }
});
