/** @file VS Code 診斷資料整理純函式。 */

/** VS Code 診斷嚴重性。 */
export type RawDiagSeverity = 'error' | 'warning' | 'information' | 'hint';

/** 原始診斷資料。 */
export interface RawDiag {
    /** 檔案絕對路徑。 */
    filePath: string;
    /** 診斷嚴重性。 */
    severity: RawDiagSeverity;
    /** 診斷訊息。 */
    message: string;
    /** 起始列，1-based。 */
    line: number;
    /** 起始欄，1-based。 */
    character: number;
    /** 診斷來源。 */
    source?: string;
    /** 診斷代碼。 */
    code?: string;
}

/** get_errors 工具回傳結果。 */
export interface GetErrorsResult {
    /** 摘要文字。 */
    summary: string;
    /** 是否因數量過多被截斷。 */
    truncated: boolean;
    /** 總診斷數量。 */
    total: number;
    /** 錯誤數量。 */
    errors: number;
    /** 警告數量。 */
    warnings: number;
    /** 已回傳的診斷明細。 */
    diagnostics: RawDiag[];
}

/** get_errors 選項。 */
export interface GetErrorsOptions {
    /** 指定要保留的絕對或工作區相對檔案路徑。 */
    filePaths?: readonly string[];
    /** 工作區根目錄，用於相對路徑過濾。 */
    workspaceRoot?: string;
    /** 最大回傳診斷數。 */
    limit?: number;
}

/** 預設最大回傳診斷數。 */
const DEFAULT_DIAGNOSTIC_LIMIT = 10;

/** 嚴重性排序權重。 */
const SEVERITY_ORDER: Record<RawDiagSeverity, number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3
};

/** 建立空集合 get_errors 結果。 */
export function emptyErrorResult(): GetErrorsResult {
    return {
        summary: 'No VS Code diagnostics found.',
        truncated: false,
        total: 0,
        errors: 0,
        warnings: 0,
        diagnostics: []
    };
}

/** 依過濾、排序與截斷規則整理 VS Code 診斷結果。 */
export function buildGetErrorsResult(rawDiagnostics: readonly RawDiag[], options: GetErrorsOptions = {}): GetErrorsResult {
    const limit = Number.isFinite(options.limit) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : DEFAULT_DIAGNOSTIC_LIMIT;
    const filters = normalizeFileFilters(options.filePaths, options.workspaceRoot);
    const filtered = filters.size > 0
        ? rawDiagnostics.filter((diag) => filters.has(normalizePath(diag.filePath)) || filters.has(normalizeWorkspacePath(diag.filePath, options.workspaceRoot)))
        : [...rawDiagnostics];
    const sorted = filtered.sort(compareDiagnostics);
    const diagnostics = sorted.slice(0, limit);
    const errors = filtered.filter((diag) => diag.severity === 'error').length;
    const warnings = filtered.filter((diag) => diag.severity === 'warning').length;
    const truncated = filtered.length > diagnostics.length;
    if (filtered.length === 0) return emptyErrorResult();
    return {
        summary: buildSummary(filtered.length, errors, warnings, truncated, diagnostics.length),
        truncated,
        total: filtered.length,
        errors,
        warnings,
        diagnostics
    };
}

/** 建立診斷摘要文字。 */
function buildSummary(total: number, errors: number, warnings: number, truncated: boolean, returned: number): string {
    const base = `Found ${total} VS Code diagnostic${total === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}).`;
    return truncated ? `${base} Showing first ${returned}.` : base;
}

/** 比較兩筆診斷的顯示順序。 */
function compareDiagnostics(a: RawDiag, b: RawDiag): number {
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        || a.filePath.localeCompare(b.filePath)
        || a.line - b.line
        || a.character - b.character
        || a.message.localeCompare(b.message);
}

/** 正規化檔案過濾集合。 */
function normalizeFileFilters(filePaths: readonly string[] | undefined, workspaceRoot: string | undefined): Set<string> {
    const filters = new Set<string>();
    for (const filePath of filePaths ?? []) {
        const trimmed = filePath.trim();
        if (!trimmed) continue;
        filters.add(normalizePath(trimmed));
        if (workspaceRoot) filters.add(normalizeWorkspacePath(trimmed, workspaceRoot));
    }
    return filters;
}

/** 正規化路徑分隔符與末尾斜線。 */
function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 正規化為工作區相對路徑。 */
function normalizeWorkspacePath(filePath: string, workspaceRoot: string | undefined): string {
    if (!workspaceRoot) return normalizePath(filePath);
    const normalizedFile = normalizePath(filePath);
    const normalizedRoot = normalizePath(workspaceRoot);
    if (normalizedFile === normalizedRoot) return '';
    return normalizedFile.startsWith(`${normalizedRoot}/`) ? normalizedFile.slice(normalizedRoot.length + 1) : normalizedFile;
}
