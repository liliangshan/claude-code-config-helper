/** @file Native web-search request/response conversion uses real provider sources and rejects unsupported protocols. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertAnthropicToOpenAIResponses } from '../anthropicToOpenAIResponses';
import { convertAnthropicToOpenAIChat } from '../anthropicToOpenAIChat';
import { convertResponsesJsonToAnthropic, OpenAIResponsesToAnthropicStreamConverter } from '../openAIResponsesToAnthropic';
import { NativeWebSearchError } from '../nativeWebSearch';

const schema = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 };
const search = { id: 'ws_test', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'TypeScript docs', sources: [{ type: 'url', url: 'https://www.typescriptlang.org/docs/' }] } };
const message = { type: 'message', content: [{ type: 'output_text', text: 'Official docs', annotations: [{ type: 'url_citation', url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript documentation' }] }] };

/** Encode one upstream SSE frame; converters must accept arbitrary network splits. */
function frame(type: string, value: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

/** Read only complete Anthropic event payloads for protocol assertions. */
function events(wire: string): any[] {
    return wire.split('\n\n').flatMap(block => {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        return data ? [JSON.parse(data)] : [];
    });
}

/** Typed server search maps to Responses search, while ordinary WebSearch stays a function. */
test('native search schema and tool_choice are mapped without an invented function schema', () => {
    const input = { tools: [{ ...schema, allowed_domains: ['typescriptlang.org'], user_location: { type: 'approximate', country: 'US' } }, { name: 'WebSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }], tool_choice: { type: 'tool', name: 'web_search' }, stream: true };
    const { body, warnings } = convertAnthropicToOpenAIResponses(input);
    assert.deepEqual(body.tools?.[0], { type: 'web_search', filters: { allowed_domains: ['typescriptlang.org'] }, user_location: { type: 'approximate', country: 'US' } });
    assert.equal(body.tools?.[1].type, 'function'); assert.equal(body.tools?.[1].name, 'WebSearch');
    assert.deepEqual(body.tool_choice, { type: 'web_search' });
    assert.deepEqual(body.include, ['web_search_call.action.sources']); assert.equal(body.stream, true); assert.equal('max_tool_calls' in body, false);
    assert.equal(warnings.some(warning => warning.code === 'invalid_input_schema'), false);
    assert.equal(convertAnthropicToOpenAIResponses({ tools: [{ name: 'web_search', input_schema: {} }] }).body.tools?.[0].type, 'function');
});

/** Responses gateways must not receive unsupported budgets, even when upstream input explicitly carries them. */
for (const stream of [false, true]) test(`Responses native search omits max_tool_calls with stream=${stream}`, () => {
    const request = { tools: [schema], tool_choice: { type: 'tool', name: 'web_search' }, max_tool_calls: 8, stream };
    const converted = JSON.parse(JSON.stringify(convertAnthropicToOpenAIResponses(request).body));
    assert.equal(Object.prototype.hasOwnProperty.call(converted, 'max_tool_calls'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(converted.tools[0], 'max_uses'), false);
    assert.deepEqual(converted.tools, [{ type: 'web_search' }]);
    assert.deepEqual(converted.tool_choice, { type: 'web_search' });
    assert.deepEqual(converted.include, ['web_search_call.action.sources']);
    assert.equal(converted.stream, stream);
});

/** Unsupported exclusions remain explicit, while Chat native search is not downgraded into a function. */
test('unsupported filters fail and native Chat search preserves the server tool declaration', () => {
    assert.throws(() => convertAnthropicToOpenAIResponses({ tools: [{ ...schema, blocked_domains: ['example.com'] }] }), NativeWebSearchError);
    const result = convertAnthropicToOpenAIChat({ tools: [schema], tool_choice: { type: 'tool', name: 'web_search' }, stream: true });
    assert.deepEqual(result.body.tools?.[0], { type: 'web_search' });
    assert.equal(result.body.tool_choice, 'required'); assert.equal('max_tool_calls' in result.body, false);
    assert.throws(() => convertAnthropicToOpenAIChat({ tools: [{ ...schema, blocked_domains: ['example.com'] }] }), /blocked_domains/);
    assert.equal(convertAnthropicToOpenAIChat({ tools: [{ name: 'WebSearch', input_schema: {} }] }).body.tools?.[0].function?.name, 'WebSearch');
});

/** JSON search blocks are paired, deduplicated and do not trigger locally executable tool_use. */
test('JSON search output preserves real URLs and titles as CLI-native result blocks', () => {
    const result = convertResponsesJsonToAnthropic({ output: [search, message, search], status: 'completed' }, 'off', true);
    const blocks = result.body.content as any[];
    assert.equal(result.body.stop_reason, 'end_turn');
    assert.equal(blocks.filter(block => block.type === 'server_tool_use').length, 1);
    const native = blocks.find(block => block.type === 'web_search_tool_result');
    assert.equal(native.tool_use_id, blocks[0].id);
    assert.deepEqual(native.content, [{ type: 'web_search_result', url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript documentation' }]);
    assert.equal(blocks.some(block => block.type === 'tool_use'), false);
    assert.equal(result.warnings.some(warning => warning.code === 'unsupported_output_item'), false);
});

/** Reproduce split source/citation events and repeated completed snapshots from the tested Responses wire. */
test('streamed search emits one native result and retains all text until completion', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'off', true);
    const wire = frame('response.created', { response: { id: 'r', model: 'm' } })
        + frame('response.output_item.added', { output_index: 0, item: { ...search, status: 'in_progress', action: undefined } })
        + frame('response.web_search_call.searching', { item_id: search.id })
        + frame('response.output_item.done', { output_index: 0, item: search })
        + frame('response.output_text.delta', { output_index: 1, content_index: 0, delta: 'Official ' })
        + frame('response.output_text.annotation.added', { output_index: 1, content_index: 0, annotation: message.content[0].annotations[0] })
        + frame('response.output_text.delta', { output_index: 1, content_index: 0, delta: 'docs' })
        + frame('response.completed', { response: { id: 'r', status: 'completed', output: [search, message] } });
    let out = '';
    for (const char of wire.replace(/\n/g, '\r\n')) out += converter.feed(char);
    out += converter.end();
    const payloads = events(out), blocks = payloads.filter(event => event.type === 'content_block_start').map(event => event.content_block);
    assert.equal(payloads.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join(''), 'Official docs');
    assert.equal(blocks.filter(block => block.type === 'server_tool_use').length, 1);
    assert.equal(blocks.filter(block => block.type === 'web_search_tool_result').length, 1);
    assert.equal(blocks.find(block => block.type === 'web_search_tool_result').content[0].title, 'TypeScript documentation');
    assert.equal(payloads.filter(event => event.type === 'message_stop').length, 1);
    assert.equal(blocks.some(block => block.type === 'tool_use'), false);
    assert.equal(converter.getWarnings().length, 0);
});

/** Missing search, unsupported function-call substitution and premature EOF cannot look like successful empty search. */
test('missing, failed and truncated searches return explicit errors without fabricated URLs', () => {
    assert.throws(() => convertResponsesJsonToAnthropic({ output: [message] }, 'off', true), /no native web-search result/);
    const ignored = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'off', true);
    const payloads = events(ignored.feed(frame('response.completed', { response: { status: 'completed', output: [message] } })));
    assert.equal(payloads.some(event => event.type === 'error'), true);
    assert.equal(payloads.some(event => event.type === 'message_stop'), false);
    const failed = convertResponsesJsonToAnthropic({ output: [{ ...search, status: 'failed', action: {} }] }, 'off', true).body.content as any[];
    assert.equal(failed[1].content.error_code, 'unavailable');
    const truncated = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'off', true);
    truncated.feed(frame('response.output_item.done', { output_index: 0, item: search }));
    assert.equal(events(truncated.end()).some(event => event.type === 'error'), true);
    const invalid = { ...search, action: { query: 'test', sources: [{ url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com/' }] } };
    const result = convertResponsesJsonToAnthropic({ output: [invalid] }, 'off', true).body.content as any[];
    assert.equal(Array.isArray(result[1].content), false);
});

/** A gateway may provide only terminal snapshots; citations still become real links once. */
test('terminal-only search snapshots and citation-only sources remain available', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'off', true);
    const item = { ...search, action: { query: 'TypeScript docs' } };
    const payloads = events(converter.feed(frame('response.completed', { response: { status: 'completed', output: [item, message] } })));
    const results = payloads.filter(event => event.content_block?.type === 'web_search_tool_result');
    assert.equal(results.length, 1); assert.equal(results[0].content_block.content[0].url, 'https://www.typescriptlang.org/docs/');
});

/** Multiple calls keep their own source lists; global citations cannot be assigned to unrelated searches. */
test('multiple native searches do not exchange URLs or trigger local function execution', () => {
    const other = { ...search, id: 'ws_other', action: { query: 'Other docs', sources: [{ url: 'https://example.com/other', title: 'Other documentation' }] } };
    const result = convertResponsesJsonToAnthropic({ status: 'completed', output: [search, other, message] }, 'off', true).body.content as any[];
    const results = result.filter(block => block.type === 'web_search_tool_result');
    assert.equal(results.length, 2);
    assert.deepEqual(results[0].content.map((item: any) => item.url), ['https://www.typescriptlang.org/docs/']);
    assert.deepEqual(results[1].content.map((item: any) => item.url), ['https://example.com/other']);
    const streamed = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'off', true);
    const wire = streamed.feed(frame('response.completed', { response: { status: 'completed', output: [search, other, message] } }));
    const searchResults = events(wire).filter(event => event.content_block?.type === 'web_search_tool_result');
    assert.equal(searchResults.length, 2);
    assert.deepEqual(searchResults[1].content_block.content.map((item: any) => item.url), ['https://example.com/other']);
    assert.notEqual(results[0].tool_use_id, results[1].tool_use_id);
});
