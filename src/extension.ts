/**
 * @file 扩展入口：只负责 activate / deactivate 的调用顺序编排。
 *
 * 具体实现全部位于 activation/、chatRuntime/、taskFlow/、wakeup/ 等模块，
 * 本文件不承载任何业务逻辑与模块级可变状态。
 */

import * as vscode from 'vscode';

import { promptEnableBrowserChatToolsIfNeeded } from './activation/browserToolsGate';
import { autoOpenBuiltInChatIfCliConfigured } from './activation/chatEntry';
import { registerAllCommands } from './activation/commands';
import { setupRelayPipeline } from './activation/relayWiring';
import { shutdownExtension } from './activation/shutdown';
import { applyClaudeCodeInitialPermissionMode, cleanupLegacyRelaySettingsSafely } from './activation/startup';
import {
    configureRuntimeModules,
    configureStatelessModules,
    subscribeActiveEditorContext,
    subscribeChatWebviewMessages,
    subscribeConfigManagerChanges,
    subscribeVscodeConfigurationChanges
} from './activation/wiring';
import { ChatCliConfigService } from './chat/cli/cliConfig';
import { ChatViewHost } from './chat/chatViewHost';
import { createCliLifecycleServices, registerChatCliStatusHandlers } from './chatRuntime/cliLifecycle';
import { restorePersistedChatSession } from './chatRuntime/chatSession';
import { postChatTaskFlowStatus } from './chatRuntime/webviewMessages';
import { routes } from './chatRuntime/routeState';
import { ConfigManager } from './configManager';
import { CHAT_SECONDARY_VIEW_ID, PROVIDERS_VIEW_ID } from './constants';
import { AutoContinueScheduler } from './llsTask/autoContinue';
import { LlsTaskService } from './llsTask/service';
import { TaskFlowStore } from './llsTask/store';
import { Logger } from './logger';
import { RelayServer } from './relay/server';
import * as runtime from './runtime';
import { SettingsWriter } from './settingsWriter';
import { setAutoContinueScheduler, setPendingRestorePrompt } from './taskFlow/taskFlowCommands';
import { getWakeupScheduler } from './wakeup/wakeupWiring';
import { ConfigWebviewViewProvider } from './views/configView';

/**
 * 创建扩展生命周期内唯一的各服务实例，并写入 runtime 全局访问器。
 *
 * @param context 扩展上下文，由 activate 传入。
 * @returns 后续编排步骤需要直接引用的实例。
 */
function createCoreServices(context: vscode.ExtensionContext): {
    configManager: ConfigManager;
    chatViewHost: ChatViewHost;
    llsTaskService: LlsTaskService;
    configViewProvider: ConfigWebviewViewProvider;
} {
    const configManager = new ConfigManager(context);
    runtime.setConfigManager(configManager);
    createCliLifecycleServices(new ChatCliConfigService(configManager));

    const chatViewHost = new ChatViewHost(context);
    runtime.setChatViewHost(chatViewHost);

    const llsTaskService = new LlsTaskService(configManager, new TaskFlowStore());
    runtime.setLlsTaskService(llsTaskService);

    const configViewProvider = new ConfigWebviewViewProvider(context, configManager);
    runtime.setConfigViewProvider(configViewProvider);

    runtime.setSettingsWriter(new SettingsWriter());
    runtime.setRelayServer(new RelayServer({ desiredPort: 0 }));

    return { configManager, chatViewHost, llsTaskService, configViewProvider };
}

/**
 * 从磁盘恢复上次未完成的任务流。
 *
 * 恢复出未完成 workflow 时置 pendingRestorePrompt，待 Chat 首次 ready 弹恢复对话框；
 * 失败只记日志，绝不阻塞激活。
 *
 * @param llsTaskService 任务流服务实例。
 */
async function restoreTaskFlowSafely(llsTaskService: LlsTaskService): Promise<void> {
    try {
        setPendingRestorePrompt(await llsTaskService.restore());
    } catch (err) {
        Logger.warn(`[LlsTask] 任务流恢复失败：${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * 把各服务与视图 Provider 注册到 context.subscriptions，交由 VS Code 统一释放。
 *
 * @param context 扩展上下文。
 * @param services createCoreServices 的返回值。
 */
function registerDisposables(
    context: vscode.ExtensionContext,
    services: ReturnType<typeof createCoreServices>
): void {
    const { configManager, chatViewHost, llsTaskService, configViewProvider } = services;
    context.subscriptions.push(configManager, chatViewHost, llsTaskService);
    if (routes.normal.process) context.subscriptions.push(routes.normal.process);
    context.subscriptions.push(llsTaskService.onDidChange(() => {
        void postChatTaskFlowStatus();
    }));
    context.subscriptions.push(runtime.getRelayServer()!);
    context.subscriptions.push(
        configViewProvider,
        vscode.window.registerWebviewViewProvider(PROVIDERS_VIEW_ID, configViewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.window.registerWebviewViewProvider(CHAT_SECONDARY_VIEW_ID, chatViewHost, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
}

/**
 * VS Code 扩展激活函数。
 *
 * 按序完成：日志与无状态模块装配 → 恢复历史会话 → 创建核心服务 →
 * 运行期模块装配 → 中转链路装配 → 事件订阅 → 命令注册 → 启动期收尾动作。
 *
 * @param context 扩展上下文，由 VS Code 注入。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    Logger.init(context);
    Logger.info('LLS CCAI 已激活');
    runtime.setExtensionContext(context);

    configureStatelessModules();
    restorePersistedChatSession();
    await applyClaudeCodeInitialPermissionMode();

    const services = createCoreServices(context);
    configureRuntimeModules();
    await restoreTaskFlowSafely(services.llsTaskService);

    const autoContinueScheduler = new AutoContinueScheduler(services.llsTaskService);
    setAutoContinueScheduler(autoContinueScheduler);
    setupRelayPipeline(context, autoContinueScheduler);
    void cleanupLegacyRelaySettingsSafely();

    registerDisposables(context, services);
    registerChatCliStatusHandlers(context);
    subscribeConfigManagerChanges(context);
    subscribeVscodeConfigurationChanges(context);
    subscribeChatWebviewMessages(context);
    subscribeActiveEditorContext(context);
    registerAllCommands(context);

    await promptEnableBrowserChatToolsIfNeeded();
    void autoOpenBuiltInChatIfCliConfigured();

    // 必须在 chatViewHost 与 Chat 命令注册完成之后：补发错过的唤醒会立刻写聊天区。
    void getWakeupScheduler()?.restore().catch((err: unknown) => {
        Logger.warn(`恢复定时唤醒失败：${err instanceof Error ? err.message : String(err)}`);
    });
}

/**
 * VS Code 扩展停用函数。
 *
 * 实际释放顺序由 activation/shutdown 统一维护。
 */
export function deactivate(): void {
    shutdownExtension();
}
