/** @file LLS CCAI 任务流 Anthropic 工具定义与合并逻辑。 */

import { getLlsCcaiTaskTexts } from './messages';
import type { ResolvedAppLanguage } from '../types';
import type { LlsTaskWorkflow } from './types';

/** LLS CCAI 任务流状态回写工具名称。 */
export const LLS_CCAI_TASK_TOOL_NAME = 'update_llsccai_task_workflow';

/** LLS CCAI 任务流创建工具名称。 */
export const LLS_CCAI_TASK_CREATE_TOOL_NAME = 'create_llsccai_task_workflow';

/**
 * LLS CCAI 诊断读取工具名称。
 *
 * 该工具不属于任务流执行链路，而是一个通用的"模型主动读取 VS Code 问题面板"
 * 工具。命中后由拦截器本地调用 {@link "./diagnostics".executeGetDiagnosticsTool}
 * 执行，并把 tool_use 改写为 text block 直接返回给模型，模型在同一轮里看到诊断
 * 数据后继续推进。
 */
export const LLS_CCAI_GET_DIAGNOSTICS_TOOL_NAME = 'get_llsccai_vscode_diagnostics';

/** Anthropic 工具定义的最小结构。 */
export interface AnthropicToolDefinition {
    /** 工具名称。 */
    name: string;
    /** 工具说明。 */
    description?: string;
    /** Anthropic 工具输入 JSON Schema。 */
    input_schema?: unknown;
    /** 允许保留 Claude Code 自带工具的额外字段。 */
    [key: string]: unknown;
}

/**
 * 构造 LLS CCAI 任务流状态回写工具定义。
 *
 * @returns Anthropic tools[] 可直接使用的工具定义。
 */
export function buildUpdateLlsCcaiTaskWorkflowTool(): AnthropicToolDefinition {
    return {
        name: LLS_CCAI_TASK_TOOL_NAME,
        description: 'Update only the status of existing @llsccai-task workflow tasks. Do not modify task titles, descriptions, order, or summary.',
        input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                updates: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            taskId: { type: 'string' },
                            status: {
                                type: 'string',
                                enum: ['pending', 'in_progress', 'completed', 'blocked']
                            }
                        },
                        required: ['taskId', 'status']
                    }
                }
            },
            required: ['updates']
        }
    };
}

/**
 * 构造 LLS CCAI 任务流创建工具定义。
 *
 * @returns Anthropic tools[] 可直接使用的创建工具定义。
 */
export function buildCreateLlsCcaiTaskWorkflowTool(): AnthropicToolDefinition {
    return {
        name: LLS_CCAI_TASK_CREATE_TOOL_NAME,
        description: 'Create an LLS CCAI task workflow from the user prompt, opened planning document, or gathered context.',
        input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                workflow: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        title: { type: 'string' },
                        summary: { type: 'string' },
                        tasks: {
                            type: 'array',
                            minItems: 1,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    id: { type: 'string' },
                                    title: { type: 'string' },
                                    description: { type: 'string' },
                                    status: {
                                        type: 'string',
                                        enum: ['pending', 'in_progress', 'completed', 'blocked']
                                    }
                                },
                                required: ['id', 'title', 'description', 'status']
                            }
                        }
                    },
                    required: ['title', 'summary', 'tasks']
                }
            },
            required: ['workflow']
        }
    };
}

/**
 * 合并 Claude Code 原有工具与扩展内置工具。
 *
 * 只允许扩展内置工具覆盖同名工具；其它 Claude Code 自带工具按原样保留。
 *
 * @param existing Claude Code 原始 tools。
 * @param builtIns 扩展内置工具。
 * @returns 合并后的 Anthropic tools。
 */
export function mergeAnthropicTools(
    existing: unknown,
    builtIns: AnthropicToolDefinition[]
): AnthropicToolDefinition[] {
    const existingTools = Array.isArray(existing) ? existing.filter(isToolLike) : [];
    const builtInNames = new Set(builtIns.map((tool) => tool.name));
    return [
        ...existingTools.filter((tool) => !builtInNames.has(tool.name)),
        ...builtIns
    ];
}

/**
 * 构造注入给主模型的任务流系统规则。
 *
 * @param language 当前 UI 语言。
 * @returns system 规则文本。
 */
export function buildLlsCcaiTaskSystemRule(language: ResolvedAppLanguage, workflow?: LlsTaskWorkflow): string {
    const texts = getLlsCcaiTaskTexts(language);
    const lines = [
        'Active llsccai-task workflow is available for the current workspace.',
        '',
        ...(workflow ? ['Workflow JSON:', JSON.stringify(workflow, null, 2), ''] : []),
        'Workflow tool usage rules:',
        `- Output user-facing task-flow explanations in ${texts.outputLanguageName}.`,
        '- When actual task progress changes, update the workflow status.',
        '- You may only update task statuses: pending, in_progress, completed, blocked.',
        '- You may NOT modify task titles, descriptions, order, or summary.',
        '- Do not update workflow status unless the status actually changed.',
        '- If a task is completed, update the workflow status before saying it is complete in text.',
        '- If all tasks are completed, update every remaining pending or in_progress task before giving the final summary.',
        '- Never claim that the workflow or any task has been updated, completed, or finished unless the workflow status has actually been updated.',
        '- Do not end the turn with only a textual completion summary while the injected Workflow JSON still contains pending or in_progress tasks.',
        '- Strictly execute the active workflow without asking whether to continue, whether to start, or whether to proceed.',
        '- Do not ask for confirmation before executing the next pending or in-progress workflow task; continue automatically unless a real blocker prevents progress.',
        '- Only ask the user a question when execution is genuinely impossible without missing external information; never ask routine approval questions such as "continue?", "start?", or "proceed?".',
        '- When the workflow already exists, do not re-read the original planning document unless the next task explicitly requires it; execute the next concrete task directly.',
        '- If you use the Read tool, never pass an empty pages value; omit pages when allowed, or use a valid value such as "1" or "1-5".',
        '- If a task is already in_progress, do not update it to in_progress again; continue executing the task instead.',
        '- After workflow status is updated, continue with the next concrete task instead of stopping at the status message.',
        '- Do not only describe the next workflow step. Execute the concrete action whenever one is available.'
    ];
    return lines.join('\n');
}

/**
 * 构造注入给主模型的任务流创建系统规则。
 *
 * @param language 当前 UI 语言。
 * @returns 创建 workflow 的 system 规则文本。
 */
export function buildCreateLlsCcaiTaskSystemRule(language: ResolvedAppLanguage): string {
    const texts = getLlsCcaiTaskTexts(language);
    return [
        'The user wants to start an LLS CCAI task workflow.',
        '',
        'Create a task workflow after you understand the user request.',
        'Stay in normal edit/execution mode. Do not enter Plan Mode, do not write a separate plan file, and do not call ExitPlanMode.',
        '',
        'Workflow creation rules:',
        `- Output user-facing task-flow explanations in ${texts.outputLanguageName}.`,
        '- If @llsccai-task is present, first read the relevant planning document when needed, or use the user-provided content, then create the workflow.',
        '- If you use the Read tool, never pass an empty pages value; omit pages when allowed, or use a valid value such as "1" or "1-5".',
        '- Use the user prompt after @llsccai-task as the primary requirement when it contains meaningful custom text.',
        '- If the prompt is only a default placeholder, inspect IDE-opened file context such as <ide_opened_file>.',
        '- If an opened or provided document is available, read and use that document directly as the planning source. Do not require it to be a software engineering planning document, and do not reject it only because it lacks sections such as requirements, technical solution, implementation steps, or acceptance criteria.',
        '- Create the workflow from the actual document content, even if the document is informal, partial, non-standard, or written as notes. Infer clear executable tasks when possible.',
        '- If neither a useful prompt nor any usable opened/provided document content is available, ask the user to open a document or edit the prompt; do not create an unrelated workflow.',
        '- The workflow must contain clear, executable tasks.',
        '- Task ids must be stable strings, usually "1", "2", "3".',
        '- Initial statuses should usually be pending unless a task has already been completed in the current turn.'
    ].join('\n');
}

/**
 * 判断未知值是否近似 Anthropic 工具定义。
 *
 * @param value 待判断值。
 * @returns 是否包含字符串 name 字段。
 */
function isToolLike(value: unknown): value is AnthropicToolDefinition {
    return !!value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string';
}

/**
 * 构造 LLS CCAI 诊断读取工具定义。
 *
 * 该工具由模型主动调用，由扩展本地拦截并使用 VS Code
 * {@link vscode.languages.getDiagnostics} 实时读取问题面板内容，最多返回 10 条
 * 按严重级别排序的诊断。模型可在确认修复完成前调用它做"自检"。
 *
 * @returns Anthropic tools[] 可直接使用的诊断工具定义。
 */
export function buildGetLlsCcaiDiagnosticsTool(): AnthropicToolDefinition {
    return {
        name: LLS_CCAI_GET_DIAGNOSTICS_TOOL_NAME,
        description: [
            'Get current diagnostics known to VS Code, typically shown in the Problems panel.',
            'This tool is executed locally by the extension and returns at most 10 diagnostics sorted by severity (error > warning > information > hint).',
            'Use it to verify that your edits actually cleared compile or lint errors before claiming a fix is complete,',
            'or when the user asks about errors / problems in the workspace.'
        ].join(' '),
        input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                filePaths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of file or directory paths used to filter diagnostics. Omit to return diagnostics from the entire workspace.'
                }
            }
        }
    };
}

/**
 * 构造注入给主模型的"诊断工具使用指南"系统规则。
 *
 * 该规则单独成段，在任务流活跃 / 创建期间也会一并注入，让模型知道何时可以
 * 调用诊断工具、调用后会得到什么形态的结果。
 *
 * @returns 诊断工具使用规则文本。
 */
export function buildGetLlsCcaiDiagnosticsSystemRule(): string {
    const lines = [
        `You have access to a tool named \`${LLS_CCAI_GET_DIAGNOSTICS_TOOL_NAME}\` that returns the current VS Code Problems panel diagnostics (up to 10 entries, sorted by severity).`,
        '',
        `WHEN TO CALL \`${LLS_CCAI_GET_DIAGNOSTICS_TOOL_NAME}\`:`,
        '- After editing code files, call it to verify whether compile / lint errors were actually fixed.',
        '- When the user asks "what errors are there", "check the problems panel", "fix the errors", or similar.',
        '- Before claiming a fix is complete in your final reply, call it to confirm no remaining errors.',
        '',
        `WHEN NOT TO CALL \`${LLS_CCAI_GET_DIAGNOSTICS_TOOL_NAME}\`:`,
        '- Do not call it repeatedly in the same round without making any code edits in between.',
        '- Do not call it when the user has not asked about errors and you have not edited any code.',
        '',
        'INPUT SCHEMA:',
        '  { "filePaths": ["optional", "array", "of", "file", "or", "directory", "paths"] }',
        '',
        'OUTPUT (returned to you as a text block in the same turn):',
        '  A JSON wrapped between [get_llsccai_vscode_diagnostics] tool result (BEGIN) and (END) markers, with fields:',
        '    { "ok": true, "summary": { "total": N, "errors": E, "warnings": W, ... },',
        '      "diagnostics": [ { "filePath": "...", "range": { "startLine": N, "startCharacter": C, ... }, "severity": "error", "message": "...", "source": "ts", "code": "2322" } ],',
        '      "truncated": false, "message": "..." }',
        '',
        'Treat the returned diagnostics as authoritative VS Code Problems panel data. Prioritize fixing entries whose severity is "error" before warnings.'
    ];
    return lines.join('\n');
}
