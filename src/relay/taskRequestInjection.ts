/**
 * @file LLS CCAI 任务流请求注入公共模块。
 *
 * 所有上游协议适配器都应先在 Anthropic 请求体形态上调用本模块完成任务流
 * 用户控制消息与内置 tools 注入，然后再做协议转换。
 * 这样可确保 anthropic / openai-compatible / v1-response 三条路径的任务流行为一致。
 */

import type { ConfigManager } from '../configManager';
import { Logger } from '../logger';
import type { AutoContinueScheduler } from '../llsTask/autoContinue';
import type { LlsTaskService } from '../llsTask/service';
import {
    AnthropicToolDefinition,
    buildCreateLlsCcaiTaskSystemRule,
    buildCreateLlsCcaiTaskWorkflowTool,
    buildLlsCcaiTaskSystemRule,
    buildUpdateLlsCcaiTaskWorkflowTool,
    mergeAnthropicTools
} from '../llsTask/tools';
import { EXPERT_NATIVE_AGENT_TOOL_NAME } from '../expertMode/expertConstants';

/** Claude Code 用于在执行中询问用户的工具名，任务流自动执行阶段会过滤掉。 */
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Claude Code 用于切换/退出 Plan Mode 的工具名，任务流创建阶段会过滤掉以保持 Edit 模式。 */
const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

/** Claude Code 用于进入 Plan Mode 的工具名，转发上游时统一过滤掉。 */
const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';

const ALWAYS_BLOCKED_CHAT_TOOL_NAMES = new Set<string>([
    EXPERT_NATIVE_AGENT_TOOL_NAME,
    'Task',
    ENTER_PLAN_MODE_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME
]);

/**
 * Claude Code CLI 内部"会话标题生成"侧轨请求的 system 关键标识。
 *
 * 该侧轨请求会与主对话请求几乎同时（毫秒级并发）打到本地 relay，目的仅是为 UI
 * 会话列表生成一个 3-7 词的简短标题，原始 tools 字段为空、不会执行任何动作。
 * 一旦给它注入任务流工具与"请继续执行"控制消息，只会污染无关请求，因此需要
 * 在注入入口直接跳过。
 */
const TITLE_GENERATION_SYSTEM_MARKER = 'Generate a concise, sentence-case title';

/** 内置 system 提示词中用于转发时替换实际模型名的占位符。 */
const BUILTIN_MODEL_NAME_PLACEHOLDER = '{{MODEL_NAME}}';

/** Relay 转发时固定追加给上游模型的基础 system 提示词。 */
const BUILTIN_CHAT_SYSTEM_PROMPT = `You are an expert AI programming assistant, working with a user in the VS Code editor.
When asked for your name, identity, or model, you must respond that you are the lls: ${BUILTIN_MODEL_NAME_PLACEHOLDER} model, currently running in the claude-code CLI inside the LLS CCAI (Claude Code Config Helper) extension in VS Code.
Follow the user's requirements carefully & to the letter.
Follow Microsoft content policies.
Avoid content that violates copyrights.
If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can't assist with that."
Keep your answers short and impersonal.
<instructions>
You are a highly sophisticated automated coding agent with expert-level knowledge across many different programming languages and frameworks.
The user will ask a question, or ask you to perform a task, and it may require lots of research to answer correctly. There is a selection of tools that let you perform actions or retrieve helpful context to answer the user's question.
You will be given some context and attachments along with the user prompt. You can use them if they are relevant to the task, and ignore them if not. Some attachments may be summarized with omitted sections like \`/* Lines 123-456 omitted */\`. You can use the read_file tool to read more context if needed. Never pass this omitted line marker to an edit tool.
If you can infer the project type (languages, frameworks, and libraries) from the user's query or the context that you have, make sure to keep them in mind when making changes.
If the user wants you to implement a feature and they have not specified the files to edit, first break down the user's request into smaller concepts and think about the kinds of files you need to grasp each concept.
If you aren't sure which tool is relevant, you can call multiple tools. You can call tools repeatedly to take actions or gather as much context as needed until you have completed the task fully. Don't give up unless you are sure the request cannot be fulfilled with the tools you have. It's YOUR RESPONSIBILITY to make sure that you have done all you can to collect necessary context.
When reading files, prefer reading large meaningful chunks rather than consecutive small sections to minimize tool calls and gain better context.
Don't make assumptions about the situation- gather context first, then perform the task or answer the question.
Think creatively and explore the workspace in order to make a complete fix.
Don't repeat yourself after a tool call, pick up where you left off.
NEVER print out a codeblock with file changes unless the user asked for it. Use the appropriate edit tool instead.
NEVER print out a codeblock with a terminal command to run unless the user asked for it. Use the run_in_terminal tool instead.
You don't need to read a file if it's already provided in context.
</instructions>`;

/** 任务流请求注入所需依赖。 */
export interface LlsTaskRequestInjectionDeps {
    /** 配置管理器，用于读取当前 UI 语言。 */
    configManager: ConfigManager;
    /** LLS CCAI 任务流服务。 */
    llsTaskService: LlsTaskService;
    /** 自动续推调度器。 */
    autoContinueScheduler: AutoContinueScheduler;
}

/** 任务流请求注入选项。 */
export interface InjectLlsTaskRequestOptions {
    /** 本轮请求是否由 @llsccai-task 触发任务流创建。 */
    createTriggered?: boolean;
    /** 转发到上游的实际模型名，用于替换内置 system 提示词里的模型占位符。 */
    modelName?: string;
}

/** 任务流请求注入结果。 */
export interface InjectedLlsTaskRequest {
    /** 注入后的 Anthropic 请求体文本；失败或无需注入时为原输入。 */
    bodyText: string;
    /** 本次是否实际尝试并成功改写了请求体。 */
    injected: boolean;
}

/**
 * 向 Anthropic 请求体追加任务流工具与用户控制消息。
 *
 * 工具注入策略（互不阻塞）：
 *
 * - 任务流活跃 → 注入 `update_llsccai_task_workflow` + 任务流执行规则；
 * - 触发了 workflow 创建 → 注入 `create_llsccai_task_workflow` + 创建规则；
 * - 侧轨请求（如标题生成）直接跳过任何注入。
 *
 * @param bodyText 已经重写 model 后的请求体字符串。
 * @param deps 任务流依赖；缺省时跳过任务流相关注入逻辑。
 * @param options 注入选项，用于标记本轮是否触发 workflow 创建。
 * @returns 注入结果，包含最终请求体文本与是否改写的标记。
 */
export function injectLlsTaskRequestBody(
    bodyText: string,
    deps: LlsTaskRequestInjectionDeps | undefined,
    options: InjectLlsTaskRequestOptions = {}
): InjectedLlsTaskRequest {
    const createTriggered = options.createTriggered === true;
    const hasActiveWorkflow = !!deps?.llsTaskService.hasActiveWorkflow();
    const hasPendingWorkflowCreation = !!deps?.llsTaskService.hasPendingWorkflowCreation();
    const shouldInjectWorkflowExecution = hasActiveWorkflow;
    const shouldInjectWorkflowCreation = !hasActiveWorkflow && (createTriggered || hasPendingWorkflowCreation);
    try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        const originalTools = parsed.tools;
        parsed.tools = filterAnthropicToolsByName(parsed.tools, ALWAYS_BLOCKED_CHAT_TOOL_NAMES);
        const didFilterAlwaysBlockedTools = parsed.tools !== originalTools;
        if (!shouldInjectWorkflowExecution && !shouldInjectWorkflowCreation) {
            return didFilterAlwaysBlockedTools
                ? { bodyText: JSON.stringify(parsed), injected: true }
                : { bodyText, injected: false };
        }
        if (isClaudeCodeSideTrackRequest(parsed)) {
            Logger.info('[LlsTask] 跳过侧轨请求注入（会话标题生成等内部请求）');
            return didFilterAlwaysBlockedTools
                ? { bodyText: JSON.stringify(parsed), injected: true }
                : { bodyText, injected: false };
        }
        // 通过侧轨过滤后才取消自动续推定时器，避免标题生成等并发请求误把
        // 主对话刚刚登记的"缺失工具调用"续推计划清掉。
        deps?.autoContinueScheduler.cancel('任务流请求开始，避免旧定时器重复续推');
        const language = deps?.configManager.getResolvedUiLanguage();
        const builtIns: AnthropicToolDefinition[] = [];
        const systemRules: string[] = [];
        const userControlRules: string[] = [];
        systemRules.push(buildBuiltinChatSystemPrompt(options.modelName));
        const sharedSystemPrompt = buildSharedSystemPrompt(deps?.configManager);
        if (sharedSystemPrompt) {
            systemRules.push(sharedSystemPrompt);
        }
        // 工具列表中需要剔除的同名/冲突工具，按场景累加。
        //
        // **永久剔除项**：
        // - `Agent`（Claude CLI 原生 sub-agent / Task 工具）—— 与我们的 `ask_expert`
        //   能力高度重叠且不受 relay 控制，主模型若两者都看到会随机选择，导致
        //   专家模式的可见性面板、单 turn 调用上限、防递归保护等机制全部失效。
        //   无论本扩展专家模式是否开启，都强制走我们的 `ask_expert` 工具；
        //   即使专家模式关闭，移除 `Agent` 也只是把 sub-agent 能力收回，主对话本身
        //   仍能完成所有任务，不影响功能。
        // - `EnterPlanMode` / `ExitPlanMode` 是宿主规划态控制工具，不应暴露给上游模型，
        //   否则会让模型在普通转发对话里误触发规划模式。
        const blockedToolNames = new Set<string>(ALWAYS_BLOCKED_CHAT_TOOL_NAMES);
        if (shouldInjectWorkflowExecution && deps && language) {
            builtIns.push(buildUpdateLlsCcaiTaskWorkflowTool());
            blockedToolNames.add(ASK_USER_QUESTION_TOOL_NAME);
            const snapshot = deps.llsTaskService.getSnapshot();
            userControlRules.push(buildLlsCcaiTaskSystemRule(
                language,
                snapshot.workflow ?? undefined,
                snapshot.planningDocumentPath,
                snapshot.originalUserPrompt
            ));
        } else if (shouldInjectWorkflowCreation && deps && language) {
            builtIns.push(buildCreateLlsCcaiTaskWorkflowTool());
            blockedToolNames.add(EXIT_PLAN_MODE_TOOL_NAME);
            userControlRules.push(buildCreateLlsCcaiTaskSystemRule(language));
        }
        if (builtIns.length === 0) {
            return didFilterAlwaysBlockedTools
                ? { bodyText: JSON.stringify(parsed), injected: true }
                : { bodyText, injected: false };
        }
        parsed.tools = mergeAnthropicTools(
            filterAnthropicToolsByName(parsed.tools, blockedToolNames) as unknown,
            builtIns
        );
        if (systemRules.length > 0) {
            appendSystemRule(parsed, systemRules.join('\n\n'));
        }
        if (userControlRules.length > 0) {
            appendUserControlMessage(parsed, userControlRules.join('\n\n'));
        }
        return { bodyText: JSON.stringify(parsed), injected: true };
    } catch (err) {
        Logger.warn('[LlsTask] 注入 Anthropic tools/user-control 失败：' + (err instanceof Error ? err.message : String(err)));
        return { bodyText, injected: false };
    }
}

/**
 * 构造 Relay 固定注入的 Chat system 提示词。
 *
 * @returns 包含当前时间的基础 system 提示词文本。
 */
export function buildBuiltinChatSystemPrompt(modelName?: string): string {
    return `${replaceBuiltinModelNamePlaceholder(modelName)}\n\n# currentDate\n当前时间：${formatCurrentDateTimeForPrompt(new Date())}`;
}

/**
 * 替换内置 system 提示词中的模型名占位符。
 *
 * @param modelName 转发时解析出的实际模型名。
 * @returns 已替换模型名的内置 system 提示词。
 */
export function replaceBuiltinModelNamePlaceholder(modelName?: string): string {
    const safeModelName = (modelName || '').trim() || 'unknown';
    return BUILTIN_CHAT_SYSTEM_PROMPT.split(BUILTIN_MODEL_NAME_PLACEHOLDER).join(safeModelName);
}

/**
 * 将日期格式化为适合 system 提示词阅读的本地时间字符串。
 *
 * @param date 需要格式化的日期对象。
 * @returns 形如 `2026年5月23日 14:30:00` 的本地时间。
 */
export function formatCurrentDateTimeForPrompt(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 构造全局与工作区共享系统提示词。
 *
 * 共享提示词保存在 `openapicopilot.systemPrompt` 的 Global 与 Workspace 范围中。
 * relay 会在 Anthropic 请求体形态下把它们合并到 system 字段，之后 OpenAI Chat
 * 与 OpenAI Responses 转换器会继续把该 system 内容转换到对应上游协议。
 *
 * @param configManager 配置管理器；缺省时返回空字符串。
 * @returns 可追加到 Anthropic system 字段的共享系统提示词文本。
 */
export function buildSharedSystemPrompt(
    configManager: Pick<ConfigManager, 'getGlobalSystemPrompt' | 'getWorkspaceSystemPrompt'> | undefined
): string {
    if (!configManager) return '';
    const globalPrompt = configManager.getGlobalSystemPrompt().trim();
    const workspacePrompt = configManager.getWorkspaceSystemPrompt().trim();
    const sections: string[] = [];
    if (globalPrompt) {
        sections.push(`[Global System Prompt]\n${globalPrompt}`);
    }
    if (workspacePrompt) {
        sections.push(`[Workspace System Prompt]\n${workspacePrompt}`);
    }
    return sections.join('\n\n');
}

/**
 * 按工具名称过滤 Anthropic tools 数组。
 *
 * 任务流执行阶段需要避免模型调用交互式询问工具而中断自动续推，因此这里会在
 * 保留其它 Claude Code 原生工具的同时剔除指定名称的工具。非数组输入会保持原值，
 * 交给后续 merge 逻辑继续按原有规则处理。
 *
 * @param tools 原始 Anthropic tools 字段。
 * @param blockedNames 需要剔除的工具名称集合。
 * @returns 过滤后的 tools 字段。
 */
export function filterAnthropicToolsByName(tools: unknown, blockedNames: ReadonlySet<string>): unknown {
    if (!Array.isArray(tools)) return tools;
    return tools.filter((tool) => !isBlockedAnthropicTool(tool, blockedNames));
}

/**
 * 判断一个 Anthropic tool 是否命中阻止列表。
 *
 * @param tool 待检查的工具定义。
 * @param blockedNames 需要剔除的工具名称集合。
 * @returns 命中阻止列表时返回 true。
 */
export function isBlockedAnthropicTool(tool: unknown, blockedNames: ReadonlySet<string>): tool is AnthropicToolDefinition {
    return !!tool
        && typeof tool === 'object'
        && typeof (tool as { name?: unknown }).name === 'string'
        && blockedNames.has((tool as { name: string }).name);
}

/**
 * 向 Anthropic system 字段追加系统规则。
 *
 * 诊断工具的使用说明属于工具/系统层面的能力描述，不应伪装成 user message。
 * 这里兼容 Anthropic 支持的两种 system 形态：
 * - string：用空行拼接追加；
 * - text block 数组：追加一个 `{ type: 'text', text }` block。
 *
 * @param parsed Anthropic 请求体对象。
 * @param rule 要追加的系统规则文本。
 */
export function appendSystemRule(parsed: Record<string, unknown>, rule: string): void {
    if (!rule.trim()) return;
    if (typeof parsed.system === 'string') {
        parsed.system = parsed.system.trim() ? `${parsed.system}\n\n${rule}` : rule;
        return;
    }
    if (Array.isArray(parsed.system)) {
        parsed.system = [...parsed.system, { type: 'text', text: rule }];
        return;
    }
    parsed.system = rule;
}

/**
 * 向 Anthropic messages 的最后一条 user 消息头部插入任务流用户控制消息。
 *
 * 部分 OpenAI-compatible 模型对转换后的 system 规则遵循较弱，因此任务流规则改为
 * role=user 的显式控制消息注入，让模型把它当作当前轮用户指令处理，同时保留原有
 * Claude Code 工具列表与任务流工具定义。
 *
 * @param parsed Anthropic 请求体对象。
 * @param rule 要插入的任务流控制规则文本。
 */
export function appendUserControlMessage(parsed: Record<string, unknown>, rule: string): void {
    const messages = parsed.messages;
    if (!Array.isArray(messages)) {
        parsed.messages = [{ role: 'user', content: [{ type: 'text', text: rule }] }];
        return;
    }
    const lastMessage = messages[messages.length - 1];
    if (isAnthropicUserMessageRecord(lastMessage)) {
        prependTextBlockToUserMessage(lastMessage, rule);
        parsed.messages = messages;
        return;
    }
    parsed.messages = [...messages, { role: 'user', content: [{ type: 'text', text: rule }] }];
}

/**
 * 判断消息对象是否为可追加文本块的 Anthropic user message。
 *
 * @param message 待检查的消息对象。
 * @returns 是 user message 时返回 true。
 */
export function isAnthropicUserMessageRecord(message: unknown): message is { role: 'user'; content?: unknown } {
    return !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'user';
}

/**
 * 向 user message 的 content 头部插入一个 Anthropic text block。
 *
 * 不以 `<system-reminder>` 等内容作为条件；只要调用方确认当前请求不是标题生成等
 * 侧轨请求，注入文本就统一插入到 `content[0]`，让它先于该轮用户文本被模型看到。
 *
 * @param message 目标 user message。
 * @param text 需要插入的文本。
 */
export function prependTextBlockToUserMessage(message: { role: 'user'; content?: unknown }, text: string): void {
    if (typeof message.content === 'string') {
        message.content = [{ type: 'text', text }, { type: 'text', text: message.content }];
        return;
    }
    if (Array.isArray(message.content)) {
        message.content = [{ type: 'text', text }, ...message.content];
        return;
    }
    message.content = [{ type: 'text', text }];
}

/**
 * 判断给定 Anthropic 请求体是否属于 Claude Code CLI 内部并发的"侧轨请求"。
 *
 * 当前已知会与主对话毫秒级并发的侧轨请求：
 * - 会话标题生成：system 中包含 {@link TITLE_GENERATION_SYSTEM_MARKER}，并通过
 *   `output_config.format.type === "json_schema"` 强制返回 `{title}` JSON。
 *
 * 这类请求与任务流执行无关，注入只会污染上下文（凭空多出 update 工具与
 * "请继续执行"控制消息），且会让调试快照里出现 tools=1 的假象。这里识别后
 * 直接跳过注入，让请求按其原本意图透传。
 *
 * @param parsed 已经 JSON.parse 后的 Anthropic 请求体对象。
 * @returns 命中已知侧轨特征时返回 true。
 */
export function isClaudeCodeSideTrackRequest(parsed: Record<string, unknown>): boolean {
    if (extractAnthropicSystemText(parsed.system).includes(TITLE_GENERATION_SYSTEM_MARKER)) {
        return true;
    }
    const outputConfig = parsed.output_config;
    if (outputConfig && typeof outputConfig === 'object') {
        const format = (outputConfig as { format?: unknown }).format;
        if (format && typeof format === 'object' && (format as { type?: unknown }).type === 'json_schema') {
            return true;
        }
    }
    return false;
}

/**
 * 把 Anthropic system 字段统一拍平为字符串，便于关键字匹配。
 *
 * Anthropic 协议允许 system 是字符串，也允许是 `{type, text}` 数组；这里两种
 * 形态都聚合到同一段文本中返回。
 *
 * @param system Anthropic 请求体的 system 字段。
 * @returns 拍平后的 system 文本；无法识别时返回空字符串。
 */
export function extractAnthropicSystemText(system: unknown): string {
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return '';
    const parts: string[] = [];
    for (const item of system) {
        if (typeof item === 'string') {
            parts.push(item);
            continue;
        }
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
            parts.push((item as { text: string }).text);
        }
    }
    return parts.join('\n');
}

