/**
 * Relay 命中看门狗与 Relay/CLI 自愈重发链路。
 *
 * 拆分自 extension.ts：把「用户提交后等待 Relay 命中 → 超时判定 HTTP 卡死 →
 * 重启 Relay 与 CLI → 延时静默重发上一条 prompt」这条自愈闭环，连同其全部
 * 计时器与互斥锁状态收敛到一个模块。
 *
 * 依赖方向：本模块位于 chatRuntime 上层，直接 import 会话、消息、生命周期与
 * Webview 模块；无需反向注入 extension.ts 的函数。
 */
import { Logger } from '../logger';
import { getRelayServer } from '../runtime';
import { appendAssistantSegments } from './chatSession';
import { sendUserMessageToCli } from './chatMessaging';
import { restartChatCli } from './cliLifecycle';
import { showChatToast } from './webviewMessages';

/**
 * 用户主动提交消息后等待 Relay 命中的全局计时器。
 *
 * 计时窗口内 RelayServer 收到 `POST /v1/messages` 即清除；超时则触发自愈：
 * 重启 HTTP Relay → 重启 Claude CLI → 自动重发最近一次 prompt。
 */
let pendingHttpExpectationTimer: NodeJS.Timeout | undefined;

/** 等待命中的最近一次 prompt，用于自愈后自动重发。 */
let pendingHttpExpectationPrompt: string | undefined;

/** 等待命中的开始时间戳，便于日志诊断耗时。 */
let pendingHttpExpectationStartedAt: number | undefined;

/** 自愈流程互斥锁，避免并发重启 Relay/CLI。 */
let isHealingRelayAndCli = false;

/** 自愈重启后等待 CLI 完全就绪、再内部重发上次消息的延时计时器。 */
let pendingResendTimer: NodeJS.Timeout | undefined;

/** 用户消息提交后等待 Relay 命中的超时阈值（毫秒）。 */
const HTTP_EXPECTATION_TIMEOUT_MS = 20_000;

/** 自愈重启后到内部重发之间的等待时长（毫秒），给 CLI 充足启动时间。 */
const HEAL_RESEND_DELAY_MS = 2_000;
/**
 * 登记一次"等待 Relay 命中"全局计时器。
 *
 * 用户主动 `user/send` 提交消息后调用：若 20 秒内 RelayServer 未收到 `POST
 * /v1/messages` 请求（命中后会清除该计时器），则视为 HTTP 卡死，进入自愈流程
 * （{@link healRelayAndCli}）。后续提交或自愈再次启动时会先清除上一次计时器。
 *
 * 重入保护：若当前正处于自愈流程（`isHealingRelayAndCli === true`），说明
 * 之前还存在一个由 {@link scheduleHealResend} 排队的 60s 静默重发计时器。
 * 此时用户重新发送消息已经覆盖了旧 prompt 的意图，先调用
 * {@link cancelPendingResend} 取消旧重发并释放互斥锁，避免到点后旧 prompt
 * 被静默重新发送一次造成双重提交。
 *
 * @param prompt 本次提交的完整 prompt 文本，超时后用于自动重发。
 */
export function armHttpExpectation(prompt: string): void {
    if (isHealingRelayAndCli) {
        Logger.info('armHttpExpectation 检测到自愈进行中，取消旧的待重发任务避免重复发送');
        cancelPendingResend('user-resend-supersedes');
    }
    clearHttpExpectation('rearm');
    pendingHttpExpectationPrompt = prompt;
    pendingHttpExpectationStartedAt = Date.now();
    Logger.info(`Relay 看门狗已启动（等待 Relay 命中）：timeout=${HTTP_EXPECTATION_TIMEOUT_MS}ms, promptLength=${prompt.length}`);
    pendingHttpExpectationTimer = setTimeout(() => {
        pendingHttpExpectationTimer = undefined;
        void onHttpExpectationTimeout();
    }, HTTP_EXPECTATION_TIMEOUT_MS);
}

/**
 * 清除"等待 Relay 命中"全局计时器。
 *
 * 在以下情况下调用：RelayServer 命中、用户取消、会话清空、CLI 退出、重新登记
 * 计时器、扩展 deactivate。多次调用幂等。
 *
 * @param reason 触发清除的原因，仅用于日志诊断。
 */
export function clearHttpExpectation(reason: string): void {
    if (pendingHttpExpectationTimer) {
        clearTimeout(pendingHttpExpectationTimer);
        pendingHttpExpectationTimer = undefined;
        const elapsed = pendingHttpExpectationStartedAt ? Date.now() - pendingHttpExpectationStartedAt : -1;
        Logger.info(`Relay 看门狗已清除：reason=${reason}, elapsed=${elapsed}ms`);
    }
    pendingHttpExpectationPrompt = undefined;
    pendingHttpExpectationStartedAt = undefined;
}

/**
 * 看门狗超时回调：触发"重启 HTTP Relay → 重启 CLI → 延时 60s 内部重发"自愈流程。
 *
 * 通过 {@link isHealingRelayAndCli} 互斥，避免并发触发；自愈期间不会再次启动
 * 看门狗，重启完成后由 {@link scheduleHealResend} 延时重发，重发时再调用
 * {@link armHttpExpectation} 重新计时。
 */
export async function onHttpExpectationTimeout(): Promise<void> {
    if (isHealingRelayAndCli) {
        Logger.warn('Relay 看门狗超时，但已有自愈流程在执行，本次忽略');
        return;
    }
    const prompt = pendingHttpExpectationPrompt;
    pendingHttpExpectationPrompt = undefined;
    pendingHttpExpectationStartedAt = undefined;
    if (!prompt) {
        Logger.warn('Relay 看门狗超时，但未保留 prompt，跳过自愈');
        return;
    }
    isHealingRelayAndCli = true;
    try {
        await healRelayAndCli(prompt);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`Relay/CLI 自愈流程失败：${message}`);
        await appendAssistantSegments(
            [{ kind: 'error', text: `\n自动恢复失败：${message}\n` }],
            true
        );
        isHealingRelayAndCli = false;
    }
    // 注意：成功路径下不在这里释放锁。
    // 锁会在 scheduleHealResend → 内部重发完成时释放，避免重启刚完成又被新的超时
    // 抢占触发第二轮自愈。
}

/**
 * 执行 HTTP Relay 与 Claude CLI 的自愈流程（不包含重发）。
 *
 * 顺序：写入一条 Chat 提示 → 重启 RelayServer（可能换端口）→ 重启 CLI 子进程
 * （新端口随 ANTHROPIC_BASE_URL 注入）→ 安排 60 秒后内部重发。重启异常会上抛
 * 给调用方处理；安排好延时重发后立即返回，等待计时器到期。
 *
 * @param prompt 需要重发的 prompt 文本。
 */
export async function healRelayAndCli(prompt: string): Promise<void> {
    const expectationSeconds = Math.round(HTTP_EXPECTATION_TIMEOUT_MS / 1000);
    Logger.warn(`Relay ${expectationSeconds} 秒未命中，开始自愈：promptLength=${prompt.length}`);
    void appendAssistantSegments(
        [{
            kind: 'error',
            text: `\n本地中转 ${expectationSeconds} 秒内未收到请求，正在自动重启 Relay 与 CLI，重启完成后 ${Math.round(HEAL_RESEND_DELAY_MS / 1000)} 秒再重发上一条消息…\n`
        }],
        false
    );
    void showChatToast('warn', `本地中转 ${expectationSeconds} 秒未响应，正在自动恢复…`);
    const relay = getRelayServer();
    if (relay) {
        const oldPort = relay.getActualPort();
        Logger.warn(`自愈：准备重启 Relay，oldPort=${oldPort ?? 'unknown'}`);
        void appendAssistantSegments(
            [{
                kind: 'markdown',
                text: `\n> 正在停止本地中转 HTTP 服务${typeof oldPort === 'number' ? `（旧端口 ${oldPort}）` : ''}…\n`
            }],
            false
        );
        try {
            const newPort = await relay.restart();
            Logger.info(`Relay 已自愈重启，新端口=${newPort}`);
            void appendAssistantSegments(
                [{
                    kind: 'markdown',
                    text: `\n> 本地中转 HTTP 服务已启动：http://127.0.0.1:${newPort}\n`
                }],
                false
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Relay 自愈重启失败：${message}`);
            void appendAssistantSegments(
                [{ kind: 'error', text: `\n本地中转 HTTP 服务重启失败：${message}\n` }],
                false
            );
            throw err;
        }
    }
    void appendAssistantSegments(
        [{ kind: 'markdown', text: '\n> 正在重启 Claude CLI 子进程…\n' }],
        false
    );
    try {
        Logger.warn('自愈：准备重启 Claude CLI');
        await restartChatCli({ silent: true });
        Logger.info('自愈：Claude CLI 已重启完成');
        void appendAssistantSegments(
            [{ kind: 'markdown', text: '\n> Claude CLI 已重启完成\n' }],
            false
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`CLI 自愈重启失败：${message}`);
        void appendAssistantSegments(
            [{ kind: 'error', text: `\nClaude CLI 重启失败：${message}\n` }],
            false
        );
        throw err;
    }
    scheduleHealResend(prompt);
}

/**
 * 安排自愈重启后的延时内部重发。
 *
 * 给 CLI 充足启动时间（默认 60 秒），到期后调用 {@link armHttpExpectation} 重新
 * 计时并发送上次 prompt。重发成功（无论命中与否，看门狗都会重新负责）或重发
 * 异常都会释放 {@link isHealingRelayAndCli} 互斥锁。
 *
 * 用户在等待期间触发取消/会话清空时会通过 {@link cancelPendingResend} 清掉本
 * 计时器，避免再发出过期消息。
 *
 * @param prompt 需要内部重发的 prompt 文本。
 */
export function scheduleHealResend(prompt: string): void {
    cancelPendingResend('rearm');
    Logger.info(`已安排自愈重发：delay=${HEAL_RESEND_DELAY_MS}ms`);
    pendingResendTimer = setTimeout(async () => {
        pendingResendTimer = undefined;
        try {
            Logger.info('自愈重启完成，开始内部重发最近一次用户消息');
            armHttpExpectation(prompt);
            await sendUserMessageToCli(prompt);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`自愈重发失败：${message}`);
            await appendAssistantSegments(
                [{ kind: 'error', text: `\n自动恢复后重发失败：${message}\n` }],
                true
            );
        } finally {
            isHealingRelayAndCli = false;
        }
    }, HEAL_RESEND_DELAY_MS);
}

/**
 * 取消尚未触发的自愈重发计时器，并释放自愈互斥锁。
 *
 * 用户取消、会话清空、CLI 退出、扩展 deactivate 时调用，防止过期消息被自动
 * 重发出去。
 *
 * @param reason 触发取消的原因，仅用于日志诊断。
 */
export function cancelPendingResend(reason: string): void {
    if (pendingResendTimer) {
        clearTimeout(pendingResendTimer);
        pendingResendTimer = undefined;
        isHealingRelayAndCli = false;
        Logger.info(`自愈重发已取消：reason=${reason}`);
    }
}
