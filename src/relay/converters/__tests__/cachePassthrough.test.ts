/**
 * @file cacheMode 透传单元测试。
 *
 * 覆盖两条主线：缺省（auto）路径的输出必须与引入 cacheMode 之前完全一致，
 * 以及 passthrough 路径下 system / messages / tools 上的 cache_control 断点
 * 必须原样出现在转换后的请求体里。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { convertAnthropicToOpenAIChat } from '../anthropicToOpenAIChat';
import { convertAnthropicToOpenAIResponses } from '../anthropicToOpenAIResponses';

/** 构造一份 system / messages / tools 上都带缓存断点的 Anthropic 请求体。 */
function makeAnthropicBody(): Record<string, unknown> {
    return {
        model: 'claude-x',
        system: [{ type: 'text', text: '系统提示', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好', cache_control: { type: 'ephemeral' } }] }],
        tools: [
            {
                name: 'get_weather',
                description: '查询天气',
                input_schema: { type: 'object', properties: {} },
                cache_control: { type: 'ephemeral' }
            }
        ]
    };
}

test('Chat 缺省 cacheMode：丢弃 cache_control 并保留 unsupported_cache_control warning', () => {
    const withoutOptions = convertAnthropicToOpenAIChat(makeAnthropicBody());
    const withAuto = convertAnthropicToOpenAIChat(makeAnthropicBody(), { cacheMode: 'auto' });

    assert.equal(JSON.stringify(withAuto.body), JSON.stringify(withoutOptions.body));
    assert.ok(withAuto.warnings.some((warning) => warning.code === 'unsupported_cache_control'));
    assert.equal(JSON.stringify(withoutOptions.body).includes('cache_control'), false);
});

test('Chat passthrough：system / 末条 message / tools 的 cache_control 均透传且无 warning', () => {
    const { body, warnings } = convertAnthropicToOpenAIChat(makeAnthropicBody(), { cacheMode: 'passthrough' });
    const messages = body.messages as unknown as Array<Record<string, unknown>>;
    const systemParts = messages[0].content as unknown as Array<Record<string, unknown>>;
    const userParts = messages[1].content as unknown as Array<Record<string, unknown>>;
    const tools = body.tools as unknown as Array<Record<string, unknown>>;

    assert.equal(messages[0].role, 'system');
    assert.deepEqual(systemParts[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(userParts[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(tools[0].cache_control, { type: 'ephemeral' });
    assert.equal(warnings.some((warning) => warning.code === 'unsupported_cache_control'), false);
});

test('Chat passthrough：单个 text block 的 user 消息不被压平成字符串', () => {
    const { body } = convertAnthropicToOpenAIChat(
        { model: 'claude-x', messages: [{ role: 'user', content: [{ type: 'text', text: '只有一段' }] }] },
        { cacheMode: 'passthrough' }
    );
    const messages = body.messages as unknown as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(messages[0].content));
});

test('Chat 缺省 cacheMode：单个 text block 的 user 消息仍被压平成字符串', () => {
    const { body } = convertAnthropicToOpenAIChat({
        model: 'claude-x',
        messages: [{ role: 'user', content: [{ type: 'text', text: '只有一段' }] }]
    });
    const messages = body.messages as unknown as Array<Record<string, unknown>>;

    assert.equal(messages[0].content, '只有一段');
});

test('Responses 缺省 cacheMode：写 instructions、丢弃 cache_control 且 warning 仍在', () => {
    const withoutOptions = convertAnthropicToOpenAIResponses(makeAnthropicBody());
    const withAuto = convertAnthropicToOpenAIResponses(makeAnthropicBody(), { cacheMode: 'auto' });

    assert.equal(JSON.stringify(withAuto.body), JSON.stringify(withoutOptions.body));
    assert.equal(withoutOptions.body.instructions, '系统提示');
    assert.equal(JSON.stringify(withoutOptions.body).includes('cache_control'), false);
    assert.ok(withAuto.warnings.some((warning) => warning.code === 'unsupported_cache_control'));
});

test('Responses passthrough：system 移入 input 首项且不写 instructions', () => {
    const { body, warnings } = convertAnthropicToOpenAIResponses(makeAnthropicBody(), { cacheMode: 'passthrough' });
    const input = body.input as unknown as Array<Record<string, unknown>>;
    const systemParts = input[0].content as unknown as Array<Record<string, unknown>>;
    const userParts = input[1].content as unknown as Array<Record<string, unknown>>;
    const tools = body.tools as unknown as Array<Record<string, unknown>>;

    assert.equal(body.instructions, undefined);
    assert.equal(input[0].role, 'system');
    assert.equal(systemParts[0].type, 'input_text');
    assert.deepEqual(systemParts[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(userParts[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(tools[0].cache_control, { type: 'ephemeral' });
    assert.equal(warnings.some((warning) => warning.code === 'unsupported_cache_control'), false);
});
