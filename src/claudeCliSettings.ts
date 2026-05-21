/**
 * @file Claude Code CLI 全局配置文件读写器。
 *
 * Claude Code 命令行版本会读取用户目录下的 `.claude/settings.json`，
 * 与 VS Code 扩展的 `claudeCode.environmentVariables` 是独立的配置入口。
 *
 * 该模块负责跨平台定位该文件并合并 `model` 字段：
 *   - macOS / Linux：`$HOME/.claude/settings.json`
 *   - Windows：`%USERPROFILE%\.claude\settings.json`
 *
 * 与 VS Code settings.json 写入闭环保持一致的触发时机，
 * 让 CLI 与 VS Code 内的 Claude Code 看到相同的当前模型。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { Logger } from './logger';
import type { CurrentModelSelection } from './types';

/** Claude Code CLI 配置目录名（位于用户主目录下）。 */
const CLAUDE_CLI_DIR_NAME = '.claude';

/** Claude Code CLI 配置文件名。 */
const CLAUDE_CLI_FILE_NAME = 'settings.json';

/**
 * 跨平台解析 Claude Code CLI 全局配置文件路径。
 *
 * Node 的 {@link os.homedir} 在三大平台都会返回当前用户主目录：
 *   - macOS：`/Users/<name>`
 *   - Linux：`/home/<name>`
 *   - Windows：`C:\\Users\\<name>`
 *
 * 我们一律拼接 `.claude/settings.json`，由 `path.join` 处理分隔符。
 *
 * @returns Claude Code CLI 配置文件的绝对路径。
 */
export function resolveClaudeCliSettingsPath(): string {
    return path.join(os.homedir(), CLAUDE_CLI_DIR_NAME, CLAUDE_CLI_FILE_NAME);
}

/**
 * 安全地读取 Claude Code CLI 配置文件并解析为对象。
 *
 * 文件不存在或解析失败时返回空对象，避免影响主流程。
 *
 * @param filePath 目标文件路径。
 * @returns 解析后的 JSON 对象（不保证键值结构），失败时为 `{}`。
 */
async function readClaudeCliSettings(filePath: string): Promise<Record<string, unknown>> {
    try {
        const text = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        // 文件存在但顶层不是对象，丢弃旧值，避免破坏后续写入。
        Logger.warn(`Claude CLI 配置文件顶层不是对象，将以新对象覆盖：${filePath}`);
        return {};
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
            return {};
        }
        const message = err instanceof Error ? err.message : String(err);
        Logger.warn(`读取 Claude CLI 配置失败（将以空对象继续）：${message}`);
        return {};
    }
}

/**
 * 把对象以稳定 JSON 格式写回 Claude Code CLI 配置文件。
 *
 * 写入前会确保父目录存在，便于初次安装时自动创建 `~/.claude/`。
 *
 * @param filePath 目标文件路径。
 * @param data 待写入的对象。
 */
async function writeClaudeCliSettings(
    filePath: string,
    data: Record<string, unknown>
): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const text = `${JSON.stringify(data, null, 2)}\n`;
    await fs.writeFile(filePath, text, 'utf-8');
}

/**
 * 把当前模型选择合并写入 Claude Code CLI 全局配置文件。
 *
 * 行为：
 *   - 当 `selection` 有值时，把 `model` 字段写为 `<providerId>/<modelId>`；
 *   - 当 `selection` 为 null 时，删除 `model` 字段（保留其它字段）；
 *   - 其它已有键值原样保留，不做覆盖。
 *
 * 该函数不抛出：所有 IO 异常都被吞掉并记入日志，避免影响 VS Code 主流程。
 *
 * @param selection 当前模型选择，可为 null 表示清空。
 */
export async function applyCurrentModelToClaudeCli(
    selection: CurrentModelSelection | null
): Promise<void> {
    const filePath = resolveClaudeCliSettingsPath();
    try {
        const current = await readClaudeCliSettings(filePath);
        const next: Record<string, unknown> = { ...current };

        if (selection && selection.providerId && selection.modelId) {
            next.model = `${selection.providerId}/${selection.modelId}`;
        } else {
            delete next.model;
        }

        // 与已有内容完全一致时跳过写入，避免无意义磁盘 IO。
        if (JSON.stringify(current) === JSON.stringify(next)) {
            return;
        }

        await writeClaudeCliSettings(filePath, next);
        Logger.info(
            `已更新 Claude CLI 配置：${filePath} model=${
                typeof next.model === 'string' ? next.model : '(已清空)'
            }`
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`写入 Claude CLI 配置失败：${filePath} :: ${message}`);
    }
}
