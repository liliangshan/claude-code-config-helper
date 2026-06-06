/** @file VS Code get_errors 宿主側執行器。 */

import * as vscode from 'vscode';

import { buildGetErrorsResult, emptyErrorResult, type RawDiag, type RawDiagSeverity } from './diagnostics';
import type { VscodeToolName } from './tools';

/** VS Code MCP 工具執行結果。 */
export interface VscodeToolResult {
    /** 是否為工具層錯誤。 */
    isError?: boolean;
    /** MCP text content 回傳內容。 */
    content: { type: 'text'; text: string }[];
}

/** VS Code MCP 工具執行器介面。 */
export interface VscodeToolExecutor {
    /** 執行指定 VS Code 工具。 */
    execute(name: VscodeToolName, args?: Record<string, unknown>): Promise<VscodeToolResult>;
}

/** 讀取 VS Code Problems 診斷的宿主側執行器。 */
export class DiagnosticsHost implements VscodeToolExecutor {
    /** 執行 get_errors 工具並回傳 JSON 文字結果。 */
    public async execute(name: VscodeToolName, args: Record<string, unknown> = {}): Promise<VscodeToolResult> {
        if (name !== 'get_errors') {
            return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }] };
        }
        try {
            const filePaths = Array.isArray(args.filePaths)
                ? args.filePaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                : undefined;
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const result = buildGetErrorsResult(collectDiagnostics(), { filePaths, workspaceRoot });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            const result = emptyErrorResult();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ...result,
                        summary: err instanceof Error ? err.message : String(err)
                    }, null, 2)
                }]
            };
        }
    }
}

/** 收集 VS Code 目前所有診斷。 */
function collectDiagnostics(): RawDiag[] {
    const diagnostics: RawDiag[] = [];
    for (const [uri, entries] of vscode.languages.getDiagnostics()) {
        for (const diag of entries) {
            diagnostics.push({
                filePath: uri.fsPath || uri.toString(),
                severity: toRawSeverity(diag.severity),
                message: diag.message,
                line: diag.range.start.line + 1,
                character: diag.range.start.character + 1,
                source: diag.source,
                code: normalizeCode(diag.code)
            });
        }
    }
    return diagnostics;
}

/** 將 VS Code 診斷嚴重性轉為 get_errors 嚴重性。 */
function toRawSeverity(severity: vscode.DiagnosticSeverity): RawDiagSeverity {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return 'error';
        case vscode.DiagnosticSeverity.Warning:
            return 'warning';
        case vscode.DiagnosticSeverity.Information:
            return 'information';
        case vscode.DiagnosticSeverity.Hint:
        default:
            return 'hint';
    }
}

/** 正規化 VS Code 診斷 code 欄位。 */
function normalizeCode(code: vscode.Diagnostic['code']): string | undefined {
    if (code === undefined || code === null) return undefined;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
    return String(code.value);
}
