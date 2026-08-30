/**
 * @file WakeupHost 单元测试：参数校验、列表文案与取消回报。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WakeupHost } = require('../wakeupHost') as typeof import('../wakeupHost');

type WakeupJob = import('../wakeupStore').WakeupJob;
type WakeupScheduler = import('../wakeupScheduler').WakeupScheduler;
type WakeupScheduleInput = import('../wakeupScheduler').WakeupScheduleInput;
type WakeupToolResult = import('../wakeupHost').WakeupToolResult;

/** 记录调用的 WakeupScheduler 替身。 */
function makeScheduler(options: { jobs?: WakeupJob[]; cancelResult?: boolean } = {}) {
    const scheduled: WakeupScheduleInput[] = [];
    const cancelled: string[] = [];
    const scheduler = {
        schedule: (input: WakeupScheduleInput) => {
            scheduled.push(input);
            const fireAtMs = input.at !== undefined
                ? Date.parse(input.at)
                : Date.now() + (input.delaySeconds ?? 0) * 1000;
            return Promise.resolve({
                id: 'job-1',
                prompt: input.prompt,
                reason: input.reason,
                createdAt: new Date().toISOString(),
                fireAt: new Date(fireAtMs).toISOString(),
                intervalSeconds: input.intervalSeconds,
                remainingFires: input.repeatCount ?? 1,
                firedCount: 0
            } satisfies WakeupJob);
        },
        list: () => Promise.resolve(options.jobs ?? []),
        cancel: (id: string) => {
            cancelled.push(id);
            return Promise.resolve(options.cancelResult ?? true);
        }
    } as unknown as WakeupScheduler;
    return { scheduler, scheduled, cancelled };
}

/** 取出结果中的首个文本块。 */
function textOf(result: WakeupToolResult): string {
    return result.content[0]?.text ?? '';
}

test('schedule: prompt 缺失时返回参数错误且不下单', async () => {
    const { scheduler, scheduled } = makeScheduler();
    const host = new WakeupHost(scheduler);

    const result = await host.execute('lls-ccai-schedule-wakeup', { delaySeconds: 60 });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /prompt/);
    assert.equal(scheduled.length, 0);
});

test('schedule: 时间字段全缺时返回参数错误', async () => {
    const { scheduler, scheduled } = makeScheduler();
    const host = new WakeupHost(scheduler);

    const result = await host.execute('lls-ccai-schedule-wakeup', { prompt: 'hi' });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /delaySeconds/);
    assert.match(textOf(result), /at/);
    assert.equal(scheduled.length, 0);
});

test('schedule: at 非法或已过期时视为未提供时间', async () => {
    const { scheduler } = makeScheduler();
    const host = new WakeupHost(scheduler);

    const invalid = await host.execute('lls-ccai-schedule-wakeup', { prompt: 'hi', at: 'not-a-date' });
    const past = await host.execute('lls-ccai-schedule-wakeup', {
        prompt: 'hi',
        at: new Date(Date.now() - 60_000).toISOString()
    });

    assert.equal(invalid.isError, true);
    assert.equal(past.isError, true);
});

test('schedule: delaySeconds 非正数时无效，正数时下单成功', async () => {
    const { scheduler, scheduled } = makeScheduler();
    const host = new WakeupHost(scheduler);

    const zero = await host.execute('lls-ccai-schedule-wakeup', { prompt: 'hi', delaySeconds: 0 });
    assert.equal(zero.isError, true);

    const ok = await host.execute('lls-ccai-schedule-wakeup', { prompt: 'hi', delaySeconds: 60 });
    assert.equal(ok.isError, undefined);
    assert.match(textOf(ok), /Wakeup scheduled: id=job-1, fireAt=.+, in \d+s\./);
    assert.deepEqual(scheduled.map((input) => input.delaySeconds), [60]);
});

test('schedule: at 与 delaySeconds 同时给出时两者都透传，由调度器以 at 为准', async () => {
    const at = new Date(Date.now() + 120_000).toISOString();
    const { scheduler, scheduled } = makeScheduler();
    const host = new WakeupHost(scheduler);

    const result = await host.execute('lls-ccai-schedule-wakeup', { prompt: 'hi', at, delaySeconds: 5 });

    assert.equal(result.isError, undefined);
    assert.equal(scheduled[0].at, at);
    assert.match(textOf(result), new RegExp(`fireAt=${at}`));
});

test('list: 空集合返回固定文案', async () => {
    const host = new WakeupHost(makeScheduler({ jobs: [] }).scheduler);

    const result = await host.execute('lls-ccai-list-wakeups');

    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), 'No scheduled wakeups.');
});

test('list: 按 fireAt 升序输出且携带 reason', async () => {
    const jobs: WakeupJob[] = [
        { id: 'b', prompt: 'later', createdAt: 'x', fireAt: '2026-09-01T00:00:00.000Z' },
        { id: 'a', prompt: 'sooner', reason: 'check CI', createdAt: 'x', fireAt: '2026-08-01T00:00:00.000Z' }
    ];
    const host = new WakeupHost(makeScheduler({ jobs }).scheduler);

    const lines = textOf(await host.execute('lls-ccai-list-wakeups')).split('\n');

    assert.equal(lines.length, 2);
    assert.match(lines[0], /^id=a /);
    assert.match(lines[0], /reason=check CI/);
    assert.match(lines[1], /^id=b /);
});

test('cancel: id 缺失时返回参数错误；命中与未命中文案不同', async () => {
    const hit = new WakeupHost(makeScheduler({ cancelResult: true }).scheduler);
    const miss = new WakeupHost(makeScheduler({ cancelResult: false }).scheduler);

    const missingId = await hit.execute('lls-ccai-cancel-wakeup', {});
    assert.equal(missingId.isError, true);
    assert.match(textOf(missingId), /id/);

    assert.match(textOf(await hit.execute('lls-ccai-cancel-wakeup', { id: 'job-1' })), /Wakeup cancelled/);
    assert.match(textOf(await miss.execute('lls-ccai-cancel-wakeup', { id: 'job-1' })), /No scheduled wakeup/);
});

test('execute: 调度器抛错时包成 isError 文本结果', async () => {
    const scheduler = { list: () => Promise.reject(new Error('disk gone')) } as unknown as WakeupScheduler;
    const host = new WakeupHost(scheduler);

    const result = await host.execute('lls-ccai-list-wakeups');

    assert.equal(result.isError, true);
    assert.match(textOf(result), /disk gone/);
});

test('schedule: repeatCount > 1 但缺 intervalSeconds 时返回参数错误', async () => {
    const { scheduler, scheduled } = makeScheduler();
    const host = new WakeupHost(scheduler);

    const result = await host.execute('lls-ccai-schedule-wakeup', {
        prompt: 'ping', delaySeconds: 10, repeatCount: 3
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /intervalSeconds/);
    assert.equal(scheduled.length, 0);
});

test('schedule: 循环参数透传，并在结果里说明循环与取消方法', async () => {
    const { scheduler, scheduled } = makeScheduler();
    const host = new WakeupHost(scheduler);

    const result = await host.execute('lls-ccai-schedule-wakeup', {
        prompt: 'ping', delaySeconds: 10, repeatCount: 3, intervalSeconds: 60
    });

    assert.equal(result.isError, undefined);
    assert.equal(scheduled[0].repeatCount, 3);
    assert.equal(scheduled[0].intervalSeconds, 60);
    assert.match(textOf(result), /Repeats 3 times every 60s/);
    assert.match(textOf(result), /lls-ccai-cancel-wakeup/);
    assert.match(textOf(result), /"id":"job-1"/);
});

test('list: 循环任务展示间隔与剩余次数', async () => {
    const jobs: WakeupJob[] = [
        {
            id: 'a', prompt: 'ping', createdAt: 'x', fireAt: '2026-08-01T00:00:00.000Z',
            intervalSeconds: 30, remainingFires: 2, firedCount: 1
        }
    ];
    const host = new WakeupHost(makeScheduler({ jobs }).scheduler);

    const text = textOf(await host.execute('lls-ccai-list-wakeups'));

    assert.match(text, /every=30s/);
    assert.match(text, /remaining=2/);
    assert.match(text, /fired=1/);
});
