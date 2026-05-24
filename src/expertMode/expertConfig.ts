/**
 * @file 专家模式配置层：VS Code 配置读取 + 三层合并 + 专家进程配置派生。
 *
 * 三层关系（详见 `EXPERT_MODE_DESIGN.md` §8）：
 *
 *   resource 配置 (chat.expertMode.project.*)
 *        │ 项目优先
 *        ▼
 *   application 配置 (chat.expertMode.global.*)
 *        │ 全局回退
 *        ▼
 *   代码内默认 (defaultExpertModeConfig)
 *
 * 关键函数：
 * - {@link resolveExpertConfig}        纯函数三层合并（无 vscode 依赖，易于单测）
 * - {@link readExpertConfigFromVscode} 读两个 scope 后调用 resolveExpertConfig
 * - {@link buildExpertConfig}          从主 ChatCliConfig 派生出专家进程要用的 ChatCliConfig
 *
 * 整个模块**不启动任何进程、不读 mcp.json**——只做配置层的合并与变形。
 */

import * as vscode from 'vscode';
import * as path from 'path';

import {
    CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY,
    CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY,
    CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY,
    CHAT_EXPERT_MODE_PROJECT_MODEL_KEY,
    CONFIG_NAMESPACE
} from '../constants';
import {
    EXPERT_MCP_SERVER_NAME,
    EXPERT_PERMISSION_MODE,
    EXPERT_ROLE_ENV_KEY,
    EXPERT_ROLE_ENV_VALUE
} from './expertConstants';
import type { ChatCliConfig, ExpertModeConfig, McpServerConfig } from '../chat/cli/types';

/**
 * 代码内置的专家模式默认值。
 *
 * 用作 {@link resolveExpertConfig} 的最后一层兜底——只有当项目级和全局级都未显式
 * 设置时才生效。默认全部关闭，确保升级到本扩展新版本的用户不会突然多出一个工具。
 */
export const defaultExpertModeConfig: ExpertModeConfig = {
    enabled: false,
    model: ''
};

/**
 * 按「项目 > 全局 > 默认」三层覆盖合并出实际生效的专家模式配置。
 *
 * 合并规则：
 * - `enabled`：`undefined` 视为「未设置」（即只要是布尔就视为显式选择）。
 *   依次取 `projectCfg.enabled` → `globalCfg.enabled` → `defaults.enabled`。
 * - `model`：空字符串视为「未设置」（即只要是非空字符串就视为显式选择）。
 *   依次取 `projectCfg.model` → `globalCfg.model` → `defaults.model`。
 *
 * 该函数是**纯函数**，不读 vscode、不访问磁盘，方便单元测试。
 *
 * @param projectCfg 项目级配置（来自 `resource` scope，可能为部分字段或 undefined）。
 * @param globalCfg  全局级配置（来自 `application` scope，可能为部分字段或 undefined）。
 * @param defaults   代码内置默认值；通常传 {@link defaultExpertModeConfig}。
 * @returns 完整的、可直接使用的 `ExpertModeConfig`。
 */
export function resolveExpertConfig(
    projectCfg: Partial<ExpertModeConfig> | undefined,
    globalCfg: Partial<ExpertModeConfig> | undefined,
    defaults: ExpertModeConfig
): ExpertModeConfig {
    const enabled =
        firstDefinedBoolean(projectCfg?.enabled, globalCfg?.enabled) ?? defaults.enabled;
    const model =
        firstNonEmptyString(projectCfg?.model, globalCfg?.model) ?? defaults.model;
    return { enabled, model };
}

/**
 * 从 VS Code workspace 配置读取专家模式配置并合并出最终值。
 *
 * 读取的 4 个 settings key（命名空间 `claudeCodeConfigHelper`）：
 * - `chat.expertMode.project.enabled` / `.model`：scope=`resource`，写入 `.vscode/settings.json`
 * - `chat.expertMode.global.enabled`  / `.model`：scope=`application`，写入用户设置
 *
 * @returns 已三层合并好的 {@link ExpertModeConfig}。
 */
export function readExpertConfigFromVscode(): ExpertModeConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    // VS Code 的 get() 会把 defaultValue 也返回出来，无法区分「未设置」和「默认关闭」。
    // 这里必须使用 inspect() 分别读取 workspace / global 层级，保证项目未配置时
    // 能正确回退到全局配置；项目显式 false 时才视为「关闭专家」。
    const projectCfg: Partial<ExpertModeConfig> = {
        enabled: readWorkspaceBooleanOrUndefined(config, CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY),
        model: readWorkspaceStringOrUndefined(config, CHAT_EXPERT_MODE_PROJECT_MODEL_KEY)
    };
    const globalCfg: Partial<ExpertModeConfig> = {
        enabled: readGlobalBooleanOrUndefined(config, CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY),
        model: readGlobalStringOrUndefined(config, CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY)
    };

    return resolveExpertConfig(projectCfg, globalCfg, defaultExpertModeConfig);
}

/**
 * 从主进程 `ChatCliConfig` 派生出专家子进程使用的 `ChatCliConfig`。
 *
 * 派生规则（详见 `EXPERT_MODE_DESIGN.md` §4 + §6.3 防递归）：
 * - **model**：优先使用 `mainConfig.expertMode.model`，为空时回退到主模型 id；
 * - **mcpServers**：**移除 `llsExpert`** 防止专家递归调用专家；
 * - **strictMcpConfig**：强制 `true`，确保专家不会从 `.mcp.json` 自动拉回 `llsExpert`；
 * - **resumeSessionId**：强制 `undefined`，专家永远启动新 session；
 * - **permissionMode**：强制 {@link EXPERT_PERMISSION_MODE}（acceptEdits），与主进程对齐；
 * - **cliEnv**：在主配置 env 基础上额外注入 `LLS_CHAT_ROLE=expert`，供 relay 区分；
 * - **expertMode**：从派生结果中删除（专家进程不应再持有该字段，否则可能误触发递归注入）；
 * - 其余字段（cliPath、cliArgs、cwd、transport、skills）原样继承。
 *
 * @param mainConfig 主进程已组装好的 ChatCliConfig（已含 mcpServers / skills 等）。
 * @returns 可直接喂给 `new CliProcess()` 启动专家子进程的配置。
 */
export function buildExpertConfig(mainConfig: ChatCliConfig): ChatCliConfig {
    const expertMcpServers = stripExpertServerFromMcp(mainConfig.mcpServers);
    const expertModel =
        mainConfig.expertMode?.model && mainConfig.expertMode.model.length > 0
            ? mainConfig.expertMode.model
            : mainConfig.model;

    // 把主配置完整复制一份，再覆盖专家专属字段。
    const derived: ChatCliConfig = {
        ...mainConfig,
        model: expertModel,
        mcpServers: expertMcpServers,
        strictMcpConfig: true,
        resumeSessionId: undefined,
        permissionMode: EXPERT_PERMISSION_MODE,
        cliEnv: {
            ...mainConfig.cliEnv,
            // 专家 CLI 也必须走本地 Relay；若主配置已注入 ANTHROPIC_* 环境变量，
            // 这里保留 baseUrl/token/key，同时把模型环境变量同步改为专家模型，
            // 避免继承主模型的 ANTHROPIC_MODEL。
            ...(expertModel ? { ANTHROPIC_MODEL: expertModel } : {}),
            [EXPERT_ROLE_ENV_KEY]: EXPERT_ROLE_ENV_VALUE
        }
    };

    // 显式移除 expertMode 字段，避免专家进程再次自动注入 llsExpert。
    delete derived.expertMode;

    return derived;
}

/**
 * 从 mcpServers 字典中剥除内置 `llsExpert` server。
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
        if (name === EXPERT_MCP_SERVER_NAME) {
            continue;
        }
        next[name] = server;
    }
    return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 构造内置 `llsExpert` MCP server 的 stdio 启动条目。
 *
 * 返回值会被合并到主进程 `ChatCliConfig.mcpServers` 字典里，由 cliProcess 拼成
 * `--mcp-config '{"mcpServers":{"llsExpert":{"type":"stdio","command":"node",
 * "args":["<extPath>/out/expertMode/expertMcpServer.js"]}}}'` 交给 Claude CLI；
 * CLI 在工具命名空间下会以 `mcp__llsExpert__ask_expert` 暴露给主模型。
 *
 * 路径解析策略：编译后 `out/expertMode/expertMcpServer.js` 与本文件
 * `out/expertMode/expertConfig.js` 位于同一目录，使用 `__dirname` 相对解析即可，
 * 不依赖 vscode ExtensionContext，便于纯函数单测。
 *
 * 方案 3 新增 env 注入：把扩展宿主侧 Relay 的回环 URL 与一次性鉴权 token
 * 通过环境变量传给 expertMcpServer 子进程；后者收到 `tools/call` 时通过
 * `fetch(baseUrl + '/__expert/run', ...)` 把请求转回扩展宿主，由后者真正
 * spawn 第二个 Claude CLI 作为专家。
 *
 * @param relayBaseUrl 可选；形如 `http://127.0.0.1:PORT`。**强烈建议提供**，
 *                     否则 expertMcpServer 子进程会回落到 stub 占位答复。
 * @param authToken    可选；扩展宿主在 Relay 启动时生成的一次性随机 token，
 *                     用于校验回环请求来源。
 * @returns 可直接放入 `mcpServers[EXPERT_MCP_SERVER_NAME]` 的 stdio server 配置。
 */
export function buildExpertMcpServerEntry(
    relayBaseUrl?: string,
    authToken?: string
): McpServerConfig {
    // __dirname 在编译产物中是 `<ext>/out/expertMode`；目标脚本就在同目录。
    const entryScript = path.resolve(__dirname, 'expertMcpServer.js');
    const env: Record<string, string> = {
        // 给子进程一个最小标记，便于 expertMcpServer 自检 / 日志归类
        LLS_EXPERT_MCP_SERVER: '1'
    };
    if (relayBaseUrl && relayBaseUrl.length > 0) {
        env.LLS_EXPERT_RELAY_URL = relayBaseUrl;
    }
    if (authToken && authToken.length > 0) {
        env.LLS_EXPERT_RELAY_TOKEN = authToken;
    }
    return {
        type: 'stdio',
        command: process.execPath, // 复用当前 Node 二进制，避免依赖外部 PATH 中的 node
        args: [entryScript],
        env
    };
}

/**
 * 若主配置启用了专家模式，则把内置 `llsExpert` server 合并到 `mcpServers` 字典。
 *
 * 行为：
 * - `mainConfig.expertMode?.enabled !== true` → 原样返回原字典（含 undefined）；
 * - 已启用且原字典里**已经手动配置**了 `llsExpert`（罕见但合法，用户可能想覆盖
 *   命令路径）→ 尊重用户配置，不覆盖；
 * - 已启用且字典里没有 `llsExpert` → 注入 {@link buildExpertMcpServerEntry} 结果。
 *
 * 该函数是**纯函数**，不读 vscode、不访问磁盘，便于在 `ChatCliConfigService.getConfig()`
 * 中作为最后一步组装步骤调用，也方便单元测试覆盖各分支。
 *
 * @param mcpServers 已合并完用户配置 + .vscode/mcp.json + 用户 mcp.json 的字典。
 * @param expertMode 主进程读取出的专家模式配置（来自 readExpertConfigFromVscode）。
 * @param relayBaseUrl 可选；扩展宿主 Relay 当前监听地址，注入子进程 env。
 * @param authToken    可选；当前会话的回环鉴权 token，注入子进程 env。
 * @returns 已按需注入 `llsExpert` 的新字典；为空时返回 undefined。
 */
export function maybeInjectExpertMcpServer(
    mcpServers: Record<string, McpServerConfig> | undefined,
    expertMode: ExpertModeConfig | undefined,
    relayBaseUrl?: string,
    authToken?: string
): Record<string, McpServerConfig> | undefined {
    if (!expertMode || expertMode.enabled !== true) {
        return mcpServers;
    }
    const next: Record<string, McpServerConfig> = { ...(mcpServers ?? {}) };
    // 用户若手动指定了同名 server，尊重用户优先级。
    if (!next[EXPERT_MCP_SERVER_NAME]) {
        next[EXPERT_MCP_SERVER_NAME] = buildExpertMcpServerEntry(relayBaseUrl, authToken);
    }
    return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 从一组候选值中挑出第一个布尔值。
 *
 * @param vals 候选布尔值数组（含 undefined）。
 * @returns 第一个 typeof === 'boolean' 的值，全部都不是则返回 undefined。
 */
function firstDefinedBoolean(...vals: Array<boolean | undefined>): boolean | undefined {
    for (const v of vals) {
        if (typeof v === 'boolean') {
            return v;
        }
    }
    return undefined;
}

/**
 * 从一组候选值中挑出第一个非空字符串。
 *
 * @param vals 候选字符串数组（含 undefined / 空串）。
 * @returns 第一个非空字符串；全部都不是则返回 undefined。
 */
function firstNonEmptyString(...vals: Array<string | undefined>): string | undefined {
    for (const v of vals) {
        if (typeof v === 'string' && v.length > 0) {
            return v;
        }
    }
    return undefined;
}

/**
 * 从 VS Code 配置检查结果中读取工作区层级值。
 *
 * @param inspect VS Code 配置 inspect 结果。
 * @returns workspaceFolderValue 或 workspaceValue。
 */
function readWorkspaceInspectValue<T>(inspect: { workspaceFolderValue?: T; workspaceValue?: T } | undefined): T | undefined {
    return inspect?.workspaceFolderValue ?? inspect?.workspaceValue;
}

/**
 * 从 VS Code 配置检查结果中读取全局层级值。
 *
 * @param inspect VS Code 配置 inspect 结果。
 * @returns globalValue。
 */
function readGlobalInspectValue<T>(inspect: { globalValue?: T } | undefined): T | undefined {
    return inspect?.globalValue;
}

/**
 * 从 VS Code 工作区配置中读取布尔字段，类型不符或未设置时返回 undefined。
 */
function readWorkspaceBooleanOrUndefined(
    config: vscode.WorkspaceConfiguration,
    key: string
): boolean | undefined {
    const v = readWorkspaceInspectValue(config.inspect<unknown>(key));
    return typeof v === 'boolean' ? v : undefined;
}

/**
 * 从 VS Code 全局配置中读取布尔字段，类型不符或未设置时返回 undefined。
 */
function readGlobalBooleanOrUndefined(
    config: vscode.WorkspaceConfiguration,
    key: string
): boolean | undefined {
    const v = readGlobalInspectValue(config.inspect<unknown>(key));
    return typeof v === 'boolean' ? v : undefined;
}

/**
 * 从 VS Code 工作区配置中读取字符串字段，类型不符或未设置时返回 undefined。
 *
 * 空字符串保留为空字符串本身（由 resolveExpertConfig 进一步判断是否视为「未设置」）。
 */
function readWorkspaceStringOrUndefined(
    config: vscode.WorkspaceConfiguration,
    key: string
): string | undefined {
    const v = readWorkspaceInspectValue(config.inspect<unknown>(key));
    return typeof v === 'string' ? v : undefined;
}

/**
 * 从 VS Code 全局配置中读取字符串字段，类型不符或未设置时返回 undefined。
 *
 * 空字符串保留为空字符串本身（由 resolveExpertConfig 进一步判断是否视为「未设置」）。
 */
function readGlobalStringOrUndefined(
    config: vscode.WorkspaceConfiguration,
    key: string
): string | undefined {
    const v = readGlobalInspectValue(config.inspect<unknown>(key));
    return typeof v === 'string' ? v : undefined;
}
