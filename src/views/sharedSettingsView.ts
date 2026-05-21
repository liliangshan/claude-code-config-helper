/** @file LLS CCAI 共享提示词与任务流设置的 WebviewPanel。 */

import * as vscode from 'vscode';

import { ConfigManager } from '../configManager';
import { COMMANDS } from '../constants';
import type { ResolvedAppLanguage, SharedOpenApiCopilotSettings } from '../types';

/** 共享设置面板打开模式。 */
type SharedSettingsMode = 'global' | 'workspace';

/** Webview 前端发送给共享设置面板的消息。 */
type SharedSettingsMessage =
    | { type: 'ready' }
    | { type: 'switchGlobal' }
    | { type: 'switchWorkspace' }
    | { type: 'saveGlobal'; payload: { systemPrompt: string } }
    | { type: 'saveWorkspace'; payload: { systemPrompt: string } }
    | { type: 'testSimulateEnter' };

/** 共享设置面板的 Webview viewType。 */
const SHARED_SETTINGS_VIEW_TYPE = 'claudeRouter.sharedOpenApiCopilotSettings';

/** 共享设置面板标题。 */
const SHARED_SETTINGS_TITLE = 'LLS CCAI Setting';

/** 共享设置面板运行时文案集合。 */
interface SharedSettingsTexts {
    /** 页面标题。 */
    title: string;
    /** 页面说明。 */
    description: string;
    /** 全局设置标签页。 */
    globalTab: string;
    /** 工作区设置标签页。 */
    workspaceTab: string;
    /** 全局系统提示词标签。 */
    globalSystemPromptLabel: string;
    /** 全局设置说明。 */
    globalHint: string;
    /** 保存全局设置按钮。 */
    saveGlobal: string;
    /** 工作区系统提示词标签。 */
    workspaceSystemPromptLabel: string;
    /** 工作区设置说明。 */
    workspaceHint: string;
    /** 保存工作区设置按钮。 */
    saveWorkspace: string;
    /** 全局保存成功提示。 */
    globalSaved: string;
    /** 工作区保存成功提示。 */
    workspaceSaved: string;
    /** 保存失败前缀。 */
    saveFailedPrefix: string;
    /** 模拟回车测试按钮。 */
    testEnterButton: string;
    /** 模拟回车测试说明。 */
    testEnterHint: string;
}

/** 共享设置面板核心文案字典，未补全语言回落英文。 */
const SHARED_SETTINGS_TEXTS: Record<ResolvedAppLanguage, SharedSettingsTexts> = {
    en: {
        title: SHARED_SETTINGS_TITLE,
        description: 'Configure global/workspace system prompts. LLS CCAI task workflows are now created by the current main model through injected tools.',
        globalTab: 'Global Settings',
        workspaceTab: 'Workspace Settings',
        globalSystemPromptLabel: 'Global System Prompt (openapicopilot.systemPrompt / Global)',
        globalHint: 'Task workflows no longer require a dedicated Provider / Model. The workspace page only overrides the system prompt for the current workspace.',
        saveGlobal: 'Save Global Settings',
        workspaceSystemPromptLabel: 'Workspace System Prompt (openapicopilot.systemPrompt / Workspace)',
        workspaceHint: 'After saving, this writes openapicopilot.systemPrompt into the current workspace settings.json. Leave it empty if you only want to use the global value.',
        saveWorkspace: 'Save Workspace Settings',
        globalSaved: 'LLS CCAI global shared settings saved',
        workspaceSaved: 'LLS CCAI workspace shared settings saved',
        saveFailedPrefix: 'Failed to save shared settings',
        testEnterButton: 'Test Simulated Enter',
        testEnterHint: 'Pastes a short test string into the Claude Code input box and triggers a system-level Enter key. On macOS the first run will request Accessibility permission for VS Code; if it does not auto-send, open "System Settings → Privacy & Security → Accessibility" and enable "Allow Visual Studio Code to control your computer". On Windows it uses PowerShell SendKeys without extra permission.'
    },
    'zh-cn': {
        title: SHARED_SETTINGS_TITLE,
        description: '配置全局/工作区系统提示词。LLS CCAI 任务流现在由当前主模型通过注入工具创建，不再需要专用任务流模型。',
        globalTab: '全局设置',
        workspaceTab: '工作区设置',
        globalSystemPromptLabel: '全局系统提示词（openapicopilot.systemPrompt / Global）',
        globalHint: '任务流不再需要专用 Provider / Model；工作区页只用于覆盖当前工作区的系统提示词。',
        saveGlobal: '保存全局设置',
        workspaceSystemPromptLabel: '工作区系统提示词（openapicopilot.systemPrompt / Workspace）',
        workspaceHint: '保存后会写入当前工作区 settings.json 的 openapicopilot.systemPrompt。如果只设置全局值，工作区留空即可。',
        saveWorkspace: '保存工作区设置',
        globalSaved: 'LLS CCAI 全局共享设置已保存',
        workspaceSaved: 'LLS CCAI 工作区共享设置已保存',
        saveFailedPrefix: '保存共享设置失败',
        testEnterButton: '测试模拟回车',
        testEnterHint: '会向 Claude Code 输入框粘贴一段测试文本，然后调用系统级回车。macOS 首次运行会请求 VS Code 的「辅助功能」权限；如果未自动发送，请到「系统设置 → 隐私与安全性 → 辅助功能」中把 Visual Studio Code 的"允许控制电脑"权限打开后重试。Windows 使用 PowerShell SendKeys，无需额外授权。'
    },
    'zh-tw': undefined as unknown as SharedSettingsTexts,
    ko: undefined as unknown as SharedSettingsTexts,
    ja: undefined as unknown as SharedSettingsTexts,
    fr: undefined as unknown as SharedSettingsTexts,
    de: undefined as unknown as SharedSettingsTexts
};

SHARED_SETTINGS_TEXTS['zh-tw'] = SHARED_SETTINGS_TEXTS.en;
SHARED_SETTINGS_TEXTS.ko = SHARED_SETTINGS_TEXTS.en;
SHARED_SETTINGS_TEXTS.ja = SHARED_SETTINGS_TEXTS.en;
SHARED_SETTINGS_TEXTS.fr = SHARED_SETTINGS_TEXTS.en;
SHARED_SETTINGS_TEXTS.de = SHARED_SETTINGS_TEXTS.en;

/** 根据解析后的 UI 语言读取共享设置页文案，缺失语言回落英文。 */
function getSharedSettingsTexts(language: ResolvedAppLanguage): SharedSettingsTexts {
    return SHARED_SETTINGS_TEXTS[language] ?? SHARED_SETTINGS_TEXTS.en;
}

/**
 * LLS CCAI 共享设置面板。
 *
 * 系统提示词继续使用 openapicopilot.systemPrompt 与 LLS OAI 共享；任务流由当前主模型工具创建。
 */
export class SharedOpenApiCopilotSettingsPanel implements vscode.Disposable {
    /** 当前打开的共享设置面板单例。 */
    private static currentPanel: SharedOpenApiCopilotSettingsPanel | undefined;

    /** WebviewPanel 实例。 */
    private readonly panel: vscode.WebviewPanel;

    /** 待释放资源集合。 */
    private readonly disposables: vscode.Disposable[] = [];

    /**
     * 打开或聚焦共享设置面板。
     *
     * @param context 扩展上下文。
     * @param manager 配置管理器。
     * @param mode 打开的初始设置模式，全局或工作区。
     */
    public static show(context: vscode.ExtensionContext, manager: ConfigManager, mode: SharedSettingsMode): void {
        if (SharedOpenApiCopilotSettingsPanel.currentPanel) {
            SharedOpenApiCopilotSettingsPanel.currentPanel.reveal(mode);
            return;
        }
        SharedOpenApiCopilotSettingsPanel.currentPanel = new SharedOpenApiCopilotSettingsPanel(context, manager, mode);
    }

    /**
     * 创建共享设置面板。
     *
     * @param context 扩展上下文。
     * @param manager 配置管理器。
     * @param mode 初始设置模式。
     */
    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly manager: ConfigManager,
        private mode: SharedSettingsMode
    ) {
        this.panel = vscode.window.createWebviewPanel(
            SHARED_SETTINGS_VIEW_TYPE,
            SHARED_SETTINGS_TITLE,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        this.panel.webview.html = this.renderHtml();
        this.disposables.push(
            this.panel.webview.onDidReceiveMessage((message: SharedSettingsMessage) => {
                void this.handleMessage(message);
            }),
            this.panel.onDidDispose(() => {
                SharedOpenApiCopilotSettingsPanel.currentPanel = undefined;
                this.dispose();
            })
        );
    }

    /**
     * 聚焦面板并切换到指定模式。
     *
     * @param mode 要显示的设置模式。
     */
    private reveal(mode: SharedSettingsMode): void {
        this.mode = mode;
        this.panel.reveal(vscode.ViewColumn.One);
        this.panel.webview.html = this.renderHtml();
    }

    /** 释放面板资源。 */
    public dispose(): void {
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    /**
     * 处理 Webview 前端消息。
     *
     * @param message 前端消息。
     */
    private async handleMessage(message: SharedSettingsMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                    return;
                case 'switchGlobal':
                    this.mode = 'global';
                    this.panel.webview.html = this.renderHtml();
                    return;
                case 'switchWorkspace':
                    this.mode = 'workspace';
                    this.panel.webview.html = this.renderHtml();
                    return;
                case 'saveGlobal':
                    await this.manager.updateGlobalSystemPrompt(message.payload.systemPrompt);
                    vscode.window.showInformationMessage(this.texts.globalSaved);
                    this.panel.webview.html = this.renderHtml();
                    return;
                case 'saveWorkspace':
                    await this.manager.updateWorkspaceSystemPrompt(message.payload.systemPrompt);
                    vscode.window.showInformationMessage(this.texts.workspaceSaved);
                    this.panel.webview.html = this.renderHtml();
                    return;
                case 'testSimulateEnter':
                    // 转交给扩展命令，统一日志与错误提示。
                    await vscode.commands.executeCommand(COMMANDS.testSimulateEnter);
                    return;
            }
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`${this.texts.saveFailedPrefix}: ${messageText}`);
        }
    }

    /** 获取当前共享设置页使用的运行时文案。 */
    private get texts(): SharedSettingsTexts {
        return getSharedSettingsTexts(this.manager.getResolvedUiLanguage());
    }

    /** 渲染面板 HTML。 */
    private renderHtml(): string {
        const nonce = this.createNonce();
        const settings = this.manager.getSharedOpenApiCopilotSettings();
        const language = this.manager.getResolvedUiLanguage();
        const texts = getSharedSettingsTexts(language);
        const modeHtml = this.mode === 'global'
            ? this.renderGlobalSettings(settings, texts)
            : this.renderWorkspaceSettings(settings, texts);
        return `<!DOCTYPE html>
<html lang="${this.escapeHtml(language)}">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${this.escapeHtml(texts.title)}</title>
    <style>
        body { margin: 0; padding: 20px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
        .shell { max-width: 960px; margin: 0 auto; }
        .header { margin-bottom: 16px; }
        .header h1 { margin: 0 0 8px; font-size: 24px; }
        .hint { color: var(--vscode-descriptionForeground); line-height: 1.6; }
        .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
        button { border: 0; border-radius: 4px; padding: 7px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
        button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
        .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; background: var(--vscode-sideBar-background); }
        .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
        label { color: var(--vscode-descriptionForeground); font-size: 12px; }
        input, select, textarea { border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font-family: var(--vscode-font-family); }
        textarea { min-height: 220px; resize: vertical; }
        .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
        code { color: var(--vscode-textPreformat-foreground); }
    </style>
</head>
<body>
    <main class="shell">
        <section class="header">
            <h1>${this.escapeHtml(texts.title)}</h1>
            <p class="hint">${this.escapeHtml(texts.description)}</p>
        </section>
        <div class="tabs">
            <button id="tab-global" class="${this.mode === 'global' ? '' : 'secondary'}">${this.escapeHtml(texts.globalTab)}</button>
            <button id="tab-workspace" class="${this.mode === 'workspace' ? '' : 'secondary'}">${this.escapeHtml(texts.workspaceTab)}</button>
        </div>
        ${modeHtml}
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const mode = ${JSON.stringify(this.mode)};
        document.getElementById('tab-global').addEventListener('click', () => vscode.postMessage({ type: 'switchGlobal' }));
        document.getElementById('tab-workspace').addEventListener('click', () => vscode.postMessage({ type: 'switchWorkspace' }));
        document.getElementById('save-global')?.addEventListener('click', () => vscode.postMessage({
            type: 'saveGlobal',
            payload: {
                systemPrompt: document.getElementById('global-system-prompt').value
            }
        }));
        document.getElementById('save-workspace')?.addEventListener('click', () => vscode.postMessage({
            type: 'saveWorkspace',
            payload: { systemPrompt: document.getElementById('workspace-system-prompt').value }
        }));
        document.getElementById('test-simulate-enter')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'testSimulateEnter' });
        });
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }

    /**
     * 渲染全局设置区域。
     *
     * @param settings 当前共享设置。
     */
    private renderGlobalSettings(settings: SharedOpenApiCopilotSettings, texts: SharedSettingsTexts): string {
        return `<section class="card">
            <div class="field">
                <label for="global-system-prompt">${this.escapeHtml(texts.globalSystemPromptLabel)}</label>
                <textarea id="global-system-prompt">${this.escapeHtml(settings.globalSystemPrompt)}</textarea>
            </div>
            <p class="hint">${this.escapeHtml(texts.globalHint)}</p>
            <p class="hint">${this.escapeHtml(texts.testEnterHint)}</p>
            <div class="actions">
                <button id="test-simulate-enter" class="secondary">${this.escapeHtml(texts.testEnterButton)}</button>
                <button id="save-global">${this.escapeHtml(texts.saveGlobal)}</button>
            </div>
        </section>`;
    }

    /**
     * 渲染工作区设置区域。
     *
     * @param settings 当前共享设置。
     */
    private renderWorkspaceSettings(settings: SharedOpenApiCopilotSettings, texts: SharedSettingsTexts): string {
        return `<section class="card">
            <div class="field">
                <label for="workspace-system-prompt">${this.escapeHtml(texts.workspaceSystemPromptLabel)}</label>
                <textarea id="workspace-system-prompt">${this.escapeHtml(settings.workspaceSystemPrompt)}</textarea>
            </div>
            <p class="hint">${this.escapeHtml(texts.workspaceHint)}</p>
            <div class="actions"><button id="save-workspace">${this.escapeHtml(texts.saveWorkspace)}</button></div>
        </section>`;
    }

    /** 转义 HTML 文本，避免用户提示词破坏页面结构。 */
    private escapeHtml(value: string): string {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** 转义嵌入脚本标签中的 JSON，避免用户配置内容提前结束 script。 */
    private toScriptJson(value: unknown): string {
        return JSON.stringify(value).replace(/</g, '\\u003c');
    }

    /** 创建 CSP nonce。 */
    private createNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i += 1) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }
}
