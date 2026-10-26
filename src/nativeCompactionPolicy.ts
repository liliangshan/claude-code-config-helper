/** @file CLI 与 Relay 共用的上下文窗口及原生自动压缩策略（不依赖 VS Code）。 */

/** 自动压缩工作区设置键。 */
export const AUTO_COMPACT_SETTING_KEY = 'chat.autoCompact.enabled';
/** 无模型配置或静态表命中时的窗口。 */
export const DEFAULT_CONTEXT_LIMIT = 200_000;
/** 原生窗口能力已核验的最低 CLI 版本。 */
export const MIN_NATIVE_COMPACTION_VERSION = '2.1.280';

/** 现有已知模型窗口，不以默认值抬高小窗口模型。 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'claude-opus-4-7': 200_000, 'claude-sonnet-4-6': 200_000,
    'claude-haiku-4-5': 200_000, 'claude-haiku-4-5-20251001': 200_000,
    'claude-3-5-sonnet': 200_000, 'claude-3-5-haiku': 200_000,
    'gpt-4o': 128_000, 'gpt-4o-mini': 128_000, 'gpt-4-turbo': 128_000
};

/** 本功能管理的键；每次启动从原始环境重新生成，禁止复用上次覆盖值。 */
export const NATIVE_COMPACTION_ENV_KEYS = [
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'
] as const;

/** 非敏感策略摘要；estimatedThreshold 不是原生确认值。 */
export interface NativeCompactionPolicy {
    enabled: boolean;
    contextLimit: number;
    source: 'configured' | 'static' | 'default';
    percentage: 90 | 80;
    estimatedThreshold: number;
    status: 'managed' | 'disabled' | 'conflict' | 'unsupported';
    conflicts: string[];
    cliVersion?: string;
    /** 不接管的明确原因，避免把探测失败误称为版本过低。 */
    unsupportedReason?: 'version_unknown' | 'version_old' | 'window';
    /** 已选择摘要模型的容量偏小，仅提示，不自动改模型或扩大窗口。 */
    summaryContextLimit?: number;
}

/**
 * 统一解析模型窗口，非法配置回退，不修改模型对象。
 * @param modelId 模型 ID。
 * @param configured 用户配置的 contextLength。
 * @returns 窗口和来源。
 */
export function resolveContextWindow(modelId: string, configured?: unknown): Pick<NativeCompactionPolicy, 'contextLimit' | 'source'> {
    if (typeof configured === 'number' && Number.isFinite(configured) && Math.floor(configured) > 0) {
        return { contextLimit: Math.floor(configured), source: 'configured' };
    }
    const known = Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_LIMITS, modelId) ? MODEL_CONTEXT_LIMITS[modelId] : undefined;
    return { contextLimit: known ?? DEFAULT_CONTEXT_LIMIT, source: known ? 'static' : 'default' };
}

/** 按 200k 边界选择使用比例。
 * @param limit 模型窗口。
 * @returns ≤200k 为 90，大于 200k 为 80。
 */
export function compactionPercentage(limit: number): 90 | 80 { return limit <= 200_000 ? 90 : 80; }

/**
 * 估算 2.1.280 原生阈值，未知输出上限时保守预留 20k。
 * @param limit 有效窗口。
 * @param maxOutput 可选最大输出配置。
 * @returns 非负估算阈值，不能当作原生反馈。
 */
export function estimateCompactionThreshold(limit: number, maxOutput = 20000): number {
    const output = Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 20000;
    const effective = limit - Math.min(output, 20000);
    return Math.max(0, Math.min(Math.floor(effective * compactionPercentage(limit) / 100), effective - 13000));
}

/** 判断环境中的显式禁用值；@param value 环境变量原文。 */
export function envFlagEnabled(value: string | undefined): boolean {
    return !!value && !['0', 'false', 'no', 'off', ''].includes(value.trim().toLowerCase());
}

/**
 * 生成原生策略及子进程覆盖值；冲突时不接管，不解除用户禁用配置。
 * @param modelId 当前主模型。
 * @param configured 模型上下文配置。
 * @param enabled 扩展自动压缩开关。
 * @param inherited 父进程与用户环境合并结果，不含上次生成值。
 * @param nativeConflicts 原生设置中检测到的禁用或不同窗口键。
 * @param cliVersion 当前实际可执行文件版本；未探测时不确认托管生效。
 * @returns 策略与本次生成环境，不修改入参。
 */
export function buildNativeCompactionPolicy(modelId: string, configured: unknown, enabled: boolean, inherited: NodeJS.ProcessEnv, nativeConflicts: string[] = [], cliVersion?: string): { policy: NativeCompactionPolicy; env: Record<string, string> } {
    const window = resolveContextWindow(modelId, configured);
    const percentage = compactionPercentage(window.contextLimit);
    const intended = {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window.contextLimit),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window.contextLimit),
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(percentage)
    };
    const conflicts = enabled ? Object.entries(intended).filter(([key, value]) => inherited[key]?.trim() && Number(inherited[key]) !== Number(value)).map(([key]) => key) : [];
    for (const key of ['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT']) {
        if (enabled && envFlagEnabled(inherited[key])) conflicts.push(key);
    }
    if (enabled) conflicts.push(...nativeConflicts);
    const unsupportedReason = !cliVersion || !parseCliVersion(cliVersion) ? 'version_unknown'
        : !supportsNativeCompaction(cliVersion) ? 'version_old'
            : window.contextLimit < 100000 || window.contextLimit > 1000000 ? 'window' : undefined;
    const supported = unsupportedReason === undefined;
    const status = !enabled ? 'disabled' : conflicts.length ? 'conflict' : !supported ? 'unsupported' : 'managed';
    const env: Record<string, string> = status === 'managed' ? intended : {};
    // 关闭仅禁用自动压缩，不设置 DISABLE_COMPACT；每次从原始环境重建，重新开启不会继承本次值。
    if (!enabled) {
        env.DISABLE_AUTO_COMPACT = '1';
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window.contextLimit);
    }
    return { policy: { ...window, enabled, percentage, estimatedThreshold: estimateCompactionThreshold(window.contextLimit, Number(inherited.CLAUDE_CODE_MAX_OUTPUT_TOKENS)), status, conflicts: [...new Set(conflicts)], cliVersion, ...(status === 'unsupported' ? { unsupportedReason } : {}) }, env };
}

/**
 * 合并子进程环境时先移除管理键，再应用本次快照，杜绝父进程二次继承。
 * @param parent 启动时父环境。
 * @param overrides 本次 CLI 环境。
 * @param nativeSnapshot 原始用户值和生成值的最终快照；未提供时维持兼容。
 * @returns 全新的子进程环境，不修改入参。
 */
export function buildCliChildEnv(parent: NodeJS.ProcessEnv, overrides: Record<string, string>, nativeSnapshot?: Record<string, string>): NodeJS.ProcessEnv {
    const env = { ...parent, ...overrides };
    if (nativeSnapshot) {
        for (const key of NATIVE_COMPACTION_ENV_KEYS) delete env[key];
        Object.assign(env, nativeSnapshot);
    }
    return env;
}

/**
 * 从 CLI 版本行解析稳定版本，兼容 v 前缀、Claude Code 标签和 ANSI 颜色。
 * 不从任意警告中的 Node 等组件版本猜测 CLI 版本，不接管预发布版本。
 * @param output --version 输出。
 * @returns 规范化三段版本；无法唯一确认时未知。
 */
export function parseCliVersion(output: string): string | undefined {
    const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const found = new Set<string>();
    for (const raw of clean.split(/\r?\n/)) {
        const line = raw.trim();
        const match = /^(?:v)?(\d+\.\d+\.\d+)(?:\s*\(Claude Code\))?$/i.exec(line)
            ?? /^Claude(?:\s+Code)?(?:\s+version)?\s*[:：]?\s+v?(\d+\.\d+\.\d+)$/i.exec(line);
        if (match && match[1].split('.').every(value => Number.isSafeInteger(Number(value)))) found.add(match[1]);
    }
    return found.size === 1 ? [...found][0] : undefined;
}

/** 比较 CLI 版本是否满足已验证能力基线；@param version --version 输出。 */
export function supportsNativeCompaction(version: string): boolean {
    const parsed = parseCliVersion(version);
    if (!parsed) return false;
    const [major, minor, patch] = parsed.split('.').map(Number);
    return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 280)));
}
