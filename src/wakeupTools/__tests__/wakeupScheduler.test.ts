/**
 * @file WakeupScheduler 单元测试：一次性语义、取消、补发与超长延迟分段。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WakeupScheduler } = require('../wakeupScheduler') as typeof import('../wakeupScheduler');

type WakeupJob = import('../wakeupStore').WakeupJob;
type WakeupStore = import('../wakeupStore').WakeupStore;

/** 纯内存的 WakeupStore 替身，避免测试触碰真实文件系统。 */
function makeStore(initial: WakeupJob[] = []): WakeupStore {
    let jobs = [...initial];
    return {
        load: () => Promise.resolve([...jobs]),
        saveAll: (next: WakeupJob[]) => { jobs = [...next]; return Promise.resolve(); },
        add: (job: WakeupJob) => {
            jobs = [...jobs.filter((item) => item.id !== job.id), job];
            return Promise.resolve();
        },
        remove: (id: string) => {
            const next = jobs.filter((item) => item.id !== id);
            const removed = next.length !== jobs.length;
            jobs = next;
            return Promise.resolve(removed);
        }
    } as unknown as WakeupStore;
}

/** 让出事件循环若干轮，等待 setTimeout(0) 与其后的 await 链跑完。 */
async function tick(times = 5): Promise<void> {
    for (let i = 0; i < times; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('schedule: 到点只触发一次，且触发后 store 中不再有该任务', async () => {
    const store = makeStore();
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    const job = await scheduler.schedule({ prompt: 'wake me', delaySeconds: 0.01 });
    await tick();

    assert.equal(fired.length, 1);
    assert.equal(fired[0].id, job.id);
    assert.deepEqual(await store.load(), []);
    scheduler.dispose();
});

test('cancel: 取消后不再触发，且磁盘中被移除', async () => {
    const store = makeStore();
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    const job = await scheduler.schedule({ prompt: 'wake me', delaySeconds: 0.05 });
    assert.equal(await scheduler.cancel(job.id), true);
    await tick();

    assert.equal(fired.length, 0);
    assert.deepEqual(await store.load(), []);
    scheduler.dispose();
});

test('cancel: 未命中的 id 返回 false', async () => {
    const scheduler = new WakeupScheduler(makeStore(), async () => { /* noop */ });
    assert.equal(await scheduler.cancel('nope'), false);
    scheduler.dispose();
});

test('restore: 已过期的任务立即补发一次并清除', async () => {
    const expired: WakeupJob = {
        id: 'expired-1',
        prompt: 'missed while closed',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        fireAt: new Date(Date.now() - 1_000).toISOString()
    };
    const store = makeStore([expired]);
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    await scheduler.restore();

    assert.deepEqual(fired.map((job) => job.id), ['expired-1']);
    assert.deepEqual(await store.load(), []);
    scheduler.dispose();
});

test('restore: 未到点的任务重新武装而非立即触发', async () => {
    const future: WakeupJob = {
        id: 'future-1',
        prompt: 'later',
        createdAt: new Date().toISOString(),
        fireAt: new Date(Date.now() + 60_000).toISOString()
    };
    const store = makeStore([future]);
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    await scheduler.restore();
    await tick();

    assert.equal(fired.length, 0);
    assert.deepEqual((await store.load()).map((job) => job.id), ['future-1']);
    scheduler.dispose();
});

test('arm: 超过 setTimeout 上限的超长延迟不会立即触发（分段续期）', async () => {
    const store = makeStore();
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    await scheduler.schedule({ prompt: 'in 30 days', delaySeconds: 30 * 24 * 3600 });
    await tick();

    assert.equal(fired.length, 0);
    assert.equal((await store.load()).length, 1);
    scheduler.dispose();
});

test('onFire 抛错不影响一次性语义（任务仍已从磁盘移除）', async () => {
    const store = makeStore();
    const scheduler = new WakeupScheduler(store, () => Promise.reject(new Error('chat not ready')));

    await scheduler.schedule({ prompt: 'boom', delaySeconds: 0.01 });
    await tick();

    assert.deepEqual(await store.load(), []);
    scheduler.dispose();
});

test('schedule: at 优先于 delaySeconds', async () => {
    const at = new Date(Date.now() + 120_000).toISOString();
    const scheduler = new WakeupScheduler(makeStore(), async () => { /* noop */ });

    const job = await scheduler.schedule({ prompt: 'x', at, delaySeconds: 1 });

    assert.equal(job.fireAt, at);
    scheduler.dispose();
});

test('repeat: 循环 3 次会触发 3 次后自动清除', async () => {
    const store = makeStore();
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    await scheduler.schedule({ prompt: 'ping', delaySeconds: 0.01, intervalSeconds: 0.01, repeatCount: 3 });
    await tick(20);

    assert.equal(fired.length, 3);
    assert.deepEqual(fired.map((job) => job.firedCount), [1, 2, 3]);
    assert.deepEqual(await store.load(), []);
    scheduler.dispose();
});

test('repeat: 循环任务的 id 在每一轮保持不变（便于取消）', async () => {
    const store = makeStore();
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    const job = await scheduler.schedule({ prompt: 'ping', delaySeconds: 0.01, intervalSeconds: 0.01, repeatCount: 2 });
    await tick(20);

    assert.deepEqual(fired.map((item) => item.id), [job.id, job.id]);
    scheduler.dispose();
});

test('repeat: 中途 cancel 后停止后续轮次', async () => {
    const store = makeStore();
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    const job = await scheduler.schedule({ prompt: 'ping', delaySeconds: 0.01, intervalSeconds: 0.2, repeatCount: 5 });
    await tick(6);
    assert.equal(fired.length, 1);

    assert.equal(await scheduler.cancel(job.id), true);
    await tick(60);

    assert.equal(fired.length, 1);
    assert.deepEqual(await store.load(), []);
    scheduler.dispose();
});

test('repeat: 未给 intervalSeconds 时按一次性处理', async () => {
    const store = makeStore();
    const fired: WakeupJob[] = [];
    const scheduler = new WakeupScheduler(store, async (job) => { fired.push(job); });

    await scheduler.schedule({ prompt: 'ping', delaySeconds: 0.01, repeatCount: 3 });
    await tick(20);

    assert.equal(fired.length, 1);
    assert.deepEqual(await store.load(), []);
    scheduler.dispose();
});
