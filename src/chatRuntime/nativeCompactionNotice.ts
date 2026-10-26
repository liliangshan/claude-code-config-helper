/** @file 原生压缩兼容性通知；同一问题仅提示一次，不自动升级或终止任务。 */
import type { NativeCompactionPolicy } from '../nativeCompactionPolicy';
import { MIN_NATIVE_COMPACTION_VERSION } from '../nativeCompactionPolicy';

/** 非阻塞通知的最小依赖，便于不启动 VS Code 的回归测试。 */
export interface NativeCompactionNoticeDeps {
    /** 显示系统通知。 */
    warn: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
    /** 打开用户选择入口，不立即重启活动任务。 */
    select: () => Promise<void>;
    /** 清缓存后重新计算策略，生命周期负责安全重启。 */
    retry: () => void;
    /** 用户界面语言。 */
    language: string;
}

/** 通知跨启动去重；手动重试只重新检测，不反复弹同一警告。 */
const shown = new Set<string>();

/**
 * 显示明确的版本/探测/窗口提示，路径帮助发现更新了另一份 CLI 的情况。
 * @param policy 已应用的策略。
 * @param cliPath 实际配置文件。
 * @param deps 通知与安全操作。
 * @returns 用户处理通知完成；不阻塞 CLI 启动。
 */
export async function notifyNativeCompactionUnsupported(policy: NativeCompactionPolicy | undefined, cliPath: string, deps: NativeCompactionNoticeDeps): Promise<void> {
    if (!policy?.enabled || policy.status !== 'unsupported') {
        for (const key of shown) if (key.startsWith(`${cliPath}\n`)) shown.delete(key);
        return;
    }
    const reason = policy.unsupportedReason ?? 'version_unknown';
    const key = `${cliPath}\n${reason}:${policy.cliVersion ?? ''}:${policy.contextLimit}`;
    if (shown.has(key)) return;
    shown.add(key);
    const zh = deps.language.startsWith('zh');
    const retry = zh ? '重新检测' : 'Check again';
    const select = zh ? '重新选择 CLI' : 'Select CLI';
    const close = zh ? '关闭' : 'Dismiss';
    const detail = reason === 'version_old'
        ? zh ? `CLI 版本 ${policy.cliVersion} 低于最低要求 ${MIN_NATIVE_COMPACTION_VERSION}。请更新下面路径对应的文件，而不是另一份 CLI。`
            : `CLI ${policy.cliVersion} is older than ${MIN_NATIVE_COMPACTION_VERSION}. Update the file at the path below, not another CLI installation.`
        : reason === 'window'
            ? zh ? `模型上下文窗口 ${policy.contextLimit} 超出托管范围 100000–1000000 token；这不是 CLI 版本问题。`
                : `Context window ${policy.contextLimit} is outside the managed range of 100000–1000000 tokens; this is not a CLI version problem.`
            : zh ? '无法确认 CLI 版本：版本检测启动失败、超时（15 秒），或输出不是可识别的 CLI 版本。不能据此判断版本过低。'
                : 'Could not verify the CLI version: the probe failed to launch, timed out (15 seconds), or returned an unrecognized version. This does not mean the version is too old.';
    const message = zh ? `原生自动压缩未接管。${detail}\n实际 CLI 路径：${cliPath}\n手动 /compact 保留。`
        : `Native auto-compaction is not managed. ${detail}\nActual CLI path: ${cliPath}\nManual /compact remains available.`;
    const action = await deps.warn(message, retry, select, close);
    if (action === retry) deps.retry();
    if (action === select) await deps.select();
}
