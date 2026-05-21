/** @file Claude Code 输入框粘贴与系统级自动提交能力。 */

import * as vscode from 'vscode';

import { Logger } from '../logger';

/** 粘贴到 Claude Code 时的行为选项。 */
export interface PasteToClaudeCodeOptions {
    /** 是否在粘贴后模拟系统级回车自动发送。 */
    autoSubmit?: boolean;
}

/**
 * 等待指定毫秒数。
 *
 * @param ms 等待时长，单位毫秒。
 * @returns 等待结束 Promise。
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把错误对象转成日志友好的字符串。
 *
 * @param err 任意错误对象。
 * @returns 错误消息字符串。
 */
function asMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * 把提示词复制到剪贴板并粘贴到 Claude Code 输入框。
 *
 * 流程固定为：写剪贴板 → `claude-vscode.focus` → delay(500) →
 * `editor.action.clipboardPasteAction` → delay(300) → 可选系统级回车。
 *
 * @param prompt 要写入 Claude Code 输入框的提示词。
 * @param options 粘贴行为选项。
 */
export async function pasteToClaudeCode(
    prompt: string,
    options: PasteToClaudeCodeOptions = {}
): Promise<void> {
    Logger.info(`[LlsTask][Paster] 写剪贴板，长度=${prompt.length}`);
    await vscode.env.clipboard.writeText(prompt);

    try {
        await vscode.commands.executeCommand('claude-vscode.focus');
    } catch (err) {
        Logger.error('[LlsTask][Paster] claude-vscode.focus 调用失败：' + asMessage(err));
    }

    await delay(500);

    try {
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    } catch (err) {
        Logger.error('[LlsTask][Paster] 粘贴命令调用失败：' + asMessage(err));
    }

    await delay(300);
    if (options.autoSubmit) {
        await simulateEnterKeyAtSystemLevel();
    }
}

/**
 * 在操作系统层面模拟一次回车按键。
 *
 * macOS 使用 osascript；Windows 使用 PowerShell SendKeys；其它平台仅写日志。
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
    Logger.info('[LlsTask][Paster] 当前平台暂不支持系统级模拟回车，platform=' + process.platform);
}

/**
 * macOS 平台使用 osascript 模拟一次 Return 键。
 */
export async function simulateEnterOnMac(): Promise<void> {
    try {
        const { spawn } = await import('child_process');
        await new Promise<void>((resolve, reject) => {
            const child = spawn('osascript', ['-e', 'tell application "System Events" to key code 36'], {
                stdio: 'ignore'
            });
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error('osascript 退出码=' + code));
            });
        });
    } catch (err) {
        Logger.error('[LlsTask][Paster] macOS 模拟回车失败：' + asMessage(err));
    }
}

/**
 * Windows 平台使用 PowerShell SendKeys 模拟一次 Enter 键。
 */
export async function simulateEnterOnWindows(): Promise<void> {
    try {
        const { spawn } = await import('child_process');
        const script = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")';
        await new Promise<void>((resolve, reject) => {
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                stdio: 'ignore',
                windowsHide: true
            });
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error('powershell 退出码=' + code));
            });
        });
    } catch (err) {
        Logger.error('[LlsTask][Paster] Windows 模拟回车失败：' + asMessage(err));
    }
}
