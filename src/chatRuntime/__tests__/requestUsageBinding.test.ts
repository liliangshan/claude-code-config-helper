/** @file 请求归属精确匹配与乱序回归测试。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestUsageRegistry } from '../requestUsage';
import { createRequestUsageContext, normalizeRequestUsage } from '../../relay/requestUsage';

test('parallel requests remain isolated when reports arrive out of order', () => {
    const registry = new RequestUsageRegistry();
    const a = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'a');
    const b = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'b');
    registry.registerRequest(a); registry.registerRequest(b);
    registry.bindResponseMessage(a.requestId, 's', 'ma');
    registry.bindResponseMessage(b.requestId, 's', 'cb', 'tool');
    registry.recordRequestUsage(normalizeRequestUsage(b, { inputTokens: 2 }, 'completed'));
    registry.recordRequestUsage(normalizeRequestUsage(a, { inputTokens: 1 }, 'completed'));
    assert.equal(registry.resolveRequestForSegment('s', 'ma')?.modelId, 'a');
    assert.equal(registry.resolveRequestForSegment('s', undefined, 'cb')?.modelId, 'b');
    assert.equal(registry.resolveRequestForSegment('s', 'ma', 'cb'), undefined);
    assert.equal(registry.resolveRequestForSegment('other', 'ma'), undefined);
    assert.equal(registry.resolveRequestForSegment('s', 'unknown-response', 'cb'), undefined, 'A known call ID cannot override an unknown explicit message identity');
    registry.bindResponseMessage(b.requestId, 's', 'ma');
    assert.equal(registry.resolveRequestForSegment('s', 'ma'), undefined);
    registry.clearRequestUsageBindings();
    assert.equal(registry.recordRequestUsage(normalizeRequestUsage(a, {}, 'completed')), false);
    assert.equal(registry.resolveRequestForSegment('s', undefined, 'cb'), undefined);
});

test('unknown sessions and compaction are not assigned; pruning removes completed bindings', () => {
    const registry = new RequestUsageRegistry();
    const unknown = createRequestUsageContext({}, 'normal', 'p', 'm');
    registry.registerRequest(unknown);
    assert.equal(registry.bindResponseMessage(unknown.requestId, '', 'id'), false);
    const compact = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'm', true);
    registry.registerRequest(compact);
    assert.equal(registry.bindResponseMessage(compact.requestId, 's', 'id'), false);
    const a = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'm');
    registry.registerRequest(a);
    registry.recordRequestUsage(normalizeRequestUsage(a, {}, 'completed'));
    registry.bindResponseMessage(a.requestId, 's', 'id');
    registry.prune(new Set());
    assert.equal(registry.resolveRequestForSegment('s', 'id'), undefined);
});

/** Provisional IDs are explicitly aliased once, not guessed from whichever conversation is currently selected. */
test('startup identity confirmation works before and after response binding', () => {
    for (const bindFirst of [false, true]) {
        const registry = new RequestUsageRegistry();
        const context = createRequestUsageContext({ metadata: { session_id: 'conversation' } }, 'normal', 'p', 'm');
        registry.registerRequest(context);
        if (bindFirst) registry.bindResponseMessage(context.requestId, 'conversation', 'response');
        registry.bindInitialSession('conversation', 'native');
        if (!bindFirst) registry.bindResponseMessage(context.requestId, 'conversation', 'response');
        registry.recordRequestUsage(normalizeRequestUsage(context, { inputTokens: 7 }, 'completed'));
        for (const session of ['conversation', 'native']) {
            assert.equal(registry.resolveRequestForSegment(session, 'response')?.requestId, context.requestId);
            const segment: import('../../chat/protocol').ChatSegment = { kind: 'text', responseMessageId: 'response' };
            assert.equal(registry.bindSegment(session, segment), true); assert.equal(segment.requestUsage?.inputTokens, 7);
        }
        assert.equal(registry.resolveRequestForSegment('other', 'response'), undefined);
        registry.clearRequestUsageBindings(); assert.equal(registry.ownsSession('conversation', 'native'), false);
    }
});

/** An already-bound or restored segment cannot be stolen by a later response with a reused upstream ID. */
test('immutable segment ownership and request-scoped messages survive reused tool and message IDs', () => {
    const registry = new RequestUsageRegistry();
    const a = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'a');
    const b = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'b');
    registry.registerRequest(a); registry.registerRequest(b);
    registry.bindResponseMessage(a.requestId, 's', 'one'); registry.bindResponseMessage(b.requestId, 's', 'two');
    registry.bindResponseMessage(a.requestId, 's', 'reused-tool', 'tool'); registry.bindResponseMessage(b.requestId, 's', 'reused-tool', 'tool');
    registry.recordRequestUsage(normalizeRequestUsage(a, { inputTokens: 10 }, 'completed'));
    registry.recordRequestUsage(normalizeRequestUsage(b, { inputTokens: 20 }, 'completed'));
    const segment: import('../../chat/protocol').ChatSegment = { kind: 'text', responseMessageId: 'one', responseCallId: 'reused-tool' };
    assert.equal(registry.bindSegment('s', segment), true); assert.equal(segment.requestId, a.requestId);
    segment.responseMessageId = 'two'; registry.bindSegment('s', segment);
    assert.equal(segment.requestUsage?.inputTokens, 10);
    assert.equal(registry.resolveRequestForSegment('s', undefined, 'reused-tool'), undefined);
    const restored = JSON.parse(JSON.stringify(segment)); registry.clearRequestUsageBindings();
    registry.registerRequest(b); registry.bindResponseMessage(b.requestId, 's', 'two');
    registry.recordRequestUsage(normalizeRequestUsage(b, { inputTokens: 99 }, 'completed'));
    assert.equal(registry.bindSegment('s', restored), false); assert.equal(restored.requestUsage.inputTokens, 10);
});

/** Pruned identities remain ambiguous until history switches; forged request contexts cannot overwrite usage. */
test('pruned responses and changed context fields cannot reassign late usage', () => {
    const registry = new RequestUsageRegistry();
    const a = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'a');
    registry.registerRequest(a); registry.bindResponseMessage(a.requestId, 's', 'reuse');
    registry.recordRequestUsage(normalizeRequestUsage(a, { inputTokens: 1 }, 'completed')); registry.prune(new Set());
    const b = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'b');
    registry.registerRequest(b); assert.equal(registry.bindResponseMessage(b.requestId, 's', 'reuse'), false);
    assert.equal(registry.resolveRequestForSegment('s', 'reuse'), undefined);
    for (const change of [{ sessionId: 'other' }, { modelId: 'forged' }, { providerId: 'forged' }, { startedAt: b.startedAt + 1 }, { compactCommandTriggered: true }]) {
        assert.equal(registry.recordRequestUsage(normalizeRequestUsage({ ...b, ...change }, { inputTokens: 999 }, 'completed')), false);
    }
});

/** Native-history reloads preserve exact saved usage without using repeated legacy IDs as a lookup key. */
test('history restoration carries usage only for unambiguous request-scoped messages', () => {
    const registry = new RequestUsageRegistry();
    const context = createRequestUsageContext({ metadata: { session_id: 'session' } }, 'normal', 'p', 'm');
    const summary = normalizeRequestUsage(context, { inputTokens: 12, outputTokens: 4 }, 'completed');
    const responseMessageId = `msg_llsccai_${context.requestId}`;
    const saved: import('../../chat/protocol').ChatMessage[] = [{ id: 'old-ui', role: 'assistant', createdAt: 1,
        segments: [{ kind: 'text', responseMessageId, requestId: context.requestId, requestUsage: summary }] }];
    const restored: import('../../chat/protocol').ChatMessage[] = [{ id: 'native-uuid', role: 'assistant', createdAt: 1,
        segments: [{ kind: 'text', responseMessageId }, { kind: 'text', responseMessageId: 'legacy-reused-id' }] }];
    registry.restoreSegmentUsage('session', restored, saved);
    assert.equal(restored[0].segments[0].requestUsage?.inputTokens, 12);
    assert.equal(restored[0].segments[1].requestUsage, undefined);
    const foreign = [{ ...restored[0], segments: [{ kind: 'text' as const, responseMessageId }] }];
    registry.restoreSegmentUsage('different', foreign, saved); assert.equal((foreign[0].segments[0] as import('../../chat/protocol').ChatSegment).requestUsage, undefined);
});
