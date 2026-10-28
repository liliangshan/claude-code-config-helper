/** @file Left parallel-session entry points, with legacy editor implementation retained for later use. */
import * as vscode from 'vscode';
import type { ConfigManager } from '../configManager';
import { EditorChatManager } from './manager';
import { LeftChatView } from './leftView';
let instance: EditorChatManager | undefined;
let leftView: LeftChatView | undefined;

/** Register direct left-chat actions while retaining editor serialization and hidden legacy commands. */
export function configureEditorChat(context: vscode.ExtensionContext, manager: ConfigManager): void {
    instance = new EditorChatManager(context, manager);
    leftView = new LeftChatView(context, manager);
    context.subscriptions.push(leftView);
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('claudeRouter.editorChat', {
        /** Rebind an existing editor tab without deleting its implementation or saved history. */
        deserializeWebviewPanel: async (panel, state) => { await instance?.restore(panel, state ?? {}); }
    }));
    for (const [command, list] of [['claudeRouter.chat.newEditorSession', false], ['claudeRouter.chat.openEditorHistory', true]] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
            try { await instance?.open(list); } catch (error) { await vscode.window.showErrorMessage(String(error)); }
        }));
    }
    context.subscriptions.push(vscode.commands.registerCommand('claudeRouter.chat.openParallelSessions', async () => {
        try { await leftView?.showConversation(); } catch (error) { await vscode.window.showErrorMessage(String(error)); }
    }));
    for (const action of ['rename', 'restart'] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(`claudeRouter.chat.left.${action}`, async () => {
            try { await leftView?.runToolbarAction(action); } catch (error) { await vscode.window.showErrorMessage(String(error)); }
        }));
    }
}

/** Return the independent left presentation without exposing its CLI to the main runtime. */
export function getLeftChatView(): LeftChatView | undefined { return leftView; }

/** Prepare left and preserved editor runtimes together during a confirmed all-session CLI update. */
export async function prepareEditorCliUpdate(): Promise<{ resume: (path: string) => Promise<string[]>; errors: string[] }> {
    const preparations = await Promise.all([
        instance?.prepareCliUpdate() ?? Promise.resolve({ errors: [], resume: async () => [] as string[] }),
        leftView?.session.prepareCliUpdate() ?? Promise.resolve({ errors: [], resume: async () => [] as string[] })
    ]);
    return { errors: preparations.flatMap(item => item.errors), resume: async path => (await Promise.all(preparations.map(item => item.resume(path)))).flat() };
}

/** Await independent left and editor-owned shutdown without touching the main-chat process. */
export async function shutdownEditorChat(): Promise<void> {
    const results = await Promise.allSettled([instance?.shutdown(), leftView?.session.shutdown()]);
    leftView?.dispose(); instance = undefined; leftView = undefined;
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
}

/** Prevent the main chat from resuming a history already owned by the left conversation or an editor. */
export async function isEditorCliSessionOwned(sessionId: string): Promise<boolean> {
    const { EditorConversationStore } = await import('./store');
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const entries = await EditorConversationStore.list(folder.uri.fsPath);
        if (entries.some(entry => entry.occupied && entry.conversation?.cliSessionId === sessionId)) return true;
    }
    return false;
}
