/** @file 请求身份与统计口径回归测试。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestUsageContext, normalizeRequestUsage, readRequestSessionId } from '../requestUsage';

const context = createRequestUsageContext({ metadata: { session_id: 'session-a' } }, 'normal', 'p', 'm');

test('request identity is unique, frozen and independent of later body mutation', () => {
    const body = { metadata: { session_id: 'first' } };
    const a = createRequestUsageContext(body, 'taskFlow', 'provider', 'model', true);
    body.metadata.session_id = 'second';
    const b = createRequestUsageContext(body, 'normal', 'p2', 'm2');
    assert.notEqual(a.requestId, b.requestId);
    assert.equal(a.sessionId, 'first');
    assert.equal(a.modelId, 'model');
    assert.equal(a.compactCommandTriggered, true);
    assert.ok(Object.isFrozen(a));
    assert.equal(readRequestSessionId({ metadata: { user_id: '{"session_id":"nested"}' } }), 'nested');
    for (const user_id of ['arbitrary-user', '{invalid', 'null', '12']) {
        assert.equal(readRequestSessionId({ metadata: { user_id } }), '');
    }
});

test('normalized cache hit uses all input components exactly once', () => {
    const summary = normalizeRequestUsage(context, {
        inputTokens: 3000, cacheReadInputTokens: 22000, cacheCreationInputTokens: 1000, outputTokens: 842
    }, 'completed');
    assert.equal(summary.totalInputTokens, 26000);
    assert.equal(summary.cacheHitRate, 84.62);
    assert.equal(summary.completeness, 'complete');
});

test('missing and invalid tokens are not coerced to zero', () => {
    assert.equal(normalizeRequestUsage(context, {}, 'completed').completeness, 'missing');
    for (const value of [undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const s = normalizeRequestUsage(context, { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: value }, 'completed');
        assert.equal(s.cacheReadInputTokens, undefined);
        assert.equal(s.totalInputTokens, undefined);
        assert.equal(s.cacheHitRate, undefined);
        assert.equal(s.completeness, 'partial');
    }
});

test('zero tokens and interrupted usage remain distinguishable', () => {
    const tokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const s = normalizeRequestUsage(context, tokens, 'completed');
    assert.equal(s.totalInputTokens, 0);
    assert.equal(s.cacheHitRate, undefined);
    assert.equal(s.completeness, 'complete');
    for (const status of ['pending', 'error', 'timeout', 'aborted'] as const) {
        assert.equal(normalizeRequestUsage(context, tokens, status).completeness, 'partial');
    }
    assert.equal(normalizeRequestUsage(context, { ...tokens, inputTokens: 100 }, 'completed').cacheHitRate, 0);
});

