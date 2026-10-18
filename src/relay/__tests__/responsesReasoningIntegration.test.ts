/** @file 生产 Responses 代理本地 HTTP 集成：摘要提前可见、开关和 JSON 回退。 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { OpenAIResponsesProxyAdapter } = require('../openaiResponsesProxy') as typeof import('../openaiResponsesProxy');

/** 监听隔离回环端口，不使用真实提供商。 */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
}

/** 关闭本用例创建的连接与监听。 */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const mode of ['off', 'passthrough'] as const) {
    for (const stream of [false, true]) {
        test(`Responses HTTP ${mode}, stream=${stream}: 摘要开关、提早输出与去重`, async () => {
            let requestBody: Record<string, any> | undefined;
            let release: (() => void) | undefined;
            const reasoning = { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: '可见摘要🙂' }], encrypted_content: 'NOT_VISIBLE' };
            const upstream = http.createServer((req, res) => {
                let raw = '';
                req.on('data', chunk => raw += chunk);
                req.on('end', () => {
                    requestBody = JSON.parse(raw);
                    if (!stream) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ id: 'resp', model: 'm', status: 'completed', output: [reasoning, { type: 'message', content: [{ type: 'output_text', text: '正文' }] }] }));
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    const send = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
                    send('response.created', { response: { id: 'resp', model: 'm' } });
                    send('response.reasoning_summary_text.delta', { item_id: 'r', output_index: 0, summary_index: 0, delta: '可见摘要🙂' });
                    let released = false;
                    release = () => {
                        if (released) return;
                        released = true;
                        send('response.reasoning_summary_text.done', { item_id: 'r', output_index: 0, summary_index: 0, text: '可见摘要🙂' });
                        send('response.output_item.done', { output_index: 0, item: reasoning });
                        send('response.output_text.delta', { output_index: 1, content_index: 0, delta: '正文' });
                        send('response.completed', { response: { id: 'resp', status: 'completed', output: [reasoning] } });
                        res.end();
                    };
                    if (mode === 'off') release();
                });
            });
            const port = await listen(upstream);
            const adapter = new OpenAIResponsesProxyAdapter();
            const parsedBody = { model: 'm', stream, messages: [{ role: 'user', content: 'test' }] };
            const relay = http.createServer((req, res) => {
                void adapter.handle({ req, res, provider: { id: 'p', baseUrl: `http://127.0.0.1:${port}`, apiType: 'v1-response', authMode: 'none', models: [{ modelId: 'm', reasoningMode: mode }] } as never, modelId: 'm', parsedBody, rawBody: JSON.stringify(parsedBody) }).catch(error => { res.destroy(error); });
            });
            const relayPort = await listen(relay);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, { method: 'POST', body: '{}' });
                if (stream) {
                    const reader = response.body!.getReader();
                    const decoder = new TextDecoder();
                    let wire = '';
                    const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => { release?.(); reject(new Error('摘要未实时到达')); }, 2000); });
                    const first = await Promise.race([reader.read(), watchdog]);
                    if (first.value) wire += decoder.decode(first.value, { stream: true });
                    if (mode === 'passthrough') {
                        while (!wire.includes('thinking_delta')) {
                            const next = await Promise.race([reader.read(), watchdog]);
                            assert.equal(next.done, false);
                            wire += decoder.decode(next.value, { stream: true });
                        }
                        assert.equal(wire.includes('message_stop'), false, '不等待最终响应再显示摘要');
                        release!();
                    }
                    clearTimeout(timer);
                    for (;;) {
                        const next = await reader.read();
                        if (next.done) break;
                        wire += decoder.decode(next.value, { stream: true });
                    }
                    wire += decoder.decode();
                    const events = wire.split('\n\n').flatMap(frame => {
                        const line = frame.split('\n').find(value => value.startsWith('data:'));
                        return line ? [JSON.parse(line.slice(5))] : [];
                    });
                    assert.equal(events.filter(event => event.delta?.type === 'thinking_delta').map(event => event.delta.thinking).join(''), mode === 'passthrough' ? '可见摘要🙂' : '');
                    assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
                    assert.equal(wire.includes('NOT_VISIBLE'), false);
                } else {
                    const result = await response.json() as { content: Array<{ type: string; thinking?: string }> };
                    assert.equal(result.content.some(block => block.type === 'thinking'), mode === 'passthrough');
                    assert.equal(JSON.stringify(result).includes('NOT_VISIBLE'), false);
                }
                assert.deepEqual(requestBody?.reasoning, mode === 'passthrough' ? { summary: 'auto' } : undefined);
            } finally {
                if (timer) clearTimeout(timer);
                release?.();
                await close(relay); await close(upstream);
            }
        });
    }
}
