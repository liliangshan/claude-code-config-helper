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
