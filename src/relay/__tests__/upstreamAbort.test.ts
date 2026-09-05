/**
 * @file bindClientAbortToUpstream 行为回归测试（B4 / B10）。
 *
 * 覆盖两个关键语义：
 * 1. 客户端中途断开（res 未写完就 close）时，上游请求必须被 destroy；
 * 2. 响应正常写完后的 close 不能误伤上游，解绑后更不能再触发。
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bindClientAbortToUpstream } = require('../upstreamAbort') as typeof import('../upstreamAbort');

/** 一次测试用的假上游 + 假下行响应组合。 */
interface Fixture {
    /** 只写 headers、永不结束的假上游服务器。 */
    upstream: http.Server;
    /** 指向假上游的真实 ClientRequest。 */
    upstreamReq: http.ClientRequest;
    /** 假上游侧收到的请求是否已被下游 destroy。 */
    upstreamClosed: Promise<void>;
    /** 关闭所有资源。 */
    dispose: () => Promise<void>;
}

/**
 * 起一个「只写 headers 不结束」的假上游，并向它发出一个真实请求。
 *
 * @returns 已建立连接的 fixture。
 */
async function createFixture(): Promise<Fixture> {
    let markClosed: () => void = () => undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
        markClosed = resolve;
    });
    const upstream = http.createServer((upReq, upRes) => {
        upRes.writeHead(200, { 'content-type': 'text/event-stream' });
        upRes.write(': open\n\n');
        // 模拟长 SSE：不调用 end()，等下游断开触发 close。
        upReq.on('close', () => markClosed());
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;

    const upstreamReq = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' });
    await new Promise<void>((resolve) => {
        upstreamReq.on('response', () => resolve());
        upstreamReq.on('error', () => resolve());
        upstreamReq.end();
    });

    return {
        upstream,
        upstreamReq,
        upstreamClosed,
        dispose: () => new Promise<void>((resolve) => upstream.close(() => resolve()))
    };
}

/**
 * 构造一个最小 ServerResponse 替身：只需要 once/off/writableFinished 三个成员。
 *
 * @param writableFinished 模拟响应是否已正常写完。
 */
function createFakeRes(writableFinished: boolean): http.ServerResponse & { fireClose: () => void } {
    const listeners: Array<() => void> = [];
    return {
        writableFinished,
        once(event: string, fn: () => void) {
            if (event === 'close') listeners.push(fn);
            return this;
        },
        off(event: string, fn: () => void) {
            const idx = listeners.indexOf(fn);
            if (event === 'close' && idx >= 0) listeners.splice(idx, 1);
            return this;
        },
        fireClose() {
            for (const fn of [...listeners]) fn();
        }
    } as unknown as http.ServerResponse & { fireClose: () => void };
}

test('客户端未写完就断开时，上游请求被销毁', async () => {
    const fx = await createFixture();
    const res = createFakeRes(false);
    bindClientAbortToUpstream(res, fx.upstreamReq, '测试链路');

    res.fireClose();
    await fx.upstreamClosed;
    assert.equal(fx.upstreamReq.destroyed, true);
    await fx.dispose();
});

test('响应已正常写完的 close 不销毁上游；解绑后不再响应 close', async () => {
    const fx = await createFixture();

    // 正常写完的 close：writableFinished 为 true，直接忽略。
    const finishedRes = createFakeRes(true);
    bindClientAbortToUpstream(finishedRes, fx.upstreamReq, '测试链路');
    finishedRes.fireClose();
    assert.equal(fx.upstreamReq.destroyed, false);

    // 解绑之后即使异常 close 也不应再销毁。
    const abortedRes = createFakeRes(false);
    const unbind = bindClientAbortToUpstream(abortedRes, fx.upstreamReq, '测试链路');
    unbind();
    abortedRes.fireClose();
    assert.equal(fx.upstreamReq.destroyed, false);

    fx.upstreamReq.destroy();
    await fx.dispose();
});
