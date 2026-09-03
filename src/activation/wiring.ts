/**
 * activate 期的模块装配与事件订阅。
 *
 * 拆分自 extension.ts：把「各 chatRuntime / taskFlow 模块的 configure* 依赖注入」
 * 与「配置变更、Webview 消息、活动编辑器/选区变化等订阅」两批编排代码收敛到
 * 一个模块，让 extension.ts 只保留调用顺序。
 *
 * 依赖方向：本模块位于所有功能模块之上，不被它们反向引用。
 */
import * as vscode from 'vscode';

import { BROWSER_BRIDGE } from '../browserTools/bridge';
import { VSCODE_BRIDGE } from '../vscodeTools/bridge';
import { WAKEUP_BRIDGE } from '../wakeupTools/bridge';
import { appendAssistantSegments, configureChatSession, finishActiveAssistantMessage } from '../chatRuntime/chatSession';
import {
    appendUserMessageAndSend,
    configureChatMessaging,
    postActiveEditorAttachmentToChat
} from '../chatRuntime/chatMessaging';
import {
    configureCliEventHandlers,
    formatLogPreview,
    handleParsedCliEvent,
    notifyPermissionDeniedToUser
} from '../chatRuntime/cliEventHandlers';
import { configureCliLifecycle } from '../chatRuntime/cliLifecycle';
import { applyTaskFlowModelForContinue, configureModelSelection, getModelLabelForRoute } from '../chatRuntime/modelSelection';
import {
    armHttpExpectation,
    cancelPendingResend,
    clearHttpExpectation
} from '../chatRuntime/selfHealing';
import {
    configureWebviewMessages,
    handleChatWebviewMessage,
    postChatModelOptions,
    postChatPermissionMode,
    postChatTaskFlowModelOptions,
    postChatUiLanguage,
    postModelsSnapshot,
    showChatToast,
    switchChatRoute
} from '../chatRuntime/webviewMessages';
import { Logger } from '../logger';
import { AutoContinueScheduler } from '../llsTask/autoContinue';
import { getChatViewHost, getConfigManager, getLlsTaskService } from '../runtime';
import {
    configureTaskFlowCommands,
    getAutoContinueScheduler,
    handleTaskFlowRestoreChoice,
    maybePostTaskFlowRestorePrompt,
    openLlsCcaiTaskMenu
} from '../taskFlow/taskFlowCommands';
import { pasteTaskFlowToExternalClaudeCode } from '../taskFlow/externalPaste';
import {
    enableBrowserAutoApprove,
    postBrowserAutoApproveState,
    TOOL_AUTO_APPROVE_KEY
} from './browserToolsGate';
import { openBuiltInChat } from './chatEntry';
import {
    logMcpInjection,
    logMcpToolsBeforeCliStart
} from './mcpInjectionLog';
import { cleanupLegacyRelaySettingsSafely, ensureRelayServerStarted, syncClaudeCliModelSettingsSafely } from './startup';

/**
 * 把不依赖任何运行期实例的模块依赖注入完成。
 *
 * 必须在 activate 最早期调用：chatSession / chatMessaging 在恢复历史会话时就会用到。
 */
export function configureStatelessModules(): void {
    configureChatSession({ getModelLabelForRoute });
    configureChatMessaging({
        openBuiltInChat,
        switchChatRoute,
        armHttpExpectation,
        clearHttpExpectation,
        cancelPendingResend,
        showChatToast,
        formatLogPreview
    });
}

/**
 * 把依赖 configManager / CLI 服务的模块依赖注入完成。
 *
 * 需在 ConfigManager 与 createCliLifecycleServices 之后调用。
 */
export function configureRuntimeModules(): void {
    configureWebviewMessages({
        openLlsCcaiTaskMenu,
        handleTaskFlowRestoreChoice,
        maybePostTaskFlowRestorePrompt,
        postBrowserAutoApproveState,
        enableBrowserAutoApprove,
        armHttpExpectation,
        clearHttpExpectation,
        cancelPendingResend,
        cancelAutoContinue: (reason) => getAutoContinueScheduler()?.cancel(reason)
    });
    configureModelSelection({
        postChatModelOptions,
        postModelsSnapshot,
        showChatToast
    });
    configureCliEventHandlers({ showChatToast });
    configureTaskFlowCommands({ pasteTaskFlowToExternalClaudeCode });
    configureCliLifecycle({
        ensureRelayServerStarted,
        syncClaudeCliModelSettingsSafely,
        appendAssistantSegments,
        finishActiveAssistantMessage,
        showChatToast,
        clearHttpExpectation,
        cancelPendingResend,
        handleParsedCliEvent,
        notifyPermissionDeniedToUser,
        logMcpInjection: (config) => {
            for (const descriptor of [BROWSER_BRIDGE, VSCODE_BRIDGE, WAKEUP_BRIDGE]) {
                logMcpInjection(config, descriptor);
            }
            logMcpToolsBeforeCliStart();
        }
    });
    // 任务流续推走内置 Chat → CLI 链路，同时让续推提示词作为一条 user 消息正常显示，
    // 避免"无声续推"。beforeSubmit 用于每次续推前判断模型：配了任务流专用模型且当前
    // 不是它时，先切换并重启 CLI（内部已静置等待新进程就绪）再提交续推 prompt。
    // 创建阶段还没有活动 workflow，因此始终由主模型创建。
    AutoContinueScheduler.setBeforeSubmit(async () => {
        if (!getLlsTaskService()?.hasActiveWorkflow()) return;
        // 切到新模型后清零缺失工具计数：主模型阶段攒下的次数不该带进任务流模型
        // 阶段，否则刚切过去就可能达到熔断阈值，让自动续推静默停摆。
        if (await applyTaskFlowModelForContinue() === 'switched') {
            getAutoContinueScheduler()?.resetMissingToolCounter('任务流模型已切换');
        }
    });
    AutoContinueScheduler.setSubmitter(async (text) => {
        await appendUserMessageAndSend(text);
    });
}

/**
 * 订阅 ConfigManager 变化：清理历史 Relay 设置、同步 CLI 模型并刷新各模型下拉。
 *
 * @param context 扩展上下文，用于挂载 disposable。
 */
export function subscribeConfigManagerChanges(context: vscode.ExtensionContext): void {
    const manager = getConfigManager();
    if (!manager) return;
    context.subscriptions.push(
        manager.onDidChange(() => {
            void cleanupLegacyRelaySettingsSafely();
            void syncClaudeCliModelSettingsSafely();
            const refreshers: Array<[string, () => Promise<void>]> = [
                ['模型列表', postChatModelOptions],
                ['任务流模型列表', postChatTaskFlowModelOptions],
                ['模型选择快照', postModelsSnapshot]
            ];
            for (const [label, refresh] of refreshers) {
                void refresh().catch((err: unknown) => {
                    Logger.warn(`刷新 Chat ${label}失败：${err instanceof Error ? err.message : String(err)}`);
                });
            }
        })
    );
}

/**
 * 订阅 VS Code 配置变化：LLS CCAI 自身设置与浏览器工具放行设置。
 *
 * LLS CCAI 使用独立的 UI 语言配置，不读取或写入 openapicopilot.language。
 *
 * @param context 扩展上下文，用于挂载 disposable。
 */
export function subscribeVscodeConfigurationChanges(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration('claudeCodeConfigHelper.language') ||
                event.affectsConfiguration('claudeCodeConfigHelper.chat.cliPath') ||
                event.affectsConfiguration('claudeCodeConfigHelper.chat.permissionMode')
            ) {
                getConfigManager()?.notifyChanged();
                if (event.affectsConfiguration('claudeCodeConfigHelper.language')) {
                    void postChatUiLanguage().catch((err: unknown) => {
                        Logger.warn(`刷新 Chat 界面语言失败：${err instanceof Error ? err.message : String(err)}`);
                    });
                }
                void postChatPermissionMode().catch((err: unknown) => {
                    Logger.warn(`刷新 Chat 权限模式失败：${err instanceof Error ? err.message : String(err)}`);
                });
            }
            if (
                event.affectsConfiguration(TOOL_AUTO_APPROVE_KEY) ||
                event.affectsConfiguration('workbench.browser.enableChatTools')
            ) {
                void postBrowserAutoApproveState().catch((err: unknown) => {
                    Logger.warn(`刷新浏览器自动放行状态失败：${err instanceof Error ? err.message : String(err)}`);
                });
            }
        })
    );
}

/**
 * 订阅 Chat Webview 回传消息，并把处理失败以 message/error 回推给前端。
 *
 * @param context 扩展上下文，用于挂载 disposable。
 */
export function subscribeChatWebviewMessages(context: vscode.ExtensionContext): void {
    const host = getChatViewHost();
    if (!host) return;
    context.subscriptions.push(
        host.onDidReceiveMessage((message) => {
            if (message.type === 'webview/ready') {
                Logger.show();
                Logger.info('收到 Chat Webview ready，准备刷新默认上下文文件');
            }
            void handleChatWebviewMessage(message).catch((err: unknown) => {
                const text = err instanceof Error ? err.message : String(err);
                Logger.error(`处理 Chat Webview 消息失败：${text}`);
                void getChatViewHost()?.postMessage({ type: 'message/error', error: text });
            });
        })
    );
}

/**
 * 订阅活动编辑器与选区变化，实时刷新 Chat 输入框的默认上下文文件。
 *
 * Webview 可能在监听器注册前就发送了 ready，因此额外做一次延迟兜底刷新。
 *
 * @param context 扩展上下文，用于挂载 disposable。
 */
export function subscribeActiveEditorContext(context: vscode.ExtensionContext): void {
    const refresh = (label: string) => {
        void postActiveEditorAttachmentToChat().catch((err: unknown) => {
            Logger.warn(`${label}失败：${err instanceof Error ? err.message : String(err)}`);
        });
    };

    setTimeout(() => {
        Logger.info('Chat 默认上下文文件延迟兜底刷新');
        refresh('延迟刷新 Chat 默认上下文文件');
    }, 300);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            refresh('刷新 Chat 默认上下文文件');
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor !== vscode.window.activeTextEditor) return;
            const scheme = event.textEditor.document.uri.scheme;
            if (scheme === 'comment' || scheme === 'output') return;
            refresh('刷新 Chat 默认选区上下文');
        })
    );
}
