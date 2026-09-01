/**
 * @file reasoningMode 落地单元测试（方案 D：请求侧下发 reasoning 参数）。
 *
 * 覆盖三块：off（含缺省）时两个请求转换器输出必须与不传 options 时逐字节相同
 * （红线）；passthrough 时按 budget_tokens 档位映射出 reasoning_effort /
 * reasoning.effort；thinking.type 非 enabled 或 thinking 缺失时一律不下发。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { convertAnthropicToOpenAIChat } from '../anthropicToOpenAIChat';
import { convertAnthropicToOpenAIResponses } from '../anthropicToOpenAIResponses';
import { mapBudgetToEffort } from '../reasoningEffort';
import {
    OpenAIChatToAnthropicStreamConverter,
    convertOpenAIChatJsonToAnthropic
} from '../openAIChatToAnthropic';

/** 把 OpenAI chunk 序列化成一段 SSE 文本。 */
function sse(chunk: Record<string, unknown>): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** 解析 SSE 文本中的 data JSON 事件序列。 */
function parseEvents(out: string): Array<Record<string, unknown>> {
    return out
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/** 用 reasoning 分片与正文分片构造一份真实形态的 Chat 流。 */
function feedStream(converter: OpenAIChatToAnthropicStreamConverter, reasonings: string[], contents: string[]): string {
    let out = '';
    for (const r of reasonings) {
        out += converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { reasoning_content: r, content: '' } }] }));
    }
    for (const c of contents) {
        out += converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { reasoning_content: '', content: c } }] }));
    }
    out += converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    out += converter.feed('data: [DONE]\n\n');
    out += converter.end();
    return out;
}

/** 构造一份带顶层 thinking 配置的 Anthropic 请求体。 */
function makeAnthropicBody(thinking?: unknown): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: 'claude-x',
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
    };
    if (thinking !== undefined) body.thinking = thinking;
    return body;
}

test('mapBudgetToEffort：按阈值映射三档，非法值返回 undefined', () => {
    assert.equal(mapBudgetToEffort(1024), 'low');
    assert.equal(mapBudgetToEffort(4095), 'low');
    assert.equal(mapBudgetToEffort(4096), 'medium');
    assert.equal(mapBudgetToEffort(16383), 'medium');
    assert.equal(mapBudgetToEffort(16384), 'high');
    assert.equal(mapBudgetToEffort(0), undefined);
    assert.equal(mapBudgetToEffort(-1), undefined);
    assert.equal(mapBudgetToEffort('big'), undefined);
    assert.equal(mapBudgetToEffort(undefined), undefined);
});

test('Chat：off / 缺省时带 thinking 的请求输出与不传 options 逐字节相同（红线）', () => {
    const body = makeAnthropicBody({ type: 'enabled', budget_tokens: 8192 });
    const withoutOptions = convertAnthropicToOpenAIChat(body);
    const withOff = convertAnthropicToOpenAIChat(body, { reasoningMode: 'off' });

    assert.equal(JSON.stringify(withOff.body), JSON.stringify(withoutOptions.body));
    assert.equal('reasoning_effort' in withOff.body, false);
});

test('Chat passthrough：budget 1024 → low、8192 → medium、32000 → high', () => {
    const low = convertAnthropicToOpenAIChat(makeAnthropicBody({ type: 'enabled', budget_tokens: 1024 }), { reasoningMode: 'passthrough' });
    const medium = convertAnthropicToOpenAIChat(makeAnthropicBody({ type: 'enabled', budget_tokens: 8192 }), { reasoningMode: 'passthrough' });
    const high = convertAnthropicToOpenAIChat(makeAnthropicBody({ type: 'enabled', budget_tokens: 32000 }), { reasoningMode: 'passthrough' });

    assert.equal(low.body.reasoning_effort, 'low');
    assert.equal(medium.body.reasoning_effort, 'medium');
    assert.equal(high.body.reasoning_effort, 'high');
});

test('Chat passthrough：thinking.type=disabled 或 thinking 缺失时不下发', () => {
    const disabled = convertAnthropicToOpenAIChat(makeAnthropicBody({ type: 'disabled', budget_tokens: 8192 }), { reasoningMode: 'passthrough' });
    const absent = convertAnthropicToOpenAIChat(makeAnthropicBody(), { reasoningMode: 'passthrough' });

    assert.equal('reasoning_effort' in disabled.body, false);
    assert.equal('reasoning_effort' in absent.body, false);
});

test('Responses：off / 缺省时带 thinking 的请求输出与不传 options 逐字节相同（红线）', () => {
    const body = makeAnthropicBody({ type: 'enabled', budget_tokens: 8192 });
    const withoutOptions = convertAnthropicToOpenAIResponses(body);
    const withOff = convertAnthropicToOpenAIResponses(body, { reasoningMode: 'off' });

    assert.equal(JSON.stringify(withOff.body), JSON.stringify(withoutOptions.body));
    assert.equal('reasoning' in withOff.body, false);
});

test('Responses passthrough：thinking.type=enabled 时映射为 reasoning.effort', () => {
    const { body } = convertAnthropicToOpenAIResponses(
        makeAnthropicBody({ type: 'enabled', budget_tokens: 8192 }),
        { reasoningMode: 'passthrough' }
    );

    assert.deepEqual(body.reasoning, { effort: 'medium' });
});

test('Responses passthrough：thinking.type=disabled 时不下发', () => {
    const { body } = convertAnthropicToOpenAIResponses(
        makeAnthropicBody({ type: 'disabled', budget_tokens: 8192 }),
        { reasoningMode: 'passthrough' }
    );

    assert.equal('reasoning' in body, false);
});

// ===== 方案 B-1：Chat 响应侧读回 thinking block =====

test('B-1 红线：off（默认构造）喂含非空 reasoning_content 的流，输出与不带 reasoning 字段时逐字节相同', () => {
    const withReasoning = feedStream(new OpenAIChatToAnthropicStreamConverter(), ['想一下', '再想想'], ['你好']);
    const withoutReasoning = feedStream(new OpenAIChatToAnthropicStreamConverter(), [], ['你好']);

    assert.equal(withReasoning, withoutReasoning);
    assert.equal(withReasoning.includes('thinking'), false);
});

test('B-1 passthrough：真实 7 分片序列产出 thinking→text 顺序与 index 0/1', () => {
    const reasonings = ['We', ' need', ' respond', ' to', ' user', ' with', ' hello'];
    const out = feedStream(new OpenAIChatToAnthropicStreamConverter('passthrough'), reasonings, ['Hi!', ' there']);
    const events = parseEvents(out);

    const starts = events.filter((e) => e.type === 'content_block_start');
    const stops = events.filter((e) => e.type === 'content_block_stop');
    const thinkingDeltas = events.filter((e) => (e.delta as Record<string, unknown>)?.type === 'thinking_delta');
    const textDeltas = events.filter((e) => (e.delta as Record<string, unknown>)?.type === 'text_delta');

    assert.equal(starts.length, 2);
    assert.equal((starts[0].content_block as Record<string, unknown>).type, 'thinking');
    assert.equal(starts[0].index, 0);
    assert.equal((starts[1].content_block as Record<string, unknown>).type, 'text');
    assert.equal(starts[1].index, 1);
    assert.equal(thinkingDeltas.length, 7);
    assert.equal(textDeltas.length, 2);
    // thinking block 在 text block 之前关闭
    assert.equal(stops[0].index, 0);
    assert.equal(stops[1].index, 1);
});

test('B-1 passthrough：所有 reasoning_content 均为空串时不得出现 thinking block，正文 index 仍为 0', () => {
    const converter = new OpenAIChatToAnthropicStreamConverter('passthrough');
    let out = '';
    for (const c of ['a', 'b']) {
        out += converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { reasoning_content: '', content: c } }] }));
    }
    out += converter.feed('data: [DONE]\n\n');
    out += converter.end();
    const events = parseEvents(out);

    assert.equal(out.includes('thinking'), false);
    const firstStart = events.find((e) => e.type === 'content_block_start');
    assert.equal(firstStart?.index, 0);
    assert.equal((firstStart?.content_block as Record<string, unknown>).type, 'text');
});

test('B-1 passthrough：只有思考没有正文时流结束时 thinking block 被正确关闭', () => {
    const out = feedStream(new OpenAIChatToAnthropicStreamConverter('passthrough'), ['只有思考'], []);
    const events = parseEvents(out);
    const starts = events.filter((e) => e.type === 'content_block_start');
    const stops = events.filter((e) => e.type === 'content_block_stop');

    assert.equal(starts.length, 1);
    assert.equal((starts[0].content_block as Record<string, unknown>).type, 'thinking');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].index, 0);
});

test('B-1 passthrough：思考后接 tool_call 时 thinking index 0、tool_use index 1', () => {
    const converter = new OpenAIChatToAnthropicStreamConverter('passthrough');
    let out = converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { reasoning_content: '要调工具了' } }] }));
    out += converter.feed(sse({
        id: 'c1',
        model: 'gpt-x',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"BJ"}' } }] } }]
    }));
    out += converter.feed(sse({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    out += converter.end();
    const events = parseEvents(out);
    const starts = events.filter((e) => e.type === 'content_block_start');

    assert.equal((starts[0].content_block as Record<string, unknown>).type, 'thinking');
    assert.equal(starts[0].index, 0);
    assert.equal((starts[1].content_block as Record<string, unknown>).type, 'tool_use');
    assert.equal(starts[1].index, 1);
});

test('B-1 非流式 passthrough：message.reasoning_content 合成 thinking block 置于 content 最前', () => {
    const json = {
        id: 'chatcmpl-1',
        model: 'gpt-x',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '你好', reasoning_content: '先想想' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
    };
    const passthrough = convertOpenAIChatJsonToAnthropic(json, 'passthrough');
    const off = convertOpenAIChatJsonToAnthropic(json);

    assert.deepEqual(passthrough.body.content[0], { type: 'thinking', thinking: '先想想' });
    assert.deepEqual(passthrough.body.content[1], { type: 'text', text: '你好' });
    assert.equal(off.body.content.length, 1);
    assert.equal(off.body.content[0].type, 'text');
});
