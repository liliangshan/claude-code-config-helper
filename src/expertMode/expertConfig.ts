/**
 * @file 专家模式配置层：VS Code 配置读取 + 三层合并。
 *
 * 三层关系：
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
 *
 * 自双 CLI 路由方案落地后，本模块**只负责读配置**——不再派生专家进程配置、
 * 不再注入 MCP server。专家 CLI 的派生逻辑下沉到 `ChatCliConfigService.getDualConfigsWithRelayEnv`。
 */

import * as vscode from 'vscode';

import {
    CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY,
    CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY,
    CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY,
    CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY,
    CHAT_EXPERT_MAX_CALLS_PER_TURN_KEY,
    CHAT_EXPERT_MAX_STEPS_KEY,
    CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY,
    CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY,
    CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY,
    CHAT_EXPERT_MODE_PROJECT_MODEL_KEY,
    CHAT_EXPERT_STEP_TIMEOUT_MS_KEY,
    CHAT_EXPERT_TOTAL_TIMEOUT_MS_KEY,
    CHAT_EXPERT_USER_TRIGGER_MODE_KEY,
    CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY,
    CHAT_PLAN_MODE_GLOBAL_MODEL_KEY,
    CHAT_PLAN_MODE_PROJECT_ENABLED_KEY,
    CHAT_PLAN_MODE_PROJECT_MODEL_KEY,
    CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY,
    CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY,
    CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY,
    CHAT_REVIEW_MODE_PROJECT_MODEL_KEY,
    CONFIG_NAMESPACE
} from '../constants';
import type { ExpertModeConfig, RoutedModelModeConfig } from '../chat/cli/types';

/**
 * 用户触发专家（@llsExpert / /expert 前缀）时的处理方式。
 *
 * - `'direct'`：直接将专家回答展示给用户作为最终答复。
 * - `'tool_result'`：把专家回答以 tool_result 形式回写主 CLI，让主模型继续编排。
 */
export type ExpertUserTriggerMode = 'direct' | 'tool_result';

/**
 * 专家 sub-turn 运行选项（按需专家方案）。
 *
 * 由 {@link readExpertSubturnOptions} 从 VS Code 配置中读取并解析。
 */
export interface ExpertSubturnOptions {
    /** 用户主动触发专家时的处理方式。 */
    userTriggerMode: ExpertUserTriggerMode;
    /** 专家 mini-agent 循环允许的最大工具使用步数。 */
    maxSteps: number;
    /** 专家 mini-agent 循环单步超时时间（毫秒）。 */
    stepTimeoutMs: number;
    /** 单次 ask_expert sub-turn 的总超时时间（毫秒）。 */
    totalTimeoutMs: number;
    /** 单个 dispatcher turn 内 ask_expert 最大调用次数。 */
    maxCallsPerTurn: number;
}

/** 专家 sub-turn 配置的内置默认值。 */
export const defaultExpertSubturnOptions: ExpertSubturnOptions = {
    userTriggerMode: 'direct',
    maxSteps: 6,
    stepTimeoutMs: 60_000,
    totalTimeoutMs: 300_000,
    maxCallsPerTurn: 1
};

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

/** 代码内置的路由模型默认值。 */
export const defaultRoutedModelModeConfig: RoutedModelModeConfig = {
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
    return resolveRoutedModelModeConfig(projectCfg, globalCfg, defaults);
}

/**
 * 按「项目 > 全局 > 默认」三层覆盖合并出实际生效的路由模型配置。
 *
 * @param projectCfg 项目级配置（来自 `resource` scope，可能为部分字段或 undefined）。
 * @param globalCfg  全局级配置（来自 `application` scope，可能为部分字段或 undefined）。
 * @param defaults   代码内置默认值。
 * @returns 完整的、可直接使用的 `RoutedModelModeConfig`。
 */
export function resolveRoutedModelModeConfig(
    projectCfg: Partial<RoutedModelModeConfig> | undefined,
    globalCfg: Partial<RoutedModelModeConfig> | undefined,
    defaults: RoutedModelModeConfig
): RoutedModelModeConfig {
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

    return readRoutedModelModeConfigFromVscode(config, {
        projectEnabledKey: CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY,
        projectModelKey: CHAT_EXPERT_MODE_PROJECT_MODEL_KEY,
        globalEnabledKey: CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY,
        globalModelKey: CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY
    });
}

/**
 * 从 VS Code workspace 配置读取方案模式配置并合并出最终值。
 *
 * @returns 已三层合并好的 {@link RoutedModelModeConfig}。
 */
export function readPlanConfigFromVscode(): RoutedModelModeConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    return readRoutedModelModeConfigFromVscode(config, {
        projectEnabledKey: CHAT_PLAN_MODE_PROJECT_ENABLED_KEY,
        projectModelKey: CHAT_PLAN_MODE_PROJECT_MODEL_KEY,
        globalEnabledKey: CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY,
        globalModelKey: CHAT_PLAN_MODE_GLOBAL_MODEL_KEY
    });
}

/**
 * 从 VS Code workspace 配置读取压缩请求专用模型配置并合并出最终值。
 *
 * @returns 已三层合并好的 {@link RoutedModelModeConfig}。
 */
export function readCompactionConfigFromVscode(): RoutedModelModeConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    return readRoutedModelModeConfigFromVscode(config, {
        projectEnabledKey: CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY,
        projectModelKey: CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY,
        globalEnabledKey: CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY,
        globalModelKey: CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY
    });
}

/**
 * 从 VS Code workspace 配置读取专家 sub-turn 运行选项。
 *
 * 仅读 resource scope（项目级）；未设置或类型不符的字段回退到内置默认。
 *
 * @returns 完整的 {@link ExpertSubturnOptions}（每个字段都有值）。
 */
export function readExpertSubturnOptions(): ExpertSubturnOptions {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    const userTriggerMode = readStringEnum<ExpertUserTriggerMode>(
        config,
        CHAT_EXPERT_USER_TRIGGER_MODE_KEY,
        ['direct', 'tool_result'],
        defaultExpertSubturnOptions.userTriggerMode
    );
    const maxSteps = readNumberInRange(
        config,
        CHAT_EXPERT_MAX_STEPS_KEY,
        1,
        50,
        defaultExpertSubturnOptions.maxSteps
    );
    const stepTimeoutMs = readNumberInRange(
        config,
        CHAT_EXPERT_STEP_TIMEOUT_MS_KEY,
        1000,
        Number.MAX_SAFE_INTEGER,
        defaultExpertSubturnOptions.stepTimeoutMs
    );
    const totalTimeoutMs = readNumberInRange(
        config,
        CHAT_EXPERT_TOTAL_TIMEOUT_MS_KEY,
        1000,
        Number.MAX_SAFE_INTEGER,
        defaultExpertSubturnOptions.totalTimeoutMs
    );
    const maxCallsPerTurn = readNumberInRange(
        config,
        CHAT_EXPERT_MAX_CALLS_PER_TURN_KEY,
        1,
        10,
        defaultExpertSubturnOptions.maxCallsPerTurn
    );

    return { userTriggerMode, maxSteps, stepTimeoutMs, totalTimeoutMs, maxCallsPerTurn };
}

/**
 * 读取一个字符串枚举字段，类型不符或不在白名单中时回退到默认值。
 */
function readStringEnum<T extends string>(
    config: vscode.WorkspaceConfiguration,
    key: string,
    allowed: readonly T[],
    fallback: T
): T {
    const raw = config.get<unknown>(key);
    return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
        ? (raw as T)
        : fallback;
}

/**
 * 读取一个数字字段并裁剪到 [min, max] 区间；类型不符时回退到默认值。
 */
function readNumberInRange(
    config: vscode.WorkspaceConfiguration,
    key: string,
    min: number,
    max: number,
    fallback: number
): number {
    const raw = config.get<unknown>(key);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return fallback;
    }
    if (raw < min) {
        return min;
    }
    if (raw > max) {
        return max;
    }
    return raw;
}

/**
 * 从 VS Code workspace 配置读取审查模式配置并合并出最终值。
 *
 * @returns 已三层合并好的 {@link RoutedModelModeConfig}。
 */
export function readReviewConfigFromVscode(): RoutedModelModeConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    return readRoutedModelModeConfigFromVscode(config, {
        projectEnabledKey: CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY,
        projectModelKey: CHAT_REVIEW_MODE_PROJECT_MODEL_KEY,
        globalEnabledKey: CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY,
        globalModelKey: CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY
    });
}

/** 路由模型配置 key 集合。 */
interface RoutedModelModeConfigKeys {
    /** 项目级 enabled key。 */
    projectEnabledKey: string;
    /** 项目级 model key。 */
    projectModelKey: string;
    /** 全局级 enabled key。 */
    globalEnabledKey: string;
    /** 全局级 model key。 */
    globalModelKey: string;
}

/**
 * 从 VS Code 配置读取任意路由模型配置并合并出最终值。
 *
 * @param config VS Code workspace configuration。
 * @param keys 路由模型配置 key 集合。
 * @returns 已三层合并好的路由模型配置。
 */
function readRoutedModelModeConfigFromVscode(
    config: vscode.WorkspaceConfiguration,
    keys: RoutedModelModeConfigKeys
): RoutedModelModeConfig {
    const projectCfg: Partial<RoutedModelModeConfig> = {
        enabled: readWorkspaceBooleanOrUndefined(config, keys.projectEnabledKey),
        model: readWorkspaceStringOrUndefined(config, keys.projectModelKey)
    };
    const globalCfg: Partial<RoutedModelModeConfig> = {
        enabled: readGlobalBooleanOrUndefined(config, keys.globalEnabledKey),
        model: readGlobalStringOrUndefined(config, keys.globalModelKey)
    };

    return resolveRoutedModelModeConfig(projectCfg, globalCfg, defaultRoutedModelModeConfig);
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
