/**
 * @file buildExpertMessages 单元测试。
 *
 * 验证专家 sub-turn 的初始 messages 满足「无历史上下文」不变量：
 * - 仅含一条 user message；
 * - system prompt 单独返回、非空，且明确声明不携带历史；
 * - question 原样进入 user content（不被改写 / 拼接历史）。
 *
 * 纯函数测试，可直接在 `node --test` 下运行（无 vscode 依赖）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// expertSubturnService 顶层 `import * as vscode`，需先装 stub 再 require。
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildExpertMessages, parseRelayMessagesResponse } = require('../expertSubturnService') as typeof import('../expertSubturnService');

test('buildExpertMessages: 仅返回一条 user message', () => {
    const { messages } = buildExpertMessages('Refactor the cache layer');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'Refactor the cache layer');
});

test('buildExpertMessages: system 非空且声明不携带历史', () => {
    const { system } = buildExpertMessages('Any question');
    assert.equal(typeof system, 'string');
    assert.ok(system.length > 0);
    assert.match(system, /NOT included/);
    assert.match(system, /expert model/i);
});

test('buildExpertMessages: question 原样进入 user content，不拼接历史', () => {
    const question = 'Explain why migration 0042 fails on Postgres 16';
    const { messages } = buildExpertMessages(question);
    assert.equal(messages[0].content, question);
    // 不应出现任何「历史」拼接痕迹：内容长度等于原问题长度。
    assert.equal(String(messages[0].content).length, question.length);
});

test('parseRelayMessagesResponse: 普通 JSON 响应保持兼容', () => {
    const response = parseRelayMessagesResponse(JSON.stringify({
        content: [{ type: 'text', text: 'json ok' }],
        stop_reason: 'end_turn'
    }), 'application/json');

    assert.equal(response.stop_reason, 'end_turn');
    assert.deepEqual(response.content, [{ type: 'text', text: 'json ok' }]);
});

test('parseRelayMessagesResponse: SSE text delta 可解析为文本 content', () => {
    const raw = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_1","type":"message"}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"expert"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        ''
    ].join('\n');

    const response = parseRelayMessagesResponse(raw, 'text/event-stream');

    assert.equal(response.stop_reason, 'end_turn');
    assert.deepEqual(response.content, [{ type: 'text', text: 'hello expert' }]);
});

test('parseRelayMessagesResponse: SSE error event 返回可读错误', () => {
    const raw = [
        'event: error',
        'data: {"type":"error","error":{"type":"invalid_request_error","message":"bad expert request"}}',
        ''
    ].join('\n');

    assert.throws(
        () => parseRelayMessagesResponse(raw, 'text/event-stream'),
        /bad expert request/
    );
});
