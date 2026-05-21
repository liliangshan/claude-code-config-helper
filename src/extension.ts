/** @file 第二阶段扩展入口：接入 Relay 状态栏、本地中转服务与 settings.json 写入闭环。 */

import * as vscode from 'vscode';

import { ConfigManager } from './configManager';
import { COMMANDS, PROVIDERS_VIEW_ID } from './constants';
import { Logger } from './logger';
import { AutoContinueScheduler } from './llsTask/autoContinue';
import { getLlsCcaiTaskTexts } from './llsTask/messages';
import { pasteToClaudeCode } from './llsTask/paster';
import { LlsTaskService } from './llsTask/service';
import type { LlsTaskItem } from './llsTask/types';
import { AnthropicProxyAdapter } from './relay/anthropicProxy';
import { DebugRecorder } from './relay/debugRecorder';
import { OpenAIChatProxyAdapter } from './relay/openaiChatProxy';
import { OpenAIResponsesProxyAdapter } from './relay/openaiResponsesProxy';
import { createRelayRouter } from './relay/router';
import { RelayServer } from './relay/server';
import { RelayStatusBar } from './relayStatusBar';
import { SettingsWriter } from './settingsWriter';
import { TaskFlowStatusBar } from './taskFlowStatusBar';
import type { CurrentModelDisplayInfo, RelayStatus, ResolvedAppLanguage } from './types';
import { ConfigWebviewViewProvider } from './views/configView';
import { SharedOpenApiCopilotSettingsPanel } from './views/sharedSettingsView';

/** 模块级配置管理器实例，便于 deactivate 兜底释放。 */
let configManager: ConfigManager | undefined;

/** 模块级侧栏配置视图 Provider，便于命令聚焦与 deactivate 兜底释放。 */
let configViewProvider: ConfigWebviewViewProvider | undefined;

/** 模块级 Relay 状态栏组件实例。 */
let relayStatusBar: RelayStatusBar | undefined;

/** 模块级任务流状态栏组件实例。 */
let taskFlowStatusBar: TaskFlowStatusBar | undefined;

/** 模块级 LLS CCAI 任务流服务实例。 */
let llsTaskService: LlsTaskService | undefined;

/** 模块级自动续推调度器实例。 */
let autoContinueScheduler: AutoContinueScheduler | undefined;

/** 模块级本地中转服务实例。 */
let relayServer: RelayServer | undefined;

/** 模块级 Claude Code settings.json 写入器。 */
let settingsWriter: SettingsWriter | undefined;

/**
 * 模块级当前 Relay 运行状态缓存。
 *
 * 由 {@link RelayServer.onStatusChange} 驱动更新，状态栏据此刷新。
 */
let currentRelayStatus: RelayStatus = { kind: 'stopped' };

/**
 * 根据当前模型选择和提供商列表，构造状态栏展示用的模型显示信息。
 *
 * @param manager 配置管理器实例。
 * @returns 状态栏与 Webview 共用的当前模型显示数据。
 */
function buildCurrentModelDisplay(manager: ConfigManager): CurrentModelDisplayInfo {
    const selection = manager.getCurrentModel();
    if (!selection) {
        return { providerName: '', modelDisplayName: '', isSelected: false };
    }
    const provider = manager.getProvider(selection.providerId);
    const model = provider?.models.find((item) => item.modelId === selection.modelId);
    if (!provider || !model) {
        return { providerName: '', modelDisplayName: '', isSelected: false };
    }
    return {
        providerName: provider.name,
        modelDisplayName: model.displayName || model.modelId,
        isSelected: true
    };
}

/**
 * 使用当前 Relay 状态与当前模型信息刷新状态栏。
 *
 * 该函数在 activate 阶段和每次配置或 Relay 状态变更时调用。
 */
function refreshStatusBar(): void {
    if (!relayStatusBar || !configManager) return;
    relayStatusBar.update(currentRelayStatus, buildCurrentModelDisplay(configManager));
}

/**
 * 启动时把 Claude Code 初始权限模式设置为 acceptEdits
 */
async function applyClaudeCodeInitialPermissionMode(): Promise<void> {
    try {
        await vscode.workspace.getConfiguration('claudeCode')
            .update('initialPermissionMode', 'acceptEdits', vscode.ConfigurationTarget.Workspace);
        Logger.info('Claude Code initialPermissionMode 已设置为 acceptEdits');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`设置 Claude Code initialPermissionMode 失败：${message}`);
    }
}

/**
 * 把当前 Relay 配置与当前模型写入 Claude Code settings.json。
 *
 * 内部对失败做兜底，避免任何写入异常打断扩展主流程。
 *
 * @param actualPort 可选实际监听端口；未提供时使用 relay.port。
 */
async function applySettingsSafely(actualPort?: number): Promise<void> {
    if (!configManager || !settingsWriter) return;
    try {
        const relay = configManager.getRelayConfig();
        const effective = typeof actualPort === 'number' ? { ...relay, port: actualPort } : relay;
        await settingsWriter.applyRelayConfig(effective, configManager.getCurrentModel());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`写入 Claude Code settings.json 失败：${message}`);
    }
}

/**
 * 当 RelayServer 实际监听到端口后，把端口持久化回写到 relay 配置。
 *
 * 仅在实际端口与持久化端口不同时执行写入，避免无意义的事件循环。
 *
 * @param actualPort 实际监听端口。
 */
async function persistActualPort(actualPort: number): Promise<void> {
    if (!configManager) return;
    const relay = configManager.getRelayConfig();
    if (relay.port === actualPort) return;
    try {
        await configManager.saveRelayConfig({ ...relay, port: actualPort });
        Logger.info(`Relay 实际端口已更新：${relay.port} -> ${actualPort}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`回写 Relay 实际端口失败：${message}`);
    }
}

/**
 * 构造点击 CC任务流 状态栏后写入剪贴板的默认文本。
 *
 * @returns 需要粘贴到 Claude Code 聊天框的任务流提示词。
 */
function buildTaskFlowPrompt(): string {
    return '@lls-task 请根据当前任务流继续推进：先检查未完成项，再给出下一步执行计划。';
}

/**
 * 打开 LLS CCAI 任务流统一菜单。
 *
 * 根据当前快照路由到：打开设置、粘贴启动占位提示、展示进度或清空已完成任务流。
 */
async function openLlsCcaiTaskMenu(): Promise<void> {
    if (!configManager || !llsTaskService) return;
    const texts = getLlsCcaiTaskTexts(configManager.getResolvedUiLanguage());
    const snapshot = llsTaskService.getSnapshot();
    if (snapshot.workflow && !llsTaskService.isWorkflowCompleted()) {
        await showLlsCcaiTaskProgress();
        return;
    }
    if (snapshot.workflow && llsTaskService.isWorkflowCompleted()) {
        const confirmed = await vscode.window.showInformationMessage(
            texts.completedTooltip,
            texts.clearAndNew,
            texts.cancel
        );
        if (confirmed === texts.clearAndNew) {
            autoContinueScheduler?.cancel('用户从任务流菜单清空已完成任务流');
            llsTaskService.clear();
        }
        return;
    }
    await pasteToClaudeCode(texts.startPrompt, { autoSubmit: false });
}

/**
 * 显示当前 LLS CCAI 任务流进度 QuickPick。
 */
async function showLlsCcaiTaskProgress(): Promise<void> {
    if (!llsTaskService) return;
    const workflow = llsTaskService.getSnapshot().workflow;
    if (!workflow) return;
    await vscode.window.showQuickPick(
        workflow.tasks.map((task, index) => ({
            label: `${index + 1}. ${getTaskStatusIcon(task)} ${task.title}`,
            description: task.status,
            detail: task.description
        })),
        { title: workflow.title, placeHolder: workflow.summary }
    );
}

/**
 * 手动继续推进当前 LLS CCAI 任务流。
 */
async function continueLlsCcaiTask(): Promise<void> {
    if (!llsTaskService) return;
    autoContinueScheduler?.cancel('用户手动继续任务流');
    await pasteToClaudeCode(llsTaskService.buildContinuePrompt(), { autoSubmit: true });
}

/**
 * 清空当前 LLS CCAI 任务流。
 */
function clearLlsCcaiTask(): void {
    autoContinueScheduler?.cancel('用户清空当前任务流');
    llsTaskService?.clear();
}

/**
 * 根据任务状态返回 QuickPick 图标。
 *
 * @param task 任务项。
 * @returns 状态图标。
 */
function getTaskStatusIcon(task: LlsTaskItem): string {
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

/**
 * 等待指定毫秒数。
 *
 * @param ms 等待时长，单位毫秒。
 * @returns 等待完成后的 Promise。
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把任务流提示词复制到剪贴板，聚焦 Claude Code 输入框，并自动执行粘贴。
 *
 * Claude Code 的输入框在 webview 内，VS Code 命令层没有发送入口，因此
 * 粘贴完成后改用「系统级模拟回车」来触发发送（macOS：osascript / AppleScript）。
 */
async function pasteTaskFlowToClaude(): Promise<void> {
    const prompt = buildTaskFlowPrompt();
    Logger.info('[TaskFlow] 写剪贴板，长度=' + prompt.length);
    await vscode.env.clipboard.writeText(prompt);

    Logger.info('[TaskFlow] 调用 claude-vscode.focus 聚焦输入框');
    try {
        await vscode.commands.executeCommand('claude-vscode.focus');
    } catch (err) {
        Logger.error('[TaskFlow] claude-vscode.focus 调用失败：' + asMessage(err));
    }

    await delay(500);

    Logger.info('[TaskFlow] 调用 editor.action.clipboardPasteAction 粘贴');
    try {
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    } catch (err) {
        Logger.error('[TaskFlow] 粘贴命令调用失败：' + asMessage(err));
    }

    // 等输入框完成粘贴渲染。
    await delay(300);

    // 用系统级模拟回车触发发送（webview 输入框 VS Code 命令层无法触发）。
    await simulateEnterKeyAtSystemLevel();
}

/**
 * 把错误对象转成字符串消息，便于日志输出。
 *
 * @param err 任意错误。
 */
function asMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * 在操作系统层面模拟一次回车按键，用于让 Claude Code 的 webview 输入框真正发送。
 *
 * - macOS：通过 `osascript` 调用 System Events 的 `key code 36`（Return）。
 *   首次执行需要在「系统设置 → 隐私与安全性 → 辅助功能」中授权 VS Code。
 * - Windows：通过 PowerShell 的 `System.Windows.Forms.SendKeys` 向前台窗口发送 `{ENTER}`，
 *   无需额外授权。
 * - 其它平台：暂不实现，仅写日志返回。
 */
async function simulateEnterKeyAtSystemLevel(): Promise<void> {
    if (process.platform === 'darwin') {
        await simulateEnterOnMac();
        return;
    }
    if (process.platform === 'win32') {
        await simulateEnterOnWindows();
        return;
    }
    Logger.info('[TaskFlow] 当前平台暂不支持系统级模拟回车，platform=' + process.platform);
}

/**
 * macOS 平台：使用 osascript 模拟一次回车键。
 *
 * 首次调用会触发系统辅助功能授权弹窗，授权后即可直接生效。
 */
async function simulateEnterOnMac(): Promise<void> {
    try {
        const { spawn } = await import('child_process');
        const script = 'tell application "System Events" to key code 36';
        Logger.info('[TaskFlow] macOS：调用 osascript 模拟回车 (key code 36)');
        await new Promise<void>((resolve, reject) => {
            const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error('osascript 退出码=' + code));
                }
            });
        });
        Logger.info('[TaskFlow] macOS：osascript 模拟回车完成');
    } catch (err) {
        Logger.error('[TaskFlow] macOS：系统级模拟回车失败：' + asMessage(err));
    }
}

/**
 * Windows 平台：使用 PowerShell SendKeys 模拟一次回车键。
 *
 * 通过加载 System.Windows.Forms 程序集后调用 `SendKeys::SendWait("{ENTER}")`，
 * 该方法把按键发送到当前前台窗口，无需额外授权。
 */
async function simulateEnterOnWindows(): Promise<void> {
    try {
        const { spawn } = await import('child_process');
        const script = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")';
        Logger.info('[TaskFlow] Windows：调用 PowerShell SendKeys 模拟回车 ({ENTER})');
        await new Promise<void>((resolve, reject) => {
            const child = spawn(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', script],
                { stdio: 'ignore', windowsHide: true }
            );
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error('powershell 退出码=' + code));
                }
            });
        });
        Logger.info('[TaskFlow] Windows：PowerShell SendKeys 模拟回车完成');
    } catch (err) {
        Logger.error('[TaskFlow] Windows：系统级模拟回车失败：' + asMessage(err));
    }
}

/**
 * 在 Claude Code 输入框中执行一次"测试模拟回车"流程。
 *
 * 用于在全局设置面板里验证当前平台是否能成功触发自动发送：
 * 1. 把测试文本写入剪贴板；
 * 2. 聚焦 Claude Code 输入框；
 * 3. 粘贴；
 * 4. 调用系统级模拟回车。
 *
 * 全过程不会修改任何用户配置；执行完成后会以信息提示提醒用户去 Claude Code 面板查看效果。
 */
async function runSimulateEnterTest(): Promise<void> {
    const testPrompt = 'CC任务流：模拟回车测试 (' + new Date().toISOString() + ')';
    Logger.info('[TaskFlow][Test] 开始模拟回车测试，文本=' + testPrompt);

    await vscode.env.clipboard.writeText(testPrompt);

    try {
        await vscode.commands.executeCommand('claude-vscode.focus');
    } catch (err) {
        Logger.error('[TaskFlow][Test] claude-vscode.focus 调用失败：' + asMessage(err));
    }

    await delay(500);

    try {
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    } catch (err) {
        Logger.error('[TaskFlow][Test] 粘贴命令调用失败：' + asMessage(err));
    }

    await delay(300);
    await simulateEnterKeyAtSystemLevel();

    await showSimulateEnterResultHint();
}

/**
 * 模拟回车测试结束后展示的弹窗文案集合，按 UI 语言取值。
 */
interface SimulateEnterHintTexts {
    /** macOS 平台提示信息（包含未自动发送时的引导）。 */
    macHint: string;
    /** macOS 平台弹窗上"打开辅助功能设置"按钮文字。 */
    macOpenAccessibilityButton: string;
    /** 其它平台（Windows / Linux）的通用提示信息。 */
    genericHint: string;
}

/**
 * 模拟回车测试弹窗文案字典，未补全语言回落英文。
 */
const SIMULATE_ENTER_HINT_TEXTS: Record<ResolvedAppLanguage, SimulateEnterHintTexts> = {
    en: {
        macHint: 'Simulated Enter test executed. If the message was not sent automatically, open "System Settings → Privacy & Security → Accessibility" and enable "Allow Visual Studio Code to control your computer", then try again.',
        macOpenAccessibilityButton: 'Open Accessibility Settings',
        genericHint: 'Simulated Enter test executed. Please check whether the Claude Code input box was sent automatically (see the "LLS CCAI" output channel for details).'
    },
    'zh-cn': {
        macHint: '已尝试"模拟回车"测试。如果未自动发送，请到「系统设置 → 隐私与安全性 → 辅助功能」中把 Visual Studio Code 的"允许控制电脑"权限打开后重试。',
        macOpenAccessibilityButton: '打开辅助功能设置',
        genericHint: '已尝试"模拟回车"测试，请查看 Claude Code 输入框是否已自动发送（若未发送，请检查输出面板「LLS CCAI」中的日志）。'
    },
    'zh-tw': {
        macHint: '已嘗試「模擬回車」測試。若未自動發送，請到「系統設定 → 隱私權與安全性 → 輔助使用」中啟用 Visual Studio Code 的「允許控制電腦」權限後重試。',
        macOpenAccessibilityButton: '開啟輔助使用設定',
        genericHint: '已嘗試「模擬回車」測試，請查看 Claude Code 輸入框是否已自動發送（若未發送，請檢查輸出面板「LLS CCAI」中的日誌）。'
    },
    ko: {
        macHint: '"엔터 키 시뮬레이션" 테스트를 실행했습니다. 자동으로 전송되지 않은 경우 "시스템 설정 → 개인 정보 보호 및 보안 → 손쉬운 사용"에서 Visual Studio Code의 "컴퓨터 제어 허용" 권한을 활성화한 후 다시 시도하세요.',
        macOpenAccessibilityButton: '손쉬운 사용 설정 열기',
        genericHint: '"엔터 키 시뮬레이션" 테스트를 실행했습니다. Claude Code 입력창이 자동으로 전송되었는지 확인하세요 (자세한 내용은 "LLS CCAI" 출력 채널 참조).'
    },
    ja: {
        macHint: '「Enter キーの模擬送信」テストを実行しました。自動送信されなかった場合は「システム設定 → プライバシーとセキュリティ → アクセシビリティ」で Visual Studio Code の「コンピュータの制御を許可」を有効にしてから再度お試しください。',
        macOpenAccessibilityButton: 'アクセシビリティ設定を開く',
        genericHint: '「Enter キーの模擬送信」テストを実行しました。Claude Code の入力欄が自動送信されたかご確認ください（詳細は出力パネル「LLS CCAI」をご覧ください）。'
    },
    fr: {
        macHint: 'Test "Entrée simulée" exécuté. Si le message n\'a pas été envoyé automatiquement, ouvrez « Réglages système → Confidentialité et sécurité → Accessibilité » et activez « Autoriser Visual Studio Code à contrôler votre ordinateur », puis réessayez.',
        macOpenAccessibilityButton: 'Ouvrir les réglages d\'accessibilité',
        genericHint: 'Test "Entrée simulée" exécuté. Vérifiez si la zone de saisie de Claude Code a été envoyée automatiquement (voir le canal de sortie « LLS CCAI » pour plus de détails).'
    },
    de: {
        macHint: 'Test "Simulierte Eingabetaste" ausgeführt. Wenn die Nachricht nicht automatisch gesendet wurde, öffnen Sie „Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen" und aktivieren Sie „Visual Studio Code darf den Computer steuern", und versuchen Sie es erneut.',
        macOpenAccessibilityButton: 'Bedienungshilfen-Einstellungen öffnen',
        genericHint: 'Test "Simulierte Eingabetaste" ausgeführt. Bitte prüfen Sie, ob das Claude-Code-Eingabefeld automatisch gesendet wurde (siehe Ausgabekanal „LLS CCAI" für Details).'
    }
};

/**
 * 根据当前 UI 语言读取模拟回车测试弹窗的本地化文案。
 *
 * 如果当前 configManager 还未就绪，或语言不在字典中，回落到英文。
 */
function getSimulateEnterHintTexts(): SimulateEnterHintTexts {
    const language: ResolvedAppLanguage = configManager?.getResolvedUiLanguage() ?? 'en';
    return SIMULATE_ENTER_HINT_TEXTS[language] ?? SIMULATE_ENTER_HINT_TEXTS.en;
}

/**
 * 在模拟回车测试结束后给出"未自动发送时如何处理"的提示。
 *
 * - macOS：提示用户去「系统设置 → 隐私与安全性 → 辅助功能」勾选 VS Code，
 *   并提供「打开辅助功能设置」按钮，点击后会用系统 URL 直接跳到该面板。
 * - Windows：无需授权，只给一句通用提示。
 * - 其它平台：只给一句通用提示。
 *
 * 所有提示文本会根据当前 UI 语言设置（claudeCodeConfigHelper.language）本地化。
 */
async function showSimulateEnterResultHint(): Promise<void> {
    const texts = getSimulateEnterHintTexts();

    if (process.platform === 'darwin') {
        const action = await vscode.window.showInformationMessage(
            texts.macHint,
            texts.macOpenAccessibilityButton
        );
        if (action === texts.macOpenAccessibilityButton) {
            try {
                await vscode.env.openExternal(
                    vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
                );
            } catch (err) {
                Logger.error('[TaskFlow][Test] 打开辅助功能设置失败：' + asMessage(err));
            }
        }
        return;
    }

    void vscode.window.showInformationMessage(texts.genericHint);
}

/**
 * VS Code 扩展激活函数。
 *
 * 激活后会初始化设置页、状态栏、本地 HTTP 中转服务、settings.json 写入闭环与命令入口。
 *
 * @param context 扩展上下文，由 VS Code 注入。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    Logger.init(context);
    Logger.info('LLS CCAI 已激活');
    await applyClaudeCodeInitialPermissionMode();
    configManager = new ConfigManager(context);
    llsTaskService = new LlsTaskService(configManager);
    autoContinueScheduler = new AutoContinueScheduler(llsTaskService);
    configViewProvider = new ConfigWebviewViewProvider(context, configManager);
    relayStatusBar = new RelayStatusBar();
    taskFlowStatusBar = new TaskFlowStatusBar(configManager, llsTaskService);
    settingsWriter = new SettingsWriter();
    const relay = configManager.getRelayConfig();
    relayServer = new RelayServer({ desiredPort: relay.port });
    const debugRecorder = new DebugRecorder();
    relayServer.setHandler(
        createRelayRouter({
            configManager,
            llsTaskService,
            autoContinueScheduler,
            adapters: [
                new AnthropicProxyAdapter(debugRecorder, {
                    configManager,
                    llsTaskService,
                    autoContinueScheduler
                }),
                new OpenAIChatProxyAdapter(debugRecorder, {
                    configManager,
                    llsTaskService,
                    autoContinueScheduler
                }),
                new OpenAIResponsesProxyAdapter(debugRecorder, {
                    configManager,
                    llsTaskService,
                    autoContinueScheduler
                })
            ]
        })
    );

    context.subscriptions.push(configManager);
    context.subscriptions.push(llsTaskService);
    context.subscriptions.push(relayStatusBar);
    context.subscriptions.push(taskFlowStatusBar);
    context.subscriptions.push(relayServer);
    context.subscriptions.push(
        configViewProvider,
        vscode.window.registerWebviewViewProvider(PROVIDERS_VIEW_ID, configViewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Relay 状态变化：刷新状态栏，必要时回写实际端口并写入 settings.json。
    context.subscriptions.push(
        relayServer.onStatusChange((status) => {
            currentRelayStatus = status;
            refreshStatusBar();
            configViewProvider?.notifyRelayStatus(status, relayServer?.getActualPort());
            if (status.kind === 'leader') {
                void persistActualPort(status.port).then(() => applySettingsSafely(status.port));
            } else if (status.kind === 'stopped') {
                void applySettingsSafely();
            }
        })
    );

    // ConfigManager 变化：刷新状态栏，并把最新 relay/currentModel 写入 settings.json。
    context.subscriptions.push(
        configManager.onDidChange(() => {
            refreshStatusBar();
            configViewProvider?.notifyRelayStatus(currentRelayStatus, relayServer?.getActualPort());
            void applySettingsSafely(relayServer?.getActualPort());
        })
    );

    // LLS CCAI 独立 UI 语言配置变化：通知配置页刷新，不读取或写入 openapicopilot.language。
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('claudeCodeConfigHelper.language')) {
                configManager?.notifyChanged();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.openConfigPanel, async () => {
            await configViewProvider?.focus();
        }),
        vscode.commands.registerCommand(COMMANDS.openSettingsJson, async () => {
            await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }),
        vscode.commands.registerCommand(COMMANDS.openGlobalSharedSettings, () => {
            if (!configManager) return;
            SharedOpenApiCopilotSettingsPanel.show(context, configManager, 'global');
        }),
        vscode.commands.registerCommand(COMMANDS.openWorkspaceSharedSettings, () => {
            if (!configManager) return;
            SharedOpenApiCopilotSettingsPanel.show(context, configManager, 'workspace');
        }),
        vscode.commands.registerCommand(COMMANDS.reloadWindow, async () => {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }),
        vscode.commands.registerCommand(COMMANDS.refreshProviders, () => undefined),
        vscode.commands.registerCommand(COMMANDS.newProvider, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.editProviderItem, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.deleteProviderItem, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.setCurrentModel, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.clearCurrentModel, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.restartRelay, async () => {
            if (!relayServer || !configManager) return;
            try {
                const desired = configManager.getRelayConfig().port;
                const actual = await relayServer.restart(desired);
                await vscode.window.showInformationMessage(`本地中转服务已重启：127.0.0.1:${actual}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await vscode.window.showErrorMessage(`本地中转服务重启失败：${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.pasteTaskFlowToClaude, async () => {
            try {
                await pasteTaskFlowToClaude();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await vscode.window.showErrorMessage(`粘贴任务流到 Claude Code 失败：${message}`);
            }
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
            try {
                await runSimulateEnterTest();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await vscode.window.showErrorMessage(`模拟回车测试失败：${message}`);
            }
        }),
        vscode.commands.registerCommand(COMMANDS.exportConfig, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel)),
        vscode.commands.registerCommand(COMMANDS.importConfig, () => vscode.commands.executeCommand(COMMANDS.openConfigPanel))
    );

    // 首次刷新状态栏，保证启动时即显示初始状态。
    refreshStatusBar();

    // 按 autoStart 决定是否立刻启动本地中转服务。
    if (relay.autoStart) {
        void relayServer.start().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Relay 自动启动失败：${message}`);
        });
    }
}

/**
 * VS Code 扩展停用函数。
 *
 * 第二阶段需要释放：Relay 服务、状态栏、Webview Provider 与 ConfigManager。
 */
export function deactivate(): void {
    autoContinueScheduler?.cancel('扩展停用');
    autoContinueScheduler = undefined;
    configViewProvider?.dispose();
    configViewProvider = undefined;
    relayStatusBar?.dispose();
    relayStatusBar = undefined;
    taskFlowStatusBar?.dispose();
    taskFlowStatusBar = undefined;
    llsTaskService?.dispose();
    llsTaskService = undefined;
    try {
        void relayServer?.stop();
    } catch {
        // ignore
    }
    relayServer?.dispose();
    relayServer = undefined;
    configManager?.dispose();
    configManager = undefined;
    settingsWriter = undefined;
}
