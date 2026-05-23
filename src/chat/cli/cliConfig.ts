/** @file 读取并规范化内置 Chat 的 CLI 配置。 */

import * as os from 'os';
import * as vscode from 'vscode';

import {
    CHAT_CLI_ARGS_KEY,
    CHAT_CLI_CWD_KEY,
    CHAT_CLI_ENV_KEY,
    CHAT_CLI_PATH_KEY,
    CHAT_CLI_PERMISSION_MODE_KEY,
    CHAT_ENABLED_KEY,
    CHAT_TRANSPORT_KEY,
    CONFIG_NAMESPACE
} from '../../constants';
import { ConfigManager } from '../../configManager';
import type { ChatCliConfig, ChatCliPermissionMode, ChatCliTransport } from './types';

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
            permissionMode
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
        const relayEnv = this.resolveRelayEnv(relayPort);
        return {
            ...config,
            cliEnv: {
                ...config.cliEnv,
                ...relayEnv
            }
        };
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
     * @returns 适合合并进 child_process.spawn env 的环境变量字典。
     */
    private resolveRelayEnv(relayPort: number): Record<string, string> {
        const current = this.configManager?.getCurrentModel();
        const modelId = current?.providerId && current.modelId
            ? this.buildRoutedModelId(current.providerId, current.modelId)
            : undefined;
        return this.buildRelayEnv(relayPort, modelId);
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
     * @returns 环境变量字典。
     */
    private buildRelayEnv(relayPort: number, modelId: string | undefined): Record<string, string> {
        const env: Record<string, string> = {
            CLAUDE_CODE_SKIP_AUTH_LOGIN: '1',
            CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayPort}`,
            ANTHROPIC_AUTH_TOKEN: 'claude-code-relay',
            ANTHROPIC_API_KEY: 'claude-code-relay'
        };
        if (modelId) {
            env.ANTHROPIC_MODEL = modelId;
        }
        return env;
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
}
