/** @file LLS CCAI 全局常量。 */

/** 提供商列表持久化 key。 */
export const PROVIDERS_STATE_KEY = 'claudeRouter.providers';

/** 当前模型持久化 key。 */
export const CURRENT_MODEL_STATE_KEY = 'claudeRouter.currentModel';

/** 中转配置持久化 key。 */
export const RELAY_STATE_KEY = 'claudeRouter.relay';

/** 提供商 API Key 在 SecretStorage 中的 key 前缀。 */
export const PROVIDER_API_KEY_SECRET_PREFIX = 'claudeRouter.providerApiKey.';

/** 默认本地中转端口。 */
export const DEFAULT_RELAY_PORT = 17783;

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
    'CLAUDE_CODE_SKIP_AUTH_LOGIN'
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

/**
 * 本扩展自身的 configuration 命名空间（用于读取 autoReloadWindow 等开关）。
 */
export const CONFIG_NAMESPACE = 'claudeCodeConfigHelper';

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
    /** 重启本地中转服务。 */
    restartRelay: 'claudeRouter.restartRelay',
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
