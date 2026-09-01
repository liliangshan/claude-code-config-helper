/**
 * @file LLS CCAI 任务流请求注入公共模块。
 *
 * 所有上游协议适配器都应先在 Anthropic 请求体形态上调用本模块完成任务流
 * 用户控制消息与内置 tools 注入，然后再做协议转换。
 * 这样可确保 anthropic / openai-compatible / v1-response 三条路径的任务流行为一致。
 */

import type { ConfigManager } from '../configManager';
import type { ChatCacheTtl } from '../constants';
import { Logger } from '../logger';
import type { AutoContinueScheduler } from '../llsTask/autoContinue';
import type { LlsTaskService } from '../llsTask/service';
import {
    AnthropicToolDefinition,
    buildCreateLlsCcaiTaskSystemRule,
    buildCreateLlsCcaiTaskWorkflowTool,
    buildUpdateLlsCcaiTaskWorkflowTool,
    mergeAnthropicTools
} from '../llsTask/tools';

/** Claude Code 用于在执行中询问用户的工具名，任务流自动执行阶段会过滤掉。 */
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Claude Code 用于切换/退出 Plan Mode 的工具名，任务流创建阶段会过滤掉以保持 Edit 模式。 */
const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

/** Claude Code 用于进入 Plan Mode 的工具名，转发上游时统一过滤掉。 */
const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';

const ALWAYS_BLOCKED_CHAT_TOOL_NAMES = new Set<string>([
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

/** 旧版基础提示词的起始文本，用于清理历史会话里已经注入到 user 的大块内容。 */
const LEGACY_BUILTIN_PROMPT_START = 'You are an expert AI programming assistant, working with a user in the VS Code editor.';

/**
 * 动态时间段匹配表达式，用于避免每秒变化的 system 前缀持续破坏缓存。
 *
 * 命中形如 `# currentDate\n当前时间：2026年6月16日 06:13:11` 的整段，并把它连同
 * 前后所有空行一起吞掉；替换逻辑再补回单个 `\n\n` 分隔符，避免删除后相邻段落
 * 被粘连成新的字节序列（粘连同样会改变缓存前缀、持续触发 cache_creation）。
 */
const LEGACY_CURRENT_DATE_SECTION_PATTERN = /\n*# currentDate\n当前时间：[^\n]*\n*/g;

/**
 * Claude Code 客户端注入的计费 header 里每轮变化的 `cch=...;` 段匹配表达式。
 *
 * 该 header 形如 `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=2c828;`，
 * 位于 system 数组第 0 块、所有 cache_control 断点之前。其中 `cch` 值每轮请求都变，
 * 而 Anthropic 前缀缓存要求从首字节逐字节相同——只要 `cch` 变，后续所有 system 断点
 * （约 29K）就全部失效，持续触发大块 cache_creation。归一化为固定占位符即可稳定前缀，
 * 同时保留 header 结构、不影响计费埋点解析。
 */
const VOLATILE_BILLING_CCH_PATTERN = /(x-anthropic-billing-header:[^\n]*?\bcch=)[^;\n]*/g;

/** 归一化后写回的稳定 `cch` 占位值。 */
const STABLE_BILLING_CCH_PLACEHOLDER = 'stable';

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
        parsed.tools = filterAnthropicToolsByName(parsed.tools, ALWAYS_BLOCKED_CHAT_TOOL_NAMES);

        // 缓存 ttl 统一改写必须在侧轨提前 return 之前执行：Anthropic 要求整条请求里
        // ttl 不能从 1h 退回 5m（按 tools->system->messages 顺序），而侧轨/标题生成等
        // 请求同样带客户端原生缓存断点。若只在主路径改写，侧轨请求会保留混合 ttl 触发 400。
        const cacheTtl = deps?.configManager.getChatCacheTtl() ?? 'default';
        applyCacheTtlToRequest(parsed, cacheTtl);

        // 侧轨请求（会话标题生成等内部并发请求）不注入任何 system 提示词或任务流
        // 工具，仅保留 always-blocked 工具过滤与缓存 ttl 统一结果，按原意图透传。
        if (isClaudeCodeSideTrackRequest(parsed)) {
            Logger.info('[LlsTask] 跳过侧轨请求注入（会话标题生成等内部请求）');
            return { bodyText: JSON.stringify(parsed), injected: true };
        }

        // 先清理旧版本曾经注入到 system/messages 的动态时间与基础提示词，避免历史会话继续携带大块不稳定前缀。
        stripLegacyInjectedPromptArtifacts(parsed, options.modelName);

        // 内置身份提示词 + 用户全局/工作区共享提示词与任务流无关：只要不是侧轨
        // 请求，每一轮都应注入到 system 字段，否则普通对话里这些提示词会丢失。
        // 不再把整段基础提示词塞进 user 消息，避免历史消息反复累积大块文本并持续写缓存。
        const baseSystemRules: string[] = [buildBuiltinChatSystemPrompt(options.modelName)];
        const sharedSystemPrompt = buildSharedSystemPrompt(deps?.configManager);
        if (sharedSystemPrompt) {
            baseSystemRules.push(sharedSystemPrompt);
        }
        const baseSystemText = baseSystemRules.join('\n\n');
        appendSystemRule(parsed, baseSystemText);

        // 任务流工具/控制消息注入与 system 提示词解耦：仅在任务流活跃或触发创建时执行。
        if (!shouldInjectWorkflowExecution && !shouldInjectWorkflowCreation) {
            return { bodyText: JSON.stringify(parsed), injected: true };
        }

        // 通过侧轨过滤后才取消自动续推定时器，避免标题生成等并发请求误把
        // 主对话刚刚登记的"缺失工具调用"续推计划清掉。
        deps?.autoContinueScheduler.cancel('任务流请求开始，避免旧定时器重复续推');
        const language = deps?.configManager.getResolvedUiLanguage();
        const builtIns: AnthropicToolDefinition[] = [];
        const userControlRules: string[] = [];
        // 工具列表中需要剔除的同名/冲突工具，按场景累加。
        //
        // **永久剔除项**：
        // - `EnterPlanMode` / `ExitPlanMode` 是宿主规划态控制工具，不应暴露给上游模型，
        //   否则会让模型在普通转发对话里误触发规划模式。
        const blockedToolNames = new Set<string>(ALWAYS_BLOCKED_CHAT_TOOL_NAMES);
        if (shouldInjectWorkflowExecution && deps && language) {
            // 续推执行阶段只注入 update 工具定义，**不再注入任何任务流 system 控制规则
            // 或 Workflow JSON 快照**。原因：快照里的任务状态每轮都变，一旦进入被缓存的
            // 请求体（system 或 messages），就会逐字节击穿 Anthropic 前缀缓存，导致
            // cache_read 卡在固定前缀、增长的历史每轮全量 cache_creation。改为由
            // AutoContinueScheduler 经 submitter 发送一条「自包含」续推用户消息——其中带上
            // 任务序列、下一个待执行任务以及调用 update 工具的指示——让 CLI 当作正常一轮处理，
            // 请求体前缀保持稳定、缓存可命中。
            builtIns.push(buildUpdateLlsCcaiTaskWorkflowTool());
            blockedToolNames.add(ASK_USER_QUESTION_TOOL_NAME);
        } else if (shouldInjectWorkflowCreation && deps && language) {
            builtIns.push(buildCreateLlsCcaiTaskWorkflowTool());
            blockedToolNames.add(EXIT_PLAN_MODE_TOOL_NAME);
            userControlRules.push(buildCreateLlsCcaiTaskSystemRule(language));
        }
        if (builtIns.length === 0) {
            // system 提示词已在上方注入，此处即便没有任务流工具也算改写成功。
            return { bodyText: JSON.stringify(parsed), injected: true };
        }
        parsed.tools = mergeAnthropicTools(
            filterAnthropicToolsByName(parsed.tools, blockedToolNames) as unknown,
            builtIns
        );
        if (userControlRules.length > 0) {
            // 仅创建阶段会走到这里：把一次性的创建规则注入 system 尾部。续推执行阶段
            // userControlRules 为空，不会对请求体追加任何易变内容，从而保持缓存前缀稳定。
            appendSystemRule(parsed, userControlRules.join('\n\n'));
        }
        return { bodyText: JSON.stringify(parsed), injected: true };
    } catch (err) {
        Logger.warn('[LlsTask] 注入 Anthropic tools/user-control 失败：' + (err instanceof Error ? err.message : String(err)));
        return { bodyText, injected: false };
    }
}

/**
 * 清理历史会话里旧版本注入留下的不稳定提示词残留。
 *
 * 旧版本会把"内置身份 + 动态时间"既写进 system 又复制进最后一条 user 消息，
 * 其中 `# currentDate\n当前时间：...` 段每秒都在变。这些残留会一直留在历史
 * messages / system 里，使 Anthropic 缓存前缀每轮都被击穿、持续触发大块
 * `cache_creation`。本函数在每次注入前先做一次幂等清理：
 *
 * - 从 system 文本里删除旧版动态时间段；
 * - 从历史 user 消息里删除以旧版基础提示词开头的 text block。
 *
 * @param parsed 已经 JSON.parse 后的 Anthropic 请求体对象。
 * @param modelName 当前转发模型名，仅用于保持签名一致，暂未参与清理逻辑。
 */
export function stripLegacyInjectedPromptArtifacts(parsed: Record<string, unknown>, _modelName?: string): void {
    // 1) 清理 system 字段里旧版每秒变化的 currentDate 段，避免持续击穿缓存前缀。
    if (typeof parsed.system === 'string') {
        parsed.system = stripLegacyCurrentDateText(parsed.system);
    } else if (Array.isArray(parsed.system)) {
        parsed.system = parsed.system.map((item) => stripLegacyCurrentDateFromSystemBlock(item));
    }

    // 2) 清理历史 user 消息里旧版注入的大块基础提示词 text block。
    if (Array.isArray(parsed.messages)) {
        for (const message of parsed.messages) {
            stripLegacyBasePromptFromMessage(message);
        }
    }
}

/**
 * 按目标缓存时长改写请求体里所有 ephemeral 缓存断点的 `ttl`。
 *
 * Claude Code 客户端默认只打 `{ type: 'ephemeral' }`（即 5 分钟）。当用户希望
 * 使用 1 小时缓存时，relay 在转发前把所有 ephemeral 断点补上 `ttl`。`'1h'` 写入
 * `ttl: '1h'`；`'5m'` 是 Anthropic 默认值，直接删除 `ttl` 字段保持最短形态，
 * 避免多余字段影响前缀字节稳定性。
 *
 * 仅遍历 `system` 数组与 `messages[].content` 数组里的 block；字符串形态的
 * system / content 不含 cache_control，无需处理。
 *
 * @param parsed 已经 JSON.parse 后的 Anthropic 请求体对象。
 * @param ttl 目标缓存时长，`'1h'` 或 `'5m'`。
 */
export function applyCacheTtlToRequest(parsed: Record<string, unknown>, ttl: ChatCacheTtl): void {
    // 'default' 表示完全不改写：沿用客户端原样的缓存断点（Anthropic 默认 5m），
    // 避免我们写入的 ttl 与上游网关注入的断点冲突而触发 400。
    if (ttl === 'default') return;
    // 按 Anthropic 处理顺序 tools -> system -> messages 统一改写所有 ephemeral 断点，
    // 确保整条请求里不会出现 ttl='1h' 排在 ttl='5m' 之后（Anthropic 会拒绝该组合）。
    if (Array.isArray(parsed.tools)) {
        for (const tool of parsed.tools) {
            rewriteEphemeralCacheTtl(tool, ttl);
        }
    }
    if (Array.isArray(parsed.system)) {
        for (const block of parsed.system) {
            rewriteEphemeralCacheTtl(block, ttl);
        }
    }
    if (Array.isArray(parsed.messages)) {
        for (const message of parsed.messages) {
            const content = (message as { content?: unknown })?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    rewriteEphemeralCacheTtl(block, ttl);
                }
            }
        }
    }
}

/**
 * 改写单个 block 上的 ephemeral 缓存断点 `ttl`。
 *
 * @param block 任意 content block，仅当其 `cache_control.type === 'ephemeral'` 时改写。
 * @param ttl 目标缓存时长。
 */
function rewriteEphemeralCacheTtl(block: unknown, ttl: ChatCacheTtl): void {
    if (!block || typeof block !== 'object') return;
    const cacheControl = (block as { cache_control?: unknown }).cache_control;
    if (!cacheControl || typeof cacheControl !== 'object') return;
    if ((cacheControl as { type?: unknown }).type !== 'ephemeral') return;
    if (ttl === '1h') {
        (cacheControl as Record<string, unknown>).ttl = '1h';
    } else {
        // 5m 是 Anthropic 默认值，删除 ttl 字段保持最短形态。
        delete (cacheControl as Record<string, unknown>).ttl;
    }
}

/**
 * 从一段 system 文本中删除动态时间段，并修复删除后留下的多余空行。
 *
 * 命中段会被替换成单个 `\n\n` 分隔符，随后把连续 3 个及以上的换行折叠回 2 个，
 * 最后去掉尾部空白。这样既不会把相邻段落粘连，也不会留下多余空行，保证清理后的
 * 前缀字节稳定、可被 Anthropic 命中缓存。
 *
 * @param text 原始 system 文本。
 * @returns 清理并归一化空行后的文本。
 */
function stripLegacyCurrentDateText(text: string): string {
    return text
        .replace(LEGACY_CURRENT_DATE_SECTION_PATTERN, '\n\n')
        .replace(VOLATILE_BILLING_CCH_PATTERN, `$1${STABLE_BILLING_CCH_PLACEHOLDER}`)
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

/**
 * 从单个 Anthropic system text block 中删除动态时间段。
 *
 * @param block system 数组中的一个元素，可能是字符串或 `{type,text}` 文本块。
 * @returns 清理后的同形态元素。
 */
function stripLegacyCurrentDateFromSystemBlock(block: unknown): unknown {
    if (typeof block === 'string') {
        return stripLegacyCurrentDateText(block);
    }
    if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        const cleaned = stripLegacyCurrentDateText((block as { text: string }).text);
        return { ...(block as Record<string, unknown>), text: cleaned };
    }
    return block;
}

/**
 * 从一条消息的 content 中删除旧版注入的基础提示词 text block。
 *
 * 仅处理 content 为数组的情况：逐个剔除 text 以 {@link LEGACY_BUILTIN_PROMPT_START}
 * 开头的块。字符串 content 不做改写，避免误伤用户原始输入。
 *
 * @param message 任意 Anthropic 消息对象。
 */
function stripLegacyBasePromptFromMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    (message as { content: unknown }).content = content.filter((block) => !isLegacyBasePromptTextBlock(block));
}

/**
 * 判断一个 content block 是否为旧版注入的基础提示词 text 块。
 *
 * @param block 待检查的 content block。
 * @returns 命中旧版基础提示词起始文本时返回 true。
 */
function isLegacyBasePromptTextBlock(block: unknown): boolean {
    return !!block
        && typeof block === 'object'
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
        && (block as { text: string }).text.startsWith(LEGACY_BUILTIN_PROMPT_START);
}

/**
 * 构造 Relay 固定注入的 Chat system 提示词。
 *
 * @param modelName 转发时解析出的实际模型名。
 * @returns 只包含稳定内置身份规则的基础 system 提示词文本。
 */
export function buildBuiltinChatSystemPrompt(modelName?: string): string {
    return replaceBuiltinModelNamePlaceholder(modelName);
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

