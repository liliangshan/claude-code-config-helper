/** @file 通用恢复控制器虚拟时钟回归测试。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestRecoveryController, RECOVERY_DELAYS_MS, classifyFailure, parseRetryAfter } from '../requestRecovery';

/** 无真实等待的单计时器测试宿主。 */
function harness(recover?: (signal: AbortSignal) => Promise<void>) {
    let now = 0;
    let next: { callback: () => void; at: number } | undefined;
    let calls = 0;
    const controller = new RequestRecoveryController({
        now: () => now,
        setTimer: (callback, delay) => { next = { callback, at: now + delay }; return next; },
        clearTimer: () => { next = undefined; },
        recover: async (_context, signal) => { calls++; await recover?.(signal); },
        notify: state => assert.equal('originalPrompt' in state, false)
    });
    controller.beginTurn({ turnId: 't', sessionId: 's', cliInstanceId: 'c', route: 'normal', originalPrompt: 'synthetic', deliveryState: 'accepted' });
    return { controller, calls: () => calls, delay: () => next ? next.at - now : undefined,
        tick: async () => { assert.ok(next); const timer = next; now = timer.at; next = undefined; timer.callback(); await Promise.resolve(); await Promise.resolve(); } };
}

/** 五档退避以每次失败为起点且重复终止不重复消耗。 */
test('five retries then exhaustion; manual retry rejects old identity', async () => {
    const h = harness(); const c = h.controller;
    for (const delay of RECOVERY_DELAYS_MS) {
        const id = c.getSnapshot()!;
        c.onCliTurnFinished(id, true, { status: 502 });
        c.onCliTurnFinished(id, true, { status: 502 });
        assert.equal(h.delay(), delay);
        await h.tick();
        c.onCliTurnFinished(id, false);
        assert.notEqual(c.getSnapshot()!.state, 'succeeded');
    }
    const last = c.getSnapshot()!;
    c.onCliTurnFinished(last, true, { status: 503 });
    assert.equal(h.calls(), 5); assert.equal(h.delay(), undefined);
    assert.equal(c.getSnapshot()!.state, 'exhausted');
    assert.equal(c.hasPendingRecovery(), true);
    assert.equal(c.retryManually(last), true);
    assert.equal(c.retryManually(last), false);
    await h.tick(); assert.equal(h.calls(), 6);
});

/** 请求命中和原生重试均不触发额外恢复；阻塞解除才可执行。 */
test('native retry, in-flight requests and blockers gate recovery', async () => {
    const h = harness(); const c = h.controller; const id = c.getSnapshot()!;
    c.onCliApiRetry(id, { status: 502 }); assert.equal(h.delay(), undefined);
    c.onRelayRequestStarted(id, 'r'); c.setBlocked(id, 'permission', true);
    c.onCliTurnFinished(id, true, { status: 502, retryAfter: '900' });
    assert.equal(h.delay(), undefined);
    c.onRelayRequestFinished(id, 'r'); assert.equal(h.delay(), undefined);
    c.setBlocked(id, 'permission', false); assert.equal(h.delay(), 900000);
    await h.tick(); assert.equal(h.calls(), 1);
    c.onCliTurnFinished(c.getSnapshot()!, false);
    assert.equal(c.getSnapshot()!.attemptsUsed, 0);
});

/** 取消异步恢复后旧动作通过信号停止，旧结果不更新新回合。 */
test('cancel during await aborts executor and isolates new generation', async () => {
    let release!: () => void;
    let sent = false;
    const h = harness(async signal => {
        await new Promise<void>(resolve => { release = resolve; });
        if (!signal.aborted) sent = true;
    });
    const c = h.controller; const old = c.getSnapshot()!;
    c.onCliTurnFinished(old, true, { code: 'ETIMEDOUT' });
    await h.tick();
    c.beginTurn({ ...old, turnId: 'new' });
    release(); await Promise.resolve(); await Promise.resolve();
    assert.equal(sent, false); assert.equal(c.getSnapshot()!.turnId, 'new');
    assert.equal(c.getSnapshot()!.attemptsUsed, 0);
    c.onCliTurnFinished(old, true, { status: 502 }); assert.equal(h.delay(), undefined);
    c.dispose(); assert.throws(() => c.beginTurn(old));
});

/** 未知与永久错误不自动发送；秒与日期格式分别解析。 */
test('classification and Retry-After preserve unknowns', () => {
    assert.equal(classifyFailure({ status: 429, code: 'insufficient_quota' }), 'permanent');
    assert.equal(classifyFailure({ status: 401 }), 'permanent');
    assert.equal(classifyFailure({ code: 'EAI_AGAIN' }), 'temporary');
    assert.equal(classifyFailure({}), 'unknown');
    assert.equal(parseRetryAfter('300', 0), 300000);
    assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:05:00 GMT', 0), 300000);
    assert.equal(parseRetryAfter('', 0), undefined);
    assert.equal(parseRetryAfter(-1, 0), undefined);
    assert.equal(parseRetryAfter('-1', 0), undefined);
    assert.equal(parseRetryAfter('Infinity', 0), undefined);
    const h = harness(); const c = h.controller;
    c.onCliTurnFinished({ ...c.getSnapshot()!, sessionId: 'other' }, true, { status: 502 });
    assert.equal(c.getSnapshot()!.state, 'awaiting_request');
    c.onCliTurnFinished(c.getSnapshot()!, undefined);
    assert.equal(c.getSnapshot()!.state, 'non_retryable'); assert.equal(h.delay(), undefined);
});
/** 停滞观察不得抢原生重试；恢复等待期间新请求会撤销重启。 */
test('request stall respects blockers and fresh activity', () => {
    const h = harness(); const c = h.controller; const id = c.getSnapshot()!;
    c.setBlocked(id, 'tool', true);
    assert.equal(c.onExpectedRequestTimeout(id), false);
    c.setBlocked(id, 'tool', false);
    assert.equal(c.onExpectedRequestTimeout(id), true);
    assert.equal(h.delay(), 120000);
    c.onRelayRequestStarted(id, 'fresh');
    assert.equal(h.delay(), undefined);
    assert.equal(c.getSnapshot()!.state, 'running');
    c.onCliApiRetry(id, { status: 502 });
    assert.equal(c.onExpectedRequestTimeout(id), false);
});

/** 首次会话只绑定一次，迟到旧身份不能触发恢复。 */
test('first session binding and terminal success after stall', () => {
    const h = harness(); const c = h.controller;
    const unknown = c.beginTurn({ ...c.getSnapshot()!, sessionId: '' });
    const bound = c.bindSession(unknown, 'new-session')!;
    assert.ok(bound);
    assert.equal(c.bindSession(bound, 'other'), undefined);
    c.onCliTurnFinished(unknown, true, { status: 502 });
    assert.equal(c.getSnapshot()!.state, 'awaiting_request');
    assert.equal(c.onExpectedRequestTimeout(bound), true);
    c.onCliTurnFinished(bound, false);
    assert.equal(c.getSnapshot()!.state, 'succeeded');
    assert.equal(h.delay(), undefined);
});

/** 压缩和权限同时阻塞时，必须全部解除才能恢复；取消后解除不复活队列。 */
test('compaction and permission blockers compose and cancellation prevents rescheduling', async () => {
    const h = harness(); const c = h.controller; const id = c.getSnapshot()!;
    c.setBlocked(id, 'compact', true);
    c.setBlocked(id, 'permission', true);
    assert.equal(c.onExpectedRequestTimeout(id), false);
    c.onCliTurnFinished(id, true, { status: 502 });
    assert.equal(h.delay(), undefined);
    c.setBlocked(id, 'compact', false);
    assert.equal(h.delay(), undefined);
    c.setBlocked(id, 'permission', false);
    assert.equal(h.delay(), 120000);
    c.cancelRecovery('user_cancel');
    c.setBlocked(id, 'compact', false);
    c.onCliTurnFinished(id, true, { status: 502 });
    assert.equal(h.delay(), undefined);
    assert.equal(h.calls(), 0);
    c.dispose();
});
