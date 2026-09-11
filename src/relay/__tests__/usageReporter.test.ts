/** @file 请求级 usage 收尾回归测试。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installVscodeStub } from '../../llsTask/__tests__/vscodeStub';
import { createRequestUsageContext } from '../requestUsage';
import { requestUsageRegistry } from '../../chatRuntime/requestUsage';
installVscodeStub();
const { UsageReporter, getRequestUsageReporter } = require('../usageReporter') as typeof import('../usageReporter');
const context = createRequestUsageContext({ metadata: { session_id: 'test' } }, 'normal', 'p', 'm');

test('JSON missing usage and repeated end report exactly once', () => {
    const reports: any[] = [];
    const reporter = new UsageReporter(r => reports.push(r), context);
    reporter.feedJson('{}');
    reporter.end('error');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].summary.completeness, 'missing');
    assert.equal(reports[0].context, context);
});

test('split SSE combines input and final output without early reporting', () => {
    const reports: any[] = [];
    const reporter = new UsageReporter(r => reports.push(r), context);
    const raw = 'data: ' + JSON.stringify({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 } } }) + '\n\n'
        + 'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }) + '\n\n';
    for (const char of raw) reporter.feed(char);
    assert.equal(reports.length, 0);
    reporter.end();
    assert.equal(reports[0].summary.cacheHitRate, 75);
    assert.equal(reports[0].summary.outputTokens, 7);
});

test('timeout abort and error preserve status with no usage', () => {
    for (const status of ['timeout', 'aborted', 'error'] as const) {
        const reports: any[] = [];
        const reporter = new UsageReporter(r => reports.push(r), context);
        reporter.end(status);
        reporter.end();
        assert.equal(reports.length, 1);
        assert.equal(reports[0].summary.status, status);
    }
});

test('reporter sharing is per request and sink failure does not duplicate', () => {
    let calls = 0;
    const ctx = { usageContext: context } as import('../router').UpstreamRequestContext;
    const first = getRequestUsageReporter(ctx, () => { calls++; throw new Error('test'); });
    assert.equal(first, getRequestUsageReporter(ctx));
    first.end('error');
    first.end();
    assert.equal(calls, 1);
});

/** 透传 CRLF 事件必须在正文到达前绑定消息，并保留零命中率。 */
test('CRLF passthrough binds message before completion and preserves zero cache hit', () => {
    const ctx = createRequestUsageContext({ metadata: { session_id: 'crlf-test' } }, 'normal', 'p', 'm');
    const reports: any[] = [];
    requestUsageRegistry.registerRequest(ctx);
    const reporter = new UsageReporter(report => reports.push(report), ctx);
    const start = 'event: message_start\r\ndata: ' + JSON.stringify({ type: 'message_start', message: {
        id: 'msg-crlf', model: 'm', usage: { input_tokens: 26042, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    } }) + '\r\n\r\n';
    try {
        for (const char of start) reporter.feed(char);
        assert.equal(requestUsageRegistry.resolveRequestForSegment('crlf-test', 'msg-crlf')?.requestId, ctx.requestId);
        assert.equal(reports.length, 0);
        reporter.feed('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } }) + '\n\n');
        reporter.end();
        assert.equal(reports.length, 1);
        assert.equal(reports[0].model, 'm');
        assert.equal(reports[0].summary.inputTokens, 26042);
        assert.equal(reports[0].summary.outputTokens, 5);
        assert.equal(reports[0].summary.cacheHitRate, 0);
    } finally {
        requestUsageRegistry.clearRequestUsageBindings();
    }
});

