/** @file Chat-native search maps provider tools without inventing search records from answer Markdown. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertAnthropicToOpenAIChat } from '../anthropicToOpenAIChat';
import { convertOpenAIChatJsonToAnthropic, OpenAIChatToAnthropicStreamConverter } from '../openAIChatToAnthropic';
import { chatSearchQuery } from '../chatWebSearch';

const schema = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 };
const answer = 'Official docs: [TypeScript](https://www.typescriptlang.org/docs/).';

/** Parse converted SSE frames without assuming transport chunk boundaries. */
function payloads(wire: string): any[] {
    return wire.split('\n\n').flatMap(frame => {
        const line = frame.split('\n').find(value => value.startsWith('data:'));
        return line ? [JSON.parse(line.slice(5))] : [];
    });
}

/** Create a JSON completion with optional provider citation metadata. */
function completion(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'chat_test', choices: [{ message: { content: answer, ...extra }, finish_reason: 'stop' }] };
}

/** Preserve native search type and explicit choice without changing ordinary function tools. */
test('Chat native search declarations and explicit CLI query survive request conversion', () => {
    const request = { messages: [{ role: 'user', content: 'Perform a web search for the query: TypeScript docs' }], tools: [schema, { name: 'Read', input_schema: {} }], tool_choice: { type: 'tool', name: 'web_search' }, stream: true };
    const converted = convertAnthropicToOpenAIChat(request).body;
    assert.deepEqual(converted.tools?.[0], { type: 'web_search' });
    assert.equal(converted.tools?.[1].type, 'function'); assert.equal(converted.tool_choice, 'required');
    assert.equal('max_tool_calls' in converted, false); assert.equal(converted.stream, true);
    assert.equal(chatSearchQuery(request), 'TypeScript docs'); assert.equal(chatSearchQuery({ tools: [{ name: 'WebSearch', input_schema: {} }] }), undefined);
});

/** Chat endpoints must never receive the Responses-only budget, even if the input includes it explicitly. */
for (const stream of [false, true]) test(`Chat native search omits unsupported max_tool_calls with stream=${stream}`, () => {
    const request = { tools: [schema], tool_choice: { type: 'tool', name: 'web_search' }, max_tool_calls: 8, stream };
    const converted = JSON.parse(JSON.stringify(convertAnthropicToOpenAIChat(request).body));
    assert.equal(Object.prototype.hasOwnProperty.call(converted, 'max_tool_calls'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(converted.tools[0], 'max_uses'), false);
    assert.deepEqual(converted.tools, [{ type: 'web_search' }]);
    assert.equal(converted.tool_choice, 'required'); assert.equal(converted.stream, stream);
});

/** Keep text-only provider replies and disclaim search provenance; no invented server-call or source block is emitted. */
test('Chat text-only search preserves links but never treats Markdown as verified source metadata', () => {
    const converted = convertOpenAIChatJsonToAnthropic(completion(), 'off', 'TypeScript docs').body;
    assert.ok(converted.content.some(block => block.type === 'text' && block.text === answer));
    assert.ok(converted.content.some(block => block.type === 'text' && block.text.includes('not independently verified')));
    assert.equal(converted.content.some(block => block.type === 'server_tool_use' || block.type === 'web_search_tool_result'), false);
    assert.equal(converted.stop_reason, 'end_turn');
    assert.deepEqual(convertOpenAIChatJsonToAnthropic(completion()).body.content, [{ type: 'text', text: answer }]);
});

/** Structured annotations are authoritative source metadata and are deduplicated independently of answer text. */
test('Chat structured URL citations create paired CLI source blocks', () => {
    const converted = convertOpenAIChatJsonToAnthropic(completion({ annotations: [{ type: 'url_citation', url_citation: { url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript docs' } }], citations: ['https://www.typescriptlang.org/docs/'] }), 'off', 'TypeScript docs').body;
    const result = converted.content.find(block => block.type === 'web_search_tool_result') as any;
    assert.equal(result.content.length, 1); assert.equal(result.content[0].title, 'TypeScript docs');
    assert.equal(converted.content.filter(block => block.type === 'server_tool_use').length, 1);
});

/** Source metadata may follow finish_reason; the converter waits for final SSE and retains usage. */
test('Chat streamed search accepts late citations, UTF8 text and CRLF with one source result', () => {
    const converter = new OpenAIChatToAnthropicStreamConverter('off', 'TypeScript docs');
    const chunks = [
        { id: 'c', choices: [{ delta: { content: answer + '🙂' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], annotations: [{ type: 'url_citation', url_citation: { url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript docs' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }
    ];
    const wire = chunks.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
    let out = '';
    for (const char of wire) out += converter.feed(char);
    out += converter.end();
    const events = payloads(out);
    assert.equal(events.filter(event => event.content_block?.type === 'web_search_tool_result').length, 1);
    assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
    assert.equal(events.find(event => event.type === 'message_delta').usage.output_tokens, 4);
    assert.equal(converter.getSearchFailure(), undefined);
});

/** Empty, failed and unfinished replies fail explicitly rather than being presented as completed search. */
test('Chat missing or unfinished native search reports errors while text-only streaming stays honest', () => {
    assert.throws(() => convertOpenAIChatJsonToAnthropic({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, 'off', 'q'), /neither search sources nor answer/);
    const broken = new OpenAIChatToAnthropicStreamConverter('off', 'q');
    broken.feed('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    assert.ok(payloads(broken.end()).some(event => event.type === 'error'));
    const converter = new OpenAIChatToAnthropicStreamConverter('off', 'q');
    let out = converter.feed(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
    out += converter.feed('data: [DONE]\n\n');
    assert.ok(out.includes('not independently verified')); assert.equal(out.includes('web_search_tool_result'), false);
    assert.equal(payloads(out).filter(event => event.type === 'message_stop').length, 1);
});

/** A server search must not ask the CLI to execute another function or hide an inline upstream error. */
test('Chat native search rejects function substitutions, invalid sources and inline failures', () => {
    assert.throws(() => convertOpenAIChatJsonToAnthropic({ choices: [{ message: { content: answer, tool_calls: [{ id: 'call', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }, finish_reason: 'stop' }] }, 'off', 'q'), /did not complete/);
    const converter = new OpenAIChatToAnthropicStreamConverter('off', 'q');
    const wire = converter.feed(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'web_search', arguments: '{}' } }] }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    assert.equal(wire.includes('"type":"tool_use"'), false); assert.ok(wire.includes('event: error'));
    const invalid = convertOpenAIChatJsonToAnthropic(completion({ citations: ['javascript:alert(1)', 'https://user:pass@example.com/'] }), 'off', 'q').body;
    assert.equal(invalid.content.some(block => block.type === 'web_search_tool_result'), false);
    assert.ok(invalid.content.some(block => block.type === 'text' && block.text.includes('not independently verified')));
    assert.throws(() => convertOpenAIChatJsonToAnthropic({ error: { message: 'synthetic search failure' }, ...completion() }, 'off', 'q'), /did not complete/);
});
