/**
 * 扩展激活期的一次性启动动作：权限模式写入、历史配置清理、CLI settings 同步与 Relay 启动。
 *
 * 拆分自 extension.ts：把 activate 早期那批「失败只记日志、不阻断激活」的兜底
 * 动作，以及本地 HTTP 中转服务的按需启动收敛到一个模块。
 *
 * 依赖方向：本模块只依赖 runtime 提供的全局单例访问器，不被其它 chatRuntime 模块反向引用。
 */
import * as vscode from 'vscode';

import { Logger } from '../logger';
import { getConfigManager, getRelayServer, getSettingsWriter } from '../runtime';

/**
 * 启动时把 Claude Code 初始权限模式设置为 `bypassPermissions`。
 *
 * - 将 `claudeCode.initialPermissionMode` 写入 Workspace 配置，使新启动的 CLI
 *   直接跳过工具调用的人工确认环节，避免每次新会话都要再次授权。
 * - 失败时只记录日志，不抛出，避免阻断扩展激活流程。
 *
 * 注意：函数名与日志输出保持与实际写入值（`bypassPermissions`）一致，
 * 避免历史上"名为 acceptEdits 实写 bypassPermissions"的误导。
 */
export async function applyClaudeCodeInitialPermissionMode(): Promise<void> {
    try {
        await vscode.workspace.getConfiguration('claudeCode')
            .update('initialPermissionMode', 'bypassPermissions', vscode.ConfigurationTarget.Workspace);
        Logger.info('Claude Code initialPermissionMode 已设置为 bypassPermissions');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`设置 Claude Code initialPermissionMode 失败：${message}`);
    }
}

/**
 * 清理历史 Relay settings.json 托管环境变量。
 *
 * 内部对失败做兜底，避免历史迁移异常打断扩展主流程。
 */
export async function cleanupLegacyRelaySettingsSafely(): Promise<void> {
    const manager = getConfigManager();
    const writer = getSettingsWriter();
    if (!manager || !writer) return;
    try {
        await writer.cleanupLegacyRelaySettings(manager.getCurrentModel());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`清理历史 Relay settings.json 失败：${message}`);
    }
}

/**
 * 把当前模型同步写入 Claude CLI 全局 settings。
 *
 * 该文件位于用户目录 `~/.claude/settings.json`，是原生 Claude CLI 的配置入口。
 * 写入失败只记录日志，不阻断 Chat CLI 的启动流程。
 */
export async function syncClaudeCliModelSettingsSafely(): Promise<void> {
    const manager = getConfigManager();
    const writer = getSettingsWriter();
    if (!manager || !writer) return;
    try {
        await writer.applyClaudeCliModel(manager.getCurrentModel());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`同步 Claude CLI settings.json 模型失败：${message}`);
    }
}

/**
 * 确保本地 HTTP 中转服务已启动。
 *
 * 服务监听 `127.0.0.1` 的随机空闲端口，供 Claude CLI 通过 ANTHROPIC_BASE_URL
 * 访问；一个 VS Code 扩展宿主对应一个端口即可，不再接管固定端口。
 *
 * @returns 实际监听的本地端口。
 */
export async function ensureRelayServerStarted(): Promise<number> {
    const relay = getRelayServer();
    if (!relay) throw new Error('本地中转服务尚未初始化');
    const existing = relay.getActualPort();
    if (existing) {
        return existing;
    }
    return relay.start();
}
