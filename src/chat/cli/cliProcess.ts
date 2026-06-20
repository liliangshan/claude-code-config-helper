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

    /** 被主动清理的子进程 pid 集合；这些退出不应上报为 CLI 错误。 */
    private readonly expectedExitPids = new Set<number>();

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
        const argValue = (name: string) => {
            const index = args.indexOf(name);
            return index >= 0 ? args[index + 1] || '' : '';
        };
        Logger.info('启动 Chat CLI：' + JSON.stringify({
            cliPath: config.cliPath,
            cwd: config.cwd,
            argsCount: args.length,
            model: argValue('--model'),
            permissionMode: argValue('--permission-mode'),
            dangerouslySkip: args.includes('--dangerously-skip-permissions'),
            hasMcpConfig: args.includes('--mcp-config'),
            hasAppendSystemPrompt: args.includes('--append-system-prompt'),
            hasResume: args.includes('--resume')
        }));
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
        this.child.stdin.write(line);
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
     * 取消语义上属于"预期退出"——若 CLI 在收到 SIGINT 后直接退出（典型 Node CLI
     * 行为），宿主端不应再弹「Chat CLI 异常退出」提示。因此这里把当前 pid 加入
     * {@link expectedExitPids}，由 `bindChildEvents` 直接静默吸收退出事件，
     * 不再依赖宿主侧 `chatCliCancelRequested` 与 EXIT 事件之间的时序。
     * 同样保留 30s 自动清理，防止 CLI 实际不退出时永久占位。
     *
     * 后续接入 `CliAdapter` 后，可在适配器中优先发送协议级取消消息。
     */
    public cancel(): void {
        if (!this.child || this.child.killed) return;
        const pid = typeof this.child.pid === 'number' ? this.child.pid : undefined;
        if (pid !== undefined) {
            this.expectedExitPids.add(pid);
            setTimeout(() => this.expectedExitPids.delete(pid), 30_000).unref?.();
        }
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
     * 停止 CLI 子进程，但保留事件订阅与最近一次启动配置。
     *
     * 与 {@link dispose} 的区别在于：dispose 会同时移除全部监听器并永久退出，
     * 而 stop 仅终止当前子进程，调用方随后可以再次调用 {@link start}/{@link restart}
     * 复用既有订阅与配置。聊天区"重启 HTTP+CLI"流程会先调用本方法，再单独
     * 重启 Relay。
     */
    public async stop(): Promise<void> {
        await this.disposeRunningChild('Chat CLI 显式停止');
        this.setStatus('idle');
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
            (left.appendSystemPrompt ?? '') === (right.appendSystemPrompt ?? '') &&
            (left.strictMcpConfig === true) === (right.strictMcpConfig === true) &&
            this.isSameStringArray(left.cliArgs, right.cliArgs) &&
            this.isSameStringRecord(left.cliEnv, right.cliEnv) &&
            this.isSameSkills(left.skills, right.skills) &&
            this.isSameMcpServers(left.mcpServers, right.mcpServers);
    }

    /**
     * 对比两份 skills 配置是否完全一致。
     *
     * 规则：
     * - 两者都缺省视为一致；
     * - `"all"` 与 `"all"` 视为一致；
     * - 数组按顺序+元素完全比较（规范化阶段已去重且按用户输入顺序）。
     *
     * @param left 左侧 skills 配置。
     * @param right 右侧 skills 配置。
     * @returns 等价时返回 true。
     */
    private isSameSkills(left: ChatCliConfig['skills'], right: ChatCliConfig['skills']): boolean {
        if (left === undefined && right === undefined) return true;
        if (left === 'all' || right === 'all') return left === right;
        const leftArr = Array.isArray(left) ? left : [];
        const rightArr = Array.isArray(right) ? right : [];
        return this.isSameStringArray(leftArr, rightArr);
    }

    /**
     * 对比两份 MCP servers 配置是否完全一致。
     *
     * 用稳定 JSON 序列化（key 排序）做深比较，避免字段顺序变化触发误重启。
     *
     * @param left 左侧 MCP servers 字典。
     * @param right 右侧 MCP servers 字典。
     * @returns 等价时返回 true。
     */
    private isSameMcpServers(
        left: ChatCliConfig['mcpServers'],
        right: ChatCliConfig['mcpServers']
    ): boolean {
        const leftJson = this.stableStringify(left ?? {});
        const rightJson = this.stableStringify(right ?? {});
        return leftJson === rightJson;
    }

    /**
     * 对任意 JSON-safe 值做稳定字符串化（对象键按字母序排序）。
     *
     * @param value 输入值。
     * @returns 稳定 JSON 字符串。
     */
    private stableStringify(value: unknown): string {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) {
            return '[' + value.map((item) => this.stableStringify(item)).join(',') + ']';
        }
        const keys = Object.keys(value as Record<string, unknown>).sort();
        return '{' + keys
            .map((key) => JSON.stringify(key) + ':' + this.stableStringify((value as Record<string, unknown>)[key]))
            .join(',') + '}';
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
    * `--permission-prompt-tool stdio` 则接入官方 Claude Code 扩展同款授权通道：
    * CLI 在 Bash/Edit/Write 等工具需要用户确认时，会向 stdout 发送
    * `control_request` / `can_use_tool`，扩展宿主确认后再通过 stdin 写回
    * `control_response`，避免非交互模式下直接报 `This command requires approval`。
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
        if (permissionMode === 'bypassPermissions') {
            // 非交互（--print）模式下，仅传 `--permission-mode bypassPermissions` 在部分
            // CLI 版本上仍会对工具要求授权（无应答通道时甚至卡住）。改用官方
            // `--dangerously-skip-permissions`：它才是 print 模式下真正「全部跳过授权」
            // 的开关。此时不再追加 `--permission-mode`，也不接 stdio 授权工具。
            if (!this.hasDangerouslySkipPermissionsArgument(args)) {
                args.push('--dangerously-skip-permissions');
            }
        } else {
            if (permissionMode && !this.hasPermissionModeArgument(args)) {
                args.push('--permission-mode', permissionMode);
            }
            this.appendPermissionPromptToolArgs(args);
        }
        this.appendMcpArgs(args);
        this.appendSkillArgs(args);
        this.appendAppendSystemPromptArgs(args);
        if (resumeSessionId) args.push('--resume', resumeSessionId);
        return args;
    }

    /**
     * 把 `ChatCliConfig.appendSystemPrompt` 注入为 `--append-system-prompt <text>`。
     *
     * 双 CLI 路由方案下，`getDualConfigsWithRelayEnv` 会分别给 normal / expert
     * 两条 CLI 派生不同的 dispatcher / expert 系统提示词。提示词非空且用户没有
     * 在 `chat.cliArgs` 里手动写入同名参数时，由本方法以 `--append-system-prompt`
     * 形式追加到启动参数末尾，让 Claude CLI 把文案合并进默认 system prompt。
     *
     * @param args 已构造的启动参数数组（原地修改）。
     */
    private appendAppendSystemPromptArgs(args: string[]): void {
        const text = (this.currentConfig?.appendSystemPrompt ?? '').trim();
        if (!text) return;
        if (this.hasAppendSystemPromptArgument(args)) return;
        args.push('--append-system-prompt', text);
    }

    /**
     * 判断启动参数中是否已经包含 `--append-system-prompt`。
     *
     * @param args 待检查的启动参数。
     * @returns 已存在 `--append-system-prompt` 或 `--append-system-prompt=...` 时返回 true。
     */
    private hasAppendSystemPromptArgument(args: string[]): boolean {
        return args.some((arg) => arg === '--append-system-prompt' || arg.startsWith('--append-system-prompt='));
    }

    /**
     * 注入 Claude CLI stdio 权限提示工具参数。
     *
     * 仅非 `bypassPermissions` 模式使用该交互通道；`bypassPermissions` 已表示完全
     * 放行工具权限，如果继续传 `--permission-prompt-tool stdio`，部分 CLI / provider
     * 组合仍可能弹出权限交互，反而破坏 bypass 的非交互体验。
     *
     * 官方 Claude Code 扩展在提供 `canUseTool` 回调时会自动追加
     * `--permission-prompt-tool stdio`。当前扩展没有直接使用官方 SDK，因此需要在
     * 启动参数层显式追加；若用户已在 `chat.cliArgs` 中手动指定同名参数，则尊重
     * 用户配置，避免重复参数导致 CLI 行为不确定。
     *
     * @param args 已构造的启动参数数组（原地修改）。
     */
    private appendPermissionPromptToolArgs(args: string[]): void {
        if (this.hasPermissionPromptToolArgument(args)) return;
        args.push('--permission-prompt-tool', 'stdio');
    }

    /**
     * 将 `mcpServers` 与 `strictMcpConfig` 配置注入 Claude CLI 启动参数。
     *
     * 参考 Claude Code 官方扩展 (`anthropic.claude-code` 2.1.x) 的 SDK 实现：
     * - 当 `mcpServers` 非空时追加 `--mcp-config '{"mcpServers":...}'`；
     * - 当 `strictMcpConfig` 为 true 时追加 `--strict-mcp-config`；
     *
     * 若用户已在 `chat.cliArgs` 中显式提供同名参数，则尊重用户值不再重复追加，
     * 避免 Claude CLI 因重复参数而报错或行为不确定。
     *
     * @param args 已构造的启动参数数组（原地修改）。
     */
    private appendMcpArgs(args: string[]): void {
        const config = this.currentConfig;
        const servers = config?.mcpServers;
        if (servers && Object.keys(servers).length > 0 && !this.hasMcpConfigArgument(args)) {
            args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
        }
        if (config?.strictMcpConfig && !args.includes('--strict-mcp-config')) {
            args.push('--strict-mcp-config');
        }
    }

    /**
     * 将 `skills` 配置注入 Claude CLI `--allowedTools` 启动参数。
     *
     * 参考 Claude Code 官方扩展中 SDK 对 skills 的处理方式：
     * - `"all"`        → 注入 `Skill`
     * - `string[]`     → 注入 `Skill(name1),Skill(name2)`
     *
     * 若用户已在 `chat.cliArgs` 中显式提供 `--allowedTools`，则会与用户值合并去重；
     * 否则直接追加一个新的 `--allowedTools` 段。
     *
     * @param args 已构造的启动参数数组（原地修改）。
     */
    private appendSkillArgs(args: string[]): void {
        const skills = this.currentConfig?.skills;
        if (!skills) return;
        const skillTokens: string[] = skills === 'all'
            ? ['Skill']
            : skills.map((name) => `Skill(${name})`);
        if (skillTokens.length === 0) return;
        const existingIndex = this.findAllowedToolsValueIndex(args);
        if (existingIndex === -1) {
            args.push('--allowedTools', skillTokens.join(','));
            return;
        }
        const merged = new Set<string>();
        for (const item of args[existingIndex].split(',')) {
            const trimmed = item.trim();
            if (trimmed) merged.add(trimmed);
        }
        for (const token of skillTokens) merged.add(token);
        args[existingIndex] = Array.from(merged).join(',');
    }

    /**
     * 判断启动参数中是否已经包含 `--mcp-config`。
     *
     * @param args 待检查的启动参数。
     * @returns 已存在 `--mcp-config` 或 `--mcp-config=...` 时返回 true。
     */
    private hasMcpConfigArgument(args: string[]): boolean {
        return args.some((arg) => arg === '--mcp-config' || arg.startsWith('--mcp-config='));
    }

    /**
     * 在启动参数数组中查找 `--allowedTools` 对应的值索引。
     *
     * 同时兼容 `--allowedTools <value>` 与 `--allowedTools=<value>` 两种写法；
     * 找不到时返回 -1。
     *
     * @param args 待检查的启动参数。
     * @returns 值所在索引；若 args 仅以 `=` 形式提供，则会就地修改首项把值提出，返回该索引。
     */
    private findAllowedToolsValueIndex(args: string[]): number {
        for (let index = 0; index < args.length; index++) {
            const arg = args[index];
            if (arg === '--allowedTools') {
                if (index + 1 < args.length) return index + 1;
                return -1;
            }
            if (arg.startsWith('--allowedTools=')) {
                args[index] = arg.substring('--allowedTools='.length);
                args.splice(index, 0, '--allowedTools');
                return index + 1;
            }
        }
        return -1;
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
     * 判断启动参数中是否已经包含 `--dangerously-skip-permissions`。
     *
     * 用于 bypassPermissions 分支去重，避免与用户在 `chat.cliArgs` 里手动写入的
     * 同名开关重复。
     *
     * @param args 待检查的启动参数。
     * @returns 已存在 `--dangerously-skip-permissions` 时返回 true。
     */
    private hasDangerouslySkipPermissionsArgument(args: string[]): boolean {
        return args.some((arg) => arg === '--dangerously-skip-permissions');
    }

    /**
     * 判断启动参数中是否已经包含权限提示工具参数。
     *
     * @param args 待检查的启动参数。
     * @returns 已存在 `--permission-prompt-tool` 或 `--permission-prompt-tool=...` 时返回 true。
     */
    private hasPermissionPromptToolArgument(args: string[]): boolean {
        return args.some((arg) => arg === '--permission-prompt-tool' || arg.startsWith('--permission-prompt-tool='));
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
            this.emitter.emit(CHUNK_EVENT, { source: 'stdout', text, receivedAt: Date.now() } satisfies CliChunk);
        });
        child.stderr.on('data', (text: string) => {
            this.emitter.emit(CHUNK_EVENT, { source: 'stderr', text, receivedAt: Date.now() } satisfies CliChunk);
        });
        child.on('error', (err) => {
            Logger.error('Chat CLI 进程错误', err);
            this.setStatus('error');
        });
        child.on('exit', (code, signal) => {
            if (typeof child.pid === 'number' && this.expectedExitPids.delete(child.pid)) {
                Logger.info(`Chat CLI 已按预期退出：pid=${child.pid}, code=${code ?? 'null'}, signal=${signal ?? 'null'}`);
                this.setStatus(this.child ? this.status : 'idle');
                return;
            }
            Logger.info(`Chat CLI 已退出：code=${code ?? 'null'}, signal=${signal ?? 'null'}`);
            this.setStatus(code === 0 ? 'exited' : 'error');
            this.emitter.emit(EXIT_EVENT, { code, signal, exitedAt: Date.now() } satisfies CliExitEvent);
        });
    }

    /**
     * 清理当前正在运行的子进程。
     *
     * 退出流程分两段保证子进程一定收到强制终止：
     * 1. 先发 `SIGTERM`，给 CLI 一次机会做优雅清理（保存历史、关闭流等）。
     * 2. 1500ms 内未退出则补发 `SIGKILL`，避免被卡住的网络 IO / osascript 等
     *    导致子进程留下变成孤儿进程。
     *
     * 同时把 pid 加入 {@link expectedExitPids}，并保留 30s 自动清理；这样即便
     * SIGKILL 后退出事件迟到（典型 macOS 下被 syscall 卡死的进程），也不会被
     * `bindChildEvents` 误判为异常退出。
     *
     * @param reason 日志记录用的清理原因。
     */
    private async disposeRunningChild(reason: string): Promise<void> {
        const child = this.child;
        if (!child) return;
        Logger.info(`停止 Chat CLI：${reason}`);
        const pid = typeof child.pid === 'number' ? child.pid : undefined;
        if (pid !== undefined) {
            this.expectedExitPids.add(pid);
            setTimeout(() => this.expectedExitPids.delete(pid), 30_000).unref?.();
        }
        this.child = undefined;
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                if (!child.killed) {
                    Logger.warn(`Chat CLI SIGTERM 1500ms 未退出，追加 SIGKILL：pid=${pid ?? 'unknown'}`);
                    try {
                        child.kill('SIGKILL');
                    } catch (err) {
                        Logger.warn(`Chat CLI SIGKILL 失败：${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                finish();
            }, 1500);
            child.once('exit', finish);
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
