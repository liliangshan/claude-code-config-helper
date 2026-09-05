/** @file LLS CCAI 全局常量。 */

/** 提供商列表持久化 key。 */
export const PROVIDERS_STATE_KEY = 'claudeRouter.providers';

/** 当前模型持久化 key。 */
export const CURRENT_MODEL_STATE_KEY = 'claudeRouter.currentModel';

/** 当前 Chat 模型配置字段：claudeCodeConfigHelper.chat.currentModel。 */
export const CHAT_CURRENT_MODEL_KEY = 'chat.currentModel';

/** 默认本地中转端口；0 表示启动时由操作系统随机分配一个空闲端口。 */
export const DEFAULT_RELAY_PORT = 0;

/** 提供商 API Key 在 SecretStorage 中的 key 前缀。 */
export const PROVIDER_API_KEY_SECRET_PREFIX = 'claudeRouter.providerApiKey.';

/**
 * 写入 `claudeCode.environmentVariables` 时插入的"托管标记"条目名。
 *
 * 用于标识从这条开始到下一个非托管变量之前的区间，都是本扩展写入的，
 * 后续切换 / 取消激活时可以安全地清除而不破坏用户手加的变量。
 */
export const MANAGED_MARKER = '__CLAUDE_ROUTER_MANAGED__';

/**
 * 已知由本扩展管理的环境变量名集合。
 *
 * stripManagedVars 在遇到 MANAGED_MARKER 后，连续清理这些名字的变量，
 * 直到遇到不在此集合的条目为止（保守清理策略）。
 *
 * 注意：用户自定义 `extraEnvVars` 不在此列，由 marker + 邻接区间识别。
 */
export const MANAGED_ENV_KEYS: ReadonlySet<string> = new Set<string>([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_MODEL',
    'CLAUDE_CODE_SKIP_AUTH_LOGIN',
    'CLAUDE_CODE_SKIP_MODEL_VALIDATION'
]);

/**
 * Claude Code 扩展使用的 configuration 命名空间。
 * 通过 `vscode.workspace.getConfiguration(CLAUDE_CODE_NAMESPACE)` 访问。
 */
export const CLAUDE_CODE_NAMESPACE = 'claudeCode';

/**
 * Claude Code 扩展的设置项 key：环境变量数组。
 */
export const CLAUDE_CODE_ENV_VARS_KEY = 'environmentVariables';

/**
 * Claude Code 扩展的设置项 key：是否禁用 OAuth 登录提示。
 */
export const CLAUDE_CODE_DISABLE_LOGIN_PROMPT_KEY = 'disableLoginPrompt';

/** Claude Code 扩展的设置项 key：新会话初始权限模式。 */
export const CLAUDE_CODE_INITIAL_PERMISSION_MODE_KEY = 'initialPermissionMode';

/** Claude Code 扩展的设置项 key：允许危险跳过权限确认。 */
export const CLAUDE_CODE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS_KEY = 'allowDangerouslySkipPermissions';

/**
 * 本扩展自身的 configuration 命名空间（用于读取 autoReloadWindow 等开关）。
 */
export const CONFIG_NAMESPACE = 'claudeCodeConfigHelper';

/** 本扩展任务流危险权限开关字段：claudeCodeConfigHelper.taskFlowBypassPermissions。 */
export const TASK_FLOW_BYPASS_PERMISSIONS_KEY = 'taskFlowBypassPermissions';

/** Relay 请求 messages 调试落盘开关的配置键。 */
export const RELAY_DEBUG_RECORD_KEY = 'relay.debugRecord';

/** 任务流发送目标配置字段：claudeCodeConfigHelper.taskFlow.target。 */
export const TASK_FLOW_TARGET_KEY = 'taskFlow.target';

/**
 * 任务流模型（工作区级）：claudeCodeConfigHelper.chat.taskFlow.model。
 *
 * 形如 `providerId/modelId`；为空表示未配置，此时任务流回退到当前主模型。
 * 仅写入 workspace 作用域，不写全局。
 */
export const CHAT_TASK_FLOW_MODEL_KEY = 'chat.taskFlow.model';

/** 内置 Chat Webview 配置字段前缀：claudeCodeConfigHelper.chat。 */
export const CHAT_CONFIG_SECTION = 'chat';

/** Chat Webview 是否启用的配置字段：claudeCodeConfigHelper.chat.enabled。 */
export const CHAT_ENABLED_KEY = 'chat.enabled';

/** Chat CLI 可执行文件路径配置字段：claudeCodeConfigHelper.chat.cliPath。 */
export const CHAT_CLI_PATH_KEY = 'chat.cliPath';

/** Chat 缓存时长在 globalState 中的持久化 key（不再暴露为 VS Code 设置项）。 */
export const CHAT_CACHE_TTL_STATE_KEY = 'claudeRouter.chatCacheTtl';

/** 子智能体开关在扩展 workspaceState 中的持久化 key，未设置时默认关闭。 */
export const CHAT_SUBAGENTS_ENABLED_STATE_KEY = 'claudeRouter.chatSubagentsEnabled';

/** Chat 缓存时长允许的取值。`default` 表示不改写、沿用客户端原样（系统默认 5m）。 */
export type ChatCacheTtl = 'default' | '1h' | '5m';

/** Chat 缓存时长缺省值：default 即不改写请求里的缓存断点，规避上游网关注入 5m 引发的 1h-after-5m 400。 */
export const CHAT_CACHE_TTL_DEFAULT: ChatCacheTtl = 'default';

/** Chat CLI 附加参数配置字段：claudeCodeConfigHelper.chat.cliArgs。 */
export const CHAT_CLI_ARGS_KEY = 'chat.cliArgs';

/** Chat CLI 工作目录配置字段：claudeCodeConfigHelper.chat.cliCwd。 */
export const CHAT_CLI_CWD_KEY = 'chat.cliCwd';

/** Chat CLI 通信通道配置字段：claudeCodeConfigHelper.chat.transport。 */
export const CHAT_TRANSPORT_KEY = 'chat.transport';

/** Chat CLI 附加环境变量配置字段：claudeCodeConfigHelper.chat.cliEnv。 */
export const CHAT_CLI_ENV_KEY = 'chat.cliEnv';

/**
 * Chat CLI 权限模式配置字段：claudeCodeConfigHelper.chat.permissionMode。
 *
 * 取值与 Claude CLI `--permission-mode` 参数一致：
 * - `default`            需要授权的工具会被 CLI 拒绝（在 --bare --print 模式下无法弹窗）
 * - `acceptEdits`        自动接受所有编辑类工具（推荐默认）
 * - `bypassPermissions`  跳过所有权限检查（完全信任，仅在沙箱环境使用）
 * - `auto` / `dontAsk`   其他 CLI 支持的取值
 * - `plan`               仅规划，不执行修改
 */
export const CHAT_CLI_PERMISSION_MODE_KEY = 'chat.permissionMode';

/**
 * Chat CLI MCP servers 配置字段：claudeCodeConfigHelper.chat.mcpServers。
 *
 * 与 Claude CLI `--mcp-config` / `.mcp.json` 结构兼容，参考 Claude Code 官方扩展
 * (`anthropic.claude-code` 2.1.x) 的传递方式：在 CLI 启动时以
 * `--mcp-config '{"mcpServers":{...}}'` 参数注入。值为对象，key 是 server 名，value
 * 是 `{ type, command, args, env, url, headers, cwd, ... }` 等 server 描述。
 */
export const CHAT_CLI_MCP_SERVERS_KEY = 'chat.mcpServers';

/**
 * Chat CLI 严格 MCP 配置开关：claudeCodeConfigHelper.chat.strictMcpConfig。
 *
 * 为 true 时在启动参数中追加 `--strict-mcp-config`，让 Claude CLI 只使用本扩展注入的
 * MCP servers，忽略 `.mcp.json` / 用户级 settings 中其它来源的 MCP 配置。
 */
export const CHAT_CLI_STRICT_MCP_CONFIG_KEY = 'chat.strictMcpConfig';

/**
 * Chat CLI 技能（skills）配置字段：claudeCodeConfigHelper.chat.skills。
 *
 * 与 Claude Code 官方扩展中 SDK options 的 `skills` 字段语义保持一致：
 * - `"all"`        允许全部 skills（注入 `--allowedTools Skill`）
 * - `string[]`     允许指定名称的 skills（注入 `--allowedTools Skill(name1),Skill(name2)`）
 * - 缺省 / 空数组  不向 allowedTools 注入任何 Skill 条目
 */
export const CHAT_CLI_SKILLS_KEY = 'chat.skills';

/** 浏览器工具 MCP 总开关：claudeCodeConfigHelper.chat.browserTools.enabled。 */
export const CHAT_BROWSER_TOOLS_ENABLED_KEY = 'chat.browserTools.enabled';

/** VS Code get_errors MCP 工具總開關：claudeCodeConfigHelper.vscodeTools.getErrors.enabled。 */
export const VSCODE_TOOLS_GET_ERRORS_ENABLED_KEY = 'vscodeTools.getErrors.enabled';

/**
 * 是否合并读取 VS Code 风格的 `mcp.json` 配置：claudeCodeConfigHelper.chat.includeVscodeMcpJson。
 *
 * 当为 true（默认）时，启动 Chat CLI 前会：
 * 1. 读取工作区 `.vscode/mcp.json`；
 * 2. 读取用户区 `mcp.json`（按平台位于 `~/Library/Application Support/Code/User/mcp.json` 等）；
 * 3. 与 `chat.mcpServers` 合并，由用户显式声明覆盖工作区，工作区再覆盖用户区；
 * 4. 最终通过 `--mcp-config '{"mcpServers":...}'` 注入给 Claude CLI。
 *
 * 设为 false 时只使用扩展自身配置 `chat.mcpServers`。
 */
export const CHAT_CLI_INCLUDE_VSCODE_MCP_JSON_KEY = 'chat.includeVscodeMcpJson';

export const CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY = 'chat.compactionMode.project.enabled';

/** 压缩请求专用模型 id：`claudeCodeConfigHelper.chat.compactionMode.project.model`。 */
export const CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY = 'chat.compactionMode.project.model';

/** 全局压缩请求专用模型开关：`claudeCodeConfigHelper.chat.compactionMode.global.enabled`。 */
export const CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY = 'chat.compactionMode.global.enabled';

/** 全局压缩请求专用模型 id：`claudeCodeConfigHelper.chat.compactionMode.global.model`。 */
export const CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY = 'chat.compactionMode.global.model';

/**
 * 普通 CLI（dispatcher）的 append-system-prompt 覆盖配置：
 * `claudeCodeConfigHelper.chat.dispatcher.appendSystemPrompt`。
 *
 * 双 CLI 路由方案下，普通 CLI 默认会注入一段「dispatcher 限制」系统提示词，
 * 用于把它的能力范围限制在 build/git/PR/上下文压缩等轻量工程操作；遇到复杂任务
 * 必须以 `@llsExpert` 文本切路由。本配置允许用户用自定义文案完全替换默认提示词；
 * 留空时使用扩展内置默认。
 */
export const CHAT_DISPATCHER_APPEND_SYSTEM_PROMPT_KEY = 'chat.dispatcher.appendSystemPrompt';

/**
 * 双 CLI 路由的默认初始路由值。
 *
 * 扩展激活后默认按 `'normal'` 路由。
 */
export const CHAT_ROUTE_DEFAULT = 'normal' as const;

/**
 * 本扩展所有命令 id 的集中定义。
 * 与 package.json 的 contributes.commands 保持一致。
 */
export const COMMANDS = {
    /** 打开 Webview 配置面板。 */
    openConfigPanel: 'claudeRouter.openConfigPanel',
    /** 在编辑器中打开用户 settings.json */
    openSettingsJson: 'claudeRouter.openSettingsJson',
    /** 打开与 OpenAPI Copilot 共享字段的全局设置面板。 */
    openGlobalSharedSettings: 'claudeRouter.openGlobalSharedSettings',
    /** 打开与 OpenAPI Copilot 共享字段的工作区设置面板。 */
    openWorkspaceSharedSettings: 'claudeRouter.openWorkspaceSharedSettings',
    /** 触发窗口重载 */
    reloadWindow: 'claudeRouter.reloadWindow',
    /** 打开内置 Chat Webview 面板。 */
    chatOpen: 'claudeRouter.chat.open',
    /** 选择或更换内置 Chat 使用的 Claude CLI 路径。 */
    chatSelectCli: 'claudeRouter.chat.selectCli',
    /** 重启内置 Chat 的 Claude CLI 长连接进程。 */
    chatRestart: 'claudeRouter.chat.restart',
    /** 刷新提供商列表。 */
    refreshProviders: 'claudeRouter.refreshProviders',
    /** 新建提供商。 */
    newProvider: 'claudeRouter.newProvider',
    /** 编辑提供商。 */
    editProviderItem: 'claudeRouter.editProviderItem',
    /** 删除提供商。 */
    deleteProviderItem: 'claudeRouter.deleteProviderItem',
    /** 切换当前模型。 */
    setCurrentModel: 'claudeRouter.setCurrentModel',
    /** 清空当前模型。 */
    clearCurrentModel: 'claudeRouter.clearCurrentModel',
    /** 复制任务流内容并粘贴到 Claude Code 聊天框。 */
    pasteTaskFlowToClaude: 'claudeRouter.pasteTaskFlowToClaude',
    /** 打开 LLS CCAI 任务流状态栏统一菜单。 */
    llsCcaiTaskOpenMenu: 'claudeRouter.llsCcaiTask.openMenu',
    /** 显示 LLS CCAI 任务流进度。 */
    llsCcaiTaskShowProgress: 'claudeRouter.llsCcaiTask.showProgress',
    /** 手动继续推进 LLS CCAI 任务流。 */
    llsCcaiTaskContinue: 'claudeRouter.llsCcaiTask.continue',
    /** 清空 LLS CCAI 任务流。 */
    llsCcaiTaskClear: 'claudeRouter.llsCcaiTask.clear',
    /** 测试"系统级模拟回车"是否可用（粘贴一段测试文本，然后模拟一次回车）。 */
    testSimulateEnter: 'claudeRouter.testSimulateEnter',
    /** 导出配置。 */
    exportConfig: 'claudeRouter.exportConfig',
    /** 导入配置。 */
    importConfig: 'claudeRouter.importConfig'
} as const;

/**
 * Activity Bar 中的 WebviewView id（与 package.json 中保持一致）。
 */
export const PROVIDERS_VIEW_ID = 'claudeRouter.providersView';

/** 右侧 Secondary Sidebar 中的 Chat WebviewView id。 */
export const CHAT_SECONDARY_VIEW_ID = 'claudeRouter.chatSidebarSecondary';

/** 右侧 Secondary Sidebar Chat 容器 id。 */
export const CHAT_SECONDARY_CONTAINER_ID = 'claudeRouterChatSecondary';

/**
 * 输出通道（OutputChannel）的显示名。
 */
export const OUTPUT_CHANNEL_NAME = 'LLS CCAI';

/**
 * WebviewPanel 的 viewType（VS Code 内部用于序列化/恢复识别）。
 */
export const WEBVIEW_VIEW_TYPE = 'claudeRouter.configPanel';

/**
 * WebviewPanel 标题。
 */
export const WEBVIEW_TITLE = 'LLS CCAI Setting';
