/** @file Local response-preview tests never contact a provider or replay a billable request. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { imageResponsePreview, parseImageResponsePreview, IMAGE_ERROR_CAPTURE_BYTES } from '../responsePreview';
import { generateImages } from '../imageClient';
import { ImageError, defaultImageConfig, type ImageGenerationExecutionSnapshot } from '../types';
import { ImageTaskStore } from '../taskStore';
import { ImageTaskManager } from '../taskManager';
import { imageResultMessage, imageResultMessageFromPrompt, imageResultPrompt } from '../results';

/** Build a non-secret connection snapshot for a localhost fixture only. */
function snapshot(url: string): ImageGenerationExecutionSnapshot {
    return { config: { ...defaultImageConfig(), enabled: true, modelId: 'test-image' }, generationUrl: url, editUrl: url,
        providerName: 'fixture', headers: { 'content-type': 'application/json', authorization: 'Bearer test-only-secret', 'x-provider-key': 'custom-secret' } };
}

/** Check character rather than byte truncation and prevent secrets or source bytes from reaching history. */
test('response excerpts preserve Unicode and response shape while redacting sensitive content', () => {
    const text = '{"error":"' + '错误🙂 '.repeat(200) + '"}';
    const preview = imageResponsePreview(text, 400);
    assert.equal(preview.body, Array.from(text).slice(0, 500).join(''));
    assert.equal(Array.from(preview.body).length, 500); assert.equal(preview.truncated, true);
    const sensitive = JSON.stringify({ error: 'test-only-secret custom-secret', authorization: 'Bearer another-secret', api_key: 'key-123',
        image: 'data:image/png;base64,iVBORw0KGgo=', b64_json: 'iVBORw0KGgo=', url: 'https://user:password@example.com/image?token=signed-secret' });
    const safe = imageResponsePreview(sensitive, 200, ['test-only-secret', 'custom-secret']);
    for (const secret of ['test-only-secret', 'custom-secret', 'another-secret', 'key-123', 'iVBORw0KGgo=', 'signed-secret', 'user:password']) assert.equal(safe.body.includes(secret), false, secret);
    assert.ok(safe.body.includes('[REDACTED]'));
    assert.equal(parseImageResponsePreview({ status: 200, body: text, truncated: false })?.body, preview.body);
    assert.equal(parseImageResponsePreview({ status: 999, body: 'bad' }), undefined);
    assert.equal(parseImageResponsePreview({ status: 200, body: {} }), undefined);
});

/** Simulate non-2xx, HTTP-200 API errors and invalid JSON while checking no retry or unbounded error buffering. */
test('image client captures capped response bodies for HTTP failures and malformed success responses', async () => {
    const bodies: Record<string, { status: number; body: string }> = {
        '/invalid-url': { status: 400, body: JSON.stringify({ error: { message: "Invalid 'images[0].image_url'. Expected a valid URL." } }) },
        '/business-error': { status: 200, body: JSON.stringify({ error: { message: 'Model does not support this size', type: 'invalid_request_error' } }) },
        '/html': { status: 200, body: '<html><body>Bad gateway</body></html>' },
        '/long': { status: 500, body: '{"message":"' + '上游错误🙂 '.repeat(20000) + '"}' },
        '/secret': { status: 403, body: '{"error":"test-only-secret custom-secret","image":"data:image/png;base64,iVBORw0KGgo="}' },
        '/empty': { status: 502, body: '' },
        '/redirect': { status: 302, body: 'Moved upstream' }
    };
    const calls: string[] = [];
    const server = http.createServer(async (request, response) => {
        for await (const _ of request) { /* Consume exactly one request without retaining its image bytes. */ }
        const name = request.url!; calls.push(name); const value = bodies[name];
        response.writeHead(value.status, { 'content-type': name === '/html' ? 'text/html' : 'application/json', ...(name === '/redirect' ? { location: '/business-error' } : {}) });
        response.end(value.body);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    try {
        for (const [route, fixture] of Object.entries(bodies)) {
            await assert.rejects(generateImages(snapshot(base + route), { operation: 'edit', prompt: 'test', size: '500x400', image: 'data:image/png;base64,iVBORw0KGgo=' }, new AbortController().signal), (error: unknown) => {
                assert.ok(error instanceof ImageError);
                assert.equal(error.code, fixture.status < 300 ? 'IMAGE_UPSTREAM_FAILED' : `IMAGE_HTTP_${fixture.status}`);
                assert.equal(error.responsePreview?.status, fixture.status);
                assert.ok(Array.from(error.responsePreview!.body).length <= 500);
                if (route === '/secret') {
                    for (const secret of ['test-only-secret', 'custom-secret', 'iVBORw0KGgo=']) assert.equal(error.responsePreview!.body.includes(secret), false);
                } else assert.equal(error.responsePreview?.body, Array.from(fixture.body).slice(0, 500).join(''));
                assert.equal(error.responsePreview?.truncated, route === '/long');
                return true;
            });
        }
        assert.equal(calls.length, Object.keys(bodies).length);
        assert.ok(Buffer.byteLength(bodies['/long'].body) > IMAGE_ERROR_CAPTURE_BYTES);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

/** Bound chunked and incomplete responses without losing status or retrying a paid request. */
test('streamed failure prefixes survive disconnects and large errors stop before an unbounded stream ends', { timeout: 5000 }, async () => {
    const text = '{"error":"stream interrupted after upstream validation"}';
    const server = http.createServer(async (request, response) => {
        for await (const _ of request) { /* Do not retain the posted input. */ }
        if (request.url === '/endless') {
            response.writeHead(429, { 'content-type': 'application/json' });
            response.write('too many requests\n'.repeat(5000));
        } else {
            response.writeHead(request.url === '/success-disconnect' ? 200 : 503, { 'content-type': 'application/json', 'content-length': 100000 });
            response.write(text); setTimeout(() => response.destroy(), 10);
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    try {
        for (const route of ['/endless', '/failure-disconnect', '/success-disconnect']) {
            await assert.rejects(generateImages(snapshot(base + route), { operation: 'generate', prompt: 'test', size: '500x400' }, new AbortController().signal), (error: unknown) => {
                assert.ok(error instanceof ImageError);
                assert.equal(error.code, route === '/endless' ? 'IMAGE_HTTP_429' : route === '/failure-disconnect' ? 'IMAGE_HTTP_503' : 'IMAGE_UPSTREAM_FAILED');
                assert.equal(error.responsePreview?.truncated, true);
                assert.equal(error.responsePreview?.body, route === '/endless' ? 'too many requests\n'.repeat(5000).slice(0, 500) : text);
                return true;
            });
        }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

/** Persist the same bounded failure diagnostic through task history, completion and native-message restoration. */
test('failed image tasks display response excerpts and keep them after task and chat restoration', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-response-preview-'));
    const store = new ImageTaskStore(cwd), scope = 'a'.repeat(64);
    const body = JSON.stringify({ error: { message: "Invalid 'images[0].image_url'", code: 'invalid_value' } });
    const preview = imageResponsePreview(body, 400);
    let calls = 0;
    const queue = new ImageTaskManager(store, { generate: async () => { calls++; throw new ImageError('IMAGE_HTTP_400', preview); }, load: async () => { throw new Error('Must not download'); } });
    try {
        const accepted = await queue.submit(scope, snapshot('https://example.com'), { operation: 'edit', prompt: 'test', size: '500x400', image: 'private-source' });
        await queue.idle();
        const done = await store.get(scope, accepted.taskId);
        assert.equal(done.status, 'failed'); assert.equal(done.error, 'IMAGE_HTTP_400'); assert.deepEqual(done.responsePreview, preview); assert.equal(calls, 1);
        const saved = await fs.readFile(path.join(cwd, '.LLSOAI/openapi-image-generation/tasks', done.taskId + '.json'), 'utf8');
        assert.equal(saved.includes('private-source'), false); assert.equal(saved.includes('test-only-secret'), false);
        for (const locale of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
            const message = imageResultMessage(done, locale);
            assert.ok(message.segments[0].text?.includes('IMAGE_HTTP_400'));
            assert.equal(message.segments[1].kind, 'code'); assert.equal(message.segments[1].text, `HTTP 400\n${body}`);
            const event = imageResultPrompt(done); assert.deepEqual(JSON.parse(event.slice('[image-generation-result]\n'.length)).responsePreview, preview);
            const restored = imageResultMessageFromPrompt(event, locale, Date.now());
            assert.equal(restored?.segments[1].text, message.segments[1].text);
        }
        const legacy = { ...done, responsePreview: undefined }; await store.save(legacy);
        assert.equal((await store.get(scope, done.taskId)).responsePreview, undefined);
        assert.equal(imageResultMessage(legacy, 'zh-cn').segments.length, 1);
    } finally { await queue.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});
