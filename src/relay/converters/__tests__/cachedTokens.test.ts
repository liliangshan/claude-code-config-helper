/**
 * @file cached_tokens 读回单元测试。
 *
 * 覆盖 Chat 非流式 / Chat 流式 / Responses 三条链路：上游返回缓存明细时
 * input_tokens 需扣除缓存部分并附带 cache_read_input_tokens；上游没有明细
 * 字段时该字段不得出现，且 input_tokens 与引入本特性之前一致。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    OpenAIChatToAnthropicStreamConverter,
    convertOpenAIChatJsonToAnthropic
} from '../openAIChatToAnthropic';
import { convertResponsesJsonToAnthropic, OpenAIResponsesToAnthropicStreamConverter } from '../openAIResponsesToAnthropic';

/** 构造一份 OpenAI Chat 非流式响应体。 */
function makeChatJson(usage: Record<string, unknown>): Record<string, unknown> {
    return {
        id: 'chatcmpl-1',
        model: 'gpt-x',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '你好' } }],
        usage
    };
}

test('Chat 非流式：有 cached_tokens 时扣除 input_tokens 并附带 cache_read_input_tokens', () => {
    const { body } = convertOpenAIChatJsonToAnthropic(
        makeChatJson({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } })
    );

    assert.equal(body.usage.input_tokens, 200);
    assert.equal(body.usage.output_tokens, 20);
    assert.equal(body.usage.cache_read_input_tokens, 800);
});

test('Chat 非流式：无明细字段时不出现 cache_read_input_tokens 且 input_tokens 不变', () => {
    const { body } = convertOpenAIChatJsonToAnthropic(makeChatJson({ prompt_tokens: 1000, completion_tokens: 20 }));

    assert.equal(body.usage.input_tokens, 1000);
    assert.equal('cache_read_input_tokens' in body.usage, false);
});

/** 把 OpenAI chunk 序列化成一段 SSE 文本。 */
function sse(chunk: Record<string, unknown>): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

test('Chat 流式：message_delta 补发扣除后的 input_tokens 与 cache_read_input_tokens', () => {
    const converter = new OpenAIChatToAnthropicStreamConverter();
    let out = converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: '你好' } }] }));
    out += converter.feed(
        sse({
            id: 'c1',
            model: 'gpt-x',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } }
        })
    );
    out += converter.end();

    const delta = out.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const messageDelta = delta.find((event) => event.type === 'message_delta');
    assert.equal(messageDelta.usage.input_tokens, 200);
    assert.equal(messageDelta.usage.cache_read_input_tokens, 800);
    assert.equal(messageDelta.usage.output_tokens, 20);
});

test('Chat 流式：无明细字段时 message_delta 不带缓存字段', () => {
    const converter = new OpenAIChatToAnthropicStreamConverter();
    converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: '你好' } }] }));
    let out = converter.feed(
        sse({
            id: 'c1',
            model: 'gpt-x',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 20 }
        })
    );
    out += converter.end();

    const delta = out.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const messageDelta = delta.find((event) => event.type === 'message_delta');
    assert.equal('cache_read_input_tokens' in messageDelta.usage, false);
    assert.equal(messageDelta.usage.input_tokens, 1000);
});

test('Chat 流式：finish_reason 与 usage 分处两个 chunk 时 usage 不丢', () => {
    const converter = new OpenAIChatToAnthropicStreamConverter();
    let out = converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: '你好' } }] }));
    out += converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    out += converter.feed(
        sse({
            id: 'c1',
            model: 'gpt-x',
            choices: [],
            usage: { prompt_tokens: 62, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 12 } }
        })
    );
    out += converter.feed('data: [DONE]\n\n');
    out += converter.end();

    const delta = out.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const messageDelta = delta.find((event) => event.type === 'message_delta');
    assert.equal(messageDelta.usage.input_tokens, 50);
    assert.equal(messageDelta.usage.output_tokens, 30);
    assert.equal(messageDelta.usage.cache_read_input_tokens, 12);
    assert.equal(messageDelta.delta.stop_reason, 'end_turn');
});

test('Responses 非流式：cached_tokens 扣除 input_tokens 并附带缓存字段', () => {
    const { body } = convertResponsesJsonToAnthropic({
        id: 'resp_1',
        model: 'gpt-x',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }],
        usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 800 } }
    });

    assert.equal(body.usage.input_tokens, 200);
    assert.equal(body.usage.cache_read_input_tokens, 800);
});

test('Responses 非流式：无明细字段时不出现缓存字段且 input_tokens 不变', () => {
    const { body } = convertResponsesJsonToAnthropic({
        id: 'resp_1',
        model: 'gpt-x',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }],
        usage: { input_tokens: 1000, output_tokens: 20 }
    });

    assert.equal(body.usage.input_tokens, 1000);
    assert.equal('cache_read_input_tokens' in body.usage, false);
});

test('Responses JSON 与 response.completed 对同一缓存读 usage 映射一致且不输出负数', () => {
    const usage = {
        input_tokens: 1000,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 }
    };
    const json = convertResponsesJsonToAnthropic({
        id: 'resp_same',
        model: 'gpt-x',
        status: 'completed',
        output: [],
        usage
    }).body.usage;
    const converter = new OpenAIResponsesToAnthropicStreamConverter();
    const completed = {
        type: 'response.completed',
        response: { id: 'resp_same', model: 'gpt-x', status: 'completed', output: [], usage }
    };
    const out = converter.feed(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`) + converter.end();
    const events = out.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const deltaUsage = events.find((event) => event.type === 'message_delta').usage;

    assert.equal(deltaUsage.input_tokens, json.input_tokens);
    assert.equal(deltaUsage.output_tokens, json.output_tokens);
    assert.equal(deltaUsage.cache_read_input_tokens, json.cache_read_input_tokens);
    assert.equal('cache_creation_input_tokens' in json, false);
    assert.equal('cache_creation_input_tokens' in deltaUsage, false);

    const invalid = convertResponsesJsonToAnthropic({
        id: 'resp_invalid', model: 'gpt-x', status: 'completed', output: [],
        usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 20 } }
    }).body.usage;
    assert.ok(invalid.input_tokens >= 0, '缓存明细不一致时不得输出负 input_tokens');
});

test('Responses 流式：response.completed 的 usage 出现在 message_delta 上', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter();
    const completed = {
        type: 'response.completed',
        response: {
            id: 'resp_1',
            model: 'qwen3.8-flash',
            status: 'completed',
            output: [
                {
                    id: 'msg_1',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'Hi!' }]
                }
            ],
            usage: {
                input_tokens: 94,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 30,
                total_tokens: 124
            }
        }
    };
    const out = converter.feed(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`) + converter.end();

    const events = out.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const messageDelta = events.find((event) => event.type === 'message_delta');
    assert.equal(messageDelta.usage.input_tokens, 94);
    assert.equal(messageDelta.usage.output_tokens, 30);
    assert.equal(messageDelta.usage.cache_read_input_tokens, 0);
});
