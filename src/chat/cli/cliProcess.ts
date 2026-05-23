/** @file 封装 Claude CLI 长生命周期子进程与 stdio JSON Lines 通道。 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';

import { Logger } from '../../logger';
import type { ChatCliConfig, CliChunk, CliExitEvent, CliProcessStatus } from './types';

/** CliProcess 输出 chunk 事件名。 */
const CHUNK_EVENT = 'chunk';

/** CliProcess 退出事件名。 */
const EXIT_EVENT = 'exit';

/** CliProcess 状态事件名。 */
const STATUS_EVENT = 'status';

/**
 * 管理用户选择的 Claude CLI 子进程生命周期。
 *
 * 该类只负责原始进程启动、stdin 写入、stdout/stderr 监听、取消、重启和释放；
 * 不理解 Claude stream-json 协议语义，协议包装由后续 `CliAdapter` 负责。
 */
export class CliProcess implements vscode.Disposable {
    /** 内部事件总线，用于订阅 chunk / exit / status。 */
    private readonly emitter = new EventEmitter();

    /** 当前持有的子进程实例。 */
    private child: ChildProcessWithoutNullStreams | undefined;

    /** 当前启动配置。 */
    private currentConfig: ChatCliConfig | undefined;

    /** 当前进程状态。 */
    private status: CliProcessStatus = 'idle';

    /**
     * 使用给定配置启动 CLI 子进程。
     *
     * @param config 已规范化的 Chat CLI 配置。
     * @throws 当 transport 不支持、路径为空或 spawn 失败时抛出错误。
     */
    public async start(config: ChatCliConfig): Promise<void> {
        if (!config.cliPath) throw new Error('Chat CLI 路径未配置');
        if (config.transport !== 'streamJsonStdio') {
            throw new Error(`当前阶段仅支持 streamJsonStdio，实际配置为：${config.transport}`);
        }
        await this.disposeRunningChild('重新启动前清理旧 CLI 进程');
        this.currentConfig = config;
        this.setStatus('starting');
        const args = this.buildStreamJsonArgs(config.cliArgs, config.resumeSessionId);
        Logger.info(`启动 Chat CLI：${config.cliPath} ${args.join(' ')}`);
        Logger.info('Chat CLI 启动参数数组：' + JSON.stringify(args));
        Logger.info('Chat CLI 环境变量摘要：' + JSON.stringify({
            ANTHROPIC_BASE_URL: config.cliEnv.ANTHROPIC_BASE_URL || '',
            ANTHROPIC_MODEL: config.cliEnv.ANTHROPIC_MODEL || '',
            hasAnthropicAuthToken: !!config.cliEnv.ANTHROPIC_AUTH_TOKEN,
            hasAnthropicApiKey: !!config.cliEnv.ANTHROPIC_API_KEY,
            hasCustomHeaders: !!config.cliEnv.ANTHROPIC_CUSTOM_HEADERS,
            CLAUDE_CODE_SKIP_AUTH_LOGIN: config.cliEnv.CLAUDE_CODE_SKIP_AUTH_LOGIN || '',
            CLAUDE_CODE_SKIP_MODEL_VALIDATION: config.cliEnv.CLAUDE_CODE_SKIP_MODEL_VALIDATION || ''
        }));
        this.child = spawn(config.cliPath, args, {
            cwd: config.cwd,
            env: { ...process.env, ...config.cliEnv },
            stdio: 'pipe',
            windowsHide: true
        });
        this.bindChildEvents(this.child);
        this.setStatus('running');
    }

    /**
     * 向 CLI stdin 写入一行 JSON Lines 文本。
     *
     * @param jsonLine 已由上层适配器包装好的单行 JSON 字符串。
     * @throws 当前进程未运行或 stdin 不可写时抛出错误。
     */
    public send(jsonLine: string): void {
        if (!this.child || this.child.killed || !this.child.stdin.writable) {
            throw new Error('Chat CLI 进程未运行，无法写入 stdin');
        }
        const line = jsonLine.endsWith('\n') ? jsonLine : `${jsonLine}\n`;
        Logger.info(`写入 Chat CLI stdin：bytes=${Buffer.byteLength(line, 'utf8')}`);
        const accepted = this.child.stdin.write(line);
        Logger.info(`Chat CLI stdin 写入已调用：accepted=${accepted}`);
    }

    /**
     * 订阅 CLI stdout/stderr 原始 chunk。
     *
     * @param listener chunk 监听器。
     * @returns 用于取消订阅的 Disposable。
     */
    public onChunk(listener: (chunk: CliChunk) => void): vscode.Disposable {
        this.emitter.on(CHUNK_EVENT, listener);
        return { dispose: () => this.emitter.off(CHUNK_EVENT, listener) };
    }

    /**
     * 订阅 CLI 退出事件。
     *
     * @param listener 退出事件监听器。
     * @returns 用于取消订阅的 Disposable。
     */
    public onExit(listener: (event: CliExitEvent) => void): vscode.Disposable {
        this.emitter.on(EXIT_EVENT, listener);
        return { dispose: () => this.emitter.off(EXIT_EVENT, listener) };
    }

    /**
     * 订阅 CLI 状态变化事件。
     *
     * @param listener 状态变化监听器。
     * @returns 用于取消订阅的 Disposable。
     */
    public onStatus(listener: (status: CliProcessStatus) => void): vscode.Disposable {
        this.emitter.on(STATUS_EVENT, listener);
        return { dispose: () => this.emitter.off(STATUS_EVENT, listener) };
    }

    /**
     * 取消当前请求，当前阶段优先向子进程发送 SIGINT。
     *
     * 后续接入 `CliAdapter` 后，可在适配器中优先发送协议级取消消息。
     */
    public cancel(): void {
        if (!this.child || this.child.killed) return;
        this.child.kill('SIGINT');
    }

    /**
     * 使用最近一次启动配置重启 CLI 子进程。
     *
     * @throws 尚未启动过或当前配置缺失时抛出错误。
     */
    public async restart(): Promise<void> {
        if (!this.currentConfig) throw new Error('Chat CLI 尚未启动，无法重启');
        await this.start(this.currentConfig);
    }

    /**
     * 判断 CLI 子进程是否处于可写运行状态。
     *
     * @returns 进程存在、未被 kill 且状态为 running 时返回 true。
     */
    public isRunning(): boolean {
        return !!this.child && !this.child.killed && this.status === 'running';
    }

    /**
     * 判断当前运行中的 CLI 是否已经使用同一份启动配置。
     *
     * @param config 待比较的启动配置。
     * @returns 进程正在运行且关键启动参数一致时返回 true。
     */
    public isRunningWithConfig(config: ChatCliConfig): boolean {
        return this.isRunning() && !!this.currentConfig && this.isSameConfig(this.currentConfig, config);
    }

    /**
     * 读取当前 CLI 进程状态。
     *
     * @returns 当前状态枚举。
     */
    public getStatus(): CliProcessStatus {
        return this.status;
    }

    /**
     * 读取当前 CLI 子进程工作目录。
     *
     * @returns 已启动配置中的 cwd；尚未启动时返回当前 Node.js 进程目录。
     */
    public getCwd(): string {
        return this.currentConfig?.cwd ?? process.cwd();
    }

    /**
     * 对比两个 CLI 启动配置是否等价。
     *
     * @param left 当前已启动配置。
     * @param right 新的待启动配置。
     * @returns 影响进程启动的字段完全一致时返回 true。
     */
    private isSameConfig(left: ChatCliConfig, right: ChatCliConfig): boolean {
        return left.cliPath === right.cliPath &&
            left.cwd === right.cwd &&
            left.transport === right.transport &&
            (left.model ?? '') === (right.model ?? '') &&
            (left.resumeSessionId ?? '') === (right.resumeSessionId ?? '') &&
            this.isSameStringArray(left.cliArgs, right.cliArgs) &&
            this.isSameStringRecord(left.cliEnv, right.cliEnv);
    }

    /**
     * 对比两个字符串数组是否完全一致。
     *
     * @param left 左侧数组。
     * @param right 右侧数组。
     * @returns 长度和每一项都相同时返回 true。
     */
    private isSameStringArray(left: string[], right: string[]): boolean {
        return left.length === right.length && left.every((item, index) => item === right[index]);
    }

    /**
     * 对比两个字符串字典是否完全一致。
     *
     * @param left 左侧字典。
     * @param right 右侧字典。
     * @returns key 集合和值都相同时返回 true。
     */
    private isSameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        return this.isSameStringArray(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key]);
    }

    /**
     * 释放 CLI 子进程和事件监听资源。
     */
    public dispose(): void {
        void this.disposeRunningChild('CliProcess dispose');
        this.emitter.removeAllListeners();
        this.setStatus('idle');
    }

    /**
     * 构造 stream-json stdin/stdout 启动参数。
     *
     * `--print` 是 CLI 文档中启用 stream-json 输入输出格式的前置模式。
     *
     * **关于 `--bare`（已移除）**：早期版本使用 `--bare` 是为了强制 CLI 从
     * `ANTHROPIC_API_KEY` / apiKeyHelper 读取鉴权信息，避免 OAuth/keychain 干扰。
     * 但 `--bare` 同时会跳过 plugin/skills/CLAUDE.md 同步，并导致 CLI 暴露给模型
     * 的工具集大幅缩水（仅 Bash/Edit/Read 三项），缺少 AskUserQuestion / TodoWrite /
     * Write / Glob / Grep / WebFetch / WebSearch 等关键工具，模型在
     * `--print --input-format stream-json` 非交互模式下也无法弹出权限询问。
     * Claude CLI v2.1.141 实测表明：不带 `--bare` 时 `ANTHROPIC_API_KEY` 仍会被
     * 正确识别（`apiKeySource:"ANTHROPIC_API_KEY"`），且工具集会扩展到 24 项，
     * 因此现在统一去掉 `--bare`，让模型拥有完整工具能力并能调用 AskUserQuestion
     * 触发授权弹窗。
     *
     * 同时根据 `ChatCliConfig.permissionMode` 注入 `--permission-mode <mode>`，
     * 默认 `acceptEdits` 用于让 Edit/Write/Read 类工具在非交互模式下自动放行；
     * 若用户已在 `cliArgs` 中显式指定权限模式，则尊重用户配置不再追加，避免重复参数。
     *
     * @param cliArgs 用户附加参数。
     * @param resumeSessionId 需要恢复的 Claude CLI session_id。
     * @returns spawn 参数数组。
     */
    private buildStreamJsonArgs(cliArgs: string[], resumeSessionId?: string): string[] {
        const args = ['--print', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', ...cliArgs];
        if (this.currentConfig?.model && !this.hasModelArgument(args)) args.push('--model', this.currentConfig.model);
        const permissionMode = this.currentConfig?.permissionMode;
        if (permissionMode && !this.hasPermissionModeArgument(args)) {
            args.push('--permission-mode', permissionMode);
        }
        if (resumeSessionId) args.push('--resume', resumeSessionId);
        return args;
    }

    /**
     * 判断用户自定义参数中是否已经包含模型参数。
     *
     * @param args 待检查的启动参数。
     * @returns 已存在 `--model` 或 `--model=...` 时返回 true。
     */
    private hasModelArgument(args: string[]): boolean {
        return args.some((arg) => arg === '--model' || arg.startsWith('--model='));
    }

    /**
     * 判断用户自定义参数中是否已经包含权限模式参数。
     *
     * 用于在 `buildStreamJsonArgs` 中决定是否需要额外追加默认的
     * `--permission-mode acceptEdits`，避免与用户在 `chat.cliArgs` 里手动写入的
     * 值冲突。
     *
     * @param args 待检查的启动参数。
     * @returns 已存在 `--permission-mode` 或 `--permission-mode=...` 时返回 true。
     */
    private hasPermissionModeArgument(args: string[]): boolean {
        return args.some((arg) => arg === '--permission-mode' || arg.startsWith('--permission-mode='));
    }

    /**
     * 绑定子进程 stdout/stderr/error/exit 事件。
     *
     * @param child 已启动的 CLI 子进程。
     */
    private bindChildEvents(child: ChildProcessWithoutNullStreams): void {
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (text: string) => {
            Logger.debug(`Chat CLI stdout chunk：length=${text.length}`, this.previewLogText(text));
            this.emitter.emit(CHUNK_EVENT, { source: 'stdout', text, receivedAt: Date.now() } satisfies CliChunk);
        });
        child.stderr.on('data', (text: string) => {
            Logger.debug(`Chat CLI stderr chunk：length=${text.length}`, this.previewLogText(text));
            this.emitter.emit(CHUNK_EVENT, { source: 'stderr', text, receivedAt: Date.now() } satisfies CliChunk);
        });
        child.on('error', (err) => {
            Logger.error('Chat CLI 进程错误', err);
            this.setStatus('error');
        });
        child.on('exit', (code, signal) => {
            Logger.info(`Chat CLI 已退出：code=${code ?? 'null'}, signal=${signal ?? 'null'}`);
            this.setStatus(code === 0 ? 'exited' : 'error');
            this.emitter.emit(EXIT_EVENT, { code, signal, exitedAt: Date.now() } satisfies CliExitEvent);
        });
    }

    /**
     * 清理当前正在运行的子进程。
     *
     * @param reason 日志记录用的清理原因。
     */
    private async disposeRunningChild(reason: string): Promise<void> {
        const child = this.child;
        if (!child) return;
        Logger.info(`停止 Chat CLI：${reason}`);
        this.child = undefined;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), 1500);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            if (!child.killed) child.kill('SIGTERM');
        });
    }

    /**
     * 更新内部状态并向订阅者广播。
     *
     * @param status 新状态。
     */
    private setStatus(status: CliProcessStatus): void {
        if (this.status === status) return;
        this.status = status;
        this.emitter.emit(STATUS_EVENT, status);
    }

    /**
     * 截断 CLI 原始输出用于日志预览，避免过长内容刷屏。
     *
     * @param text 原始 stdout/stderr 文本。
     * @returns 最多 2000 字符的预览文本。
     */
    private previewLogText(text: string): string {
        const limit = 2000;
        return text.length > limit ? `${text.slice(0, limit)}\n...<truncated ${text.length - limit} chars>` : text;
    }
}
