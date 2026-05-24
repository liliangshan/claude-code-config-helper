/** @file 内置 Chat CLI 相关领域类型。 */

/** 内置 Chat 支持的 CLI 通信通道。 */
export type ChatCliTransport = 'streamJsonStdio' | 'printStdio' | 'pty';

/**
 * Claude CLI `--permission-mode` 启动参数支持的取值。
 *
 * 与 Claude CLI v2.x `--help` 输出一致：
 * - `default`：CLI 默认策略（非交互模式下大部分写操作会被静默拒绝）
 * - `acceptEdits`：自动放行 Edit/Write 类编辑操作（推荐默认，避免非交互模式下卡住）
 * - `bypassPermissions`：完全跳过权限检查（最宽松，请仅在受信任工作目录使用）
 * - `auto`：CLI 自动决策
 * - `dontAsk`：不询问用户，按策略静默处理
 * - `plan`：仅规划，不执行
 */
export type ChatCliPermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'auto'
    | 'dontAsk'
    | 'plan';

/** Chat CLI 运行时配置快照。 */
export interface ChatCliConfig {
    /** 是否启用内置 Chat。 */
    enabled: boolean;
    /** 用户选择的 CLI 可执行文件路径。 */
    cliPath: string;
    /** 启动 CLI 时附加的自定义参数。 */
    cliArgs: string[];
    /** 当前选择的 Claude CLI 模型名，用于生成 --model 参数。 */
    model?: string;
    /** CLI 子进程工作目录。 */
    cwd: string;
    /** CLI 通信通道。 */
    transport: ChatCliTransport;
    /** 启动 CLI 时附加的环境变量。 */
    cliEnv: Record<string, string>;
    /**
     * Claude CLI 权限模式，会被转换为 `--permission-mode <mode>` 启动参数。
     *
     * 本插件默认使用 `acceptEdits`，以避免 `--bare --print` 非交互模式下
     * Edit/Write/Read 类工具被默认策略拦截后无法弹窗询问用户。
     */
    permissionMode?: ChatCliPermissionMode;
    /** 需要恢复的 Claude CLI session_id；为空时启动新会话。 */
    resumeSessionId?: string;
    /**
     * MCP servers 配置，结构兼容 Claude CLI `--mcp-config` / `.mcp.json`。
     *
     * 非空时启动 CLI 会追加 `--mcp-config '{"mcpServers":...}'` 参数；
     * 若用户在 `cliArgs` 中已显式提供 `--mcp-config`，将以用户值为准不重复追加。
     */
    mcpServers?: Record<string, McpServerConfig>;
    /**
     * 是否启用 `--strict-mcp-config`，让 Claude CLI 只使用本扩展注入的 MCP servers，
     * 忽略 `.mcp.json` / 用户级 settings 等其它来源。
     */
    strictMcpConfig?: boolean;
    /**
     * 技能（skills）配置。
     *
     * - `"all"`        允许全部 skills（启动参数中追加 `--allowedTools Skill`）
     * - `string[]`     允许指定名称的 skills（启动参数中追加 `--allowedTools Skill(name1),Skill(name2)`）
     * - 缺省 / 空数组  不向 allowedTools 注入任何 Skill 条目
     */
    skills?: 'all' | string[];

    /**
     * 专家模式配置（按「项目 > 全局 > 默认」三层合并后的最终结果）。
     *
     * - 由 `resolveExpertConfig()` 从 `chat.expertMode.project.*` /
     *   `chat.expertMode.global.*` 两个 scope 合并得到；
     * - 若 `enabled === true`，`ChatCliConfigService.getConfig()` 会在 `mcpServers`
     *   字典中追加内置 `llsExpert` server，使主模型可看到 `ask_expert` 工具；
     * - 该字段由专家进程的 `buildExpertConfig()` 在派生子配置时**反向移除**，
     *   防止专家递归调用专家（详见 `EXPERT_MODE_DESIGN.md` §6.3）。
     */
    expertMode?: ExpertModeConfig;
}

/**
 * 专家模式配置。
 *
 * 该类型同时被两个 scope 复用：
 * - 项目级（`resource` scope，写入 `.vscode/settings.json`）
 * - 全局级（`application` scope，写入用户设置 / Settings Sync）
 *
 * 实际运行时由 `resolveExpertConfig()` 按「项目 > 全局 > 默认」三层覆盖合并，
 * 因此本接口字段都是「已解析后」的最终值（非 `Partial`）。
 */
export interface ExpertModeConfig {
    /** 是否启用专家模式（即是否在主 CLI 工具列表中注入 `ask_expert`）。 */
    enabled: boolean;
    /**
     * 专家使用的模型 id。
     *
     * 空字符串表示「未显式选择」，ExpertRunner 会回退到主模型 id；
     * 主模型 id 也为空时认为专家模式不可用，主模型不会看到 `ask_expert` 工具。
     */
    model: string;
}

/**
 * MCP server 配置项，结构兼容 Claude CLI 与 `.mcp.json` 文档。
 *
 * 三种典型形态：
 * - **stdio**: 以子进程方式启动，提供 `command` + `args` + 可选 `env` + `cwd`
 * - **http**:  通过 HTTP 调用，提供 `type: "http"` + `url` + 可选 `headers`
 * - **sse**:   通过 SSE 推流，提供 `type: "sse"` + `url` + 可选 `headers`
 *
 * 这里使用宽松字段集合，未来 Claude CLI 新增字段也可以原样透传。
 */
export interface McpServerConfig {
    /** MCP server 类型：`stdio` / `http` / `sse` / `sdk` 等。 */
    type?: 'stdio' | 'http' | 'sse' | 'sdk' | string;
    /** stdio 类型必填：要执行的命令。 */
    command?: string;
    /** stdio 类型可选：命令参数列表。 */
    args?: string[];
    /** stdio 类型可选：附加环境变量。 */
    env?: Record<string, string>;
    /** 子进程工作目录。 */
    cwd?: string;
    /** http/sse 类型必填：MCP server URL。 */
    url?: string;
    /** http/sse 类型可选：附加请求头。 */
    headers?: Record<string, string>;
    /** 透传给 Claude CLI 的其他字段，由调用方自行保证字段合法性。 */
    [extraKey: string]: unknown;
}

/** CLI stdout/stderr 输出 chunk 来源。 */
export type CliChunkSource = 'stdout' | 'stderr';

/** CLI 原始输出 chunk。 */
export interface CliChunk {
    /** chunk 来源流。 */
    source: CliChunkSource;
    /** 解码后的文本内容。 */
    text: string;
    /** chunk 到达时间戳。 */
    receivedAt: number;
}

/** CLI 子进程退出事件。 */
export interface CliExitEvent {
    /** 进程退出码；被信号终止时可能为空。 */
    code: number | null;
    /** 终止信号；正常退出时可能为空。 */
    signal: NodeJS.Signals | null;
    /** 退出事件时间戳。 */
    exitedAt: number;
}

/** CLI 进程运行状态。 */
export type CliProcessStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';
