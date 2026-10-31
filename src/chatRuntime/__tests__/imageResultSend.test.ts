/** @file Completion turns reuse the real user-message transport only after an ownership guard admits them. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: {} });
const messaging = require('../chatMessaging') as typeof import('../chatMessaging');
const lifecycle = require('../cliLifecycle') as typeof import('../cliLifecycle');
const session = require('../chatSession') as typeof import('../chatSession');
const { routes, resetAllRouteBusy } = require('../routeState') as typeof import('../routeState');
const { requestRecoveryController, clearHttpExpectation } = require('../selfHealing') as typeof import('../selfHealing');

test('main image completion creates one normal user-input turn and failed guards never send to another history', async t => {
    const oldMessages = session.chatSessionState.messages, oldActive = session.chatSessionState.activeAssistantMessageId;
    const oldAdapter = routes.normal.adapter, oldSession = routes.normal.sessionId;
    const sent: string[] = [], order: string[] = [];
    t.mock.method(lifecycle, 'ensureChatCliStarted', async () => { order.push('ready'); });
    routes.normal.adapter = { sendUserMessage: async (text: string) => { order.push('send'); sent.push(text); } } as any;
    routes.normal.sessionId = 'test-history'; session.chatSessionState.messages = [];
    session.configureChatSession({ getModelLabelForRoute: () => 'model' });
    messaging.configureChatMessaging({ openBuiltInChat: async () => {}, switchChatRoute: async () => {}, armHttpExpectation() {}, clearHttpExpectation() {}, cancelPendingResend() {}, showChatToast: async () => {}, formatLogPreview: text => text });
    try {
        await messaging.sendUserMessageToCli('[image-generation-result]\n{}', { beforeSend: async () => { order.push('guard'); }, isTargetCurrent: () => true });
        assert.equal(sent.length, 1); assert.equal(session.chatSessionState.messages.length, 1); assert.equal(routes.normal.pendingTurns, 1);
        assert.ok(order.indexOf('guard') < order.indexOf('send')); resetAllRouteBusy();
        const count = session.chatSessionState.messages.length;
        await assert.rejects(messaging.sendUserMessageToCli('stale result', { beforeSend: async () => { throw new Error('changed history'); } }), /changed history/);
        assert.equal(sent.length, 1); assert.equal(session.chatSessionState.messages.length, count);
        await assert.rejects(messaging.sendUserMessageToCli('changed during startup', { beforeSend: async () => {}, isTargetCurrent: () => false }), /target changed/);
        assert.equal(sent.length, 1, 'Final synchronous target check must run immediately before CLI stdin');
    } finally {
        requestRecoveryController.cancelRecovery('test cleanup'); clearHttpExpectation('test cleanup'); resetAllRouteBusy();
        routes.normal.adapter = oldAdapter; routes.normal.sessionId = oldSession;
        session.chatSessionState.messages = oldMessages; session.chatSessionState.activeAssistantMessageId = oldActive;
    }
});
