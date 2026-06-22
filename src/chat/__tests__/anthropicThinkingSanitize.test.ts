/**
 * @file Anthropic 直连请求体回放 thinking 块清理测试。
 *
 * 覆盖 rewriteRequestBody 对历史 thinking / redacted_thinking 块的清理规则：
 * 仅保留「最后一个活跃 tool_use 轮」且签名合法的 thinking 块，其余（含中段
 * 工具轮与伪签名块）一律剥离，避免 Anthropic 直连报 Invalid signature。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub } from './testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rewriteRequestBody } = require('../../relay/anthropicProxy') as typeof import('../../relay/anthropicProxy');

/** 形如合法 Anthropic 签名（足够长、非 UUID）。 */
const VALID_SIG = 'EssDCmMIDxgCKk' + 'A'.repeat(80);
/** 转换器 / 其它 provider 注入的伪签名（UUID 形态）。 */
const BOGUS_SIG = '2f530c48-a031-4006-b393-bec09234406e';

/** 解析 rewriteRequestBody 输出为请求体对象。 */
function rewrite(body: Record<string, unknown>): { model: string; messages: Array<{ role: string; content: unknown }> } {
    const out = rewriteRequestBody(JSON.stringify(body), body, 'target-model');
    return JSON.parse(out) as { model: string; messages: Array<{ role: string; content: unknown }> };
}

test('rewriteRequestBody: 改写 model 并剥离非活跃轮的 thinking 块', () => {
    const result = rewrite({
        model: 'provider/old-model',
        messages: [
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: '旧思考', signature: VALID_SIG },
                    { type: 'text', text: '答复' }
                ]
            },
            { role: 'user', content: '继续' }
        ]
    });

    assert.equal(result.model, 'target-model');
    assert.deepEqual(result.messages[1].content, [{ type: 'text', text: '答复' }]);
});

test('rewriteRequestBody: 保留最后一个活跃 tool_use 轮的合法签名 thinking 块', () => {
    const thinking = { type: 'thinking', thinking: '工具前思考', signature: VALID_SIG };
    const result = rewrite({
        model: 'provider/old-model',
        messages: [
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: [thinking, { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }]
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }]
            }
        ]
    });

    assert.deepEqual(result.messages[1].content, [thinking, { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }]);
});

test('rewriteRequestBody: 中段 tool_use 轮的 thinking 块被剥离，仅保留最后活跃轮', () => {
    const midThinking = { type: 'thinking', thinking: '中段', signature: VALID_SIG };
    const lastThinking = { type: 'thinking', thinking: '末轮', signature: VALID_SIG };
    const result = rewrite({
        model: 'provider/old-model',
        messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [midThinking, { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a' }] },
            { role: 'assistant', content: [lastThinking, { type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'b' }] }
        ]
    });

    assert.deepEqual(result.messages[1].content, [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }]);
    assert.deepEqual(result.messages[3].content, [lastThinking, { type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }]);
});

test('rewriteRequestBody: 活跃轮上伪签名（UUID）thinking 块仍被剥离', () => {
    const result = rewrite({
        model: 'provider/old-model',
        messages: [
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: '伪签名', signature: BOGUS_SIG },
                    { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }
                ]
            },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }
        ]
    });

    assert.deepEqual(result.messages[1].content, [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }]);
});

test('rewriteRequestBody: 不修改原始 parsedBody 的 messages', () => {
    const original = {
        model: 'provider/old-model',
        messages: [
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 't', signature: VALID_SIG },
                    { type: 'text', text: 'a' }
                ]
            }
        ]
    };
    rewriteRequestBody(JSON.stringify(original), original, 'target-model');

    assert.equal((original.messages[0].content as unknown[]).length, 2);
    assert.equal(original.model, 'provider/old-model');
});
