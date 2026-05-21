/**
 * @file Relay 状态栏组件。
 *
 * 第二阶段只负责显示本地中转运行状态、端口和当前模型显示名称；
 * 完整 leader/follower 心跳与接管会在后续阶段扩展。
 */

import * as vscode from 'vscode';

import { COMMANDS } from './constants';
import type { CurrentModelDisplayInfo, RelayStatus } from './types';

/**
 * 管理 VS Code 状态栏中的 Claude Code Relay 状态显示。
 *
 * 该类只负责状态栏 UI，不负责启动或停止 HTTP 中转服务。
 */
export class RelayStatusBar implements vscode.Disposable {
    /** VS Code 状态栏 item 实例。 */
    private readonly item: vscode.StatusBarItem;

    /**
     * 创建 Relay 状态栏组件。
     */
    public constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = COMMANDS.openConfigPanel;
        this.item.name = 'Claude Code Relay';
    }

    /**
     * 根据当前 Relay 状态与模型显示信息刷新状态栏。
     *
     * @param status 本地中转运行状态。
     * @param model 当前模型显示信息。
     */
    public update(status: RelayStatus, model: CurrentModelDisplayInfo): void {
        const modelText = model.modelDisplayName || '未选择模型';
        switch (status.kind) {
            case 'starting':
                this.item.text = `$(sync~spin) CC Relay ${status.port} 启动中`;
                this.item.tooltip = `正在启动本地 Claude Code 中转服务...\n端口：${status.port}\n当前模型：${this.formatTooltipModel(model)}`;
                this.item.command = COMMANDS.openConfigPanel;
                break;
            case 'leader':
                this.item.text = `$(radio-tower) CC Relay ${status.port} ● ${modelText}`;
                this.item.tooltip = `本地 Claude Code 中转服务已开启\n端口：${status.port}\n当前模型：${this.formatTooltipModel(model)}\npid=${status.pid}`;
                this.item.command = COMMANDS.openConfigPanel;
                break;
            case 'stopped':
                this.item.text = `$(circle-slash) CC Relay 未开启 ${modelText}`;
                this.item.tooltip = `本地 Claude Code 中转服务未运行\n当前模型：${this.formatTooltipModel(model)}`;
                this.item.command = COMMANDS.openConfigPanel;
                break;
            case 'error':
                this.item.text = `$(error) CC Relay 错误 ${modelText}`;
                this.item.tooltip = `本地 Claude Code 中转服务错误：${status.message}\n端口：${status.port ?? '未知'}\n当前模型：${this.formatTooltipModel(model)}`;
                this.item.command = COMMANDS.openConfigPanel;
                break;
        }
        this.item.show();
    }

    /**
     * 释放状态栏 item。
     */
    public dispose(): void {
        this.item.dispose();
    }

    /**
     * 格式化 tooltip 中的当前模型显示文本。
     *
     * @param model 当前模型显示信息。
     * @returns 适合 tooltip 展示的模型描述。
     */
    private formatTooltipModel(model: CurrentModelDisplayInfo): string {
        if (!model.isSelected) return '未选择模型';
        return `${model.providerName || '未知提供商'}/${model.modelDisplayName || '未知模型'}`;
    }
}
