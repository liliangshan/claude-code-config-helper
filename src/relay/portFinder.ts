/**
 * @file 本地端口探测工具。
 *
 * 用于实现"指定起始端口被外部程序占用时，自动从下一个端口递增寻找空闲端口"
 * 的策略，仅限本机 127.0.0.1 监听。
 */

import * as net from 'net';

/** 默认探测主机，固定本地回环。 */
const DEFAULT_HOST = '127.0.0.1';

/**
 * 检测某个端口在 127.0.0.1 上是否空闲。
 *
 * 通过创建临时 {@link net.Server} 监听以判断；监听成功视为空闲，
 * 监听失败（任何错误）视为占用。
 *
 * @param port 待检测的端口号。
 * @param host 监听 host，默认 127.0.0.1。
 * @returns 端口空闲时 resolve 为 true，否则 resolve 为 false。
 */
export function isPortFree(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const tester = net.createServer();
        // 监听出错（端口被占或权限不足等）一律视为不可用。
        tester.once('error', () => {
            resolve(false);
        });
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        try {
            tester.listen({ port, host, exclusive: true });
        } catch {
            resolve(false);
        }
    });
}

/**
 * 从 startPort 起递增寻找一个本机空闲端口。
 *
 * @param startPort 起始端口号。
 * @param maxTries 最大尝试次数，避免出现死循环。
 * @param host 监听 host，默认 127.0.0.1。
 * @returns 找到的空闲端口号。
 * @throws 当连续 maxTries 次都未找到空闲端口时抛出。
 */
export async function findFreePort(
    startPort: number,
    maxTries: number = 64,
    host: string = DEFAULT_HOST
): Promise<number> {
    let port = Math.max(1, Math.floor(startPort));
    for (let i = 0; i < maxTries; i++) {
        if (await isPortFree(port, host)) {
            return port;
        }
        port += 1;
        if (port > 65535) {
            break;
        }
    }
    throw new Error(`未能在 ${startPort} 起 ${maxTries} 次尝试内找到空闲端口`);
}
