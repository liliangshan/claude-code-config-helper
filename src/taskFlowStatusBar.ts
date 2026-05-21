/** @file Claude Code 任务流状态栏组件。 */

import * as vscode from 'vscode';

import { ConfigManager } from './configManager';
import { COMMANDS } from './constants';
import { getLlsCcaiTaskTexts } from './llsTask/messages';
import type { LlsTaskService } from './llsTask/service';
import type { LlsTaskItem, LlsTaskWorkflow } from './llsTask/types';

/**
 * 管理 VS Code 状态栏中的 Claude Code 任务流快捷入口。
 *
 * 状态栏会根据任务流状态与 UI 语言实时刷新：
 * 无 workflow 时用于启动；有 workflow 时显示进度并作为查看入口。
 */
export class TaskFlowStatusBar implements vscode.Disposable {
    /** VS Code 状态栏 item 实例。 */
    private readonly item: vscode.StatusBarItem;

    /** 监听语言、配置与任务流变化的可释放订阅集合。 */
    private readonly disposables: vscode.Disposable[] = [];

    /**
     * 创建任务流状态栏组件。
     *
    * @param configManager 配置管理器，用于读取当前 UI 语言。
     * @param llsTaskService 任务流服务，用于读取 workflow 快照。
     */
    public constructor(
        private readonly configManager: ConfigManager,
        private readonly llsTaskService: LlsTaskService
    ) {
        // 放在右侧状态栏。VS Code 右侧状态栏排序规则：优先级数字越小越靠近右下角。
        // CC Relay 使用优先级 100，这里取 50，让 "CC 任务流" 显示在 CC Relay 右侧（更靠右下角），
        // 与 Claude Code 自身的状态项视觉分组（左侧多为编辑器/SCM 信息，右侧多为模型/会话相关指示）。
        this.item = vscode.window.createStatusBarItem('claudeRouter.llsCcaiTask.statusBar', vscode.StatusBarAlignment.Right, 50);
        this.item.command = COMMANDS.llsCcaiTaskOpenMenu;
        this.refresh();

        this.disposables.push(
            this.llsTaskService.onDidChange(() => this.refresh()),
            this.configManager.onDidChange(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration('claudeCodeConfigHelper.language')
                ) {
                    this.refresh();
                }
            })
        );
    }

    /**
     * 根据当前任务流状态与语言重新渲染状态栏文案。
     */
    public refresh(): void {
        const language = this.configManager.getResolvedUiLanguage();
        const texts = getLlsCcaiTaskTexts(language);
        const snapshot = this.llsTaskService.getSnapshot();
        this.item.name = 'CC Task Flow Menu';
        // 状态栏标签随 UI 语言切换：texts.statusLabel 已覆盖 en/zh-cn/zh-tw/ko/ja/fr/de，
        // 统一前缀 "CC " 保持品牌一致，避免不同语言下名称完全失去关联。
        const label = `CC ${texts.statusLabel}`;
        const workflow = snapshot.workflow;
        if (!workflow) {
            this.item.text = `$(list-tree) ${label}`;
            this.item.tooltip = texts.startTooltip;
            this.item.show();
            return;
        }
        const progress = this.getProgress(workflow);
        const completed = this.llsTaskService.isWorkflowCompleted();
        this.item.text = `${completed ? '$(check)' : '$(list-tree)'} ${label} ${progress.completed}/${progress.total}`;
        this.item.tooltip = this.buildWorkflowTooltip(workflow, completed ? texts.completedTooltip : undefined);
        this.item.show();
    }

    /**
     * 释放状态栏 item 与订阅。
     */
    public dispose(): void {
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
        this.item.dispose();
    }

    /**
     * 计算 workflow 完成进度。
     *
     * @param workflow 任务流对象。
     * @returns completed/total 进度。
     */
    private getProgress(workflow: LlsTaskWorkflow): { completed: number; total: number } {
        return {
            completed: workflow.tasks.filter((task) => task.status === 'completed').length,
            total: workflow.tasks.length
        };
    }

    /**
     * 构造包含任务列表的状态栏 tooltip。
     *
     * @param workflow 任务流对象。
     * @param footer 可选底部提示。
     * @returns 多行 tooltip 文本。
     */
    private buildWorkflowTooltip(workflow: LlsTaskWorkflow, footer?: string): string {
        const progress = this.getProgress(workflow);
        const lines = [workflow.title, `Progress: ${progress.completed}/${progress.total}`, ''];
        workflow.tasks.forEach((task, index) => {
            lines.push(`${index + 1}. ${this.getTaskIcon(task)} ${task.title} (${task.status})`);
        });
        if (footer) {
            lines.push('', footer);
        }
        return lines.join('\n');
    }

    /**
     * 根据任务状态返回 tooltip 图标。
     *
     * @param task 任务项。
     * @returns 状态图标。
     */
    private getTaskIcon(task: LlsTaskItem): string {
        switch (task.status) {
            case 'completed':
                return '✓';
            case 'in_progress':
                return '↻';
            case 'blocked':
                return '⚠';
            case 'pending':
            default:
                return '○';
        }
    }
}
