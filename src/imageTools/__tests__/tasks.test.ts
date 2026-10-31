/** @file Image network and asynchronous task tests use temporary storage and local simulated APIs only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateImages, loadGeneratedImage, isPublicImageAddress, imageType } from '../imageClient';
import { ImageTaskManager } from '../taskManager';
import { ImageTaskStore } from '../taskStore';
import { readImageRequest, forwardImageTool } from '../transport';
import { Readable } from 'node:stream';
import { defaultImageConfig, IMAGE_BODY_LIMIT, type ImageGenerationExecutionSnapshot, type ImageTask } from '../types';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const scopeA = 'a'.repeat(64), scopeB = 'b'.repeat(64);
/** Construct a non-secret test snapshot targeting a local mock when supplied. */
function snapshot(base = 'https://example.com'): ImageGenerationExecutionSnapshot {
    return { config: { ...defaultImageConfig(), enabled: true, revision: 1, modelId: 'test-image', editEnabled: true },
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-only-key' }, providerName: 'Test', generationUrl: base + '/generations', editUrl: base + '/edits' };
}

test('image transport enforces the same 4 MiB cap before network dispatch and while reading streams', async () => {
    const request = Readable.from([Buffer.alloc(IMAGE_BODY_LIMIT), Buffer.from('x')]) as unknown as http.IncomingMessage;
    await assert.rejects(readImageRequest(request), /IMAGE_PAYLOAD_TOO_LARGE/);
    await assert.rejects(forwardImageTool(new URL('http://127.0.0.1:1/tools'), 'openapi_edit_image', { image: 'a'.repeat(IMAGE_BODY_LIMIT) }), /IMAGE_PAYLOAD_TOO_LARGE/);
    const small = Readable.from([Buffer.from('{"name":'), Buffer.from('"test"}')]) as unknown as http.IncomingMessage;
    assert.equal(await readImageRequest(small), '{"name":"test"}');
});

test('image address guards block private IPv4/IPv6 and malformed raster data', async () => {
    for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '192.168.0.2', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::']) assert.equal(isPublicImageAddress(address), false, address);
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicImageAddress(address), true, address);
    assert.throws(() => imageType(Buffer.from('<svg/>')), /IMAGE_FORMAT_UNSUPPORTED/);
    await assert.rejects(loadGeneratedImage({ url: 'http://127.0.0.1/image.png' }, 1024, new AbortController().signal), /IMAGE_DOWNLOAD_BLOCKED/);
    assert.deepEqual(await loadGeneratedImage({ b64_json: png.toString('base64'), url: 'http://127.0.0.1/blocked' }, 1024, new AbortController().signal), png);
});

test('Images client sends one JSON edit request and never follows API redirects or retries failures', async () => {
    const requests: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push({ url: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        if (req.url === '/redirect/generations') { res.writeHead(302, { location: '/generations' }); res.end(); }
        else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
        const result = await generateImages(snapshot(base), { operation: 'edit', prompt: 'combine', size: '1024x1024', image: ['https://example.com/a.png', png.toString('base64')] }, new AbortController().signal);
        assert.equal(result.length, 1); assert.equal(requests[0].url, '/edits'); assert.equal(requests[0].headers.authorization, 'Bearer test-only-key');
        assert.deepEqual(Object.keys(requests[0].body).sort(), ['image', 'model', 'prompt', 'size']);
        await assert.rejects(generateImages(snapshot(base + '/redirect'), { operation: 'generate', prompt: 'test', size: '1024x1024' }, new AbortController().signal), /IMAGE_HTTP_302/);
        assert.equal(requests.length, 2);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('queue freezes accepted settings, separates scopes and never persists sources or authentication', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-tasks-')); const store = new ImageTaskStore(cwd);
    const models: string[] = []; let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const queue = new ImageTaskManager(store, { generate: async config => { models.push(config.config.modelId); await blocked; return [{}, {}]; }, load: async item => { if (item === null) throw new Error('bad'); return png; } });
    try {
        const firstConfig = snapshot(); const first = await queue.submit(scopeA, firstConfig, { operation: 'edit', prompt: 'first', size: '1024x1024', image: 'private-source-data' });
        firstConfig.config.modelId = 'changed-after-submit'; firstConfig.headers.authorization = 'changed-key';
        const second = await queue.submit(scopeB, snapshot(), { operation: 'generate', prompt: 'second', size: '1024x1024' });
        assert.equal(first.status, 'queued'); assert.equal(second.status, 'queued');
        await assert.rejects(store.get(scopeB, first.taskId), /IMAGE_TASK_NOT_FOUND/);
        release(); await queue.idle();
        assert.deepEqual(models, ['test-image', 'test-image']);
        const done = await store.get(scopeA, first.taskId); assert.equal(done.status, 'succeeded'); assert.equal(done.images.length, 2);
        const text = await fs.readFile(path.join(cwd, '.LLSOAI/openapi-image-generation/tasks', first.taskId + '.json'), 'utf8');
        assert.ok(!text.includes('private-source-data')); assert.ok(!text.includes('test-only-key')); assert.ok(!text.includes('authorization'));
        assert.equal((await store.list(scopeB)).length, 1);
        const imagePath = await store.imagePath(scopeA, first.taskId, done.images[0].id); assert.deepEqual(await fs.readFile(imagePath), png);
        assert.equal(imagePath, path.join(await fs.realpath(cwd), '.LLSOAI/openapi-image-generation', done.images[0].relativePath));
        await assert.rejects(fs.stat(path.join(cwd, '.LLSOAI/openapi-image-generation/scopes')), { code: 'ENOENT' });
        await assert.rejects(store.imagePath(scopeA, first.taskId, '../other'), /IMAGE_TASK_NOT_FOUND/);
        const other = new ImageTaskStore(cwd); await assert.rejects(other.acquire(), /IMAGE_STORAGE_LOCKED/);
    } finally { release(); await queue.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});

test('queue rejects overflow, preserves partial images and interrupts without replay', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-task-limits-')); const store = new ImageTaskStore(cwd);
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const queue = new ImageTaskManager(store, { generate: async () => { await blocked; return [{}, null]; }, load: async item => { if (item === null) throw new Error('bad image'); return png; } });
    try {
        queue.configure(1, 1);
        const first = await queue.submit(scopeA, snapshot(), { operation: 'generate', prompt: 'one', size: '1x1' });
        const second = await queue.submit(scopeB, snapshot(), { operation: 'generate', prompt: 'two', size: '1x1' });
        await assert.rejects(queue.submit(scopeA, snapshot(), { operation: 'generate', prompt: 'three', size: '1x1' }), /IMAGE_QUEUE_FULL/);
        await queue.interruptScope(scopeB); release(); await queue.idle();
        assert.equal((await store.get(scopeB, second.taskId)).status, 'interrupted');
        assert.equal((await store.get(scopeA, first.taskId)).status, 'partially_failed');
        assert.equal((await store.get(scopeA, first.taskId)).images.length, 1);
    } finally { release(); await queue.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});

test('flat image storage preserves reference MCP tasks and recovers only extension-owned metadata', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-flat-store-')); const store = new ImageTaskStore(cwd);
    try {
        const directory = path.join(cwd, '.LLSOAI/openapi-image-generation/tasks'); await fs.mkdir(directory, { recursive: true });
        const externalId = `20261002T081530123Z_${randomUUID()}`;
        const external = { schemaVersion: 1, taskId: externalId, projectName: 'openapi-image-generation', operation: 'generate', prompt: 'external', status: 'running', images: [] };
        const externalText = JSON.stringify(external); await fs.writeFile(path.join(directory, externalId + '.json'), externalText);
        await store.acquire();
        assert.deepEqual(await store.list(scopeA), []); await assert.rejects(store.get(scopeA, externalId), /IMAGE_TASK_NOT_FOUND/);
        assert.equal(await fs.readFile(path.join(directory, externalId + '.json'), 'utf8'), externalText);
        const task: ImageTask = { version: 1, taskId: `20261002T081530124Z_${randomUUID()}`, scopeId: scopeA, operation: 'generate', prompt: 'owned', model: 'test', configRevision: 1, size: '1536x1024', status: 'queued', createdAt: Date.now(), images: [] };
        await store.save(task, true); await store.release(); await store.acquire();
        assert.equal((await store.get(scopeA, task.taskId)).status, 'interrupted');
        assert.equal(await fs.readFile(path.join(directory, externalId + '.json'), 'utf8'), externalText);
        await assert.rejects(store.get(scopeB, task.taskId), /IMAGE_TASK_NOT_FOUND/);
    } finally { await store.release(); await fs.rm(cwd, { recursive: true, force: true }); }
});

test('read-only task lists create no directories; recovery marks unfinished metadata and rejects symlinks', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-recovery-')); const store = new ImageTaskStore(cwd);
    try {
        assert.deepEqual(await store.list(scopeA), []); assert.deepEqual(await fs.readdir(cwd), []);
        await store.acquire();
        const task: ImageTask = { version: 1, taskId: `20261002T081530123Z_${randomUUID()}`, scopeId: scopeA, operation: 'edit', prompt: 'restore', model: 'test-image', configRevision: 1, size: '1x1', status: 'running', createdAt: Date.now(), images: [] };
        await store.save(task, true); await store.release(); await store.acquire();
        assert.equal((await store.get(scopeA, task.taskId)).status, 'interrupted');
        await store.release();
        const images = path.join(cwd, '.LLSOAI/openapi-image-generation/images'); await fs.mkdir(images);
        await fs.rmdir(images); await fs.symlink(cwd, images);
        await assert.rejects(store.imagePath(scopeA, task.taskId, 'absent'), /IMAGE_TASK_NOT_FOUND/);
        await store.acquire();
        await assert.rejects(store.saveImage(scopeB, png), /IMAGE_STORAGE_FAILED/);
    } finally { await store.release(); await fs.rm(cwd, { recursive: true, force: true }); }
});
