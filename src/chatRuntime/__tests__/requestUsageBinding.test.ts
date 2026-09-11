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
