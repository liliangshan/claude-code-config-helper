/** @file One-shot setup reset requests for extension-development onboarding tests. */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SETUP_KEY, SETUP_COMPLETE_KEY } from './state';
import { Logger } from '../logger';

export const SETUP_RESET_REQUEST = 'setup-reset-request.json';

/**
 * Consume an explicitly prepared reset request before views or CLI runtimes read cached installation state.
 * Only a development host for the named workspace may consume it; all unrelated configuration is preserved.
 * @param context The current extension host's real state and storage APIs.
 */
export async function applyPendingSetupReset(context: vscode.ExtensionContext): Promise<void> {
    if (context.extensionMode !== vscode.ExtensionMode.Development) return;
    const file = path.join(context.globalStorageUri.fsPath, SETUP_RESET_REQUEST);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try { stat = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid setup reset request');
    const request = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: unknown; workspaceFolder?: unknown };
    if (request.version !== 1 || typeof request.workspaceFolder !== 'string' || !path.isAbsolute(request.workspaceFolder)) {
        throw new Error('Invalid setup reset request');
    }
    const target = await fs.realpath(request.workspaceFolder);
    const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => fs.realpath(folder.uri.fsPath)));
    if (!roots.includes(target)) return;
    await context.globalState.update(SETUP_COMPLETE_KEY, undefined);
    await context.globalState.update(SETUP_KEY, undefined);
    await fs.unlink(file);
    Logger.info('[setup/reset] 已应用调试工作区的一次性安装状态重置，接下来自动进入引导。');
}
