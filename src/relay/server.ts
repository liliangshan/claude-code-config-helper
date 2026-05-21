/**
 * @file 最小本地 HTTP 中转服务。
 *
 * 第二阶段目标：使用 Node 内置 `http` 模块零依赖启动一个 127.0.0.1 服务，
 * 仅承载 Claude Code 的 `POST /v1/messages` 转发；其他路径返回 404。
 *
 * 该模块只关心服务生命周期（启动 / 停止 / 重启）与端口占用兜底，
 * 真正的请求处理委托给注入的 {@link RelayRequestHandler}（任务 5 中实现）。
 *
 * Vendored from liliangshan.openapi-compatible-copilot@3.0.3, last-sync 2026-05-20。
 */

import * as http from 'http';
import * as vscode from 'vscode';

import { DEFAULT_RELAY_PORT } from '../constants';
import { Logger } from '../logger';
import type { RelayStatus } from '../types';
import { findFreePort, isPortFree } from './portFinder';

/** 本地中转服务监听的固定 host，仅允许本机访问。 */
const LISTEN_HOST = '127.0.0.1';

/**
 * Relay 请求处理函数签名。
 *
 * 后续任务（router、anthropicProxy）会提供具体实现，
 * 本模块只负责把每个进入的 HTTP 请求委派到该函数。
 */
export type RelayRequestHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse
) => void | Promise<void>;

/** {@link RelayServer} 构造参数。 */
export interface RelayServerOptions {
    /**
     * 期望监听的起始端口；当被外部程序占用时会从其+1 起递增寻找。
     * 缺省使用 {@link DEFAULT_RELAY_PORT}。
     */
    desiredPort?: number;
    /** 找到空闲端口前最多尝试的次数。 */
    maxPortTries?: number;
    /** 请求处理函数；缺省使用一个返回 404 的安全实现。 */
    handler?: RelayRequestHandler;
}

/**
 * 默认请求处理器：所有路径都返回 404。
 *
 * 仅用于 RelayServer 在 router 还未接入前的安全兜底，
 * 接入任务 5 的 router 后会被替换。
 */
const defaultHandler: RelayRequestHandler = (req, res) => {
    Logger.warn(`Relay 默认 handler 未处理请求：${req.method} ${req.url}`);
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { type: 'not_found', message: 'relay router not wired yet' } }));
};

/**
 * 最小本地 HTTP 中转服务。
 *
 * 该类只关心服务的生命周期与运行状态，不参与具体请求转发逻辑。
 * 通过 {@link onStatusChange} 事件向外（状态栏、settingsWriter 等）
 * 广播当前 Relay 运行状态。
 */
export class RelayServer implements vscode.Disposable {
    /** Node http server 实例，未启动时为 undefined。 */
    private server: http.Server | undefined;

    /** 当前实际监听的端口号；未启动时为 undefined。 */
    private listeningPort: number | undefined;

    /** 当前请求处理函数。 */
    private handler: RelayRequestHandler;

    /** 期望监听的起始端口。 */
    private desiredPort: number;

    /** 最大端口探测尝试次数。 */
    private readonly maxPortTries: number;

    /** Relay 状态变更事件发送器。 */
    private readonly statusEmitter = new vscode.EventEmitter<RelayStatus>();

    /** Relay 状态变更事件，供状态栏与配置写入闭环订阅。 */
    public readonly onStatusChange = this.statusEmitter.event;

    /** 内部缓存的最近一次状态，便于查询。 */
    private currentStatus: RelayStatus = { kind: 'stopped' };

    /**
     * 创建 RelayServer 实例。
     *
     * @param options 服务构造参数。
     */
    public constructor(options: RelayServerOptions = {}) {
        this.desiredPort = options.desiredPort ?? DEFAULT_RELAY_PORT;
        this.maxPortTries = options.maxPortTries ?? 64;
        this.handler = options.handler ?? defaultHandler;
    }

    /** 读取当前 Relay 状态快照。 */
    public getStatus(): RelayStatus {
        return this.currentStatus;
    }

    /** 读取当前实际监听端口；未启动时返回 undefined。 */
    public getActualPort(): number | undefined {
        return this.listeningPort;
    }

    /**
     * 动态替换请求处理函数。
     *
     * 用于后续任务把 router/anthropicProxy 注入到已构造的 RelayServer 中。
     *
     * @param handler 新的请求处理函数。
     */
    public setHandler(handler: RelayRequestHandler): void {
        this.handler = handler;
    }

    /**
     * 启动本地 HTTP 中转服务。
     *
     * 若期望端口被占用则从其+1 起递增寻找空闲端口；找到端口后实际监听。
     * 若服务已处于运行状态，此调用为 no-op。
     *
     * @returns 实际监听到的端口号。
     */
    public async start(): Promise<number> {
        if (this.server) {
            return this.listeningPort ?? this.desiredPort;
        }
        this.setStatus({ kind: 'starting', port: this.desiredPort });
        try {
            const port = (await isPortFree(this.desiredPort, LISTEN_HOST))
                ? this.desiredPort
                : await findFreePort(this.desiredPort + 1, this.maxPortTries, LISTEN_HOST);
            const server = http.createServer((req, res) => this.handleRequest(req, res));
            await this.listenServer(server, port);
            this.server = server;
            this.listeningPort = port;
            this.setStatus({
                kind: 'leader',
                port,
                pid: process.pid,
                startedAt: Date.now()
            });
            Logger.info(`本地中转服务已启动：http://${LISTEN_HOST}:${port}`);
            return port;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.setStatus({ kind: 'error', port: this.desiredPort, message });
            Logger.error(`本地中转服务启动失败：${message}`);
            throw err;
        }
    }

    /**
     * 停止本地 HTTP 中转服务。
     *
     * 若服务未运行，此调用为 no-op。
     */
    public async stop(): Promise<void> {
        const server = this.server;
        if (!server) {
            this.setStatus({ kind: 'stopped' });
            return;
        }
        this.server = undefined;
        const port = this.listeningPort;
        this.listeningPort = undefined;
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        this.setStatus({ kind: 'stopped', port });
        Logger.info('本地中转服务已停止');
    }

    /**
     * 重启本地 HTTP 中转服务。
     *
     * 内部按顺序执行 stop -> start，便于端口或配置变化时整体刷新。
     *
     * @param desiredPort 可选新起始端口；缺省沿用上一次配置。
     * @returns 重启后的实际端口号。
     */
    public async restart(desiredPort?: number): Promise<number> {
        if (typeof desiredPort === 'number' && Number.isFinite(desiredPort)) {
            this.desiredPort = desiredPort;
        }
        await this.stop();
        return this.start();
    }

    /**
     * 释放服务与事件资源，供 deactivate 调用。
     */
    public dispose(): void {
        // 尽量同步关闭：触发 close 后再清理事件。
        try {
            this.server?.close();
        } catch {
            // ignore
        }
        this.server = undefined;
        this.listeningPort = undefined;
        this.statusEmitter.dispose();
    }

    /**
     * 把 server.listen 包装成 Promise，统一处理 EADDRINUSE 等监听错误。
     *
     * @param server 待监听的 http server。
     * @param port 监听端口。
     */
    private listenServer(server: http.Server, port: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => {
                server.off('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen({ port, host: LISTEN_HOST, exclusive: true });
        });
    }

    /**
     * 将每个进入的 HTTP 请求交给当前 handler 处理，并对未捕获错误兜底。
     *
     * @param req 进入的 HTTP 请求。
     * @param res HTTP 响应对象。
     */
    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            await this.handler(req, res);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Relay 请求处理异常：${message}`);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('content-type', 'application/json; charset=utf-8');
            }
            if (!res.writableEnded) {
                res.end(JSON.stringify({ error: { type: 'internal_error', message } }));
            }
        }
    }

    /**
     * 更新内部状态缓存并触发 onStatusChange 事件。
     *
     * @param status 新的 Relay 运行状态。
     */
    private setStatus(status: RelayStatus): void {
        this.currentStatus = status;
        this.statusEmitter.fire(status);
    }
}
