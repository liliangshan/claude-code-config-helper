/** @file Responses 可见思考摘要增量、完整快照去重及工具参数隔离回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAIResponsesToAnthropicStreamConverter, convertResponsesJsonToAnthropic } from '../openAIResponsesToAnthropic';

/** 将上游事件编码为 SSE。 */
function sse(type: string, value: Record<string, unknown> = {}): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

/** 从转换输出中提取 JSON 帧。 */
function events(raw: string): Array<Record<string, any>> {
    return raw.split('\n\n').flatMap(frame => {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        return data ? [JSON.parse(data)] : [];
    });
}

/** 构造摘要事件，允许省略 item_id 测试 output_index 去重。 */
function summary(type: string, value: Record<string, unknown> = {}): string {
    return sse(`response.reasoning_summary_${type}`, { output_index: 0, item_id: 'reason-1', summary_index: 0, ...value });
}

/** 构造只有可见摘要的 reasoning 输出项，附带不能显示的加密字段。 */
function item(text: string): Record<string, unknown> {
    return { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text }], encrypted_content: 'SECRET_ENCRYPTED_CONTENT' };
}

/** 提取实际发送的思考文本。 */
function thinking(raw: string): string {
    return events(raw).filter(event => event.delta?.type === 'thinking_delta').map(event => event.delta.thinking).join('');
}

test('摘要 delta 即刻下发；text.done/part.done/item.done/completed/end 不重复', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
    let out = converter.feed(sse('response.output_item.added', { output_index: 0, item: item('') }));
    assert.equal(thinking(out), '');
    out += converter.feed(summary('part.added', { part: { type: 'summary_text', text: '' } }));
    const first = converter.feed(summary('text.delta', { delta: '先看🙂' }));
    assert.equal(thinking(first), '先看🙂', '未收到 done 前必须可见');
    out += first + converter.feed(summary('text.delta', { delta: '\n再分析' }));
    out += converter.feed(summary('text.done', { text: '先看🙂\n再分析完成' }));
    out += converter.feed(summary('text.done', { text: '先看🙂\n再分析完成' }));
    out += converter.feed(summary('part.done', { part: { type: 'summary_text', text: '先看🙂\n再分析完成' } }));
    out += converter.feed(sse('response.output_item.done', { output_index: 0, item: item('先看🙂\n再分析完成') }));
    out += converter.feed(sse('response.completed', { response: { output: [item('先看🙂\n再分析完成')] } }));
    out += converter.end() + converter.end();
    assert.equal(thinking(out), '先看🙂\n再分析完成');
    assert.equal(events(out).filter(event => event.type === 'content_block_start').length, 1);
    assert.equal(events(out).filter(event => event.type === 'content_block_stop').length, 1);
    assert.equal(events(out).filter(event => event.type === 'message_stop').length, 1);
    assert.equal(out.includes('SECRET_ENCRYPTED_CONTENT'), false);
});

test('多个摘要段不串块，省略 item_id 或 summaryIndex=0 都正确', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
    const out = converter.feed(summary('text.delta', { delta: '第一段', item_id: undefined }))
        + converter.feed(summary('part.done', { part: { type: 'summary_text', text: '第一段' } }))
        + converter.feed(summary('text.delta', { summary_index: 1, delta: '第二段' }))
        + converter.feed(summary('text.done', { summary_index: 1, text: '第二段' }))
        + converter.feed(sse('response.output_item.done', { output_index: 0, item: { ...item(''), summary: [{ type: 'summary_text', text: '第一段' }, { type: 'summary_text', text: '第二段' }] } }))
        + converter.end();
    const parsed = events(out);
    assert.equal(thinking(out), '第一段第二段');
    assert.deepEqual(parsed.filter(event => event.type === 'content_block_start').map(event => event.index), [0, 1]);
    assert.deepEqual(parsed.filter(event => event.type === 'content_block_stop').map(event => event.index), [0, 1]);
});

test('output_item.done/completed 只补发未发送的摘要后缀，按 item_id 补齐缺失索引', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
    const out = converter.feed(sse('response.output_item.added', { output_index: 0, item: item('') }))
        + converter.feed(summary('text.delta', { output_index: undefined, delta: '开头' }))
        + converter.feed(sse('response.output_item.done', { output_index: 0, item: item('开头结尾') }))
        + converter.feed(sse('response.output_item.done', { output_index: 0, item: item('开头结尾') }))
        + converter.feed(sse('response.completed', { response: { output: [item('开头结尾')] } })) + converter.end();
    assert.equal(thinking(out), '开头结尾');
    assert.equal(events(out).filter(event => event.type === 'content_block_stop').length, 1);
});

test('done-only 与 completed-only 在正文之前可回填，正文之后不倒插思考', () => {
    for (const end of [summary('text.done', { text: '完整摘要' }), summary('part.done', { part: { type: 'summary_text', text: '完整摘要' } }), sse('response.output_item.done', { output_index: 0, item: item('完整摘要') }), sse('response.completed', { response: { output: [item('完整摘要')] } })]) {
        const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
        assert.equal(thinking(converter.feed(end) + converter.end()), '完整摘要');
    }
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
    const out = converter.feed(sse('response.output_text.delta', { output_index: 1, content_index: 0, delta: '正文' }))
        + converter.feed(sse('response.completed', { response: { output: [item('不能倒插')] } })) + converter.end();
    assert.equal(thinking(out), '');
    assert.ok(converter.getWarnings().some(warning => warning.code === 'late_reasoning_summary'));
});

test('前缀冲突、迟到 delta 和身份冲突不拼接错误后缀、不改变正文', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
    const out = converter.feed(summary('text.delta', { delta: '已发送' }))
        + converter.feed(summary('text.done', { text: '完全不同' }))
        + converter.feed(summary('text.delta', { delta: '迟到' }))
        + converter.feed(summary('text.delta', { item_id: 'other-item', delta: '错误归属' }))
        + converter.feed(sse('response.output_text.delta', { output_index: 1, content_index: 0, delta: '正常正文' })) + converter.end();
    assert.equal(thinking(out), '已发送');
    assert.ok(out.includes('正常正文'));
    assert.ok(converter.getWarnings().some(warning => warning.code === 'reasoning_summary_conflict'));
    assert.ok(converter.getWarnings().some(warning => warning.code === 'reasoning_identity_conflict'));
});

test('空摘要、加密 reasoning 和非法索引不生成 thinking block', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
    const out = converter.feed(sse('response.output_item.added', { output_index: 0, item: item('') }))
        + converter.feed(summary('part.added', { part: { type: 'summary_text', text: '' } }))
        + converter.feed(summary('text.delta', { summary_index: -1, delta: '非法' }))
        + converter.feed(summary('text.delta', { summary_index: '0', delta: '非法' }))
        + converter.feed(summary('text.delta', { output_index: -1, item_id: undefined, delta: '非法' }))
        + converter.feed(sse('response.output_item.done', { output_index: 0, item: item('') }))
        + converter.feed(sse('response.output_text.delta', { output_index: 1, content_index: 0, delta: '回答' })) + converter.end();
    assert.equal(thinking(out), '');
    const start = events(out).find(event => event.type === 'content_block_start');
    assert.equal(start?.index, 0);
    assert.equal(start?.content_block.type, 'text');
    assert.equal(out.includes('SECRET_ENCRYPTED_CONTENT'), false);
});

test('off 保持既有文本/工具 SSE 逐字节一致；JSON 默认仍忽略 reasoning', () => {
    const plain = [sse('response.created', { response: { id: 'r', model: 'm' } }), sse('response.output_text.delta', { output_index: 1, content_index: 0, delta: '回答' }), sse('response.completed', { response: { status: 'completed' } })];
    const withSummary = [plain[0], summary('text.delta', { delta: '不可展示' }), summary('text.done', { text: '不可展示' }), plain[1], plain[2]];
    const disabled = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'off');
    const baseline = new OpenAIResponsesToAnthropicStreamConverter();
    assert.equal(disabled.feed(withSummary.join('')) + disabled.end(), baseline.feed(plain.join('')) + baseline.end());
    const json = { output: [item('可见摘要'), { type: 'message', content: [{ type: 'output_text', text: '正文' }] }] };
    assert.deepEqual(convertResponsesJsonToAnthropic(json).body.content, [{ type: 'text', text: '正文' }]);
    assert.deepEqual(convertResponsesJsonToAnthropic(json, 'passthrough').body.content, [{ type: 'thinking', thinking: '可见摘要' }, { type: 'text', text: '正文' }]);
});

test('thinking 关闭早于工具 start，工具参数分片与原参数完全一致', () => {
    const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
    const args = JSON.stringify({ file_path: '/测试/🙂.md', old_string: '旧值', new_string: '新值\n"引用"', replace_all: false });
    const out = converter.feed(summary('text.delta', { delta: '先分析' }))
        + converter.feed(sse('response.output_item.added', { output_index: 1, item: { type: 'function_call', call_id: 'call', name: 'Edit', arguments: '' } }))
        + converter.feed(sse('response.function_call_arguments.delta', { output_index: 1, delta: args.slice(0, 20) }))
        + converter.feed(sse('response.function_call_arguments.delta', { output_index: 1, delta: args.slice(20) }))
        + converter.feed(sse('response.function_call_arguments.done', { output_index: 1, arguments: args }))
        + converter.feed(sse('response.output_item.done', { output_index: 1, item: { type: 'function_call', arguments: args } })) + converter.end();
    const parsed = events(out);
    const stopIndex = parsed.findIndex(event => event.type === 'content_block_stop' && event.index === 0);
    const toolIndex = parsed.findIndex(event => event.content_block?.type === 'tool_use');
    assert.ok(stopIndex >= 0 && stopIndex < toolIndex);
    assert.equal(thinking(out), '先分析');
    assert.equal(parsed.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''), args);
    assert.ok(out.includes('"stop_reason":"tool_use"'));
    assert.deepEqual(converter.getToolCallIds(), ['call']);
});

test('断流/incomplete/failed/error 均关闭摘要一次，失败不伪装成功', () => {
    for (const terminal of ['', sse('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }), sse('response.failed', { response: { error: { message: '失败' } } }), sse('error', { error: { message: '断开' } })]) {
        const converter = new OpenAIResponsesToAnthropicStreamConverter(undefined, 'passthrough');
        const out = converter.feed(summary('text.delta', { delta: '未完成摘要' })) + converter.feed(terminal) + converter.end() + converter.end();
        assert.equal(thinking(out), '未完成摘要');
        assert.equal(events(out).filter(event => event.type === 'content_block_stop').length, 1);
        const failed = terminal.includes('response.failed') || terminal.startsWith('event: error');
        assert.equal(events(out).filter(event => event.type === 'message_stop').length, failed ? 0 : 1);
    }
});
