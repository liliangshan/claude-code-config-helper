/**
 * @file createToolRelayHandler 的 HTTP 分支回归测试。
 *
 * relay handler 挂在扩展宿主的公共 HTTP server 上，返回 false 表示「这条请求不归我管」，
 * 一旦路径判断或体积上限回归，要么会吞掉别人的路由，要么让宿主被超大请求体拖垮。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type * as http from 'node:http';

import { createToolRelayHandler } from '../httpBridge';
import type { McpBridgeDescriptor } from '../registry';
import type { McpToolExecutor } from '../types';

/** 测试用工具名集合。 */
type TestToolName = 'demo_tool';

/** 测试用桥声明。 */
const TEST_BRIDGE: McpBridgeDescriptor<TestToolName> = {
    serverName: 'llsccaiTest',
    serverInfoName: 'llsccai-test',
    displayName: 'Test',
    httpPath: '/llsccai/test-tool',
    relayPortEnv: 'LLS_TEST_TOOL_RELAY_PORT',
    entryModule: '../../mcpKit/stdioServer',
    entryStarter: 'startTestMcpServer',
    schemas: [{
        name: 'demo_tool',
        description: '测试工具。',
        inputSchema: { type: 'object', properties: {}, required: [] }
    }],
    unavailableMessage: 'Test tools require the extension host relay.',
    bodyTooLargeMessage: 'Test tool request body is too large.'
};

/** 记录状态码与响应体的假 ServerResponse。 */
class FakeResponse {
    /** handler 写入的状态码。 */
    public statusCode = 0;

    /** end 收到的响应体文本。 */
    public body = '';

    /** 已设置的响应头。 */
    public readonly headers = new Map<string, string>();

    /**
     * 记录响应头。
     *
     * @param name 头名。
     * @param value 头值。
     */
    public setHeader(name: string, value: string): void {
        this.headers.set(name, value);
    }

    /**
     * 记录响应体。
     *
     * @param body 响应体文本。
     */
    public end(body?: string): void {
        this.body = body ?? '';
    }
}

/**
 * 构造一个把给定文本按 chunk 推送的假 IncomingMessage。
 *
 * @param options 方法、url 与请求体分片。
 * @returns 可交给 handler 的假请求对象。
 */
function createRequest(options: { method?: string; url?: string; chunks?: string[] }) {
    const req = new EventEmitter() as EventEmitter & {
        method?: string;
        url?: string;
        setEncoding?: (encoding: string) => void;
        destroy?: () => void;
    };
    req.method = options.method ?? 'POST';
    req.url = options.url ?? TEST_BRIDGE.httpPath;
    let destroyed = false;
    req.setEncoding = () => { /* 假流固定按字符串推送，无需切换编码。 */ };
    req.destroy = () => { destroyed = true; };
    setImmediate(() => {
        for (const chunk of options.chunks ?? []) {
            if (destroyed) return;
            req.emit('data', chunk);
        }
        if (!destroyed) req.emit('end');
    });
    return req as unknown as http.IncomingMessage;
}

/**
 * 装配一个 handler 与配套的假响应。
 *
 * @param host 工具执行器；缺省返回一个固定成功结果。
 * @returns handler 与假响应对象。
 */
function createHandler(host?: McpToolExecutor<TestToolName, unknown>) {
    const res = new FakeResponse();
    const handler = createToolRelayHandler(
        TEST_BRIDGE,
        () => host ?? { execute: (name) => Promise.resolve({ ok: name }) }
    );
    return { handler, res };
}

/**
 * 跑一轮 handler。
 *
 * @param options 请求参数。
 * @param host 工具执行器。
 * @returns handler 返回值与假响应。
 */
async function invoke(options: { method?: string; url?: string; chunks?: string[] }, host?: McpToolExecutor<TestToolName, unknown>) {
    const { handler, res } = createHandler(host);
    const handled = await handler(createRequest(options), res as unknown as http.ServerResponse);
    return { handled, res };
}

test('路径不匹配时返回 false 且不碰响应', async () => {
    const { handled, res } = await invoke({ url: '/llsccai/other-tool' });
    assert.equal(handled, false);
    assert.equal(res.statusCode, 0);
});

test('带 query string 的同路径仍被认领', async () => {
    const { handled, res } = await invoke({ url: `${TEST_BRIDGE.httpPath}?x=1`, chunks: ['{"name":"demo_tool"}'] });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
});

test('非 POST 返回 405', async () => {
    const { handled, res } = await invoke({ method: 'GET' });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
    assert.equal((JSON.parse(res.body) as { error: string }).error, 'method_not_allowed');
});

test('请求体超过上限时返回 500 与 bodyTooLargeMessage', async () => {
    const oversized = 'x'.repeat(5 * 1024 * 1024);
    const { handled, res } = await invoke({ chunks: [oversized] });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 500);
    assert.equal((JSON.parse(res.body) as { error: string }).error, TEST_BRIDGE.bodyTooLargeMessage);
});

test('未知工具名返回 400', async () => {
    const { handled, res } = await invoke({ chunks: ['{"name":"nope"}'] });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.match((JSON.parse(res.body) as { error: string }).error, /unknown_tool: nope/);
});

test('合法请求把 arguments 透传给宿主并回 200', async () => {
    let seen: Record<string, unknown> | undefined;
    const { handled, res } = await invoke(
        { chunks: ['{"name":"demo_tool","arguments":{"a":1}}'] },
        { execute: (_name, args) => { seen = args; return Promise.resolve({ ok: true }); } }
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, { a: 1 });
});

test('非法 JSON 体返回 500', async () => {
    const { handled, res } = await invoke({ chunks: ['{ not json }'] });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 500);
});
