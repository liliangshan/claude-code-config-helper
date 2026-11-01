/** @file Dedicated compaction outcomes stop the owning recovery turn without affecting another session. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { createRequestUsageContext } from '../../relay/requestUsage';

installVscodeStub({ values: {} });
const healing = require('../selfHealing') as typeof import('../selfHealing');

/** Verify the production request-to-turn bridge, including retryable evidence from an earlier normal request. */
test('dedicated compaction failure cancels pending recovery and ignores late CLI retry events', () => {
    const id = healing.beginRecoveryTurn({ sessionId: 's', cliInstanceId: 'cli', route: 'normal', originalPrompt: 'test', deliveryState: 'accepted' });
    const controller = healing.requestRecoveryController;
    const usage = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'summary', true, 'anthropic');
    try {
        controller.onCliTurnFinished(id, true, { status: 503 });
        assert.equal(controller.getSnapshot()?.state, 'waiting_recovery');
        healing.observeRecoveryRequestStart({ route: 'normal', providerId: 'p', modelId: 'summary', usageContext: usage });
        healing.observeRecoveryRequestOutcome({ context: usage, status: 'error', upstreamStatus: 503, mappedStatus: 400, retryable: false });
        assert.equal(controller.getSnapshot()?.state, 'non_retryable');
        assert.equal(controller.getSnapshot()?.nextRetryAt, undefined);
        assert.equal(controller.getSnapshot()?.lastFailure?.stage, 'compaction');
        controller.onCliApiRetry(id, { status: 503 }); controller.onCliTurnFinished(id, true, { status: 503 });
        assert.equal(controller.getSnapshot()?.state, 'non_retryable');
    } finally { healing.cancelPendingResend('test cleanup'); }
});

/** A late failed summary must not stop a new user turn, even when it reused the same CLI session. */
test('stale compaction failures cannot disable recovery in a newer turn', () => {
    const input = { sessionId: 's', cliInstanceId: 'cli', route: 'normal', originalPrompt: 'test', deliveryState: 'accepted' as const };
    healing.beginRecoveryTurn(input);
    const usage = createRequestUsageContext({ metadata: { session_id: 's' } }, 'normal', 'p', 'summary', true, 'anthropic');
    healing.observeRecoveryRequestStart({ route: 'normal', providerId: 'p', modelId: 'summary', usageContext: usage });
    const current = healing.beginRecoveryTurn({ ...input, originalPrompt: 'new turn' });
    try {
        healing.observeRecoveryRequestOutcome({ context: usage, status: 'error', mappedStatus: 400, retryable: false });
        assert.equal(healing.requestRecoveryController.getSnapshot()?.state, 'awaiting_request');
        healing.requestRecoveryController.onCliTurnFinished(current, true, { status: 503 });
        assert.equal(healing.requestRecoveryController.getSnapshot()?.state, 'waiting_recovery');
    } finally { healing.cancelPendingResend('test cleanup'); }
});
