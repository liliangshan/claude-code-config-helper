/**
 * @file 客户端断开 → 上游请求销毁的共用绑定工具。
 *
 * 三个代理（Anthropic 透传、OpenAI Chat、OpenAI Responses）都需要「下游客户端
 * 中途关闭连接时，立刻掐断已经发出的上游请求」，否则上游会继续把整段回答流完，
 * 既浪费额度也让 relay 侧的 Promise 迟迟不结算。
 */

import type * as http from 'http';

import { Logger } from '../logger';

/**
 * 把「客户端断开」绑定到「销毁上游请求」。
 *
 * 监听下行响应对象的 `close` 而不是请求对象的 `aborted`：后者自 Node 17 起已废弃，
 * 且在 keep-alive 连接复用下并不可靠。`res.writableFinished` 为 true 说明是正常
 * 写完后的关闭，不属于异常断开，此时不应销毁上游。
 *
 * @param res         下行响应对象。
 * @param upstreamReq 已发出的上游请求。
 * @param label       日志标签，用于区分是哪个代理链路。
 * @returns 解绑函数；上游正常结束后调用，避免响应收尾阶段误触发 destroy。
 */
export function bindClientAbortToUpstream(
    res: http.ServerResponse,
    upstreamReq: http.ClientRequest,
    label: string
): () => void {
    const onClose = (): void => {
        if (res.writableFinished) return;
        Logger.info(`${label}：客户端已断开，销毁上游请求`);
        try {
            upstreamReq.destroy();
        } catch {
            // ignore：上游可能已自行结束。
        }
    };
    res.once('close', onClose);
    return () => {
        res.off('close', onClose);
    };
}
