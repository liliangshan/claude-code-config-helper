/**
 * @file Anthropic/OpenAI Chat 协议转换器轻量单元测试。
 *
 * 该文件不依赖第三方测试框架，直接使用 Node assert，便于在当前扩展项目中
 * 通过 ts-node 之外的 `out/**` 编译产物执行。
 */

import * as assert from 'assert';

import { convertAnthropicToOpenAIChat } from '../anthropicToOpenAIChat';
import { convertAnthropicToOpenAIResponses } from '../anthropicToOpenAIResponses';
import { sanitizeErrorMessage } from '../openAIErrorToAnthropic';
import { convertOpenAIChatJsonToAnthropic } from '../openAIChatToAnthropic';
import { convertResponsesJsonToAnthropic, OpenAIResponsesToAnthropicStreamConverter } from '../openAIResponsesToAnthropic';

/** 单个测试用例。 */
interface TestCase {
    /** 测试名称。 */
    name: string;
    /** 测试函数。 */
    run: () => void;
}

/** 所有轻量协议转换测试用例。 */
const tests: TestCase[] = [
    {
        name: 'Anthropic system 字符串、文本、图片、工具定义、tool_choice 可转换为 OpenAI Chat',
        run: () => {
            const result = convertAnthropicToOpenAIChat({
                model: 'claude-sonnet',
                system: 'You are helpful.',
                max_tokens: 128,
                stop_sequences: ['END'],
                metadata: { user_id: 'u-1' },
                tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
                tool_choice: { type: 'tool', name: 'lookup' },
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'hello' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }
                    ]
                }]
            });
            assert.strictEqual(result.body.model, 'claude-sonnet');
            assert.strictEqual(result.body.messages[0].role, 'system');
            assert.strictEqual(result.body.messages[1].role, 'user');
            assert.deepStrictEqual(result.body.stop, ['END']);
            assert.strictEqual(result.body.user, 'u-1');
            assert.deepStrictEqual(result.body.tool_choice, { type: 'function', function: { name: 'lookup' } });
            assert.strictEqual(result.body.tools?.[0].function.name, 'lookup');
        }
    },
    {
        name: 'Anthropic assistant tool_use 与 user tool_result 可映射为 OpenAI tool_calls/tool 消息',
        run: () => {
            const result = convertAnthropicToOpenAIChat({
                model: 'm',
                messages: [
                    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result' }] }] }
                ]
            });
            assert.strictEqual(result.body.messages[0].role, 'assistant');
            assert.strictEqual(result.body.messages[0].tool_calls?.[0].function.name, 'lookup');
            assert.strictEqual(result.body.messages[1].role, 'tool');
            assert.strictEqual(result.body.messages[1].tool_call_id, 'toolu_1');
            assert.strictEqual(result.body.messages[1].content, 'result');
        }
    },
    {
        name: 'Anthropic thinking/cache_control/未知 block 产生降级 warning',
        run: () => {
            const result = convertAnthropicToOpenAIChat({
                model: 'm',
                system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
                messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'unknown_kind', value: 1 }] }]
            });
            assert.ok(result.warnings.some((warning) => warning.code === 'unsupported_cache_control'));
            assert.ok(result.warnings.some((warning) => warning.code === 'ignored_thinking'));
            assert.ok(result.warnings.some((warning) => warning.code === 'unsupported_block'));
        }
    },
    {
        name: 'Anthropic system、文本、图片、工具定义、tool_choice 可转换为 OpenAI Responses',
        run: () => {
            const result = convertAnthropicToOpenAIResponses({
                model: 'claude-sonnet',
                system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
                max_tokens: 128,
                stream: true,
                metadata: { user_id: 'u-1', trace: 't-1' },
                tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
                tool_choice: { type: 'tool', name: 'lookup' },
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'hello' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }
                    ]
                }]
            });
            assert.strictEqual(result.body.model, 'claude-sonnet');
            assert.strictEqual(result.body.instructions, 'You are helpful.');
            assert.strictEqual(result.body.max_output_tokens, 128);
            assert.strictEqual(result.body.stream, true);
            assert.strictEqual(result.body.user, 'u-1');
            assert.deepStrictEqual(result.body.tool_choice, { type: 'function', name: 'lookup' });
            assert.strictEqual(result.body.tools?.[0].name, 'lookup');
            assert.deepStrictEqual(result.body.input[0], {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'hello' },
                    { type: 'input_image', image_url: 'data:image/png;base64,abc' }
                ]
            });
            assert.ok(result.warnings.some((warning) => warning.code === 'unsupported_cache_control'));
        }
    },
    {
        name: 'Anthropic tool_use 与 tool_result 可转换为 Responses function_call/function_call_output 并保持 call_id',
        run: () => {
            const result = convertAnthropicToOpenAIResponses({
                model: 'm',
                messages: [
                    { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result' }] }] }
                ]
            });
            assert.deepStrictEqual(result.body.input[0], { role: 'assistant', content: [{ type: 'output_text', text: 'before' }] });
            assert.deepStrictEqual(result.body.input[1], {
                type: 'function_call',
                call_id: 'toolu_1',
                name: 'lookup',
                arguments: JSON.stringify({ q: 'x' })
            });
            assert.deepStrictEqual(result.body.input[2], { type: 'function_call_output', call_id: 'toolu_1', output: 'result' });
        }
    },
    {
        name: 'Anthropic thinking/未知 block/metadata 非对象在 Responses 转换中产生 warning',
        run: () => {
            const result = convertAnthropicToOpenAIResponses({
                model: 'm',
                metadata: 'bad',
                messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'unknown_kind', value: 1 }] }]
            });
            assert.ok(result.warnings.some((warning) => warning.code === 'invalid_metadata'));
            assert.ok(result.warnings.some((warning) => warning.code === 'ignored_thinking'));
            assert.ok(result.warnings.some((warning) => warning.code === 'unsupported_block'));
        }
    },
    {
        name: 'OpenAI Chat JSON 文本与用量可转换为 Anthropic message',
        run: () => {
            const result = convertOpenAIChatJsonToAnthropic({
                id: 'chatcmpl_1',
                model: 'gpt-test',
                choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 5 }
            });
            assert.strictEqual(result.body.id, 'msg_chatcmpl_1');
            assert.deepStrictEqual(result.body.content, [{ type: 'text', text: 'hello' }]);
            assert.strictEqual(result.body.stop_reason, 'end_turn');
            assert.deepStrictEqual(result.body.usage, { input_tokens: 3, output_tokens: 5 });
        }
    },
    {
        name: 'OpenAI Chat tool_calls 和非法 arguments JSON 可转换并产生 warning',
        run: () => {
            const result = convertOpenAIChatJsonToAnthropic({
                id: 'chatcmpl_2',
                model: 'gpt-test',
                choices: [{
                    message: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{bad' } }] },
                    finish_reason: 'tool_calls'
                }]
            });
            assert.strictEqual(result.body.stop_reason, 'tool_use');
            assert.deepStrictEqual(result.body.content[0], { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} });
            assert.ok(result.warnings.some((warning) => warning.code === 'invalid_tool_arguments_json'));
        }
    },
    {
        name: 'OpenAI Responses JSON output_text/function_call/usage 可转换为 Anthropic message',
        run: () => {
            const result = convertResponsesJsonToAnthropic({
                id: 'resp_1',
                model: 'gpt-resp',
                status: 'completed',
                output: [
                    { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
                    { type: 'function_call', call_id: 'call_1', id: 'fc_1', name: 'lookup', arguments: '{"q":"x"}' }
                ],
                usage: { input_tokens: 7, output_tokens: 11, input_tokens_details: { cached_tokens: 3 } }
            });
            assert.strictEqual(result.body.id, 'msg_resp_1');
            assert.deepStrictEqual(result.body.content[0], { type: 'text', text: 'hello' });
            assert.deepStrictEqual(result.body.content[1], { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } });
            assert.strictEqual(result.body.stop_reason, 'tool_use');
            assert.deepStrictEqual(result.body.usage, { input_tokens: 7, output_tokens: 11 });
        }
    },
    {
        name: 'OpenAI Responses JSON incomplete、refusal、非法 arguments 可转换并产生 warning',
        run: () => {
            const result = convertResponsesJsonToAnthropic({
                id: 'resp_2',
                model: 'gpt-resp',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                output: [
                    { type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'unknown_part' }] },
                    { type: 'function_call', id: 'fc_2', name: 'bad_args', arguments: '{bad' },
                    { type: 'reasoning', summary: [] }
                ]
            });
            assert.strictEqual(result.body.stop_reason, 'tool_use');
            assert.deepStrictEqual(result.body.content[0], { type: 'text', text: 'no' });
            assert.deepStrictEqual(result.body.content[1], { type: 'tool_use', id: 'fc_2', name: 'bad_args', input: {} });
            assert.ok(result.warnings.some((warning) => warning.code === 'refusal_as_text'));
            assert.ok(result.warnings.some((warning) => warning.code === 'unsupported_content_part'));
            assert.ok(result.warnings.some((warning) => warning.code === 'invalid_tool_arguments_json'));
            assert.ok(result.warnings.some((warning) => warning.code === 'ignored_reasoning'));
        }
    },
    {
        name: 'OpenAI Responses SSE 文本流可转换为 Anthropic SSE 且关闭 block',
        run: () => {
            const converter = new OpenAIResponsesToAnthropicStreamConverter();
            const out = [
                converter.feed(toSse('response.created', { type: 'response.created', response: { id: 'resp_s_1', model: 'gpt-resp', usage: { input_tokens: 2 } } })),
                converter.feed(toSse('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text' } })),
                converter.feed(toSse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'he' })),
                converter.feed(toSse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'llo' })),
                converter.feed(toSse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0 })),
                converter.feed(toSse('response.completed', { type: 'response.completed', response: { id: 'resp_s_1', model: 'gpt-resp', status: 'completed', usage: { input_tokens: 2, output_tokens: 3 } } }))
            ].join('');
            assert.ok(out.includes('event: message_start'));
            assert.ok(out.includes('"id":"msg_resp_s_1"'));
            assert.ok(out.includes('"type":"text_delta","text":"he"'));
            assert.ok(out.includes('"type":"text_delta","text":"llo"'));
            assert.ok(out.includes('event: content_block_stop'));
            assert.ok(out.includes('"stop_reason":"end_turn"'));
            assert.ok(out.includes('event: message_stop'));
        }
    },
    {
        name: 'OpenAI Responses SSE function_call 分片可转换为 Anthropic tool_use',
        run: () => {
            const converter = new OpenAIResponsesToAnthropicStreamConverter();
            const out = [
                converter.feed(toSse('response.created', { type: 'response.created', response: { id: 'resp_s_2', model: 'gpt-resp' } })),
                converter.feed(toSse('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup' } })),
                converter.feed(toSse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"q"' })),
                converter.feed(toSse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 1, delta: ':"x"}' })),
                converter.feed(toSse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"q":"x"}' })),
                converter.feed(toSse('response.completed', { type: 'response.completed', response: { id: 'resp_s_2', model: 'gpt-resp', status: 'completed' } }))
            ].join('');
            assert.ok(out.includes('"type":"tool_use","id":"call_1","name":"lookup"'));
            assert.ok(out.includes('"type":"input_json_delta","partial_json":"{\\"q\\""'));
            assert.ok(out.includes('"type":"input_json_delta","partial_json":":\\"x\\"}"'));
            assert.ok(out.includes('"stop_reason":"tool_use"'));
        }
    },
    {
        name: 'OpenAI Responses SSE incomplete 与 error 事件可转换为 Anthropic 收尾或错误',
        run: () => {
            const incomplete = new OpenAIResponsesToAnthropicStreamConverter();
            const incompleteOut = incomplete.feed(toSse('response.incomplete', {
                type: 'response.incomplete',
                response: { id: 'resp_s_3', model: 'gpt-resp', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
            }));
            assert.ok(incompleteOut.includes('"stop_reason":"max_tokens"'));

            const failed = new OpenAIResponsesToAnthropicStreamConverter();
            const failedOut = failed.feed(toSse('response.failed', {
                type: 'response.failed',
                response: { id: 'resp_s_4', error: { message: 'Authorization: secret Bearer sk-test failed' } }
            }));
            assert.ok(failedOut.includes('event: error'));
            assert.ok(!failedOut.includes('secret'));
            assert.ok(!failedOut.includes('sk-test'));
        }
    },
    {
        name: '错误消息会脱敏 URL query、Authorization、x-api-key、cookie 与 Bearer token',
        run: () => {
            const sanitized = sanitizeErrorMessage(
                'GET https://api.example.com/v1?api_key=secret Authorization: abc x-api-key=def cookie=session Bearer sk-test'
            );
            assert.ok(!sanitized.includes('secret'));
            assert.ok(!sanitized.includes('abc'));
            assert.ok(!sanitized.includes('def'));
            assert.ok(!sanitized.includes('session'));
            assert.ok(!sanitized.includes('sk-test'));
        }
    }
];

/**
 * 构造 OpenAI 风格 SSE 事件文本。
 *
 * @param event SSE event 名称。
 * @param data SSE data JSON。
 * @returns SSE 文本。
 */
function toSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 执行所有测试用例。
 */
function main(): void {
    for (const test of tests) {
        test.run();
        // eslint-disable-next-line no-console
        console.log(`✓ ${test.name}`);
    }
}

main();
