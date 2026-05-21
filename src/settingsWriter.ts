/**
 * @file Claude Code settings.json 写入核心逻辑。
 *
 * 严格通过 VS Code 官方 Configuration API 写入用户全局 settings.json，
 * 不直接读写文件。负责：
 *
 * 1. 后续把中转端口与当前模型展开成 ANTHROPIC_* 等环境变量条目；
 * 2. 在写入前用 {@link stripManagedVars} 剥离上一次本扩展写过的条目，保留用户手加的变量；
 * 3. 用 {@link MANAGED_MARKER} 标记本扩展管辖范围。
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
import type { CurrentModelSelection, ExtraEnvVar, RelayServerConfig } from './types';

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
 * 把中转配置和当前模型展开为待写入的 managed 环境变量数组（含 marker）。
 *
 * 该函数由 settings.json 写入闭环调用，用于生成本扩展托管的环境变量块。
 */
export function buildManagedVars(
    relay: RelayServerConfig,
    currentModel: CurrentModelSelection | null
): EnvVar[] {
    const list: EnvVar[] = [{ name: MANAGED_MARKER, value: 'claude-code-relay' }];

    list.push({
        name: 'ANTHROPIC_BASE_URL',
        value: `http://127.0.0.1:${relay.port}`
    });
    list.push({ name: 'ANTHROPIC_AUTH_TOKEN', value: 'claude-code-relay' });

    if (relay.skipAuthLogin) {
        list.push({ name: 'CLAUDE_CODE_SKIP_AUTH_LOGIN', value: '1' });
    }

    if (currentModel) {
        list.push({
            name: 'ANTHROPIC_MODEL',
            value: `${currentModel.providerId}/${currentModel.modelId}`
        });
    }

    if (relay.extraEnvVars && relay.extraEnvVars.length > 0) {
        for (const e of relay.extraEnvVars) {
            if (!e || !e.name || !e.name.trim()) continue;
            if (e.name === MANAGED_MARKER) continue; // 防止注入冲突
            list.push({ name: e.name.trim(), value: e.value ?? '' });
        }
    }

    return list;
}

/**
 * Claude Code settings 写入器。
 *
 * 提供 {@link applyRelayConfig}（写入中转配置）与 {@link deactivate}（清除本扩展条目）
 * 两个高层操作。所有写入均落到 {@link vscode.ConfigurationTarget.Global}。
 */
export class SettingsWriter {
    /**
    * 把当前中转配置写入 Claude Code 配置。
     *
     * - 合并策略：保留用户手加的变量，仅替换本扩展先前写入的 managed 区域。
    * - 同时把 `claudeCode.disableLoginPrompt` 同步为 relay.disableLoginPrompt。
     *
     * @param relay 中转服务配置
     * @param currentModel 当前模型选择
     */
    public async applyRelayConfig(
        relay: RelayServerConfig,
        currentModel: CurrentModelSelection | null
    ): Promise<void> {
        const cfg = vscode.workspace.getConfiguration(CLAUDE_CODE_NAMESPACE);
        const existing = (cfg.get<EnvVar[]>(CLAUDE_CODE_ENV_VARS_KEY) ?? []).filter(
            (v): v is EnvVar => !!v && typeof v.name === 'string'
        );
        const userOwned = stripManagedVars(existing);
        const managed = buildManagedVars(relay, currentModel);

        const merged = [...userOwned, ...managed];

        await cfg.update(
            CLAUDE_CODE_ENV_VARS_KEY,
            merged,
            vscode.ConfigurationTarget.Global
        );
        await cfg.update(
            CLAUDE_CODE_DISABLE_LOGIN_PROMPT_KEY,
            !!relay.disableLoginPrompt,
            vscode.ConfigurationTarget.Global
        );
        await this.applyTaskFlowPermissionMode();
// 同步把当前模型写入 Claude Code CLI 的 ~/.claude/settings.json（跨平台）。
        await applyCurrentModelToClaudeCli(currentModel);

        
        Logger.info(
            `已写入 Claude Code settings (relayPort=${relay.port})，` +
                `managed=${managed.length}, userOwned=${userOwned.length}`
        );
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

        // 同步清空 Claude CLI 配置中的 model 字段。
        await applyCurrentModelToClaudeCli(null);

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
