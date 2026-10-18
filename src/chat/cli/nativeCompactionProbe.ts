/** @file 只读探测选定 CLI 的版本和原生压缩配置，不写全局设置。 */
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NATIVE_COMPACTION_ENV_KEYS } from '../../nativeCompactionPolicy';

/** 可执行文件版本缓存按路径、mtime、大小区分，升级后自动失效。 */
const versions = new Map<string, Promise<string | undefined>>();

/**
 * 对实际选定文件执行 --version，避免误用 PATH 中的另一份 CLI。
 * @param cliPath 启动文件路径。
 * @returns 版本输出；探测失败时未知，不阻塞手动压缩。
 */
export async function probeCliVersion(cliPath: string): Promise<string | undefined> {
    if (!cliPath) return undefined;
    const stat = await fs.stat(cliPath).catch(() => undefined);
    const key = `${cliPath}:${stat?.mtimeMs}:${stat?.size}`;
    let value = versions.get(key);
    if (!value) {
        value = new Promise(resolve => {
            execFile(cliPath, ['--version'], { timeout: 5000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
                resolve(error ? undefined : stdout.trim());
            });
        });
        versions.set(key, value);
    }
    return value;
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
