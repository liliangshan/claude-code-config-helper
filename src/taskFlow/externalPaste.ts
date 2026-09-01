/**
 * 外部 Claude Code 输入框旁路：剪贴板粘贴与系统级模拟回车。
 *
 * 拆分自 extension.ts：把「写剪贴板 → 聚焦 claude-vscode 输入框 → 粘贴 →
 * 系统级模拟回车发送」这条降级链路，连同 macOS/Windows 的模拟回车实现、
 * 模拟回车自测命令与其多语言提示文案收敛到一个模块。
 *
 * 依赖方向：本模块只依赖 taskFlow 命令层与 runtime，不被 chatRuntime 反向引用。
 */
import * as vscode from 'vscode';

import { Logger } from '../logger';
import { getConfigManager } from '../runtime';
import type { ResolvedAppLanguage } from '../types';
import { buildTaskFlowPrompt, sendTaskFlowPrompt } from './taskFlowCommands';

/**
 * 等待指定毫秒数。
 *
 * @param ms 等待时长，单位毫秒。
 * @returns 等待完成后的 Promise。
 */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把任务流提示词复制到剪贴板，聚焦 Claude Code 输入框，并自动执行粘贴。
 *
 * Claude Code 的输入框在 webview 内，VS Code 命令层没有发送入口，因此
 * 粘贴完成后改用「系统级模拟回车」来触发发送（macOS：osascript / AppleScript）。
 */
export async function pasteTaskFlowToClaude(): Promise<void> {
    const prompt = buildTaskFlowPrompt();
    await sendTaskFlowPrompt(prompt, { autoSubmit: true });
}

/**
 * 保留的外部 Claude Code 输入框旁路实现。
 *
 * 仅在 taskFlow.target=externalClaudeCode 或内置 Chat 不可用降级时使用。
 * 后续任务 11/稳定期再删除剪贴板、focus 和系统级回车依赖。
 */
export async function pasteTaskFlowToExternalClaudeCode(prompt: string): Promise<void> {
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
export function asMessage(err: unknown): string {
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
export async function simulateEnterKeyAtSystemLevel(): Promise<void> {
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
export async function simulateEnterOnMac(): Promise<void> {
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
export async function simulateEnterOnWindows(): Promise<void> {
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
export async function runSimulateEnterTest(): Promise<void> {
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
export interface SimulateEnterHintTexts {
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
export function getSimulateEnterHintTexts(): SimulateEnterHintTexts {
    const language: ResolvedAppLanguage = getConfigManager()?.getResolvedUiLanguage() ?? 'en';
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
export async function showSimulateEnterResultHint(): Promise<void> {
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
