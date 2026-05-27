/** @file LLS CCAI 任务流 Anthropic 工具定义与合并逻辑。 */

import { getLlsCcaiTaskTexts } from './messages';
import type { ResolvedAppLanguage } from '../types';
import type { LlsTaskWorkflow } from './types';

/** LLS CCAI 任务流状态回写工具名称。 */
export const LLS_CCAI_TASK_TOOL_NAME = 'update_llsccai_task_workflow';

/** LLS CCAI 任务流创建工具名称。 */
export const LLS_CCAI_TASK_CREATE_TOOL_NAME = 'create_llsccai_task_workflow';

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
        description: 'Create an LLS CCAI task workflow from the user prompt, opened planning document, or gathered context. You must also echo back the planning document path you used (if any) and the user\'s original request text, so later turns can keep the original context anchored without repeating document contents.',
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
                },
                planningDocumentPath: {
                    type: 'string',
                    description: 'Workspace-relative path of the planning document you read to build this workflow. Empty string if no document was used (pure prompt-driven workflow).'
                },
                originalUserPrompt: {
                    type: 'string',
                    description: 'The user\'s original request text after the @llsccai-task trigger. If a document/file was used, keep this to the user\'s typed request only and do not paste document or file contents; later continue-prompts will reuse the planningDocumentPath instead.'
                }
            },
            required: ['workflow', 'planningDocumentPath', 'originalUserPrompt']
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
 * @param workflow 当前任务流；存在时会被序列化进 system 让模型每轮都能看到。
 * @param planningDocumentPath 触发任务流时 IDE 打开的方案文档路径；
 *                             非空时追加为 `Planning document path: <path>`，
 *                             作为"原始用户上下文"锚点，避免多轮续推后丢失意图。
 * @param originalUserPrompt 用户在 `@llsccai-task` 后面手输入的原始提示词；
 *                           非空时追加为 `Original user request: <text>`，
 *                           让模型在没有文档的场景下也能记住最初的需求。
 * @returns system 规则文本。
 */
export function buildLlsCcaiTaskSystemRule(
    language: ResolvedAppLanguage,
    workflow?: LlsTaskWorkflow,
    planningDocumentPath?: string,
    originalUserPrompt?: string
): string {
    const texts = getLlsCcaiTaskTexts(language);
    const trimmedPath = (planningDocumentPath || '').trim();
    const trimmedPrompt = !trimmedPath ? (originalUserPrompt || '').trim() : '';
    const lines = [
        'Active llsccai-task workflow is available for the current workspace.',
        '',
        ...(workflow ? ['Workflow JSON:', JSON.stringify(workflow, null, 2), ''] : []),
        ...(trimmedPath ? [`Planning document path: ${trimmedPath}`, ''] : []),
        ...(trimmedPrompt ? [`Original user request: ${trimmedPrompt}`, ''] : []),
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
        '- When you invoke create_llsccai_task_workflow, you MUST also fill the planningDocumentPath and originalUserPrompt arguments:',
        '  * planningDocumentPath: workspace-relative path of the document/file you actually read (from <ide_opened_file> or otherwise). Use an empty string if no document/file was used.',
        '  * originalUserPrompt: only the user request text after @llsccai-task verbatim. If the workflow is document/file-driven and the user wrote no meaningful prompt, use an empty string. Never paste document/file contents into originalUserPrompt.',
        '  Later turns reuse planningDocumentPath to keep the original document/file anchored, so do not duplicate its contents.',
        '- The workflow must contain clear, executable tasks.',
        '- Only include tasks that the model can complete autonomously through edit / write / run / search style tool calls (for example: editing files, running build / test / lint commands, searching the codebase, generating code).',
        '- Do NOT include tasks that require the user to verify, confirm, approve, sign off, manually test, deploy, configure, click, run interactive commands, take screenshots, or otherwise perform actions outside the model. Skip any such step instead of adding it as a task.',
        '- Do NOT add planning, discussion, "wait for user feedback", "ask user to verify", or "user acceptance" tasks. The model executes; the user only reviews the diff at the end.',
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

