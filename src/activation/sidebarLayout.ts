/** @file One-time migration to left settings and right main chat without resetting the workbench layout. */
import * as vscode from 'vscode';
import { CHAT_SECONDARY_CONTAINER_ID, CHAT_SECONDARY_VIEW_ID, PROVIDERS_VIEW_ID } from '../constants';
import { Logger } from '../logger';

const LAYOUT_KEY = 'claudeRouter.sidebarLayout.rightChat.v1';
let pending: Promise<void> | undefined;

/** Move only this extension's two views once per workspace; later user layout changes remain untouched. */
export async function restorePreferredSidebarLayout(context: vscode.ExtensionContext): Promise<void> {
    if (context.workspaceState.get<boolean>(LAYOUT_KEY) === true) return;
    if (pending) return pending;
    const action = migrateSidebarLayout(context); pending = action;
    try { await action; } finally { if (pending === action) pending = undefined; }
}

/** Use the host's verified view-move command and mark completion only after both moves succeed. */
async function migrateSidebarLayout(context: vscode.ExtensionContext): Promise<void> {
    try {
        const commands = await vscode.commands.getCommands(true);
        if (!commands.includes('vscode.moveViews')) return;
        await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [PROVIDERS_VIEW_ID], destinationId: 'claudeRouter' });
        await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [CHAT_SECONDARY_VIEW_ID], destinationId: CHAT_SECONDARY_CONTAINER_ID });
        await context.workspaceState.update(LAYOUT_KEY, true);
    } catch (error) {
        Logger.warn(`恢复左右侧栏布局失败，保留现有会话：${String(error)}`);
    }
}
