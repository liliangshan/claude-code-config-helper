/**
 * @file 浏览器工具 HTTP relay handler（httpBridge）单元测试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createBrowserToolRelayHandler, BROWSER_TOOL_HTTP_PATH } =
    require('../httpBridge') as typeof import('../httpBridge');

type BrowserToolResult = import('../browserToolHost').BrowserToolResult;

/** 收集写入内容的 ServerResponse 替身。 */
function makeRes(): { res: http.ServerResponse; body: () => string; status: () => number } {
    let payload = '';
    const res = {
        statusCode: 200,
        setHeader() { /* noop */ },
        end(chunk?: string) { payload = chunk ?? ''; }
    } as unknown as http.ServerResponse;
    return { res, body: () => payload, status: () => res.statusCode };
}

/** 构造带 JSON body 的 IncomingMessage 替身。 */
function makeReq(url: string, method: string, body: unknown): http.IncomingMessage {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        url,
        method,
        setEncoding() { /* noop */ },
        on(event: string, cb: (arg?: unknown) => void) {
            (listeners[event] ??= []).push(cb);
            if (event === 'end') {
                queueMicrotask(() => {
                    for (const fn of listeners.data ?? []) fn(JSON.stringify(body));
                    for (const fn of listeners.end ?? []) fn();
                });
            }
            return req;
        }
    } as unknown as http.IncomingMessage;
    return req;
}

test('relay: 非目标路径返回 false 交由后续 handler 处理', async () => {
    const handler = createBrowserToolRelayHandler({ execute: () => Promise.resolve({ content: [] }) });
    const { res } = makeRes();

    assert.equal(await handler(makeReq('/other', 'POST', {}), res), false);
});

test('relay: 非 POST 返回 405', async () => {
    const handler = createBrowserToolRelayHandler({ execute: () => Promise.resolve({ content: [] }) });
    const { res, status } = makeRes();

    assert.equal(await handler(makeReq(BROWSER_TOOL_HTTP_PATH, 'GET', {}), res), true);
    assert.equal(status(), 405);
});

test('relay: 转发工具名与入参给注入的 executor', async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const handler = createBrowserToolRelayHandler({
        execute: (name, args) => {
            seen.push({ name, args });
            return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] } as BrowserToolResult);
        }
    });
    const { res, body } = makeRes();

    await handler(
        makeReq(BROWSER_TOOL_HTTP_PATH, 'POST', { name: 'browser_open', arguments: { url: 'https://a.com' } }),
        res
    );

    assert.deepEqual(seen, [{ name: 'browser_open', args: { url: 'https://a.com' } }]);
    assert.match(body(), /ok/);
});

test('relay: 未知工具名返回 400 且不转发', async () => {
    let called = false;
    const handler = createBrowserToolRelayHandler({
        execute: () => { called = true; return Promise.resolve({ content: [] }); }
    });
    const { res, status } = makeRes();

    await handler(makeReq(BROWSER_TOOL_HTTP_PATH, 'POST', { name: 'nope' }), res);

    assert.equal(status(), 400);
    assert.equal(called, false);
});

test('relay: 缺省 executor 时按传入 sessionStore 构造持久化宿主', async () => {
    let loaded = 0;
    const store = {
        load: () => { loaded += 1; return Promise.resolve(undefined); },
        save: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        listOrigins: () => Promise.resolve([])
    } as unknown as import('../sessionStore').BrowserSessionStore;

    // 缺省宿主走真实 BrowserToolHost；web 环境（uiKind!=1）下会在门槛处返���错误，
    // 故此处只断言 handler 可被构造且请求被受理，不触达 lm.invokeTool。
    const handler = createBrowserToolRelayHandler(undefined, store);
    const { res } = makeRes();

    const handled = await handler(
        makeReq(BROWSER_TOOL_HTTP_PATH, 'POST', { name: 'browser_open', arguments: { url: 'https://a.com' } }),
        res
    );

    assert.equal(handled, true);
    assert.equal(loaded, 0, '未成功打开页面时不应查询快照');
});
