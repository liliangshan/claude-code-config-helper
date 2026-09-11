/** @file Relay 故障证据单次终态及协议错误回归。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestOutcomeReporter, type RelayRequestOutcome } from '../requestOutcome';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

/** 直接验证生产 Responses 判断逻辑，避免仅测证据收集器。 */
test('Responses error:null is not mapped to 502', () => {
    const { OpenAIResponsesProxyAdapter } = require('../openaiResponsesProxy');
    const adapter = Object.create(OpenAIResponsesProxyAdapter.prototype);
    assert.equal(adapter.buildInlineResponsesJsonError(200, { status: 'completed', error: null }), undefined);
    assert.equal(adapter.buildInlineResponsesJsonError(200, { status: 'failed', error: null }).statusCode, 502);
    assert.equal(adapter.buildInlineResponsesJsonError(200, { error: { message: 'synthetic' } }).statusCode, 502);
});

/** HTTP 原始状态和映射状态分离且仅上报一次。 */
test('HTTP error preserves Retry-After and first failure across abort', () => {
    const reports: RelayRequestOutcome[] = [];
    const r = new RequestOutcomeReporter(undefined, value => reports.push(value));
    r.headers(429, '300'); r.json({ error: { code: 'insufficient_quota' } });
    r.fail('upstream_stream', 'ECONNRESET'); r.end(502); r.end(200);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].upstreamStatus, 429); assert.equal(reports[0].mappedStatus, 502);
    assert.equal(reports[0].retryAfter, '300'); assert.equal(reports[0].code, 'insufficient_quota');
    assert.equal(reports[0].stage, 'upstream_http');
});

/** 三种协议错误包经过分片 SSE 后仍保留故障。 */
test('JSON and split SSE detect protocol errors but not error:null', () => {
    for (const payload of [{ type: 'error', error: { type: 'overloaded_error' } },
        { error: { code: 'rate_limit_exceeded' } },
        { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error' } } }]) {
        let result: RelayRequestOutcome | undefined;
        const r = new RequestOutcomeReporter(undefined, value => { result = value; });
        r.headers(200);
        for (const char of `data: ${JSON.stringify(payload)}\r\n\r\n`) r.feed(char);
        r.end(200);
        assert.equal(result?.status, 'error'); assert.equal(result?.stage, 'upstream_inline_error');
    }
    let normal: RelayRequestOutcome | undefined;
    const r = new RequestOutcomeReporter(undefined, value => { normal = value; });
    r.headers(200); r.json({ status: 'completed', error: null }); r.end(200);
    assert.equal(normal?.status, 'completed');
});

/** 超时不被取消覆盖；主动取消不伪装成网络错误。 */
test('timeout and cancellation are distinct', () => {
    let result: RelayRequestOutcome | undefined;
    const r = new RequestOutcomeReporter(undefined, value => { result = value; });
    r.fail('upstream_first_byte', 'first_byte_timeout'); r.fail(undefined, 'client_aborted', true); r.end(504);
    assert.equal(result?.code, 'first_byte_timeout'); assert.equal(result?.status, 'error');
    const a = new RequestOutcomeReporter(undefined, value => { result = value; });
    a.fail(undefined, 'client_aborted', true); a.end(200); assert.equal(result?.status, 'aborted');
});
