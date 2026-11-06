/** @file SSE stream-prefix regressions: preserve the first event and never strip BOMs from payload text. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StringDecoder } from 'node:string_decoder';
import { OpenAIChatToAnthropicStreamConverter } from '../openAIChatToAnthropic';
import { OpenAIResponsesToAnthropicStreamConverter } from '../openAIResponsesToAnthropic';
import { RequestOutcomeReporter } from '../../requestOutcome';

const BOM = String.fromCharCode(0xFEFF);
type Protocol = 'chat' | 'responses';

/** Encode one complete event with optional event-name fallback, preserving LF/CRLF boundaries. */
function sse(payload: unknown, newline = '\n', name?: string): string {
    return `${name ? `event: ${name}${newline}` : ''}data: ${JSON.stringify(payload)}${newline}${newline}`;
}

/** Create an independent converter for every response; prefix state must never leak between requests. */
function converter(protocol: Protocol) {
    return protocol === 'chat' ? new OpenAIChatToAnthropicStreamConverter('passthrough')
        : new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
}

/** Complete the input after the first event without supplying replacement text or input-token measurements. */
function finish(protocol: Protocol, newline = '\n'): string {
    return protocol === 'chat'
        ? sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, newline) + `data: [DONE]${newline}${newline}`
        : sse({ type: 'response.completed', response: { status: 'completed' } }, newline);
}

/** Drive a real StringDecoder byte by byte, including empty writes while a multibyte codepoint is pending. */
function convert(protocol: Protocol, wire: string, fragmented: boolean): string {
    const stream = converter(protocol); let output = stream.feed('');
    if (fragmented) {
        const decoder = new StringDecoder('utf8');
        for (const byte of Buffer.from(wire)) output += stream.feed(decoder.write(Buffer.from([byte])));
        output += stream.feed(decoder.end());
    } else output += stream.feed(wire);
    output += stream.end();
    assert.deepEqual(stream.getWarnings(), []);
    return output;
}

/** Decode converted events so assertions inspect actual text/arguments/usage, not escaped raw substrings. */
function events(wire: string): any[] {
    return wire.split('\n\n').flatMap(event => {
        const data = event.split('\n').find(line => line.startsWith('data:'));
        return data ? [JSON.parse(data.slice(5))] : [];
    });
}

for (const protocol of ['chat', 'responses'] as const) {
    for (const newline of ['\n', '\r\n']) for (const fragmented of [false, true]) {
        test(`${protocol} leading BOM preserves first text and usage (${JSON.stringify(newline)}, fragmented=${fragmented})`, () => {
            const text = `首段🙂${BOM}正文`;
            const first = protocol === 'chat'
                ? { id: 'first', model: 'fixture', choices: [{ delta: { content: text } }], usage: { prompt_tokens: 17, completion_tokens: 3 } }
                : { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text };
            const wire = sse(first, newline) + finish(protocol, newline);
            const expected = convert(protocol, wire, fragmented);
            const actual = convert(protocol, BOM + wire, fragmented);
            assert.equal(actual, expected);
            const parsed = events(actual);
            assert.equal(parsed.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join(''), text);
            assert.equal(parsed.filter(event => event.type === 'message_stop').length, 1);
            if (protocol === 'chat') assert.equal(parsed.find(event => event.type === 'message_start').message.usage.input_tokens, 17);
        });
    }

    test(`${protocol} BOM does not hide the first tool identity or alter its arguments`, () => {
        const args = JSON.stringify({ value: `${BOM}保留内部字符🙂${BOM}` });
        const wire = protocol === 'chat'
            ? sse({ id: 'first', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-first', function: { name: 'lookup', arguments: args } }] } }] }) + finish(protocol)
            : sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc-first', call_id: 'call-first', name: 'lookup', arguments: '' } })
                + sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args })
                + sse({ type: 'response.function_call_arguments.done', output_index: 0, arguments: args }) + finish(protocol);
        const actual = convert(protocol, BOM + wire, true);
        assert.equal(actual, convert(protocol, wire, true));
        const parsed = events(actual);
        assert.equal(parsed.find(event => event.content_block?.type === 'tool_use').content_block.name, 'lookup');
        assert.equal(parsed.find(event => event.content_block?.type === 'tool_use').content_block.id, 'call-first');
        assert.equal(parsed.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''), args);
    });

    test(`${protocol} BOM on a separate first chunk survives empty chunks and final unterminated data`, () => {
        const first = protocol === 'chat' ? { choices: [{ delta: { content: 'tail-only' }, finish_reason: 'stop' }] }
            : { type: 'response.completed', response: { id: 'tail', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'tail-only' }] }] } };
        const tail = `data: ${JSON.stringify(first)}`;
        const stream = converter(protocol);
        assert.equal(stream.feed(''), ''); assert.equal(stream.feed(BOM), ''); assert.equal(stream.feed(''), '');
        assert.equal(stream.feed(tail) + stream.end(), convert(protocol, tail, false));
    });

    test(`${protocol} strips only one BOM at the absolute start, never at a later event or after whitespace`, () => {
        const payload = protocol === 'chat' ? { choices: [{ delta: { content: 'MUST_NOT_APPEAR' } }] }
            : { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'MUST_NOT_APPEAR' };
        for (const wire of [BOM + BOM + sse(payload), `: heartbeat\n\n${BOM}${sse(payload)}`, `\n${BOM}${sse(payload)}`]) {
            const actual = convert(protocol, wire + finish(protocol), true);
            assert.equal(actual.includes('MUST_NOT_APPEAR'), false);
        }
        const stream = converter(protocol);
        stream.feed(': heartbeat\n\n'); stream.feed(BOM + `data: ${JSON.stringify(payload)}`);
        assert.equal(stream.end().includes('MUST_NOT_APPEAR'), false, 'end() must not trim a non-leading BOM into a valid data field');
    });
}

/** Responses may rely exclusively on event: rather than a duplicated type in the JSON body. */
test('Responses leading BOM preserves event-name fallback and first response usage', () => {
    const named = sse({ output_index: 0, content_index: 0, delta: 'event-name-only' }, '\r\n', 'response.output_text.delta') + finish('responses');
    assert.equal(convert('responses', BOM + named, true), convert('responses', named, true));
    const usage = sse({ type: 'response.created', response: { id: 'usage-first', model: 'fixture', usage: { input_tokens: 23, output_tokens: 7 } } }) + finish('responses');
    const actual = convert('responses', BOM + usage, true);
    assert.equal(actual, convert('responses', usage, true));
    assert.equal(events(actual).find(event => event.type === 'message_start').message.usage.input_tokens, 23);
});

/** Error and terminal evidence must agree with converters even when the protocol only sends a single BOM-prefixed event. */
test('BOM-prefixed first error and terminal remain visible to the outcome reporter', () => {
    for (const payload of [{ error: { code: 'rate_limit_exceeded' } }, { type: 'response.failed', response: { status: 'failed', error: { code: 'provider_failed' } } }]) {
        const reporter = new RequestOutcomeReporter(); reporter.headers(200);
        for (const char of BOM + sse(payload, '\r\n')) reporter.feed(char);
        assert.equal(reporter.snapshot().status, 'error'); assert.equal(reporter.snapshot().stage, 'upstream_inline_error');
    }
    for (const wire of [sse({ type: 'message_stop' }), sse({ type: 'response.completed' }), 'data: [DONE]\n\n']) {
        const reporter = new RequestOutcomeReporter(); reporter.feed(''); reporter.feed(BOM); reporter.feed(''); reporter.feed(wire);
        assert.equal(reporter.hasStreamTerminal(), true);
    }
});
