/**
 * @file cached_tokens 读回单元测试。
 *
 * 覆盖 Chat 非流式 / Chat 流式 / Responses 三条链路：上游返回缓存明细时
 * input_tokens 需扣除缓存部分并附带 cache_read_input_tokens；上游没有明细
 * 字段时该字段不得出现，且 input_tokens 与引入本特性之前一致。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestUsageContext, normalizeRequestUsage } from '../../requestUsage';

import {
    OpenAIChatToAnthropicStreamConverter,
    convertOpenAIChatJsonToAnthropic
} from '../openAIChatToAnthropic';
import { normalizeOpenAIUsage } from '../openAIUsage';
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
    assert.equal(json.cache_creation_input_tokens, 0);
    assert.equal(deltaUsage.cache_creation_input_tokens, 0);

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

/** 生成两种协议的 JSON 与分片 SSE 用量，确保 message_start/message_delta 使用相同拆分。 */
function allUsageVariants(total: number, details: Record<string, unknown>, extra: Record<string, unknown> = {}): Array<Record<string, number>> {
    const chatUsage = { prompt_tokens: total, completion_tokens: 3, prompt_tokens_details: details, ...extra };
    const response = { id: 'resp_write', status: 'completed', output: [], usage: {
        input_tokens: total, output_tokens: 3, input_tokens_details: details, ...extra
    } };
    const chat = new OpenAIChatToAnthropicStreamConverter();
    const responses = new OpenAIResponsesToAnthropicStreamConverter();
    const chatEvent = sse({ id: 'chat_write', choices: [], usage: chatUsage });
    const responseEvent = sse({ type: 'response.completed', response });
    // 按不同字节边界拆分，避免完整 SSE 帧测试掩盖缓冲路径问题。
    const streams = [
        chat.feed(chatEvent.slice(0, 17)) + chat.feed(chatEvent.slice(17)) + chat.feed('data: [DONE]\n\n') + chat.end(),
        responses.feed(responseEvent.slice(0, 23)) + responses.feed(responseEvent.slice(23)) + responses.end()
    ];
    return [
        convertOpenAIChatJsonToAnthropic(makeChatJson(chatUsage)).body.usage,
        convertResponsesJsonToAnthropic(response).body.usage,
        ...streams.flatMap(stream => stream.split('\n').filter(line => line.startsWith('data: '))
            .map(line => JSON.parse(line.slice(6)))
            .filter(event => event.type === 'message_start' || event.type === 'message_delta')
            .map(event => event.type === 'message_start' ? event.message.usage : event.usage))
    ];
}

/** 非零写入量按真实明细还原，普通输入 + 读 + 写严格等于总输入。 */
test('Chat/Responses JSON/SSE 保留缓存写入且不会混进未缓存输入', () => {
    const context = createRequestUsageContext({}, 'normal', 'p', 'claude-test');
    for (const [ordinary, read, write] of [[3, 32746, 10], [13, 32746, 0], [0, 0, 4096], [10, 0, 0]]) {
        const total = ordinary + read + write;
        for (const usage of allUsageVariants(total, { cached_tokens: read, cache_write_tokens: write })) {
            assert.equal(usage.input_tokens, ordinary);
            assert.equal(usage.cache_read_input_tokens, read);
            assert.equal(usage.cache_creation_input_tokens, write);
            const summary = normalizeRequestUsage(context, {
                inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
                cacheReadInputTokens: usage.cache_read_input_tokens,
                cacheCreationInputTokens: usage.cache_creation_input_tokens
            }, 'completed');
            assert.equal(summary.totalInputTokens, total);
            assert.equal(summary.cacheCreationInputTokens, write);
        }
    }
});

/** 仅写入字段也可独立透传；非法值不转型，显式 0 优先于回退明细。 */
test('缓存写入独立存在、别名优先级和缺失值均正确处理', () => {
    for (const usage of allUsageVariants(20, { cache_write_tokens: 13 })) {
        assert.equal(usage.input_tokens, 7);
        assert.equal(usage.cache_creation_input_tokens, 13);
        assert.equal(usage.cache_read_input_tokens, undefined);
    }
    for (const usage of allUsageVariants(20, { cache_write_tokens: 13 }, { cache_write_tokens: 0 })) {
        assert.equal(usage.input_tokens, 20);
        assert.equal(usage.cache_creation_input_tokens, 0);
    }
    for (const alias of ['cache_write_tokens', 'cache_creation_input_tokens', 'cache_creation_tokens']) {
        for (const usage of allUsageVariants(20, {}, { [alias]: 13 })) {
            assert.equal(usage.input_tokens, 7);
            assert.equal(usage.cache_creation_input_tokens, 13);
        }
    }
    for (const invalid of [-1, 1.5, '13', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        for (const protocol of ['chat', 'responses'] as const) {
            const source = protocol === 'chat'
                ? { prompt_tokens: 20, prompt_tokens_details: { cache_write_tokens: invalid } }
                : { input_tokens: 20, input_tokens_details: { cache_write_tokens: invalid } };
            const result = normalizeOpenAIUsage(source, protocol);
            assert.equal(result.inputTokens, 20);
            assert.equal(result.cacheWriteTokens, undefined);
        }
    }
});

/** 明细异常大于总输入时限制读写之和，不允许负输入或膨胀命中率分母。 */
test('缓存读写超出总输入时保持总量守恒', () => {
    for (const usage of allUsageVariants(10, { cached_tokens: 8, cache_write_tokens: 9 })) {
        assert.equal(usage.input_tokens, 0);
        assert.equal(usage.cache_read_input_tokens, 8);
        assert.equal(usage.cache_creation_input_tokens, 2);
    }
});

/** usage 晚于 finish_reason 到达时缓存写入仍必须出现在终态中。 */
test('Chat 晚到的缓存写入不会在 finish_reason 后丢失', () => {
    const converter = new OpenAIChatToAnthropicStreamConverter();
    let out = converter.feed(sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }));
    out += converter.feed(sse({ choices: [], usage: {
        prompt_tokens: 32759, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 32746, cache_write_tokens: 10 }
    } }));
    out += converter.feed('data: [DONE]\n\n') + converter.end();
    const events = out.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const usage = events.find(event => event.type === 'message_delta').usage;
    assert.equal(usage.input_tokens, 3);
    assert.equal(usage.cache_read_input_tokens, 32746);
    assert.equal(usage.cache_creation_input_tokens, 10);
    assert.equal(usage.output_tokens, 3);
});

/** 复现标题有缓存读取却缺少命中率，覆盖两种 OpenAI 协议的 JSON/SSE 输出。 */
test('OpenAI JSON/SSE 用量可计算截图中的 99.5% 命中率，缺少读取仍保持未知', () => {
    const context = createRequestUsageContext({}, 'normal', 'p', 'gpt-x');
    for (const cached of [19712, 0, undefined]) {
        const chatUsage = { prompt_tokens: 19812, completion_tokens: 14,
            ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) };
        const response = { id: 'resp_hit', model: 'gpt-x', status: 'completed', output: [],
            usage: { input_tokens: 19812, output_tokens: 14,
                ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }) } };
        const chat = new OpenAIChatToAnthropicStreamConverter();
        const responses = new OpenAIResponsesToAnthropicStreamConverter();
        const streams = [
            chat.feed(sse({ id: 'chat_hit', choices: [], usage: chatUsage })) + chat.end(),
            responses.feed(sse({ type: 'response.completed', response })) + responses.end()
        ];
        const usages = [convertOpenAIChatJsonToAnthropic(makeChatJson(chatUsage)).body.usage,
            convertResponsesJsonToAnthropic(response).body.usage,
            ...streams.map(stream => stream.split('\n').filter(line => line.startsWith('data: '))
                .map(line => JSON.parse(line.slice(6))).find(event => event.type === 'message_delta').usage)];
        for (const usage of usages) {
            const summary = normalizeRequestUsage(context, {
                inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
                cacheReadInputTokens: usage.cache_read_input_tokens,
                cacheCreationInputTokens: usage.cache_creation_input_tokens
            }, 'completed');
            assert.equal(summary.cacheHitRate, cached === undefined ? undefined : cached === 0 ? 0 : 99.5);
            assert.equal(summary.totalInputTokens, cached === undefined ? undefined : 19812);
            assert.equal(summary.cacheCreationInputTokens, cached === undefined ? undefined : 0);
        }
    }
});
