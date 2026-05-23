/**
 * @file VS Code 诊断收集模块。
 *
 * 该模块封装了"读取 VS Code Problems 面板内容并整理成模型可消费 JSON"的
 * 全部逻辑，供 {@link executeGetDiagnosticsTool} 在拦截到 `get_llsccai_vscode_diagnostics`
 * 工具调用时本地执行使用。
 *
 * 设计参考自 liliangshan.openapi-compatible-copilot 项目 `provider.ts` 中
 * `_collectVscodeDiagnostics` 一系列函数，做了如下调整：
 *
 * - 拆成独立模块，避免与拦截器耦合；
 * - 全部改写为顶层函数，配合本仓库 LLS CCAI 任务流的"无类静态依赖"风格；
 * - 输出文本中带 BEGIN/END 标记，便于模型从拼接后的文本中精确切片。
 */

import * as vscode from 'vscode';

/**
 * 用户/续推提示词中"请在下一轮请求里注入 VS Code 诊断"的触发词。
 *
 * 该触发词由 Chat 发送链路识别：
 * 当用户最后一条消息文本中包含该词时，Chat 宿主会用 {@link executeGetDiagnosticsTool}
 * 实时读取诊断并替换/追加到该用户消息中，让模型直接看到 VS Code 错误数据。
 *
 * 当前两类触发来源：
 *
 * - 模型主动调用 `get_llsccai_vscode_diagnostics` 工具 → 拦截器伪造 ACK
 *   响应 → {@link "./autoContinue".AutoContinueScheduler} 续推时把该触发词粘贴回输入框；
 * - 用户在 Claude Code CLI 中手动输入该触发词。
 */
export const GET_DIAGNOSTICS_TRIGGER_TOKEN = '@llsccai-get-errors';

/** 每次 `get_llsccai_vscode_diagnostics` 工具调用最多返回的诊断条数。 */
export const MAX_GET_DIAGNOSTICS_ITEMS = 10;

/** 工具输入参数。 */
export interface GetDiagnosticsArguments {
    /**
     * 可选的文件或目录路径过滤列表。
     *
     * - 为空或未提供：返回 VS Code 当前所有已知诊断。
     * - 含具体路径：仅返回这些路径对应的诊断；既匹配文件，也匹配目录前缀。
     */
    filePaths?: string[];
}

/** 单条诊断序列化结构。 */
export interface VscodeDiagnosticItem {
    /** VS Code 资源 URI 文本形式。 */
    uri: string;
    /** 文件系统路径；非文件 URI 时回退为 URI 文本。 */
    filePath: string;
    /** 严重级别。 */
    severity: 'error' | 'warning' | 'information' | 'hint' | 'unknown';
    /** 诊断信息。 */
    message: string;
    /** 来源工具名，如 ts、eslint。 */
    source?: string;
    /** 诊断 code，可能是字符串或对象 code。 */
    code?: string;
    /** 诊断位置范围，行列均为 1 基。 */
    range: {
        /** 起始行（1 基）。 */
        startLine: number;
        /** 起始列（1 基）。 */
        startCharacter: number;
        /** 结束行（1 基）。 */
        endLine: number;
        /** 结束列（1 基）。 */
        endCharacter: number;
    };
}

/** 工具结果汇总结构。 */
export interface GetDiagnosticsToolResult {
    /** 执行成功标记。 */
    ok: boolean;
    /** 数据来源标识。 */
    source: 'vscode.languages.getDiagnostics';
    /** 按严重级别分类汇总。 */
    summary: {
        /** 匹配到的诊断总数（未截断前）。 */
        total: number;
        /** error 级别数。 */
        errors: number;
        /** warning 级别数。 */
        warnings: number;
        /** information 级别数。 */
        information: number;
        /** hint 级别数。 */
        hints: number;
    };
    /** 截断后的诊断列表。 */
    diagnostics: VscodeDiagnosticItem[];
    /** 人类可读总结，可直接展示给模型。 */
    message: string;
    /** 是否因为超过 {@link MAX_GET_DIAGNOSTICS_ITEMS} 而截断。 */
    truncated: boolean;
}

/**
 * 拦截器入口：本地执行 `get_llsccai_vscode_diagnostics` 工具。
 *
 * 该函数把任意类型的工具输入规范化后调用 {@link collectVscodeDiagnostics}，
 * 异常时返回带 `ok=false` 的结果而不是抛出，保证拦截器永远能给模型一个
 * 完整 JSON 反馈。
 *
 * @param input 任意形态的工具输入；典型为 `{ filePaths?: string[] }`。
 * @returns 序列化后的工具结果 JSON 字符串。
 */
export function executeGetDiagnosticsTool(input: unknown): string {
    try {
        const args = normalizeGetDiagnosticsArguments(input);
        return JSON.stringify(collectVscodeDiagnostics(args));
    } catch (error) {
        const fallback: GetDiagnosticsToolResult = {
            ok: false,
            source: 'vscode.languages.getDiagnostics',
            summary: { total: 0, errors: 0, warnings: 0, information: 0, hints: 0 },
            diagnostics: [],
            message: error instanceof Error ? error.message : '读取 VS Code 问题面板失败',
            truncated: false
        };
        return JSON.stringify(fallback);
    }
}

/**
 * 把任意形态的工具输入规范化为 {@link GetDiagnosticsArguments}。
 *
 * - 字符串输入会先尝试 JSON 解析，解析失败时按空对象处理；
 * - 仅保留 `filePaths` 中确实是非空字符串的项；
 * - 缺省时 `filePaths` 为 undefined，等价于"不过滤"。
 *
 * @param input 工具调用 input 字段。
 * @returns 规范化后的参数对象。
 */
export function normalizeGetDiagnosticsArguments(input: unknown): GetDiagnosticsArguments {
    let candidate: unknown = input;
    if (typeof candidate === 'string') {
        try {
            candidate = JSON.parse(candidate);
        } catch {
            candidate = {};
        }
    }
    const filePathsRaw = (candidate as { filePaths?: unknown })?.filePaths;
    const filePaths = Array.isArray(filePathsRaw)
        ? filePathsRaw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : undefined;
    return { filePaths };
}

/**
 * 读取 VS Code 诊断并按 {@link GetDiagnosticsToolResult} 结构返回。
 *
 * 工作流程：
 * 1. 遍历 {@link vscode.languages.getDiagnostics};
 * 2. 按 `args.filePaths` 过滤（{@link matchesGetDiagnosticsFilePaths}）；
 * 3. 全部条目按 error→warning→information→hint→unknown 排序，同级别按文件+行列；
 * 4. 截断到 {@link MAX_GET_DIAGNOSTICS_ITEMS}；
 * 5. 生成 summary 与 message 文本。
 *
 * @param args 已规范化的参数。
 * @returns 工具结果。
 */
export function collectVscodeDiagnostics(args: GetDiagnosticsArguments): GetDiagnosticsToolResult {
    const items: VscodeDiagnosticItem[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (!matchesGetDiagnosticsFilePaths(uri, args.filePaths)) continue;
        for (const diagnostic of diagnostics) {
            items.push(toVscodeDiagnosticItem(uri, diagnostic));
        }
    }
    items.sort(compareVscodeDiagnosticItems);
    const summary = buildGetDiagnosticsSummary(items);
    const truncated = items.length > MAX_GET_DIAGNOSTICS_ITEMS;
    const visibleItems = items.slice(0, MAX_GET_DIAGNOSTICS_ITEMS);
    const message = items.length === 0
        ? '当前 VS Code 问题面板没有匹配的诊断信息。'
        : truncated
            ? `当前 VS Code 问题面板共有 ${items.length} 条匹配诊断，已返回前 ${MAX_GET_DIAGNOSTICS_ITEMS} 条。`
            : `当前 VS Code 问题面板共有 ${items.length} 条匹配诊断。`;
    return {
        ok: true,
        source: 'vscode.languages.getDiagnostics',
        summary,
        diagnostics: visibleItems,
        message,
        truncated
    };
}

/**
 * 判断诊断所属 URI 是否命中调用方提供的过滤路径。
 *
 * 命中规则（任一即可）：
 * - URI 规范化路径与目标完全相等；
 * - URI 路径以 `/目标` 结尾（按文件名 + 父目录匹配）；
 * - URI 路径以 `目标/` 为前缀（目录前缀匹配）。
 *
 * 当 `filePaths` 为空或未提供时返回 true，等价于"不过滤"。
 *
 * @param uri 诊断条目所属的 VS Code URI。
 * @param filePaths 调用方提供的过滤路径列表，可缺省。
 * @returns 命中过滤条件时返回 true。
 */
export function matchesGetDiagnosticsFilePaths(uri: vscode.Uri, filePaths?: string[]): boolean {
    if (!filePaths || filePaths.length === 0) return true;
    const candidates = [
        uri.fsPath || '',
        uri.toString(),
        vscode.workspace.asRelativePath(uri, false)
    ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => normalizeDiagnosticPath(value));
    return filePaths.some((filePath) => {
        const target = normalizeDiagnosticPath(filePath.trim());
        if (!target) return false;
        const directoryTarget = target.endsWith('/') ? target : `${target}/`;
        return candidates.some((candidate) =>
            candidate === target
            || candidate.endsWith(`/${target}`)
            || candidate.startsWith(directoryTarget));
    });
}

/**
 * 规范化诊断路径文本，便于 {@link matchesGetDiagnosticsFilePaths} 比较。
 *
 * 处理项：
 * - 反斜杠统一替换为正斜杠；
 * - 去除起始的 `./`；
 * - 尝试 URI 解码以兼容 `%20` 之类的转义形式。
 *
 * @param value 原始路径文本。
 * @returns 规范化后的路径文本。
 */
function normalizeDiagnosticPath(value: string): string {
    let normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
    try {
        normalized = decodeURI(normalized);
    } catch {
        // URI 解码失败时保留先前的规范化结果。
    }
    return normalized;
}

/**
 * 把单个 {@link vscode.Diagnostic} 转换为可序列化的 {@link VscodeDiagnosticItem}。
 *
 * 行列号统一从 0 基转为 1 基，方便模型在文本中直接复述。
 *
 * @param uri 诊断所属 URI。
 * @param diagnostic VS Code 诊断对象。
 * @returns 序列化条目。
 */
function toVscodeDiagnosticItem(uri: vscode.Uri, diagnostic: vscode.Diagnostic): VscodeDiagnosticItem {
    return {
        uri: uri.toString(),
        filePath: uri.fsPath || uri.toString(),
        severity: toSeverityText(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code: normalizeDiagnosticCode(diagnostic.code),
        range: {
            startLine: diagnostic.range.start.line + 1,
            startCharacter: diagnostic.range.start.character + 1,
            endLine: diagnostic.range.end.line + 1,
            endCharacter: diagnostic.range.end.character + 1
        }
    };
}

/**
 * 把 VS Code 严重级别枚举映射为字符串。
 *
 * @param severity VS Code 严重级别。
 * @returns 字符串形式的严重级别。
 */
function toSeverityText(severity: vscode.DiagnosticSeverity): VscodeDiagnosticItem['severity'] {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'information';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return 'unknown';
    }
}

/**
 * 规范化 {@link vscode.Diagnostic.code} 字段为字符串。
 *
 * VS Code 的 code 字段可以是字符串、数字或 `{value, target}` 对象，这里
 * 统一拍平成字符串供模型消费。
 *
 * @param code 原始 code 字段。
 * @returns 字符串形式的 code，缺失时返回 undefined。
 */
function normalizeDiagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
    if (code === undefined || code === null) return undefined;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
    if (typeof code === 'object' && 'value' in code) {
        const inner = (code as { value: string | number }).value;
        return inner === undefined || inner === null ? undefined : String(inner);
    }
    return undefined;
}

/**
 * 诊断条目排序比较函数。
 *
 * 排序优先级：
 * 1. 严重级别（error → warning → information → hint → unknown）；
 * 2. 同级别按文件路径字典序；
 * 3. 同文件按起始行；
 * 4. 同行按起始列。
 *
 * @param a 左侧条目。
 * @param b 右侧条目。
 * @returns 排序比较值。
 */
function compareVscodeDiagnosticItems(a: VscodeDiagnosticItem, b: VscodeDiagnosticItem): number {
    const severityOrder: Record<VscodeDiagnosticItem['severity'], number> = {
        error: 0,
        warning: 1,
        information: 2,
        hint: 3,
        unknown: 4
    };
    const sa = severityOrder[a.severity];
    const sb = severityOrder[b.severity];
    if (sa !== sb) return sa - sb;
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
    return a.range.startCharacter - b.range.startCharacter;
}

/**
 * 按级别统计 summary。
 *
 * @param items 诊断列表（未截断）。
 * @returns summary 结构。
 */
function buildGetDiagnosticsSummary(items: VscodeDiagnosticItem[]): GetDiagnosticsToolResult['summary'] {
    const summary = { total: items.length, errors: 0, warnings: 0, information: 0, hints: 0 };
    for (const item of items) {
        if (item.severity === 'error') summary.errors += 1;
        else if (item.severity === 'warning') summary.warnings += 1;
        else if (item.severity === 'information') summary.information += 1;
        else if (item.severity === 'hint') summary.hints += 1;
    }
    return summary;
}

/**
 * 把工具结果包装为"模型在响应里看到的 ACK 文本"。
 *
 * 注意：拦截器不会把诊断 JSON 塞进响应——只塞一段简短 ACK 告诉模型
 * "诊断请求已收到，Chat 宿主将在下一轮请求里把诊断数据作为用户消息提供"。
 * 这样模型在下一轮看到的是"用户提供的最新 VS Code 错误"，而不是"上一轮
 * 自己说出来的过期 JSON"，心智模型与续推时序都更符合 Anthropic 协议直觉。
 *
 * `resultJson` 仅用于排查问题，不会被写回响应文本。
 *
 * @param resultJson 通过 {@link executeGetDiagnosticsTool} 得到的 JSON 文本，
 *   保留参数以兼容旧调用方；当前实现中仅用于日志。
 * @returns 写入响应 text block 的完整 ACK 文本。
 */
export function formatGetDiagnosticsToolMessage(resultJson: string): string {
    void resultJson;
    return [
        `[${LLS_CCAI_GET_DIAGNOSTICS_TOOL_LABEL}] tool call accepted.`,
        `The chat host will read the current VS Code Problems panel and inject the diagnostics as a user message in the next turn (via the ${GET_DIAGNOSTICS_TRIGGER_TOKEN} trigger).`,
        'Please wait for the next turn to receive the actual diagnostics, then continue fixing the highest-severity entries first.'
    ].join('\n');
}

/**
 * 把工具结果包装为"下一轮请求里要追加给模型的用户消息"。
 *
 * 输出文本用 BEGIN/END 标记把 JSON 包起来，便于模型在多轮历史中也能稳定识别
 * 诊断数据块。该函数由 Chat 发送链路在识别到
 * {@link GET_DIAGNOSTICS_TRIGGER_TOKEN} 时调用。
 *
 * @param resultJson 通过 {@link executeGetDiagnosticsTool} 得到的 JSON 文本。
 * @returns 注入到 user 消息末尾的文本块内容。
 */
export function formatGetDiagnosticsInjectionBlock(resultJson: string): string {
    return [
        `[${LLS_CCAI_GET_DIAGNOSTICS_TOOL_LABEL}] live diagnostics from VS Code Problems panel (BEGIN)`,
        resultJson,
        `[${LLS_CCAI_GET_DIAGNOSTICS_TOOL_LABEL}] live diagnostics from VS Code Problems panel (END)`,
        '',
        'These diagnostics were read just now from `vscode.languages.getDiagnostics()` and reflect the current workspace state.',
        'Please continue based on the diagnostics above. Prioritize fixing entries whose severity is "error".'
    ].join('\n');
}

/**
 * 该工具结果标签，用于 BEGIN/END 标记，便于模型在历史中稳定识别。
 *
 * 与工具名称同名以保持一致；如果未来工具名变化，集中改这里即可。
 */
const LLS_CCAI_GET_DIAGNOSTICS_TOOL_LABEL = 'get_llsccai_vscode_diagnostics';
