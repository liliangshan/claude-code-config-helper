/** @file 负责选择、校验并持久化用户的 Claude CLI 路径。 */

import { constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { Logger } from '../../logger';
import { ChatCliConfigService } from './cliConfig';

/** Windows 可执行文件扩展名集合。 */
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.ps1']);

/**
 * 解析和校验内置 Chat 所使用的 CLI 可执行文件路径。
 *
 * 该类负责读取已有配置、在缺失时弹出文件选择器、做跨平台可执行性校验，
 * 并将用户选择写回配置。它不负责启动 CLI 进程。
 */
export class CliResolver {
    /**
     * 创建 CLI 路径解析器。
     *
     * @param configService Chat CLI 配置服务。
     */
    public constructor(private readonly configService: ChatCliConfigService) {}

    /**
     * 解析当前可用的 CLI 路径；未配置时会引导用户选择。
     *
     * @returns 可执行 CLI 路径；用户取消选择时返回 undefined。
     */
    public async resolveOrPrompt(): Promise<string | undefined> {
        const configuredPath = this.configService.getConfig().cliPath;
        if (configuredPath) {
            await this.validateExecutable(configuredPath);
            return configuredPath;
        }
        return this.selectCliPath();
    }

    /**
     * 强制弹出文件选择器并保存新的 CLI 路径。
     *
     * @returns 用户选择并校验通过的 CLI 路径；取消时返回 undefined。
     */
    public async selectCliPath(): Promise<string | undefined> {
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: '选择 Claude CLI 可执行文件',
            openLabel: '使用此 CLI'
        });
        const cliPath = selected?.[0]?.fsPath;
        if (!cliPath) return undefined;
        await this.validateExecutable(cliPath);
        await this.configService.updateCliPath(cliPath);
        await this.configService.updateEnabled(true);
        Logger.info(`Chat CLI 路径已更新：${cliPath}`);
        return cliPath;
    }

    /**
     * 校验路径存在且在当前平台上可作为 CLI 可执行文件使用。
     *
     * @param cliPath 待校验的 CLI 文件路径。
     * @throws 路径不存在、不是文件或无执行权限时抛出错误。
     */
    public async validateExecutable(cliPath: string): Promise<void> {
        const stat = await fs.stat(cliPath).catch(() => undefined);
        if (!stat) throw new Error(`CLI 路径不存在：${cliPath}`);
        if (!stat.isFile()) throw new Error(`CLI 路径不是文件：${cliPath}`);
        if (process.platform === 'win32') {
            this.validateWindowsExecutable(cliPath);
            return;
        }
        await fs.access(cliPath, fsConstants.X_OK).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`CLI 文件缺少执行权限：${cliPath} (${message})`);
        });
    }

    /**
     * 校验 Windows 平台下的可执行文件扩展名。
     *
     * @param cliPath 待校验的 CLI 文件路径。
     * @throws 扩展名不在 PATHEXT 常见集合中时抛出错误。
     */
    private validateWindowsExecutable(cliPath: string): void {
        const ext = path.extname(cliPath).toLowerCase();
        if (!WINDOWS_EXECUTABLE_EXTENSIONS.has(ext)) {
            throw new Error(`Windows CLI 文件扩展名不受支持：${cliPath}`);
        }
    }
}
