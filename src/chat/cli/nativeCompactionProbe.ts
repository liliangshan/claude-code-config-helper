/** @file 只读探测选定 CLI 的版本和原生压缩配置，不写全局设置。 */
import { execFile } from 'child_process';
import { createHash } from 'node:crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NATIVE_COMPACTION_ENV_KEYS, parseCliVersion } from '../../nativeCompactionPolicy';

/** 同一文件/环境的并发探测合并；失败不缓存，成功仅缓存一分钟。 */
const versions = new Map<string, { result: Promise<string | undefined>; expires: number }>();

/** 清除版本缓存供用户显式重新检测，不修改 CLI 文件。 */
export function clearCliVersionCache(): void { versions.clear(); }

/**
 * 构造跨平台版本探测入口；Windows 脚本不直接交给 execFile。
 * @param cliPath 用户实际选择的 CLI 路径。
 * @param platform 探测平台，允许纯测试注入。
 * @param env 与启动一致的环境。
 * @returns 可执行文件及参数；cmd 无法安全引用的路径拒绝而非拼接执行。
 */
export function buildCliVersionCommand(cliPath: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
    const ext = path.win32.extname(cliPath).toLowerCase();
    if (platform === 'win32' && ['.cmd', '.bat'].includes(ext)) {
        if (/["%\r\n\0]/.test(cliPath)) throw new Error('unsupported_cmd_path');
        return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/v:off', '/c', `""${cliPath}" --version"`], windowsVerbatimArguments: true };
    }
    if (platform === 'win32' && ext === '.ps1') {
        return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', cliPath, '--version'] };
    }
    return { file: cliPath, args: ['--version'] };
}

/**
 * 对实际文件执行 --version，使用与 CLI 启动一致的 cwd/env。
 * @param cliPath 启动文件路径。
 * @param options 工作目录和原始用户环境；不含鉴权日志。
 * @returns 规范化版本；失败不缓存，不以 Node 等组件版本代替。
 */
export async function probeCliVersion(cliPath: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string | undefined> {
    if (!cliPath) return undefined;
    const env = options.env ?? process.env;
    const stat = await fs.stat(cliPath).catch(() => undefined);
    // 环境仅用于内存缓存身份，不写日志或磁盘。
    const key = createHash('sha256').update(JSON.stringify([cliPath, stat?.mtimeMs, stat?.size, options.cwd, Object.entries(env).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
    const existing = versions.get(key);
    if (existing && existing.expires > Date.now()) return existing.result;
    for (const [cachedKey, entry] of versions) if (entry.expires <= Date.now()) versions.delete(cachedKey);
    if (versions.size >= 32) versions.delete(versions.keys().next().value!);
    const result = new Promise<string | undefined>(resolve => {
        try {
            const command = buildCliVersionCommand(cliPath, process.platform, env);
            execFile(command.file, command.args, { cwd: options.cwd, env, timeout: 15000, maxBuffer: 65536, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments }, (error, stdout, stderr) => {
                resolve(error ? undefined : parseCliVersion(stdout) ?? parseCliVersion(stderr));
            });
        } catch { resolve(undefined); }
    });
    const entry = { result, expires: Date.now() + 60000 };
    versions.set(key, entry);
    const version = await result;
    if (!version && versions.get(key) === entry) versions.delete(key);
    return version;
}

/**
 * 读取原生用户/项目/启动参数设置中的窗口与禁用冲突，只返回键名。
 * @param cwd CLI 工作目录。
 * @param env 原始父进程与用户环境。
 * @param args 用户启动参数。
 * @param contextLimit 期望模型窗口。
 * @returns 不含配置值或凭据的冲突键名。
 */
export async function probeNativeCompactionConflicts(cwd: string, env: NodeJS.ProcessEnv, args: string[], contextLimit: number): Promise<string[]> {
    const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const files = [
        env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json'),
        path.join(configDir, 'settings.json'),
        ...(process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
            : process.platform === 'win32' ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')]
                : ['/etc/claude-code/managed-settings.json'])
    ];
    // CLI 会从 cwd 向上解析项目设置，不能只检查当前目录。
    for (let directory = cwd; ; directory = path.dirname(directory)) {
        files.push(path.join(directory, '.claude', 'settings.json'), path.join(directory, '.claude', 'settings.local.json'));
        if (path.dirname(directory) === directory) break;
    }
    const objects: Array<Record<string, unknown>> = [];
    for (const file of files) {
        try { objects.push(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { /* 缺失或无效配置由 CLI 自己报告。 */ }
    }
    for (let index = 0; index < args.length; index++) {
        const raw = args[index] === '--settings' ? args[++index]
            : args[index].startsWith('--settings=') ? args[index].slice('--settings='.length) : undefined;
        if (!raw) continue;
        try { objects.push(JSON.parse(raw.trim().startsWith('{') ? raw : await fs.readFile(path.resolve(cwd, raw), 'utf8'))); } catch { /* 不猜测 CLI 对非法参数的处理。 */ }
    }
    const conflicts = new Set<string>();
    for (const object of objects) {
        if (!object || typeof object !== 'object') continue;
        if (object.autoCompactEnabled === false) conflicts.add('autoCompactEnabled');
        if (object.autoCompactWindow !== undefined && Number(object.autoCompactWindow) !== contextLimit) conflicts.add('autoCompactWindow');
        const settingsEnv = object.env;
        if (settingsEnv && typeof settingsEnv === 'object') {
            for (const key of NATIVE_COMPACTION_ENV_KEYS) {
                const value = (settingsEnv as Record<string, unknown>)[key];
                if (typeof value !== 'string') continue;
                // 原生设置 env 可能在启动后覆盖 spawn 环境；交给同一个策略校验函数。
                const intended = key === 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' ? (contextLimit <= 200000 ? 90 : 80) : contextLimit;
                if (key.startsWith('DISABLE_')) {
                    if (value && !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())) conflicts.add(key);
                } else if (value.trim() && Number(value) !== intended) conflicts.add(key);
            }
        }
    }
    return [...conflicts];
}
