/**
 * @file Claude Code settings.json 写入核心逻辑。
 *
 * 严格通过 VS Code 官方 Configuration API 写入用户全局 settings.json，
 * 不直接读写文件。负责：
 *
 * 1. 清理历史 Relay 版本写入的 ANTHROPIC_* 等环境变量条目；
 * 2. 用 {@link stripManagedVars} 剥离上一次本扩展写过的条目，保留用户手加的变量；
 * 3. 根据任务流配置同步官方 Claude Code 危险权限开关。
 */

import * as vscode from 'vscode';

import { applyCurrentModelToClaudeCli } from './claudeCliSettings';
import {
    CONFIG_NAMESPACE,
    CLAUDE_CODE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS_KEY,
    CLAUDE_CODE_DISABLE_LOGIN_PROMPT_KEY,
    CLAUDE_CODE_ENV_VARS_KEY,
    CLAUDE_CODE_INITIAL_PERMISSION_MODE_KEY,
    CLAUDE_CODE_NAMESPACE,
    MANAGED_ENV_KEYS,
    MANAGED_MARKER,
    TASK_FLOW_BYPASS_PERMISSIONS_KEY
} from './constants';
import { Logger } from './logger';
import type { CurrentModelSelection } from './types';

/** Claude Code environmentVariables 中的单条环境变量。 */
export interface EnvVar {
    /** 变量名。 */
    name: string;
    /** 变量值。 */
    value: string;
}

/**
 * 从环境变量数组中剥离掉所有本扩展管理的条目。
 *
 * 识别算法（保守策略）：
 *   1. 遇到 {@link MANAGED_MARKER} 进入"managed 区域"；
 *   2. 在 managed 区域内，连续清除属于 {@link MANAGED_ENV_KEYS} 的条目；
 *   3. 一旦遇到不属于已知 managed key 的条目，立即退出 managed 区域，
 *      之后的条目原样保留（视为用户手加）；
 *   4. marker 本身永远被剥离。
 *
 * 该策略**不会**误删用户手加的同名环境变量，前提是用户不要把这些变量
 * 紧挨着 marker 放置——这是合理的约定：用户应当把自己的变量放在 marker
 * 区域之外。
 *
 * @param vars 当前 settings.json 中的环境变量数组
 * @returns 剥离后的"用户手加"环境变量数组
 * @internal 仅 settingsWriter 模块内部使用，导出以便单元测试。
 */
export function stripManagedVars(vars: readonly EnvVar[]): EnvVar[] {
    const result: EnvVar[] = [];
    let inManagedBlock = false;
    for (const v of vars) {
        if (!v || typeof v.name !== 'string') {
            // 容错：忽略非法条目
            continue;
        }
        if (v.name === MANAGED_MARKER) {
            inManagedBlock = true;
            continue;
        }
        if (inManagedBlock && MANAGED_ENV_KEYS.has(v.name)) {
            continue;
        }
        // 退出 managed 区域
        inManagedBlock = false;
        result.push({ name: v.name, value: v.value ?? '' });
    }
    return result;
}

/**
 * 构造历史 Relay 版本使用过的 managed 环境变量块。
 *
 * 该函数仅保留给旧测试或迁移排查使用，新版运行时不再调用。
 *
 * @param port 历史 Relay 端口。
 * @param currentModel 当前模型选择。
 * @returns 历史版本会写入的托管环境变量列表。
 */
export function buildManagedVars(
    port: number,
    currentModel: CurrentModelSelection | null
): EnvVar[] {
    const list: EnvVar[] = [{ name: MANAGED_MARKER, value: 'claude-code-relay' }];

    list.push({
        name: 'ANTHROPIC_BASE_URL',
        value: `http://127.0.0.1:${port}`
    });
    list.push({ name: 'ANTHROPIC_AUTH_TOKEN', value: 'claude-code-relay' });

    if (currentModel) {
        list.push({
            name: 'ANTHROPIC_MODEL',
            value: `${currentModel.providerId}/${currentModel.modelId}`
        });
    }

    return list;
}

/**
 * Claude Code settings 写入器。
 *
 * 提供历史 Relay 配置清理、CLI 当前模型同步、任务流权限同步与停用清理能力。
 * 所有写入均落到 {@link vscode.ConfigurationTarget.Global}。
 */
export class SettingsWriter {
    /**
     * 把当前模型同步到 Claude Code CLI 全局配置文件。
     *
    * CLI 原生命令会读取 `~/.claude/settings.json` 中的 `model` 字段；
    * 这里写入带提供商前缀的中转模型 ID，便于后端按 `providerId/modelId` 路由。
     *
     * @param currentModel 当前模型选择；为空时删除 CLI settings 中的 model 字段。
     */
    public async applyClaudeCliModel(currentModel: CurrentModelSelection | null): Promise<void> {
        await applyCurrentModelToClaudeCli(currentModel);
    }

    /**
     * 清理历史 HTTP Relay 写入的 Claude Code 配置。
     *
     * 新版内置 Chat 已不再启动本地 HTTP Relay，因此启动时只移除旧版 managed
     * 环境变量块，避免官方 Claude Code 继续指向已不存在的 127.0.0.1 端口。
    * 同时继续同步任务流权限设置；模型由内置 Chat 启动参数 `--model` 控制，不再写入 Claude CLI settings.json。
     *
     * @param currentModel 当前模型选择；为空时清空 Claude CLI 模型配置。
     */
    public async cleanupLegacyRelaySettings(currentModel: CurrentModelSelection | null): Promise<void> {
        const cfg = vscode.workspace.getConfiguration(CLAUDE_CODE_NAMESPACE);
        const existing = (cfg.get<EnvVar[]>(CLAUDE_CODE_ENV_VARS_KEY) ?? []).filter(
            (v): v is EnvVar => !!v && typeof v.name === 'string'
        );
        const userOwned = stripManagedVars(existing);
        const shouldClearEnv = userOwned.length === 0;

        await cfg.update(
            CLAUDE_CODE_ENV_VARS_KEY,
            shouldClearEnv ? undefined : userOwned,
            vscode.ConfigurationTarget.Global
        );
        await cfg.update(
            CLAUDE_CODE_DISABLE_LOGIN_PROMPT_KEY,
            false,
            vscode.ConfigurationTarget.Global
        );
        await this.applyTaskFlowPermissionMode();
        await this.applyClaudeCliModel(currentModel);

        Logger.info(`已清理历史 Relay settings，userOwned=${userOwned.length}`);
    }

    /**
     * 清除本扩展管理的所有环境变量，恢复用户手加的部分。
     *
     * 同时把 `claudeCode.disableLoginPrompt` 恢复为 `false`（最常见的默认值）。
     * 不动用户手加的其他设置项。
     */
    public async deactivate(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration(CLAUDE_CODE_NAMESPACE);
        const existing = (cfg.get<EnvVar[]>(CLAUDE_CODE_ENV_VARS_KEY) ?? []).filter(
            (v): v is EnvVar => !!v && typeof v.name === 'string'
        );
        const userOwned = stripManagedVars(existing);

        await cfg.update(
            CLAUDE_CODE_ENV_VARS_KEY,
            userOwned.length > 0 ? userOwned : undefined,
            vscode.ConfigurationTarget.Global
        );
        await cfg.update(
            CLAUDE_CODE_DISABLE_LOGIN_PROMPT_KEY,
            false,
            vscode.ConfigurationTarget.Global
        );
        await this.applyClaudeCliModel(null);

        Logger.info('已清除本扩展写入的 Claude Code 环境变量');
    }

    /**
     * 读取当前 settings.json 中 Claude Code 相关字段，用于 Webview 预览。
     *
     * @returns environmentVariables 数组与 disableLoginPrompt 布尔值
     */
    public readSnapshot(): {
        environmentVariables: EnvVar[];
        disableLoginPrompt: boolean;
    } {
        const cfg = vscode.workspace.getConfiguration(CLAUDE_CODE_NAMESPACE);
        const env = cfg.get<EnvVar[]>(CLAUDE_CODE_ENV_VARS_KEY) ?? [];
        const disable = cfg.get<boolean>(CLAUDE_CODE_DISABLE_LOGIN_PROMPT_KEY) ?? false;
        return {
            environmentVariables: env.filter(
                (v): v is EnvVar => !!v && typeof v.name === 'string'
            ),
            disableLoginPrompt: !!disable
        };
    }

    /**
     * 根据本扩展任务流全局开关联动写入官方 Claude Code 的危险权限配置。
     *
     * 官方扩展只有同时满足：
     * - `claudeCode.initialPermissionMode = "bypassPermissions"`
     * - `claudeCode.allowDangerouslySkipPermissions = true`
     * 才会真正让新会话进入绕过权限确认模式；否则会降级为 default。
     */
    private async applyTaskFlowPermissionMode(): Promise<void> {
        const enabled = vscode.workspace
            .getConfiguration(CONFIG_NAMESPACE)
            .get<boolean>(TASK_FLOW_BYPASS_PERMISSIONS_KEY, false);
        const cfg = vscode.workspace.getConfiguration(CLAUDE_CODE_NAMESPACE);
        if (enabled) {
            await cfg.update(
                CLAUDE_CODE_INITIAL_PERMISSION_MODE_KEY,
                'bypassPermissions',
                vscode.ConfigurationTarget.Global
            );
            await cfg.update(
                CLAUDE_CODE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS_KEY,
                true,
                vscode.ConfigurationTarget.Global
            );
            return;
        }

        const initialInspect = cfg.inspect<string>(CLAUDE_CODE_INITIAL_PERMISSION_MODE_KEY);
        const skipInspect = cfg.inspect<boolean>(CLAUDE_CODE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS_KEY);
        if (initialInspect?.globalValue === 'bypassPermissions') {
            await cfg.update(
                CLAUDE_CODE_INITIAL_PERMISSION_MODE_KEY,
                'default',
                vscode.ConfigurationTarget.Global
            );
        }
        if (skipInspect?.globalValue === true) {
            await cfg.update(
                CLAUDE_CODE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS_KEY,
                false,
                vscode.ConfigurationTarget.Global
            );
        }
    }
}
