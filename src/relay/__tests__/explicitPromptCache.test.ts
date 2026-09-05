/**
 * @file Chat 显式 Prompt Cache 请求处理单元测试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    applyChatExplicitPromptCache,
    applyResponsesExplicitPromptCache,
    type ChatExplicitCacheBody,
    type ResponsesExplicitCacheBody,
    extractExplicitCacheSessionId
} from '../explicitPromptCache';
import { convertAnthropicToOpenAIChat } from '../converters/anthropicToOpenAIChat';
import { convertAnthropicToOpenAIResponses } from '../converters/anthropicToOpenAIResponses';

test('严格提取 metadata 中的纯 session_id，不回退到原始 user_id', () => {
    assert.equal(extractExplicitCacheSessionId({ metadata: { session_id: ' direct ' } }), 'direct');
    assert.equal(extractExplicitCacheSessionId({
        metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: ' nested ' }) }
    }), 'nested');
    assert.equal(extractExplicitCacheSessionId({ metadata: { user_id: 'raw-user-id' } }), '');
    assert.equal(extractExplicitCacheSessionId({ metadata: { user_id: '{invalid' } }), '');
    assert.equal(extractExplicitCacheSessionId({ metadata: { user_id: JSON.stringify({ device_id: 'd' }) } }), '');
});

test('Chat 显式缓存一次写入 key、30m options 和 system 消息断点并保持幂等', () => {
    const body: ChatExplicitCacheBody = {
        messages: [
            { role: 'system', content: 'static prefix' },
            { role: 'user', content: 'dynamic suffix' }
        ]
    };
    assert.deepEqual(applyChatExplicitPromptCache(body, ' session-1 '), { applied: true });
    const once = JSON.stringify(body);
    assert.deepEqual(applyChatExplicitPromptCache(body, 'session-1'), { applied: true });
    assert.equal(JSON.stringify(body), once);
    assert.equal(body.prompt_cache_key, 'session-1');
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.deepEqual(body.messages[0].cache_control, { prompt_cache_breakpoint: { mode: 'explicit' } });
    assert.equal('cache_control' in body.messages[1], false);
});

test('缺少 session_id 或 system 时不写入任何部分字段', () => {
    const missingSession = { messages: [{ role: 'system', content: 'prefix' }] };
    assert.deepEqual(applyChatExplicitPromptCache(missingSession, ''), {
        applied: false,
        reason: 'missing_session_id'
    });
    assert.equal('prompt_cache_key' in missingSession, false);
    assert.equal('cache_control' in missingSession.messages[0], false);

    const missingSystem = { messages: [{ role: 'user', content: 'hello' }] };
    assert.deepEqual(applyChatExplicitPromptCache(missingSystem, 'session-1'), {
        applied: false,
        reason: 'missing_system_message'
    });
    assert.equal('prompt_cache_key' in missingSystem, false);
});

test('转换器开启显式缓存时覆盖 passthrough 策略且不混入 ephemeral 标记', () => {
    const { body, warnings } = convertAnthropicToOpenAIChat({
        model: 'gpt-6-astra',
        system: [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
        tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]
    }, {
        cacheMode: 'passthrough',
        explicitCache: true,
        cacheSessionId: 'session-1'
    });

    assert.equal(body.prompt_cache_key, 'session-1');
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.deepEqual(body.messages[0].cache_control, { prompt_cache_breakpoint: { mode: 'explicit' } });
    assert.equal(JSON.stringify(body).includes('ephemeral'), false);
    assert.ok(warnings.some((warning) => warning.code === 'unsupported_cache_control'));
});

test('显式缓存关闭时保持原 cacheMode 行为，开启但条件不足时仅返回 warning', () => {
    const original = {
        model: 'gpt-6-astra',
        system: [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'hello' }]
    };
    const passthrough = convertAnthropicToOpenAIChat(original, {
        cacheMode: 'passthrough',
        explicitCache: false,
        cacheSessionId: 'ignored'
    });
    assert.equal(passthrough.body.prompt_cache_key, undefined);
    assert.ok(JSON.stringify(passthrough.body).includes('ephemeral'));

    const incomplete = convertAnthropicToOpenAIChat({ model: 'm', messages: [] }, {
        explicitCache: true,
        cacheSessionId: 'session-1'
    });
    assert.equal(incomplete.body.prompt_cache_key, undefined);
    assert.ok(incomplete.warnings.some((warning) => warning.code === 'explicit_cache_not_applied'));
});

test('Responses 显式缓存写入 key 和 options，保持 instructions 且不生成断点', () => {
    const body: ResponsesExplicitCacheBody = { instructions: 'static prefix' };
    assert.deepEqual(applyResponsesExplicitPromptCache(body, ' session-r '), { applied: true });
    const once = JSON.stringify(body);
    assert.deepEqual(applyResponsesExplicitPromptCache(body, 'session-r'), { applied: true });
    assert.equal(JSON.stringify(body), once);
    assert.equal(body.prompt_cache_key, 'session-r');
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.equal(JSON.stringify(body).includes('cache_control'), false);
});

test('Responses 显式缓存缺少 session_id 或 instructions 时不写部分字段', () => {
    const missingSession = { instructions: 'prefix' };
    assert.deepEqual(applyResponsesExplicitPromptCache(missingSession, ''), {
        applied: false,
        reason: 'missing_session_id'
    });
    assert.equal('prompt_cache_key' in missingSession, false);

    const missingInstructions = {};
    assert.deepEqual(applyResponsesExplicitPromptCache(missingInstructions, 'session-r'), {
        applied: false,
        reason: 'missing_instructions'
    });
    assert.equal('prompt_cache_key' in missingInstructions, false);
});

test('Responses 显式缓存强制 instructions 并保留流式开关与工具消息配对', () => {
    const { body, warnings } = convertAnthropicToOpenAIResponses({
        model: 'gpt-6-astra',
        system: [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }],
        stream: true,
        messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' }, cache_control: { type: 'ephemeral' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result', cache_control: { type: 'ephemeral' } }] }
        ],
        tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]
    }, {
        cacheMode: 'passthrough',
        explicitCache: true,
        cacheSessionId: 'session-r'
    });

    assert.equal(body.instructions, 'prefix');
    assert.equal(body.prompt_cache_key, 'session-r');
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.equal(body.stream, true);
    assert.deepEqual(body.input[0], { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"q":"x"}' });
    assert.deepEqual(body.input[1], { type: 'function_call_output', call_id: 'toolu_1', output: 'result' });
    assert.equal(JSON.stringify(body).includes('cache_control'), false);
    assert.ok(warnings.some((warning) => warning.code === 'unsupported_cache_control'));
});

test('Responses 非流式显式缓存关闭时保持 passthrough 原行为', () => {
    const { body } = convertAnthropicToOpenAIResponses({
        model: 'm',
        system: [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }],
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
    }, { cacheMode: 'passthrough', explicitCache: false, cacheSessionId: 'ignored' });
    assert.equal(body.instructions, undefined);
    assert.equal(body.prompt_cache_key, undefined);
    assert.equal(body.stream, false);
    assert.ok(JSON.stringify(body).includes('cache_control'));
});
