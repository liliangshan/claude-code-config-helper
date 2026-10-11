/** @file UTF-8 网络分片与 Responses 工具参数快照冲突回归测试。 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import type { UpstreamAdapter } from '../router';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { OpenAIResponsesToAnthropicStreamConverter } = require('../converters/openAIResponsesToAnthropic') as typeof import('../converters/openAIResponsesToAnthropic');

for (const final of ['{"text":"same-length"}', '{"text":"x"}', '{"text":"different-and-longer"}']) {
    test(`Responses 最终参数改变已发送前缀时安全失败：${final}`, () => {
        const diagnostics: string[] = [];
        const converter = new OpenAIResponsesToAnthropicStreamConverter(message => diagnostics.push(message));
        const original = '{"text":"old-content"}';
        const output = converter.feed(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call', name: 'Edit', arguments: '' } }))
            + converter.feed(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: original }))
            + converter.feed(sse({ type: 'response.function_call_arguments.done', output_index: 0, arguments: final })
                + sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: final } })
                + sse({ type: 'response.completed', response: { status: 'completed' } }))
            + converter.end();
        const events = parseEvents(output);
        assert.equal(events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''), original);
        assert.equal(events.filter(event => event.type === 'error').length, 1);
        assert.equal(events.some(event => event.type === 'message_stop'), false);
        assert.equal(events.some(event => event.type === 'content_block_stop'), false);
        assert.ok(diagnostics.length > 0);
    });
}

test('Responses done 只补发前缀匹配的剩余参数，重复 done 不重复输出', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter();
    const complete = '{"text":"完整🙂"}';
    const output = converter.feed(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call', name: 'Edit', arguments: '' } }))
        + converter.feed(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"text":' }))
        + converter.feed(sse({ type: 'response.function_call_arguments.done', output_index: 0, arguments: complete }))
        + converter.feed(sse({ type: 'response.function_call_arguments.done', output_index: 0, arguments: complete }))
        + converter.feed(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: complete } }))
        + converter.feed(sse({ type: 'response.completed', response: { status: 'completed' } })) + converter.end();
    const events = parseEvents(output);
    assert.equal(events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''), complete);
    assert.equal(events.some(event => event.type === 'error'), false);
});

/** 测试响应正文与工具参数包含中文、四字节 emoji 及 JSON 转义。 */
const text = '中文估算🙂，保留逐字输出';
const args = JSON.stringify({ file_path: '/测试/🙂.md', new_string: '估算值\n"引用"\\路径🙂', old_string: '旧值', replace_all: false });

/** 把事件编码为 UTF-8 SSE，包含 event 名以兼容任务流拦截器。 */
function sse(value: Record<string, unknown>): string {
    return `${typeof value.type === 'string' ? `event: ${value.type}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
}

/** 解析下发的 SSE JSON 事件。 */
function parseEvents(raw: string): Array<Record<string, any>> {
    return raw.split('\n\n').flatMap(block => {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
    });
}

/** 为三个协议构造语义相同的流，并返回文本早于工具结束的分段。 */
function fixture(protocol: string): [string, string] {
    if (protocol === 'responses') {
        return [
            sse({ type: 'response.created', response: { id: 'fixture', model: 'fixture' } })
                + sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }),
            sse({ type: 'response.output_text.done', output_index: 0, content_index: 0 })
                + sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'Edit', arguments: '' } })
                + sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: args })
                + sse({ type: 'response.function_call_arguments.done', output_index: 1, arguments: args })
                + sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', arguments: args } })
                + sse({ type: 'response.completed', response: { status: 'completed' } })
        ];
    }
    if (protocol === 'chat') {
        return [sse({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta: { content: text } }] }),
            sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'Edit', arguments: args } }] } }] })
                + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'];
    }
    return [
        sse({ type: 'message_start', message: { id: 'fixture', model: 'fixture', usage: {} } })
            + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
            + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
        sse({ type: 'content_block_stop', index: 0 })
            + sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'Edit', input: {} } })
            + sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args } })
            + sse({ type: 'content_block_stop', index: 1 })
            + sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} })
            + sse({ type: 'message_stop' })
    ];
}

for (const protocol of ['responses', 'chat', 'anthropic']) {
    for (const intercept of [false, true]) {
        test(`${protocol} intercept=${intercept}: 每字节拆包仍保留中文、emoji、完整工具 JSON 和实时文本`, async (t) => {
            const wire: Buffer[] = [];
            const upstream = Object.assign(new EventEmitter(), {
                statusCode: 200, headers: { 'content-type': 'text/event-stream' }, complete: false, readableEnded: false, destroyed: false,
                /** 假响应不创建真实超时定时器。 */
                setTimeout: () => upstream
            });
            const downstream = Object.assign(new EventEmitter(), {
                statusCode: 200, writableEnded: false, writableFinished: false, headersSent: false,
                /** 忽略测试中无需断言的响应头。 */
                setHeader: () => {}, removeHeader: () => {},
                /** 保存输出字节以检测分片期间是否已经发送文本。 */
                write: (value: string | Buffer) => { wire.push(Buffer.from(value)); return true; },
                /** 模拟下行正常结束，供客户端断开监听区分。 */
                end: (value?: string | Buffer) => { if (value) wire.push(Buffer.from(value)); downstream.writableEnded = true; downstream.writableFinished = true; }
            });
            let started!: () => void;
            const ready = new Promise<void>(resolve => { started = resolve; });
            t.mock.method(require('node:http'), 'request', (_options: unknown, callback: (response: unknown) => void) => {
                const request = Object.assign(new EventEmitter(), {
                    write: () => true, destroy: () => {},
                    /** 请求发出后异步启动假上游，遵循 Node HTTP 事件顺序。 */
                    end: () => { queueMicrotask(() => { callback(upstream); started(); }); }
                });
                return request;
            });
            const deps = intercept ? {
                configManager: { getChatCacheTtl: () => 'default', getChatSubagentsEnabled: () => false, getResolvedUiLanguage: () => 'en', getSharedSystemPrompt: () => '' },
                llsTaskService: { hasActiveWorkflow: () => false, hasPendingWorkflowCreation: () => false },
                autoContinueScheduler: { resetMissingToolCounter: () => {}, cancel: () => {}, armIdleWatchdog: () => {} }
            } : undefined;
            const modulePath = protocol === 'responses' ? '../openaiResponsesProxy' : protocol === 'chat' ? '../openaiChatProxy' : '../anthropicProxy';
            const name = protocol === 'responses' ? 'OpenAIResponsesProxyAdapter' : protocol === 'chat' ? 'OpenAIChatProxyAdapter' : 'AnthropicProxyAdapter';
            const Adapter = require(modulePath)[name];
            const adapter: UpstreamAdapter = new Adapter(undefined, deps);
            const parsedBody = { model: 'fixture', stream: true, messages: [] };
            const pending = adapter.handle({
                req: { headers: {} } as http.IncomingMessage, res: downstream as unknown as http.ServerResponse,
                provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', authMode: 'none', models: [] } as never,
                modelId: 'fixture', parsedBody, rawBody: JSON.stringify(parsedBody)
            });
            await ready;
            const [early, late] = fixture(protocol);
            for (const byte of Buffer.from(early)) upstream.emit('data', Buffer.from([byte]));
            assert.ok(Buffer.concat(wire).toString('utf8').includes(text), '正文应在工具生成完成前发送');
            for (const byte of Buffer.from(late)) upstream.emit('data', Buffer.from([byte]));
            upstream.complete = true;
            upstream.readableEnded = true;
            upstream.emit('end');
            await pending;
            const output = Buffer.concat(wire).toString('utf8');
            assert.equal(output.includes('�'), false);
            const events = parseEvents(output);
            const emitted = events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join('');
            assert.equal(emitted, args);
            assert.deepEqual(JSON.parse(emitted), JSON.parse(args));
            assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
            assert.equal(events.some(event => event.type === 'error'), false);
        });
    }
}
