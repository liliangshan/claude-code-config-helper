/** @file Lock-free task ownership and Windows checkpoint replacement regressions; no paid API calls. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImageTaskStore } from '../taskStore';
import { ImageTaskManager } from '../taskManager';
import { replaceImageJson } from '../storage';
import { ImageError, defaultImageConfig, type ImageTask, type ImageGenerationExecutionSnapshot } from '../types';

/** Construct a task record with a unique file identity and no credentials. */
function task(scope: string): ImageTask {
    return { version: 1, taskId: `20261102T000000000Z_${randomUUID()}`, scopeId: scope, operation: 'generate', prompt: 'test', model: 'fixture',
        size: '1x1', configRevision: 1, createdAt: Date.now(), status: 'queued', images: [] };
}
/** Provide only local mock generation settings; the URLs are never contacted. */
function snapshot(): ImageGenerationExecutionSnapshot {
    return { config: { ...defaultImageConfig(), enabled: true, modelId: 'fixture' }, generationUrl: 'https://example.invalid/generate',
        editUrl: 'https://example.invalid/edit', headers: {}, providerName: 'fixture' };
}

/** Independent stores can update only their own UUIDs, without reading or removing legacy locks. */
test('separate writers share a workspace without runtime.lock and cannot overwrite each other', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-independent-writers-'));
    const a = new ImageTaskStore(cwd), b = new ImageTaskStore(cwd), c = new ImageTaskStore(cwd);
    const scope = 'a'.repeat(64), one = task(scope), two = task(scope);
    try {
        await Promise.all([a.acquire(), b.acquire()]);
        const lock = path.join(cwd, '.LLSOAI/openapi-image-generation/runtime.lock');
        await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
        await fs.writeFile(lock, 'legacy owner marker, not a new queue lock');
        await Promise.all([a.save(one, true), b.save(two, true)]);
        await assert.rejects(b.save({ ...one, status: 'failed' }), /IMAGE_TASK_NOT_OWNED/);
        await assert.rejects(b.save(one, true), { code: 'EEXIST' });
        one.status = 'running'; two.status = 'running';
        await Promise.all([a.save(one), b.save(two)]);
        await c.acquire();
        assert.equal((await c.get(scope, one.taskId)).status, 'running');
        assert.equal((await c.get(scope, two.taskId)).status, 'running');
        await a.release();
        two.status = 'succeeded'; await b.save(two);
        assert.equal((await c.get(scope, two.taskId)).status, 'succeeded');
        assert.equal(await fs.readFile(lock, 'utf8'), 'legacy owner marker, not a new queue lock');
        await assert.rejects(c.save(two), /IMAGE_TASK_NOT_OWNED/);
    } finally { await Promise.all([a.release(), b.release(), c.release()]); await fs.rm(cwd, { recursive: true, force: true }); }
});

/** Windows transient replacement errors retry only rename and preserve the old target on permanent failure. */
test('Windows replacement retries sharing errors without deleting or truncating an existing JSON', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-windows-replace-'));
    const file = path.join(cwd, 'task.json'), temporary = path.join(cwd, 'new.tmp');
    const filesystem = require('node:fs/promises') as typeof fs;
    const original = filesystem.rename;
    try {
        await fs.writeFile(file, '{"status":"queued"}'); await fs.writeFile(temporary, '{"status":"running"}');
        let attempts = 0;
        const rename = t.mock.method(filesystem, 'rename', async (source: string, destination: string) => {
            attempts++;
            if (attempts < 4) throw Object.assign(new Error('sharing violation'), { code: ['EPERM', 'EACCES', 'EBUSY'][attempts - 1] });
            return original(source, destination);
        });
        await replaceImageJson(temporary, file, 'win32');
        assert.equal(attempts, 4); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'running');
        rename.mock.restore();
        await fs.writeFile(temporary, '{"status":"succeeded"}');
        const alwaysBusy = t.mock.method(filesystem, 'rename', async () => { throw Object.assign(new Error('permanent sharing violation'), { code: 'EPERM' }); });
        await assert.rejects(replaceImageJson(temporary, file, 'win32'), /IMAGE_STORAGE_RENAME_EPERM/);
        assert.equal(alwaysBusy.mock.callCount(), 6);
        assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'running');
        assert.equal(JSON.parse(await fs.readFile(temporary, 'utf8')).status, 'succeeded');
        alwaysBusy.mock.restore();
        const noRetry = t.mock.method(filesystem, 'rename', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
        await assert.rejects(replaceImageJson(temporary, file, 'win32'), /IMAGE_STORAGE_RENAME_ENOSPC/);
        assert.equal(noRetry.mock.callCount(), 1);
    } finally { t.mock.restoreAll(); await fs.rm(cwd, { recursive: true, force: true }); }
});

/** A damaged checkpoint fails just that task, exposes the real code and never stops subsequent accepted tasks. */
test('failed running checkpoints never call the provider or disable unrelated image tasks', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-task-failure-isolation-'));
    const store = new ImageTaskStore(cwd); let calls = 0;
    const queue = new ImageTaskManager(store, { generate: async () => { calls++; return [{}]; }, load: async () => Buffer.from('89504e470d0a1a0a', 'hex') });
    const diagnostics: any[] = []; queue.on('storageFailure', value => diagnostics.push(value));
    const scope = 'b'.repeat(64); let brokenId: string | undefined;
    const save = store.save.bind(store);
    t.mock.method(store, 'save', async (value: ImageTask, exclusive = false) => {
        if (exclusive && !brokenId) brokenId = value.taskId;
        if (!exclusive && value.taskId === brokenId) throw new ImageError('IMAGE_STORAGE_RENAME_EPERM');
        return save(value, exclusive);
    });
    try {
        const first = await queue.submit(scope, snapshot(), { operation: 'generate', prompt: 'first', size: '1x1' });
        await queue.idle();
        assert.equal(calls, 0); assert.equal((await store.get(scope, first.taskId)).status, 'queued');
        const visible = queue.visibleTasks(scope, await store.list(scope));
        assert.equal(visible[0].status, 'failed'); assert.equal(visible[0].error, 'IMAGE_STORAGE_RENAME_EPERM');
        assert.deepEqual(queue.visibleTasks('c'.repeat(64), visible), []);
        assert.deepEqual(diagnostics.map(item => item.stage), ['running', 'terminal']);
        const second = await queue.submit(scope, snapshot(), { operation: 'generate', prompt: 'second', size: '1x1' });
        await queue.idle();
        assert.equal(calls, 1); assert.equal((await store.get(scope, second.taskId)).status, 'succeeded');
        assert.equal(diagnostics.every(item => item.code === 'IMAGE_STORAGE_RENAME_EPERM'), true);
    } finally { await queue.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});

/** Concurrent checkpoint requests for one task preserve order even if the first publication is slow. */
test('one task serializes its checkpoints while a different task can publish independently', async t => {
    const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'image-checkpoint-order-')));
    const store = new ImageTaskStore(cwd), scope = 'e'.repeat(64), first = task(scope), other = task(scope);
    const filesystem = require('node:fs/promises') as typeof fs, original = filesystem.rename;
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const published: string[] = [];
    try {
        await store.acquire(); await Promise.all([store.save(first, true), store.save(other, true)]);
        t.mock.method(filesystem, 'rename', async (source: string, destination: string) => {
            const value = JSON.parse(await fs.readFile(source, 'utf8'));
            if (destination.endsWith(first.taskId + '.json') && value.status === 'running') { entered(); await gate; }
            published.push(`${value.taskId}:${value.status}`); return original(source, destination);
        });
        const running = store.save({ ...first, status: 'running' }); await blocked;
        const finished = store.save({ ...first, status: 'succeeded' });
        await store.save({ ...other, status: 'running' });
        assert.deepEqual(published, [`${other.taskId}:running`]);
        unblock(); await Promise.all([running, finished]);
        assert.deepEqual(published, [`${other.taskId}:running`, `${first.taskId}:running`, `${first.taskId}:succeeded`]);
        assert.equal((await store.get(scope, first.taskId)).status, 'succeeded');
    } finally { unblock(); t.mock.restoreAll(); await store.release(); await fs.rm(cwd, { recursive: true, force: true }); }
});

/** Two queues execute concurrently without one host's initialization or shutdown interrupting the other's task. */
test('multiple queues run concurrently and closing one leaves the other task intact', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-multiple-queues-'));
    const a = new ImageTaskStore(cwd), b = new ImageTaskStore(cwd), reader = new ImageTaskStore(cwd);
    let release!: () => void, bothStarted!: () => void, count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { bothStarted = resolve; });
    const client = { generate: async () => { if (++count === 2) bothStarted(); await gate; return [{}]; }, load: async () => Buffer.from('89504e470d0a1a0a', 'hex') };
    const left = new ImageTaskManager(a, client), right = new ImageTaskManager(b, client);
    const scope = 'd'.repeat(64);
    try {
        const [first, second] = await Promise.all([left.submit(scope, snapshot(), { operation: 'generate', prompt: 'left', size: '1x1' }), right.submit(scope, snapshot(), { operation: 'generate', prompt: 'right', size: '1x1' })]);
        await started; await reader.acquire();
        assert.equal((await reader.get(scope, first.taskId)).status, 'running');
        assert.equal((await reader.get(scope, second.taskId)).status, 'running');
        release(); await Promise.all([left.idle(), right.idle()]); await left.close();
        assert.equal((await reader.get(scope, second.taskId)).status, 'succeeded');
        const third = await right.submit(scope, snapshot(), { operation: 'generate', prompt: 'right again', size: '1x1' }); await right.idle();
        assert.equal((await reader.get(scope, third.taskId)).status, 'succeeded');
        await assert.rejects(fs.stat(path.join(cwd, '.LLSOAI/openapi-image-generation/runtime.lock')), { code: 'ENOENT' });
    } finally { release(); await Promise.all([left.close(), right.close(), reader.release()]); await fs.rm(cwd, { recursive: true, force: true }); }
});
