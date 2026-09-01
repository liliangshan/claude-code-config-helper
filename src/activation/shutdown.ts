/**
 * 扩展停用期的统一释放链路。
 *
 * 拆分自 extension.ts：把 deactivate 里「刷盘会话 → 取消各类定时器 → 释放各条
 * 路由的 adapter 与进程 → 释放 Webview/服务/ConfigManager → 清空全局单例」
 * 这条固定顺序的释放流程收敛到一个模块。
 *
 * 依赖方向：本模块位于所有功能模块之上，不被它们反向引用。
 */
import { flushPersistedChatSession } from '../chatRuntime/chatSession';
import { disposeCliLifecycleServices } from '../chatRuntime/cliLifecycle';
import type { ChatRoute } from '../chat/protocol';
import { routes } from '../chatRuntime/routeState';
import { cancelPendingResend, clearHttpExpectation } from '../chatRuntime/selfHealing';
import * as runtime from '../runtime';
import { getAutoContinueScheduler, setAutoContinueScheduler } from '../taskFlow/taskFlowCommands';
import { getWakeupScheduler, setWakeupScheduler } from '../wakeup/wakeupWiring';

/** 释放顺序固定：先 adapter 订阅与 adapter，再 CLI 进程，避免退出事件回调打到已释放对象。 */
const ROUTE_DISPOSE_ORDER: readonly ChatRoute[] = ['normal', 'taskFlow'];

/** 释放全部路由的 adapter 订阅与 adapter 实例。 */
function disposeRouteAdapters(): void {
    for (const kind of ROUTE_DISPOSE_ORDER) {
        const route = routes[kind];
        route.adapterSubscription?.dispose();
        route.adapterSubscription = undefined;
        route.adapter?.dispose();
        route.adapter = undefined;
    }
}

/** 释放全部路由的 CLI 子进程。 */
function disposeRouteProcesses(): void {
    for (const kind of ROUTE_DISPOSE_ORDER) {
        const route = routes[kind];
        route.process?.dispose();
        route.process = undefined;
    }
}

/**
 * 执行扩展停用的全部释放动作。
 *
 * 停用时会刷盘 Chat 会话，并释放 Chat、任务流服务、Webview Provider 与 ConfigManager。
 */
export function shutdownExtension(): void {
    void flushPersistedChatSession();
    clearHttpExpectation('deactivate');
    cancelPendingResend('deactivate');
    getAutoContinueScheduler()?.cancel('扩展停用');
    setAutoContinueScheduler(undefined);
    getWakeupScheduler()?.dispose();
    setWakeupScheduler(undefined);

    runtime.getRelayServer()?.dispose();
    runtime.setRelayServer(undefined);

    disposeRouteAdapters();
    disposeRouteProcesses();

    runtime.getChatViewHost()?.dispose();
    runtime.setChatViewHost(undefined);
    disposeCliLifecycleServices();

    runtime.getConfigViewProvider()?.dispose();
    runtime.setConfigViewProvider(undefined);
    runtime.getLlsTaskService()?.dispose();
    runtime.setLlsTaskService(undefined);
    runtime.getConfigManager()?.dispose();
    runtime.setConfigManager(undefined);
    runtime.setExtensionContext(undefined);
    runtime.setSettingsWriter(undefined);
}
