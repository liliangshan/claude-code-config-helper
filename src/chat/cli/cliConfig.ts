/** @file 读取并规范化内置 Chat 的 CLI 配置。 */

import * as os from 'os';
import * as vscode from 'vscode';

import {
    CHAT_BROWSER_TOOLS_ENABLED_KEY,
    CHAT_CLI_ARGS_KEY,
    CHAT_CLI_CWD_KEY,
    CHAT_CLI_ENV_KEY,
    CHAT_CLI_INCLUDE_VSCODE_MCP_JSON_KEY,
    CHAT_CLI_MCP_SERVERS_KEY,
    CHAT_CLI_PATH_KEY,
    CHAT_CLI_PERMISSION_MODE_KEY,
    CHAT_CLI_SKILLS_KEY,
    CHAT_CLI_STRICT_MCP_CONFIG_KEY,
    CHAT_DISPATCHER_APPEND_SYSTEM_PROMPT_KEY,
    CHAT_ENABLED_KEY,
    CHAT_EXPERT_APPEND_SYSTEM_PROMPT_KEY,
    CHAT_PLAN_APPEND_SYSTEM_PROMPT_KEY,
    CHAT_REVIEW_APPEND_SYSTEM_PROMPT_KEY,
    CHAT_TRANSPORT_KEY,
    CONFIG_NAMESPACE,
    VSCODE_TOOLS_GET_ERRORS_ENABLED_KEY
} from '../../constants';
import { ConfigManager } from '../../configManager';
import { readCompactionConfigFromVscode, readExpertConfigFromVscode, readPlanConfigFromVscode, readReviewConfigFromVscode } from '../../expertMode/expertConfig';
import { ASK_EXPERT_MCP_SERVER_NAME } from '../../expertMode/askExpertMcpServer';
import { BROWSER_BRIDGE } from '../../browserTools/bridge';
import { VSCODE_BRIDGE } from '../../vscodeTools/bridge';
import { WAKEUP_BRIDGE } from '../../wakeupTools/bridge';
import type { McpBridgeDescriptor } from '../../mcpKit/registry';
import {
    loadAllVscodeMcpJsons,
    mergeMcpServers,
    workspaceFolderResolver
} from './mcpJsonLoader';
import type { ChatRoute } from '../protocol';
import type { ChatCliConfig, ChatCliPermissionMode, ChatCliTransport, McpServerConfig } from './types';

/** 内置 Chat 默认通信通道。 */
const DEFAULT_TRANSPORT: ChatCliTransport = 'streamJsonStdio';

/**
 * 内置 Chat 默认权限模式。
 *
 * 选 `acceptEdits` 是为了避免 Claude CLI `--bare --print` 非交互模式下
 * Edit/Write/Read 类工具被默认策略拦截后无法弹窗询问用户。
 * Bash 等执行类工具仍由 CLI 自身的策略评估。
 */
const DEFAULT_PERMISSION_MODE: ChatCliPermissionMode = 'acceptEdits';

/** Claude CLI `--permission-mode` 可接受的取值集合。 */
const VALID_PERMISSION_MODES: ReadonlySet<ChatCliPermissionMode> = new Set([
    'default',
    'acceptEdits',
    'bypassPermissions',
    'auto',
    'dontAsk',
    'plan'
]);

/** 官方扩展长连接模式建议注入的兼容环境变量。 */
const DEFAULT_STREAM_JSON_ENV: Record<string, string> = {
    MCP_CONNECTION_NONBLOCKING: 'true',
    CLAUDE_CODE_ENABLE_TASKS: '0',
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode'
};

/**
 * Write 工具调用纪律：所有 CLI 角色共用的硬约束。
 *
 * 强制点：
 * - Write 调用必须同时带非空 file_path 与非空 content，禁止用空参数尝试 Write；
 * - 新建文件时只先 Write 一小段（头部/首段），剩余内容必须通过多次 Edit 追加；
 * - 若 tool_result 命中 "Empty Write call blocked by relay" 错误，立刻按规则重试。
 */
const WRITE_TOOL_USAGE_RULE = [
    'Write tool discipline (mandatory, applies whenever you can edit files):',
    '- Every Write call MUST include BOTH a non-empty `file_path` AND a non-empty',
    '  `content`. Never call Write with empty arguments, with `content` omitted, or',
    '  with an empty/whitespace-only `content`.',
    '- When creating a NEW file, do NOT dump the entire file body into a single Write',
    '  call. First call Write with `file_path` plus a SHORT seed segment (the file',
    '  header / first section / first few lines). Then keep extending the file by',
    '  repeated Edit calls that append the remaining content in chunks.',
    '- If a tool_result contains "Empty Write call blocked by relay", the relay layer',
    '  has rejected an invalid Write. Do NOT retry the same empty Write. Retry with a',
    '  small seed Write followed by Edit appends as described above.'
].join('\n');

/**
 * dispatcher（normal）CLI 默认追加的 system prompt 文案。
 *
 * 双 CLI 路由方案下，普通 CLI 承担轻量任务、简单问答与低风险工程操作；遇到复杂任务
 * 必须以 `@llsExpert <一句任务复述>` 文本切路由。提示文案在
 * `getDualConfigsWithRelayEnv` 里通过 `appendSystemPrompt` 字段注入到 normal CLI
 * 启动参数 `--append-system-prompt`；用户可通过 `chat.dispatcher.appendSystemPrompt`
 * 完全替换该默认文案（非空时不再使用此默认值）。
 */
const DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT = [
    'You are the primary engineering assistant. Handle requests directly by default —',
    'including writing, editing, refactoring code, running shell/git commands,',
    'inspecting diffs, and making ordinary engineering decisions.',
    '',
    'An optional `ask_expert` tool may appear in your tool list. Treat it as a rare',
    'escalation path, not a normal step. Use it ONLY when:',
    '  1. the user explicitly asks for the expert ("用专家", "ask the expert", /expert), OR',
    '  2. after reading the relevant files, you still cannot make a confident decision',
    '     and a wrong choice would have high blast radius.',
    '',
    'Do NOT call `ask_expert` for:',
    '  - implementation work you can perform yourself;',
    '  - simple, local edits;',
    '  - normal debugging, test failures, compile errors, or refactors;',
    '  - questions you can answer from the files you can already read;',
    '  - speculative "let me double-check" calls.',
    '',
    'Before calling `ask_expert`, first inspect the relevant local context yourself.',
    'When calling `ask_expert`, pass `{ "question": "<one self-contained paragraph>" }`.',
    'The expert receives NO conversation history — your question must be self-contained.',
    'Treat the returned `tool_result` as advisory and integrate it into your final reply.',
    '',
    'If `ask_expert` is not in your tool list, expert mode is disabled — just answer',
    'directly and never mention the expert.',
    '',
    WRITE_TOOL_USAGE_RULE
].join('\n');

/**
 * Plan routing 优先级片段，仅在方案模型已配置时追加到 dispatcher 提示词。
 *
 * 单独抽出是为了避免「未启用方案模型时 dispatcher 仍被告知必须用 `@llsPlanTask`」
 * 的硬编码诱导——历史上这一段被写死在 {@link DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT}
 * 里，无论 `planAvailable` 与否都会注入，导致普通模型在没有方案模型的环境下也尝试
 * 触发不存在的 `@llsPlanTask` 路由。
 *
 * 注入位置：在 {@link DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT} 主体与
 * {@link DISPATCHER_PLAN_REVIEW_PROMPT} 详细编排之间，作为中间桥接段。
 */
const DISPATCHER_PLAN_ROUTING_PRIORITY = [
    '',
    'Routing priority (the plan model is available):',
    '1. If the user asks for a design, architecture proposal, implementation plan,',
    '   technical方案, 方案设计, planning work, or a plan/review workflow, you MUST',
    '   use `@llsPlanTask`. This rule overrides all generic expert-tool guidance.',
    '2. For non-planning work, continue handling the task yourself unless the strict',
    '   `ask_expert` escalation conditions above are met.'
].join('\n');

/**
 * Plan/review 编排提示词片段，当方案模型已配置时追加到 dispatcher 提示词末尾。
 *
 * 在 {@link ChatCliConfigService.getRoutedConfigsWithRelayEnv} 中根据
 * `planMode.enabled && planMode.model` 判断是否追加本段。
 */
const DISPATCHER_PLAN_REVIEW_PROMPT = [
    '',
    'HIGHEST PRIORITY plan/review orchestration (the plan/review model is available):',
    '- Planning/design requests MUST go to the plan model, not the expert model.',
    '- Planning/design requests include: design docs, architecture proposals, technical',
    ' 方案, 方案设计, implementation plans, structured planning work, or any request',
    '  asking to produce/review a plan before implementation.',
    '- For those requests, reply only with `@llsPlanTask` followed by the full planning',
    '  request. Do NOT reply with `@llsExpert` for planning/design requests.',
    '- Include in the `@llsPlanTask` prompt that the plan model must write the result',
    '  into a Markdown (.md) file and output the file path when done.',
    '- Example: user asks "请出一份获取当前时间的Go应用的方案设计" → respond with:',
    '  "@llsPlanTask 请出一份获取当前时间的Go应用的方案设计，包含技术选型、项目结构、',
    '  代码实现方案。同时将方案写入 Markdown 文件并输出文件路径。"',
    '- When the plan model result is returned to you, decide the next step by replying',
    '  only with `@llsPlanReview` when review is needed, or `@llsPlanDone` followed',
    '  by a concise user-facing summary when review is unnecessary.',
    '- When the review model result is returned to you, reply only with',
    '  `@llsPlanRevise` plus the required changes if the verdict requests changes;',
    '  reply with `@llsPlanApproved` plus a concise user-facing summary if approved.',
    '- Do not expose internal plan/review prompts or token mechanics to the user.'
].join('\n');

/**
 * expert CLI 默认追加的 system prompt 文案。
 *
 * 双 CLI 路由方案下，专家 CLI 由 dispatcher 通过 `@llsExpert` 文本切路由后激活，
 * 承担复杂分析、重构、调试、设计提案等高强度任务。用户可通过
 * `chat.expert.appendSystemPrompt` 完全替换该默认文案（非空时不再使用此默认值）。
 */
const DEFAULT_EXPERT_APPEND_SYSTEM_PROMPT = [
    'You are the **expert model**, activated by the dispatcher routing layer when the',
    'user asks for tasks beyond lightweight chores. You receive each user message',
    'directly through the routed CLI; the dispatcher is NOT in the loop on your turn.',
    '',
    'Your scope:',
    '- deep code analysis, refactoring, multi-step implementations, debugging',
    '- design proposals, architecture trade-off discussions',
    '- any task that requires reading large amounts of context or making non-trivial edits',
    '',
    'Do NOT echo `@llsExpert` markers back to the user — that token is only used by the',
    'dispatcher to hand off control to you, never the other way around. Reply with',
    'real engineering work; the routing layer takes care of staying on the expert CLI',
    'until the user manually switches back.',
    '',
    WRITE_TOOL_USAGE_RULE
].join('\n');

/**
 * @deprecated 按需专家方案下 expert CLI 已退役。该常量保留仅为兼容历史
 * `getRoutedConfigsWithRelayEnv` 调用链中 `buildRoutedModeConfig` 的 fallback。
 * 当 expertMode.enabled=true 时，专家不再常驻 CLI，而是通过 `ask_expert` MCP
 * 工具按需启动 ExpertSubturnService。
 */
const LEGACY_EXPERT_APPEND_SYSTEM_PROMPT = DEFAULT_EXPERT_APPEND_SYSTEM_PROMPT;

/** 方案 CLI 默认追加的 system prompt 文案。 */
const DEFAULT_PLAN_APPEND_SYSTEM_PROMPT = [
    'You are the **plan model** in a multi-model orchestration system. Your job is to',
    'produce clear, structured plans, designs, and technical proposals.',
    '',
    'You receive a fresh task from the normal dispatcher. You do not have reliable',
    'access to prior conversation history unless it is included in the prompt.',
    '',
    'Output a well-structured plan covering:',
    '- Requirements and assumptions',
    '- Architecture / design decisions',
    '- Implementation steps',
    '- Validation and test strategy',
    '- Risks, tradeoffs, and alternatives',
    '',
    'Write the plan into a Markdown (.md) file in the current workspace. After writing',
    'the file, output the absolute path to the generated file so the dispatcher knows',
    'where to find it.',
    '',
    'Do not execute implementation steps. Do not use routing tokens such as',
    '@llsExpert, @llsPlanReview, @llsPlanRevise, @llsPlanDone, or @llsPlanApproved.',
    '',
    WRITE_TOOL_USAGE_RULE
].join('\n');

/** 审查 CLI 默认追加的 system prompt 文案。 */
const DEFAULT_REVIEW_APPEND_SYSTEM_PROMPT = [
    'You are the **review model** in a multi-model orchestration system. Your job is',
    'to review plans produced by the plan model for quality, correctness, and',
    'completeness.',
    '',
    'You receive the plan content from the normal dispatcher. You do not have reliable',
    'access to prior conversation history unless it is included in the prompt.',
    '',
    'Evaluate the plan against:',
    '- Completeness: Are all requirements addressed?',
    '- Correctness: Are the technical decisions sound and consistent with the repo?',
    '- Clarity: Is the plan easy to understand and implement?',
    '- Validation: Are tests and manual verification covered?',
    '- Risks: Are potential issues identified and mitigated?',
    '',
    'Start with exactly one verdict line:',
    'VERDICT: APPROVED',
    'or',
    'VERDICT: CHANGES_REQUESTED',
    '',
    'Then provide concise findings. If changes are requested, list specific required',
    'fixes. Do not use routing tokens and do not implement the plan.'
].join('\n');

/**
 * 管理 Chat CLI 配置读取、默认值解析与持久化更新。
 *
 * 该类只访问 VS Code configuration，不启动进程；典型调用方为
 * `CliResolver`、`CliProcess` 和后续 `ChatController`。
 */
export class ChatCliConfigService {
    /**
     * 创建 Chat CLI 配置读取器。
     *
     * @param configManager 可选的模型配置管理器，用于把当前模型转换成 --model 参数。
     */
    public constructor(private readonly configManager?: ConfigManager) {}

    /**
     * 读取当前生效的 Chat CLI 配置快照。
     *
     * @returns 已补齐 cwd、transport 和默认环境变量的配置。
     */
    public getConfig(): ChatCliConfig {
        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const transport = this.normalizeTransport(config.get<string>(CHAT_TRANSPORT_KEY, DEFAULT_TRANSPORT));
        const userEnv = this.normalizeEnv(config.get<Record<string, unknown>>(CHAT_CLI_ENV_KEY, {}));
        const permissionMode = this.normalizePermissionMode(
            config.get<string>(CHAT_CLI_PERMISSION_MODE_KEY, DEFAULT_PERMISSION_MODE)
        );
        const mcpServers = this.normalizeMcpServers(
            config.get<Record<string, unknown>>(CHAT_CLI_MCP_SERVERS_KEY, {})
        );
        const strictMcpConfig = config.get<boolean>(CHAT_CLI_STRICT_MCP_CONFIG_KEY, false) === true;
        const includeVscodeMcpJson = config.get<boolean>(CHAT_CLI_INCLUDE_VSCODE_MCP_JSON_KEY, true) !== false;
        const mergedMcpServers = this.mergeWithVscodeMcpJson(mcpServers, includeVscodeMcpJson);
        const skills = this.normalizeSkills(config.get<unknown>(CHAT_CLI_SKILLS_KEY, undefined));
        // 双 CLI 路由方案下，旧 llsExpert MCP server 已被废弃；这里仅在用户
        // 历史 settings.json / mcp.json 残留同名条目时兜底剥除，防止 Claude CLI
        // 试图启动一条已不存在的 stdio 子进程。
        const expertMode = readExpertConfigFromVscode();
        const compactionMode = readCompactionConfigFromVscode();
        const planMode = readPlanConfigFromVscode();
        const reviewMode = readReviewConfigFromVscode();
        const browserToolsEnabled = config.get<boolean>(CHAT_BROWSER_TOOLS_ENABLED_KEY, true) !== false
            && vscode.env.uiKind === vscode.UIKind.Desktop;
        const vscodeToolsGetErrorsEnabled = config.get<boolean>(VSCODE_TOOLS_GET_ERRORS_ENABLED_KEY, true) !== false;
        const builtinMcpEnabled: ReadonlyArray<[McpBridgeDescriptor, boolean]> = [
            [BROWSER_BRIDGE, browserToolsEnabled],
            [VSCODE_BRIDGE, vscodeToolsGetErrorsEnabled],
            [WAKEUP_BRIDGE, true]
        ];
        const finalMcpServers = builtinMcpEnabled.reduce<ChatCliConfig['mcpServers']>(
            (servers, [descriptor, enabled]) => injectBuiltinMcpServer(servers, descriptor, enabled, undefined),
            stripExpertServerFromMcp(mergedMcpServers)
        );
        return {
            enabled: config.get<boolean>(CHAT_ENABLED_KEY, false),
            cliPath: config.get<string>(CHAT_CLI_PATH_KEY, '').trim(),
            cliArgs: this.normalizeArgs(config.get<unknown[]>(CHAT_CLI_ARGS_KEY, [])),
            model: this.resolveCurrentModelArgument(),
            cwd: this.resolveCwd(config.get<string>(CHAT_CLI_CWD_KEY, '').trim()),
            transport,
            cliEnv: transport === 'streamJsonStdio'
                ? { ...DEFAULT_STREAM_JSON_ENV, ...userEnv }
                : userEnv,
            permissionMode,
            mcpServers: finalMcpServers && Object.keys(finalMcpServers).length > 0 ? finalMcpServers : undefined,
            strictMcpConfig: strictMcpConfig || undefined,
            skills,
            expertMode,
            compactionMode,
            planMode,
            reviewMode
        };
    }

    /**
     * 异步读取当前 Chat CLI 配置，并把本地 Relay 的运行时变量注入到 CLI 环境。
     *
     * @param relayPort 本地 HTTP 中转服务实际监听端口。
     * @returns 已补齐 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 等变量的配置。
     */
    public async getConfigWithRelayEnv(relayPort: number): Promise<ChatCliConfig> {
        const config = this.getConfig();
        const relayEnv = this.resolveRelayEnv(relayPort, 'normal');
        return {
            ...config,
            cliEnv: {
                ...config.cliEnv,
                ...relayEnv
            }
        };
    }

    /**
     * 派生「四 CLI 路由」方案下可能启动的 Chat CLI 配置。
     *
     * @param relayPort 本地 HTTP 中转服务实际监听端口。
     * @returns 已派生好的 normal / expert / plan / review 配置。
     */
    public async getRoutedConfigsWithRelayEnv(relayPort: number): Promise<{
        normal: ChatCliConfig;
        expert: ChatCliConfig | undefined;
        plan: ChatCliConfig | undefined;
        review: ChatCliConfig | undefined;
    }> {
        const baseConfig = await this.getConfigWithRelayEnv(relayPort);
        const vsCfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const dispatcherPromptOverride = (vsCfg.get<string>(CHAT_DISPATCHER_APPEND_SYSTEM_PROMPT_KEY, '') || '').trim();
        const expertPromptOverride = (vsCfg.get<string>(CHAT_EXPERT_APPEND_SYSTEM_PROMPT_KEY, '') || '').trim();
        const planPromptOverride = (vsCfg.get<string>(CHAT_PLAN_APPEND_SYSTEM_PROMPT_KEY, '') || '').trim();
        const reviewPromptOverride = (vsCfg.get<string>(CHAT_REVIEW_APPEND_SYSTEM_PROMPT_KEY, '') || '').trim();

        const planAvailable = !!(baseConfig.planMode?.enabled && baseConfig.planMode?.model);
        const expertAvailable = !!(baseConfig.expertMode?.enabled && baseConfig.expertMode?.model);
        const dispatcherPrompt = dispatcherPromptOverride.length > 0
            ? dispatcherPromptOverride
            : DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT;
        const planSuffix = planAvailable
            ? DISPATCHER_PLAN_ROUTING_PRIORITY + '\n' + DISPATCHER_PLAN_REVIEW_PROMPT
            : '';
        const browserToolsEnabled = baseConfig.mcpServers?.[BROWSER_BRIDGE.serverName] !== undefined;
        const vscodeToolsGetErrorsEnabled = baseConfig.mcpServers?.[VSCODE_BRIDGE.serverName] !== undefined;
        const wakeupToolsEnabled = baseConfig.mcpServers?.[WAKEUP_BRIDGE.serverName] !== undefined;
        const builtinMcpEnabled: ReadonlyArray<[McpBridgeDescriptor, boolean]> = [
            [BROWSER_BRIDGE, browserToolsEnabled],
            [VSCODE_BRIDGE, vscodeToolsGetErrorsEnabled],
            [WAKEUP_BRIDGE, wakeupToolsEnabled]
        ];
        const normal: ChatCliConfig = {
            ...baseConfig,
            mcpServers: injectAskExpertMcpServer(
                builtinMcpEnabled.reduce<ChatCliConfig['mcpServers']>(
                    (servers, [descriptor, enabled]) => injectBuiltinMcpServer(servers, descriptor, enabled, relayPort),
                    baseConfig.mcpServers
                ),
                expertAvailable
            ),
            appendSystemPrompt: dispatcherPrompt + planSuffix
        };

        // 按需专家方案：expert 不再常驻 CLI，按需通过 ask_expert MCP 工具触发。
        // 这里保留旧 buildRoutedModeConfig 调用路径以便兼容历史 caller，但 normal CLI
        // 才是唯一会被启动的常驻进程。
        const expert = expertPromptOverride.length > 0
            ? this.buildRoutedModeConfig(
                baseConfig,
                baseConfig.expertMode,
                'expert',
                expertPromptOverride,
                LEGACY_EXPERT_APPEND_SYSTEM_PROMPT
            )
            : undefined;
        const plan = this.buildRoutedModeConfig(
            baseConfig,
            baseConfig.planMode,
            'plan',
            planPromptOverride,
            DEFAULT_PLAN_APPEND_SYSTEM_PROMPT
        );
        const review = this.buildRoutedModeConfig(
            baseConfig,
            baseConfig.reviewMode,
            'review',
            reviewPromptOverride,
            DEFAULT_REVIEW_APPEND_SYSTEM_PROMPT
        );

        return { normal, expert, plan, review };
    }

    /**
     * 派生「双 CLI 路由」兼容配置。
     *
     * @param relayPort 本地 HTTP 中转服务实际监听端口。
     * @returns 已派生好的 normal / expert 配置，附带 plan / review 兼容字段。
     */
    public async getDualConfigsWithRelayEnv(relayPort: number): Promise<{
        normal: ChatCliConfig;
        expert: ChatCliConfig | undefined;
        plan: ChatCliConfig | undefined;
        review: ChatCliConfig | undefined;
    }> {
        return this.getRoutedConfigsWithRelayEnv(relayPort);
    }

    /**
     * 构造单个非 normal 路由模型的 CLI 配置。
     *
     * @param baseConfig 已注入 relay env 的基础配置。
     * @param selection 路由模型配置。
     * @param roleEnvValue 注入给 relay 的角色值。
     * @param promptOverride 用户配置的 system prompt 覆盖。
     * @param defaultPrompt 默认 system prompt。
     * @returns 路由 CLI 配置；未启用或模型为空时返回 undefined。
     */
    private buildRoutedModeConfig(
        baseConfig: ChatCliConfig,
        selection: ChatCliConfig['expertMode'],
        route: ChatRoute,
        promptOverride: string,
        defaultPrompt: string
    ): ChatCliConfig | undefined {
        if (!selection?.enabled || !selection.model) {
            return undefined;
        }
        const modelId = selection.model;
        const routedEnv: Record<string, string> = {
            ...this.withRelayRoute(baseConfig.cliEnv, route),
            ANTHROPIC_MODEL: modelId
        };
        // 路由模型可能和 normal 模型上下文长度不同，需按自己的配置覆盖继承来的值。
        const routedContextTokens = this.resolveMaxContextTokensForRoutedModel(modelId);
        if (routedContextTokens) {
            routedEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(routedContextTokens);
        } else {
            delete routedEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
        }
        return {
            ...baseConfig,
            model: modelId,
            cliEnv: routedEnv,
            mcpServers: stripExpertServerFromMcp(baseConfig.mcpServers),
            strictMcpConfig: true,
            appendSystemPrompt: promptOverride.length > 0 ? promptOverride : defaultPrompt
        };
    }

    /**
     * 按 `providerId/modelId` 读取该模型手填的上下文长度。
     *
     * @param routedModelId 中转模型 ID，格式为 `providerId/modelId`。
     * @returns 上下文 token 上限；未配置或非法时返回 undefined。
     */
    private resolveMaxContextTokensForRoutedModel(routedModelId: string): number | undefined {
        const separator = routedModelId.indexOf('/');
        if (separator <= 0) return undefined;
        const providerId = routedModelId.slice(0, separator);
        const modelId = routedModelId.slice(separator + 1);
        if (!modelId) return undefined;
        const contextLength = this.configManager?.getProviderModel(providerId, modelId)?.contextLength;
        if (typeof contextLength !== 'number' || !Number.isFinite(contextLength) || contextLength <= 0) {
            return undefined;
        }
        return Math.floor(contextLength);
    }

    /**
     * 把用户选择的 CLI 路径保存到 machine-overridable 配置层级。
     *
     * @param cliPath 用户选择且已校验的 CLI 可执行文件路径。
     */
    public async updateCliPath(cliPath: string): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .update(CHAT_CLI_PATH_KEY, cliPath, vscode.ConfigurationTarget.Global);
    }

    /**
     * 在用户手动选定 CLI 后启用 Chat 功能。
     *
     * @param enabled 是否启用内置 Chat。
     */
    public async updateEnabled(enabled: boolean): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .update(CHAT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    }

    /**
     * 更新 Chat CLI 权限模式配置。
     *
     * 该配置会在下一次启动 CLI 时转换为 `--permission-mode <mode>` 参数，调用方
     * 通常会在更新后立即重启 Chat CLI 让配置生效。
     *
     * @param mode Claude CLI 权限模式。
     */
    public async updatePermissionMode(mode: ChatCliPermissionMode): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .update(CHAT_CLI_PERMISSION_MODE_KEY, mode, vscode.ConfigurationTarget.Workspace);
    }

    /**
     * 更新 Chat CLI MCP servers 配置。
     *
     * 写入后下一次启动 CLI 会以 `--mcp-config '{"mcpServers":...}'` 形式注入；
     * 调用方通常会在更新后立即重启 Chat CLI 让配置生效。
     *
     * @param servers MCP server 字典；传入空对象等价于清空。
     * @param target VS Code 配置作用域，默认写入工作区。
     */
    public async updateMcpServers(
        servers: Record<string, McpServerConfig>,
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace
    ): Promise<void> {
        const normalized = this.normalizeMcpServers(servers as Record<string, unknown>);
        await vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .update(CHAT_CLI_MCP_SERVERS_KEY, normalized, target);
    }

    /**
     * 更新 Chat CLI `--strict-mcp-config` 开关。
     *
     * 写入后下一次启动 CLI 会附加 `--strict-mcp-config` 参数（true 时），用于让
     * Claude CLI 忽略其它 MCP 配置来源（如 `.mcp.json`）。
     *
     * @param strict 是否启用严格 MCP 模式。
     * @param target VS Code 配置作用域，默认写入工作区。
     */
    public async updateStrictMcpConfig(
        strict: boolean,
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace
    ): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .update(CHAT_CLI_STRICT_MCP_CONFIG_KEY, strict, target);
    }

    /**
     * 更新 Chat CLI 技能（skills）配置。
     *
     * 写入后下一次启动 CLI 会向 `--allowedTools` 注入 `Skill` 或 `Skill(name)` 条目。
     *
     * @param skills `"all"` / 名称数组 / `undefined`。
     * @param target VS Code 配置作用域，默认写入工作区。
     */
    public async updateSkills(
        skills: 'all' | string[] | undefined,
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace
    ): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .update(CHAT_CLI_SKILLS_KEY, skills ?? null, target);
    }

    /**
     * 解析 CLI 子进程工作目录。
     *
     * @param configuredCwd 用户在配置中显式填写的工作目录。
     * @returns 可传给 child_process.spawn 的 cwd。
     */
    private resolveCwd(configuredCwd: string): string {
        if (configuredCwd) return configuredCwd;
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri) {
            const folder = vscode.workspace.getWorkspaceFolder(activeUri);
            if (folder) return folder.uri.fsPath;
        }
        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        if (firstFolder) return firstFolder.uri.fsPath;
        return os.homedir();
    }

    /**
     * 规范化 CLI 附加参数，过滤非字符串与空字符串。
     *
     * @param args 原始配置数组。
     * @returns 可直接传给 spawn 的参数数组。
     */
    private normalizeArgs(args: unknown[] | undefined): string[] {
        if (!Array.isArray(args)) return [];
        return args
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }

    /**
     * 解析当前模型对应的 Claude CLI `--model` 参数值。
     *
    * `--model` 会进入中转服务路由逻辑，因此需要传扩展内部使用的
    * `providerId/modelId` 组合，便于中转端按提供商和模型分发请求。
     *
     * @returns 当前模型 ID；没有当前模型时返回 undefined。
     */
    private resolveCurrentModelArgument(): string | undefined {
        const current = this.configManager?.getCurrentModel();
        if (!current?.providerId || !current.modelId) return undefined;
        return this.buildRoutedModelId(current.providerId, current.modelId);
    }

    /**
     * 根据当前模型选择和本地 Relay 端口构造 Claude CLI 兼容环境变量。
     *
     * Claude CLI 只请求本地 Relay；真正的 Provider baseUrl / key / headers
     * 由 Relay 根据 `providerId/modelId` 在服务端读取并转发。
     *
     * @param relayPort 本地 HTTP 中转服务实际监听端口。
     * @param route 当前 CLI 路由。
     * @returns 适合合并进 child_process.spawn env 的环境变量字典。
     */
    private resolveRelayEnv(relayPort: number, route: ChatRoute): Record<string, string> {
        const current = this.configManager?.getCurrentModel();
        const modelId = current?.providerId && current.modelId
            ? this.buildRoutedModelId(current.providerId, current.modelId)
            : undefined;
        return this.buildRelayEnv(relayPort, modelId, route, this.resolveMaxContextTokens());
    }

    /**
     * 读取当前模型在配置面板手填的"上下文长度"，用于同步给 Claude CLI。
     *
     * CLI 不认识扩展的 provider 配置，只会用内置默认窗口（200000）推算自动压缩线，
     * 于是插件按用户配置算的阈值和 CLI 自己的触发线各算各的。未配置时返回
     * undefined，让 CLI 保持默认行为。
     *
     * @returns 上下文 token 上限；未配置或非法时返回 undefined。
     */
    private resolveMaxContextTokens(): number | undefined {
        const current = this.configManager?.getCurrentModel();
        if (!current?.providerId || !current.modelId) return undefined;
        const model = this.configManager?.getProviderModel(current.providerId, current.modelId);
        const contextLength = model?.contextLength;
        if (typeof contextLength !== 'number' || !Number.isFinite(contextLength) || contextLength <= 0) {
            return undefined;
        }
        return Math.floor(contextLength);
    }

    /**
     * 构造中转服务识别的带提供商前缀模型 ID。
     *
     * @param providerId 当前模型所属提供商 ID。
     * @param modelId 当前模型 ID。
     * @returns `providerId/modelId` 格式的中转模型 ID。
     */
    private buildRoutedModelId(providerId: string, modelId: string): string {
        return `${providerId}/${modelId}`;
    }

    /**
     * 将本地 Relay 配置映射为 Claude CLI 识别的 ANTHROPIC_* 环境变量。
     *
     * @param relayPort 本地 HTTP 中转服务实际监听端口。
     * @param modelId 当前中转模型 ID，格式为 `providerId/modelId`。
     * @param maxContextTokens 用户配置的上下文 token 上限；undefined 时不注入。
     * @returns 环境变量字典。
     */
    private buildRelayEnv(
        relayPort: number,
        modelId: string | undefined,
        route: ChatRoute,
        maxContextTokens?: number
    ): Record<string, string> {
        const env: Record<string, string> = {
            CLAUDE_CODE_SKIP_AUTH_LOGIN: '1',
            CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayPort}/${route}`,
            ANTHROPIC_AUTH_TOKEN: 'claude-code-relay',
            ANTHROPIC_API_KEY: 'claude-code-relay'
        };
        if (modelId) {
            env.ANTHROPIC_MODEL = modelId;
        }
        if (maxContextTokens) {
            // CLI 按此值推算自动压缩线，和插件 token 计量条共用同一个上限。
            env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(maxContextTokens);
        }
        return env;
    }

    /**
     * 将已注入的 Relay 环境变量重新绑定到指定 CLI route path。
     *
     * @param env 基础 CLI 环境变量。
     * @param route 目标 CLI 路由。
     * @returns 带 route-specific `ANTHROPIC_BASE_URL` 的环境变量。
     */
    private withRelayRoute(env: Record<string, string>, route: ChatRoute): Record<string, string> {
        const baseUrl = env.ANTHROPIC_BASE_URL || '';
        const routedBaseUrl = baseUrl.replace(/\/(normal|expert|plan|review)$/, '');
        return {
            ...env,
            ANTHROPIC_BASE_URL: `${routedBaseUrl}/${route}`
        };
    }

    /**
     * 规范化 CLI 环境变量配置，过滤非字符串键值。
     *
     * @param env 原始对象配置。
     * @returns 可合并到 process.env 的字符串字典。
     */
    private normalizeEnv(env: Record<string, unknown> | undefined): Record<string, string> {
        if (!env || typeof env !== 'object') return {};
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
            if (!key || typeof value !== 'string') continue;
            normalized[key] = value;
        }
        return normalized;
    }

    /**
     * 规范化通信通道，非法值回落到 streamJsonStdio。
     *
     * @param transport 原始配置值。
     * @returns 支持的通信通道。
     */
    private normalizeTransport(transport: string | undefined): ChatCliTransport {
        if (transport === 'streamJsonStdio' || transport === 'printStdio' || transport === 'pty') {
            return transport;
        }
        return DEFAULT_TRANSPORT;
    }

    /**
     * 规范化 Claude CLI 权限模式配置；非法值回落到默认 acceptEdits。
     *
     * 仅接受 Claude CLI `--permission-mode` 文档中允许的取值。配置中填入未知模式时
     * 不会抛错，避免阻塞 Chat 启动；保留 Logger 的边界由调用方处理。
     *
     * @param mode 用户在 settings.json 中填入的原始模式字符串。
     * @returns 合法的 ChatCliPermissionMode 值。
     */
    private normalizePermissionMode(mode: string | undefined): ChatCliPermissionMode {
        const trimmed = (mode ?? '').trim() as ChatCliPermissionMode;
        if (VALID_PERMISSION_MODES.has(trimmed)) return trimmed;
        return DEFAULT_PERMISSION_MODE;
    }

    /**
     * 规范化 MCP servers 配置字典。
     *
     * - 跳过 key 为空、value 非对象、value 为 null/数组 的项；
     * - 对每个 server 仅保留字符串类型字段（type / command / url / cwd）与可序列化字段
     *   （args 必须为字符串数组、env / headers 必须为字符串值字典），其它键原样透传以
     *   保证与未来 Claude CLI 字段保持前向兼容；
     * - 异常项会被静默丢弃，避免阻塞 Chat 启动。
     *
     * @param raw 原始配置对象。
     * @returns 规范化后的 MCP servers 字典；非法/空时返回空对象。
     */
    private normalizeMcpServers(raw: Record<string, unknown> | undefined): Record<string, McpServerConfig> {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const normalized: Record<string, McpServerConfig> = {};
        for (const [key, value] of Object.entries(raw)) {
            const name = (key ?? '').trim();
            if (!name) continue;
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const source = value as Record<string, unknown>;
            const server: McpServerConfig = {};
            for (const [field, fieldValue] of Object.entries(source)) {
                if (fieldValue === undefined || fieldValue === null) continue;
                switch (field) {
                    case 'args': {
                        if (Array.isArray(fieldValue)) {
                            server.args = fieldValue.filter((item): item is string => typeof item === 'string');
                        }
                        break;
                    }
                    case 'env':
                    case 'headers': {
                        const dict = this.normalizeEnv(fieldValue as Record<string, unknown>);
                        if (Object.keys(dict).length > 0) (server as Record<string, unknown>)[field] = dict;
                        break;
                    }
                    case 'type':
                    case 'command':
                    case 'url':
                    case 'cwd': {
                        if (typeof fieldValue === 'string' && fieldValue.length > 0) {
                            (server as Record<string, unknown>)[field] = fieldValue;
                        }
                        break;
                    }
                    default: {
                        // 透传其余可 JSON 序列化字段，保持与 Claude CLI 新字段的前向兼容。
                        (server as Record<string, unknown>)[field] = fieldValue;
                    }
                }
            }
            normalized[name] = server;
        }
        return normalized;
    }

    /**
     * 规范化 skills 配置。
     *
     * - 字符串 `"all"`（忽略大小写）映射为 `'all'`；
     * - 数组按字符串去重并过滤空值；空数组返回 `undefined`；
     * - 其它非法输入返回 `undefined`。
     *
     * @param raw 原始配置值。
     * @returns 规范化后的 skills 配置。
     */
    private normalizeSkills(raw: unknown): 'all' | string[] | undefined {
        if (typeof raw === 'string') {
            return raw.trim().toLowerCase() === 'all' ? 'all' : undefined;
        }
        if (!Array.isArray(raw)) return undefined;
        const seen = new Set<string>();
        const list: string[] = [];
        for (const item of raw) {
            if (typeof item !== 'string') continue;
            const trimmed = item.trim();
            if (!trimmed || seen.has(trimmed)) continue;
            seen.add(trimmed);
            list.push(trimmed);
        }
        return list.length > 0 ? list : undefined;
    }

    /**
     * 把 `chat.mcpServers` 与 VS Code mcp.json 合并。
     *
     * 优先级（从高到低，前者同名 key 覆盖后者）：
     * 1. `chat.mcpServers`：扩展自身配置；
     * 2. 工作区 `.vscode/mcp.json`；
     * 3. 用户区 `mcp.json`（VS Code User 目录）。
     *
     * 当 `includeVscodeMcpJson=false` 时跳过工作区/用户区两个文件，行为退化为只读扩展配置。
     *
     * 文件来源同时支持 VS Code 标准的顶层 `servers` 字段，以及 Claude CLI 风格的
     * `mcpServers` 字段（向前兼容），具体由 `mcpJsonLoader.normalizeServersField` 处理。
     *
     * @param extensionServers 扩展配置中读取并已规范化的 server 字典。
     * @param includeVscodeMcpJson 是否合并 VS Code mcp.json。
     * @returns 合并后的 server 字典。
     */
    private mergeWithVscodeMcpJson(
        extensionServers: Record<string, McpServerConfig>,
        includeVscodeMcpJson: boolean
    ): Record<string, McpServerConfig> {
        if (!includeVscodeMcpJson) return extensionServers;
        const workspaceFolder = workspaceFolderResolver.resolve();
        const results = loadAllVscodeMcpJsons(workspaceFolder);
        const workspaceServers = results.find((item) => item.source === 'workspace')?.servers;
        const userServers = results.find((item) => item.source === 'user')?.servers;
        return mergeMcpServers(extensionServers, workspaceServers, userServers);
    }
}

/**
 * 从 mcpServers 字典中剥除内置 `llsExpert` server。
 *
 * 双 CLI 路由方案下旧 expert MCP 链路已废弃，但用户的 settings.json /
 * .vscode/mcp.json 中可能仍残留同名条目。本函数兜底剥除，防止 Claude CLI
 * 试图启动一条已不存在的 stdio 子进程。
 *
 * 若结果为空对象则返回 `undefined`，保持 `ChatCliConfig.mcpServers` 字段
 * 「空即省略」的语义（避免下游 cliProcess 拼出 `--mcp-config '{"mcpServers":{}}'`）。
 *
 * @param mcpServers 原始 mcpServers 字典（可能为 undefined）。
 * @returns 已剥除 `llsExpert` 的新字典；为空时返回 undefined。
 */
function stripExpertServerFromMcp(
    mcpServers: ChatCliConfig['mcpServers']
): ChatCliConfig['mcpServers'] {
    if (!mcpServers) {
        return undefined;
    }
    const next: NonNullable<ChatCliConfig['mcpServers']> = {};
    for (const [name, server] of Object.entries(mcpServers)) {
        if (name === 'llsExpert') continue;
        next[name] = server;
    }
    return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 按需专家方案下，根据专家配置是否可用，向 mcpServers 字典注入 askExpert MCP server。
 *
 * 注入策略：
 * - `expertAvailable=true`：增加一个 stdio 类型的 server，命令由扩展宿主进程通过
 *   `process.execPath`（Node 可执行路径） + 一段内嵌脚本启动；实际的 MCP server
 *   实现位于 `src/expertMode/askExpertMcpServer.ts`，由 extension.ts 在
 *   activate 时通过另一个机制（如直接 ChildProcess.fork）启动并接管 stdio。
 * - `expertAvailable=false`：不注入，主模型也就看不到 `ask_expert` 工具，提示词中
 *   关于专家的段落会被自然忽略。
 *
 * 该函数同时会先调用 {@link stripExpertServerFromMcp} 兜底剥除历史残留。
 */
function injectAskExpertMcpServer(
    mcpServers: ChatCliConfig['mcpServers'],
    expertAvailable: boolean
): ChatCliConfig['mcpServers'] {
    const cleaned = stripExpertServerFromMcp(mcpServers);
    if (!expertAvailable) {
        return cleaned;
    }
    const next: NonNullable<ChatCliConfig['mcpServers']> = { ...(cleaned ?? {}) };
    if (!next[ASK_EXPERT_MCP_SERVER_NAME]) {
        // 由 extension.ts 在创建子进程时填充真实 command / args / env；
        // 这里只占位以便 Claude CLI 能在 tools/list 阶段感知到该 server。
        next[ASK_EXPERT_MCP_SERVER_NAME] = {
            type: 'stdio',
            command: process.execPath,
            args: ['__LLS_ASK_EXPERT_PLACEHOLDER__']
        };
    }
    return next;
}

/**
 * 按 descriptor 向 mcpServers 字典注入一个内置 MCP server。
 *
 * 三套桥（browser / vscode / wakeup）此前各有一份逐字相同的注入函数与入口脚本
 * 构造函数，这里合并为一个，差异全部由 descriptor 承载。
 *
 * @param mcpServers 已规范化并剥除历史 expert server 的 MCP server 字典。
 * @param descriptor 该套桥的静态声明。
 * @param enabled 是否允许注入；为 false 时原样返回。
 * @param relayPort 本地 HTTP 中转服务实际监听端口。
 * @returns 注入后的字典；没有任何 server 时返回 undefined。
 */
function injectBuiltinMcpServer(
    mcpServers: ChatCliConfig['mcpServers'],
    descriptor: McpBridgeDescriptor,
    enabled: boolean,
    relayPort: number | undefined
): ChatCliConfig['mcpServers'] {
    if (!enabled) {
        return mcpServers;
    }
    const { serverName, relayPortEnv } = descriptor;
    const next: NonNullable<ChatCliConfig['mcpServers']> = { ...(mcpServers ?? {}) };
    if (!next[serverName]) {
        next[serverName] = {
            type: 'stdio',
            command: process.execPath,
            args: ['-e', buildBuiltinMcpEntrypointScript(descriptor)],
            env: relayPort ? { [relayPortEnv]: String(relayPort) } : undefined
        };
    } else if (relayPort) {
        next[serverName] = {
            ...next[serverName],
            env: {
                ...(next[serverName].env ?? {}),
                [relayPortEnv]: String(relayPort)
            }
        };
    }
    return next;
}

/**
 * 建立内置 MCP server 的子进程入口脚本。
 *
 * @param descriptor 该套桥的静态声明，提供入口模块与启动函数名。
 * @returns `node -e` 执行的一行脚本。
 */
function buildBuiltinMcpEntrypointScript(descriptor: McpBridgeDescriptor): string {
    const entry = require.resolve(descriptor.entryModule);
    return `require(${JSON.stringify(entry)}).${descriptor.entryStarter}();`;
}
