/**
 * 双路由（normal / taskFlow）Chat CLI 运行期状态。
 *
 * 拆分自 extension.ts：原本散落的 40 余个模块级 `let` 在这里收敛为一个
 * `routes` 记录对象——容器本身是 `const`，字段可变，既满足「禁止导出可变 let」
 * 的约束，又让调用方保持 `routes.normal.process = x` 这样的直接读写语义。
 *
 * 依赖方向：本模块处于 chatRuntime 的最底层，只允许 import runtime 与类型，
 * 不得反向 import cliLifecycle / webviewMessages 等上层模块。
 */
import type * as vscode from 'vscode';
import type { StreamJsonCliAdapter } from '../chat/cli/cliAdapter';
import type { CliProcess } from '../chat/cli/cliProcess';
import type { ChatCliConfig } from '../chat/cli/types';
import type { ChatRoute } from '../chat/protocol';
import { Logger } from '../logger';
import { getChatViewHost } from '../runtime';

/** 单条路由的全部运行期状态。 */
export interface ChatRouteRuntime {
    /** Chat CLI 长连接子进程实例。 */
    process?: CliProcess;
    /** stream-json 协议适配器实例，随 CLI 启停重建。 */
    adapter?: StreamJsonCliAdapter;
    /** 适配器事件订阅。 */
    adapterSubscription?: vscode.Disposable;
    /** CLI 进程状态订阅。 */
    statusSubscription?: vscode.Disposable;
    /** CLI 进程退出订阅。 */
    exitSubscription?: vscode.Disposable;
    /** 该路由是否正在执行任务。 */
    busy: boolean;
    /** relay 侧在途请求数，busy 由其是否大于 0 推导。 */
    relayActiveCount: number;
    /** 最近一次 session/init 拿到的 session_id，供 usageSink 同步读取。 */
    sessionId: string;
    /** 按需启动配置缓存（仅 plan / review 使用）。 */
    launchConfigCache?: ChatCliConfig;
    /** 闲置释放计时器（仅 plan / review 使用）。 */
    idleDisposeTimer?: NodeJS.Timeout;
}

/** 创建一条路由的初始运行期状态。 */
function createRouteRuntime(): ChatRouteRuntime {
    return { busy: false, relayActiveCount: 0, sessionId: '' };
}

/** 两条路由（normal / taskFlow）的运行期状态容器。 */
export const routes: Record<ChatRoute, ChatRouteRuntime> = {
    normal: createRouteRuntime(),
    taskFlow: createRouteRuntime()
};

/** 按 CLI 来源累计当前一轮 assistant 文本，用于 done 时记录最终回复。 */
export const assistantTurnTextBySource: Record<ChatRoute, string> = { normal: '', taskFlow: '' };

/** 需要静默吞掉的内部 CLI 响应轮数，按路由分别统计。 */
export const hiddenCliResponseTurnsByRoute: Record<ChatRoute, number> = { normal: 0, taskFlow: 0 };

/** session_id 到 CLI 路由的内存映射，用于 token budget 压缩时选中正确 resetter。 */
export const chatSessionRouteById = new Map<string, ChatRoute>();

/** plan/review workflow 结束后保留进程的闲置窗口。 */
export const PLAN_REVIEW_IDLE_DISPOSE_MS = 10 * 60 * 1000;

/** 当前用户消息应发送到的 Chat CLI 路由（容器可变字段，避免导出可变 let）。 */
export const chatRouteState: { active: ChatRoute } = { active: 'normal' };

/** 用户是否主动取消了当前 CLI 回合；CLI 退出时据此区分「主动取消」与「异常退出」。 */
export const chatCliCancelState: { requested: boolean } = { requested: false };

/** 等待用户回答的 AskUserQuestion 请求，键为 requestId。 */
export const pendingAskUserRequests = new Map<string, { route: ChatRoute; input: unknown }>();

/** 是否有任意一条路由正在执行任务。 */
export function isAnyRouteBusy(): boolean {
    return routes.normal.busy || routes.taskFlow.busy;
}

/**
 * relay 请求进出时调整指定路由的在途计数并同步 busy 状态。
 *
 * @param route 目标路由。
 * @param busy true 表示新增一个在途请求，false 表示结束一个。
 * @param reason 日志用途的触发原因。
 */
export function setRelayRouteBusy(route: ChatRoute, busy: boolean, reason: string): void {
    const state = routes[route];
    state.relayActiveCount = Math.max(0, state.relayActiveCount + (busy ? 1 : -1));
    state.busy = state.relayActiveCount > 0;
    Logger.info(`Chat CLI 执行状态(${route})：${state.busy ? '执行中' : '空闲'}，reason=${reason}, active=${state.relayActiveCount}`);
    void getChatViewHost()?.postMessage({ type: 'chat/running', running: isAnyRouteBusy(), route });
}

/** 取指定路由的 CLI 子进程实例。 */
export function getCliProcessForRoute(route: ChatRoute): CliProcess | undefined {
    return routes[route].process;
}

/** 取指定路由的 stream-json 适配器实例。 */
export function getStreamAdapterForRoute(route: ChatRoute): StreamJsonCliAdapter | undefined {
    return routes[route].adapter;
}

/** 取指定路由最近一次已知的 session_id，未初始化时为空串。 */
export function getSessionIdForRoute(route: ChatRoute): string {
    return routes[route].sessionId;
}

/** 判断指定路由是否正在执行任务。 */
export function isRouteBusy(route: ChatRoute): boolean {
    return routes[route].busy;
}

/** 强制把指定路由的在途计数与 busy 状态归零，并同步给 webview。 */
export function resetRouteBusy(route: ChatRoute): void {
    const state = routes[route];
    state.relayActiveCount = 0;
    state.busy = false;
    void getChatViewHost()?.postMessage({ type: 'chat/running', running: isAnyRouteBusy(), route });
}

/** 归零全部两条路由（normal / taskFlow）的 busy 状态。 */
export function resetAllRouteBusy(): void {
    resetRouteBusy('normal');
    resetRouteBusy('taskFlow');
}

/** 取消指定路由正在执行的任务并归零其 busy 状态。 */
export function cancelRouteProcess(route: ChatRoute): void {
    getCliProcessForRoute(route)?.cancel();
    resetRouteBusy(route);
}

/** 根据旧 sessionId 找到触发 token 压缩的 CLI 路由，未命中时回退当前活动路由。 */
export function resolveRouteForSessionId(sessionId: string | undefined): ChatRoute {
    if (!sessionId) return chatRouteState.active;
    return chatSessionRouteById.get(sessionId) ?? chatRouteState.active;
}
