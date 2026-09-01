/**
 * @file 压缩模式配置层：VS Code 配置读取 + 三层合并。
 *
 * 从原 `src/expertMode/expertConfig.ts` 抽出的、压缩模式（compactionMode）专用的一
 * 套读取逻辑；随专家/方案/审查模式移除后，本文件成为 `RoutedModelModeConfig` 读取
 * 的唯一存活入口，因此单独成文放在 chatRuntime 层。
 *
 * 三层关系（沿用原设计）：
 *
 *   resource 配置 (chat.compactionMode.project.*)
 *        │ 项目优先
 *        ▼
 *   application 配置 (chat.compactionMode.global.*)
 *        │ 全局回退
 *        ▼
 *   代码内默认 (defaultRoutedModelModeConfig)
 *
 * 关键函数：
 * - {@link resolveRoutedModelModeConfig}   纯函数三层合并（无 vscode 依赖，易单测）
 * - {@link readCompactionConfigFromVscode} 读两个 scope 后调用合并
 */

import * as vscode from 'vscode';

import {
    CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY,
    CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY,
    CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY,
    CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY,
    CONFIG_NAMESPACE
} from '../constants';
import type { RoutedModelModeConfig } from '../chat/cli/types';

export type { RoutedModelModeConfig };

/** 代码内置的路由模型默认值。 */
export const defaultRoutedModelModeConfig: RoutedModelModeConfig = {
    enabled: false,
    model: ''
};

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
 * 空字符串保留为空字符串本身（由 {@link resolveRoutedModelModeConfig} 进一步判断是否视为「未设置」）。
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
 * 空字符串保留为空字符串本身（由 {@link resolveRoutedModelModeConfig} 进一步判断是否视为「未设置」）。
 */
function readGlobalStringOrUndefined(
    config: vscode.WorkspaceConfiguration,
    key: string
): string | undefined {
    const v = readGlobalInspectValue(config.inspect<unknown>(key));
    return typeof v === 'string' ? v : undefined;
}
