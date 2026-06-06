/** @file Claude Code 檔案工具呼叫後自動在 VS Code 編輯器開啟目標檔案。 */

import * as path from 'path';
import * as vscode from 'vscode';

import { CONFIG_NAMESPACE } from './constants';
import { Logger } from './logger';

/** 自動開檔設定 key。 */
const EDITOR_AUTO_OPEN_READ_WRITE_FILES_KEY = 'editor.autoOpenReadWriteFiles';

/** 需要觀察並自動開檔的 Claude Code 工具名稱。 */
const FILE_OPEN_TOOL_NAMES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 寫入新檔後等待檔案落盤的重試次數。 */
const WRITE_NEW_FILE_RETRY_COUNT = 5;

/** 寫入新檔後等待檔案落盤的重試間隔。 */
const WRITE_NEW_FILE_RETRY_DELAY_MS = 120;

/** 可被自動開啟的檔案工具觀察事件。 */
export interface FileToolOpenEvent {
    /** Claude Code 工具名稱。 */
    toolName: string;
    /** 工具輸入中的 file_path 或 notebook_path。 */
    filePath: string;
}

/** 判斷工具名稱是否屬於需要自動開啟檔案的工具集合。 */
export function isFileOpenToolName(toolName: string): boolean {
    return FILE_OPEN_TOOL_NAMES.has(toolName);
}

/** 從 Claude Code 工具輸入物件萃取目標檔案路徑。 */
export function extractFilePathFromToolInput(toolName: string, input: unknown): string | undefined {
    if (!isFileOpenToolName(toolName) || !input || typeof input !== 'object') return undefined;
    const record = input as Record<string, unknown>;
    const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const value = record[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

/** 在 Claude Code 檔案工具使用後自動於 VS Code 編輯器開啟對應檔案。 */
export class EditorAutoOpener {
    /** 建立自動開檔器。 */
    public constructor(private readonly workspaceRootProvider: () => readonly vscode.WorkspaceFolder[] | undefined = () => vscode.workspace.workspaceFolders) {}

    /** 觀察 Claude Code 工具呼叫並在符合條件時開啟檔案。 */
    public async observeToolUse(event: FileToolOpenEvent): Promise<void> {
        if (!this.isEnabled()) return;
        if (!isFileOpenToolName(event.toolName)) return;
        const resolvedPath = this.resolveWorkspaceFilePath(event.filePath);
        if (!resolvedPath) return;
        if (this.isAlreadyVisible(resolvedPath)) return;
        await this.openFileWhenAvailable(resolvedPath, this.shouldRetryMissingFile(event.toolName));
    }

    /** 讀取使用者是否啟用自動開檔。 */
    private isEnabled(): boolean {
        return vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .get<boolean>(EDITOR_AUTO_OPEN_READ_WRITE_FILES_KEY, true);
    }

    /** 將工具輸入路徑解析為工作區內的絕對路徑。 */
    private resolveWorkspaceFilePath(filePath: string): string | undefined {
        const trimmed = filePath.trim();
        if (!trimmed) return undefined;
        const folders = this.workspaceRootProvider();
        if (!folders?.length) return undefined;
        const absolutePath = path.isAbsolute(trimmed)
            ? path.normalize(trimmed)
            : path.normalize(path.join(folders[0].uri.fsPath, trimmed));
        return folders.some((folder) => this.isPathInsideFolder(absolutePath, folder.uri.fsPath)) ? absolutePath : undefined;
    }

    /** 判斷檔案是否已在任一可見編輯器開啟。 */
    private isAlreadyVisible(filePath: string): boolean {
        const normalized = path.normalize(filePath);
        return vscode.window.visibleTextEditors.some((editor) => path.normalize(editor.document.uri.fsPath) === normalized);
    }

    /** 等待檔案可讀後以非預覽、不搶焦點方式開啟。 */
    private async openFileWhenAvailable(filePath: string, retryMissingFile: boolean): Promise<void> {
        const attempts = retryMissingFile ? WRITE_NEW_FILE_RETRY_COUNT : 1;
        for (let index = 0; index < attempts; index += 1) {
            try {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
                return;
            } catch (err) {
                if (index >= attempts - 1) {
                    Logger.warn(`自動開啟檔案失敗：path=${filePath}, err=${err instanceof Error ? err.message : String(err)}`);
                    return;
                }
                await this.delay(WRITE_NEW_FILE_RETRY_DELAY_MS);
            }
        }
    }

    /** 判斷指定工具是否可能需要等待新檔落盤。 */
    private shouldRetryMissingFile(toolName: string): boolean {
        return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit';
    }

    /** 判斷絕對檔案路徑是否位於指定工作區資料夾內。 */
    private isPathInsideFolder(filePath: string, folderPath: string): boolean {
        const relative = path.relative(path.normalize(folderPath), path.normalize(filePath));
        return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }

    /** 等待指定毫秒數。 */
    private async delay(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
}
