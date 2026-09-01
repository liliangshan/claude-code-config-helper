/**
 * 全部扩展命令的注册入口。
 *
 * 拆分自 extension.ts：把 22 个 `vscode.commands.registerCommand` 回调收敛到一个
 * 模块，activate 只需调用 {@link registerAllCommands} 一次即可完成命令层装配。
 *
 * 依赖方向：本模块位于各功能模块之上，直接 import 它们导出的入口函数；不被其反向引用。
 */
import * as vscode from 'vscode';

import { restartChatRelayAndCli, selectChatCli } from '../chatRuntime/cliLifecycle';
import { COMMANDS } from '../constants';
import { Logger } from '../logger';
import { getConfigManager, getConfigViewProvider } from '../runtime';
import { pasteTaskFlowToClaude, runSimulateEnterTest } from '../taskFlow/externalPaste';
import {
    clearLlsCcaiTask,
    continueLlsCcaiTask,
    openLlsCcaiTaskMenu,
    showLlsCcaiTaskProgress
} from '../taskFlow/taskFlowCommands';
import { SharedOpenApiCopilotSettingsPanel } from '../views/sharedSettingsView';
import { openBuiltInChat } from './chatEntry';

/**
 * 执行一个可能抛错的命令动作，失败时记日志并弹错误提示。
 *
 * @param label 用于日志与提示的动作名称。
 * @param action 实际执行的异步动作。
 */
async function runCommandGuarded(label: string, action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`${label}失败：${message}`);
        await vscode.window.showErrorMessage(`${label}失败：${message}`);
    }
}

/**
 * 注册扩展的全部命令，并把 disposable 挂到 context.subscriptions。
 *
 * @param context 扩展上下文，由 activate 传入。
 */
export function registerAllCommands(context: vscode.ExtensionContext): void {
    /** 打开设置页的快捷转发，多个占位命令共用。 */
    const openConfigPanel = () => vscode.commands.executeCommand(COMMANDS.openConfigPanel);

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.openConfigPanel, async () => {
            await getConfigViewProvider()?.focus();
        }),
        vscode.commands.registerCommand(COMMANDS.openSettingsJson, async () => {
            await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }),
        vscode.commands.registerCommand(COMMANDS.openGlobalSharedSettings, () => {
            const manager = getConfigManager();
            if (!manager) return;
            SharedOpenApiCopilotSettingsPanel.show(context, manager, 'global');
        }),
        vscode.commands.registerCommand(COMMANDS.openWorkspaceSharedSettings, () => {
            const manager = getConfigManager();
            if (!manager) return;
            SharedOpenApiCopilotSettingsPanel.show(context, manager, 'workspace');
        }),
        vscode.commands.registerCommand(COMMANDS.reloadWindow, async () => {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }),
        vscode.commands.registerCommand(COMMANDS.chatOpen, async () => {
            await runCommandGuarded('打开内置 Chat', openBuiltInChat);
        }),
        vscode.commands.registerCommand(COMMANDS.chatSelectCli, async () => {
            await runCommandGuarded('选择 Chat CLI', selectChatCli);
        }),
        vscode.commands.registerCommand(COMMANDS.chatRestart, async () => {
            await runCommandGuarded('重启本地中转与 Chat CLI', restartChatRelayAndCli);
        }),
        vscode.commands.registerCommand(COMMANDS.refreshProviders, () => undefined),
        vscode.commands.registerCommand(COMMANDS.newProvider, openConfigPanel),
        vscode.commands.registerCommand(COMMANDS.editProviderItem, openConfigPanel),
        vscode.commands.registerCommand(COMMANDS.deleteProviderItem, openConfigPanel),
        vscode.commands.registerCommand(COMMANDS.setCurrentModel, openConfigPanel),
        vscode.commands.registerCommand(COMMANDS.clearCurrentModel, openConfigPanel),
        vscode.commands.registerCommand(COMMANDS.pasteTaskFlowToClaude, async () => {
            await runCommandGuarded('粘贴任务流到 Claude Code', pasteTaskFlowToClaude);
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskOpenMenu, async () => {
            await openLlsCcaiTaskMenu();
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskShowProgress, async () => {
            await showLlsCcaiTaskProgress();
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskContinue, async () => {
            await continueLlsCcaiTask();
        }),
        vscode.commands.registerCommand(COMMANDS.llsCcaiTaskClear, () => {
            clearLlsCcaiTask();
        }),
        vscode.commands.registerCommand(COMMANDS.testSimulateEnter, async () => {
            await runCommandGuarded('模拟回车测试', runSimulateEnterTest);
        }),
        vscode.commands.registerCommand(COMMANDS.exportConfig, openConfigPanel),
        vscode.commands.registerCommand(COMMANDS.importConfig, openConfigPanel)
    );
}
