/** @file 读取并规范化内置 Chat 的 CLI 配置。 */

import * as os from 'os';
import * as vscode from 'vscode';

import {
    CHAT_CLI_ARGS_KEY,
    CHAT_CLI_CWD_KEY,
    CHAT_CLI_ENV_KEY,
    CHAT_CLI_INCLUDE_VSCODE_MCP_JSON_KEY,
    CHAT_CLI_MCP_SERVERS_KEY,
    CHAT_CLI_PATH_KEY,
    CHAT_CLI_PERMISSION_MODE_KEY,
    CHAT_CLI_SKILLS_KEY,
    CHAT_CLI_STRICT_MCP_CONFIG_KEY,
    CHAT_ENABLED_KEY,
    CHAT_TRANSPORT_KEY,
    CONFIG_NAMESPACE
} from '../../constants';
import { ConfigManager } from '../../configManager';
import {
    loadAllVscodeMcpJsons,
    logMcpJsonLoadResults,
    mergeMcpServers,
    workspaceFolderResolver
} from './mcpJsonLoader';
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
            mcpServers: Object.keys(mergedMcpServers).length > 0 ? mergedMcpServers : undefined,
            strictMcpConfig: strictMcpConfig || undefined,
            skills
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
        logMcpJsonLoadResults(results);
        const workspaceServers = results.find((item) => item.source === 'workspace')?.servers;
        const userServers = results.find((item) => item.source === 'user')?.servers;
        return mergeMcpServers(extensionServers, workspaceServers, userServers);
    }
}
