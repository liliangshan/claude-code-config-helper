/** @file LLS CCAI 任务流自动续推调度器。 */

import * as vscode from 'vscode';
import { Logger } from '../logger';
import { pasteToClaudeCode } from './paster';
import type { LlsTaskService } from './service';

/**
 * 自动续推时使用的"提交一条用户消息"回调。
 *
 * 优先用于内置 Chat WebView + stream-json CLI 适配器场景：实现侧应直接把
 * `text` 作为一条用户消息塞到 CLI stdin（同时让该消息出现在 Chat UI 中），
 * 完全绕开剪贴板、`claude-vscode.focus`、osascript / SendKeys 等系统级模拟，
 * 解决"非外部 Claude Code 扩展环境下命令不存在 / 焦点抢不到"的问题。
 *
 * @param text 续推提示词文本。
 * @returns 提交完成 Promise。
 */
export type AutoContinueSubmitter = (text: string) => Promise<void>;

/**
 * 自动续推提交前的异步回调。
 *
 * 用于在真正提交续推 prompt 前执行前置动作，例如触发 CLI 原生压缩。
 *
 * @returns 前置动作完成 Promise。
 */
export type AutoContinueBeforeSubmit = () => Promise<void>;

/**
 * 上一轮主对话响应缺失任务流工具调用时的续推延时，单位毫秒。
 *
 * 上游模型（尤其是 OpenAI 兼容侧的国产模型）有时会"幻觉"地用文本声称已经
 * 执行了工具，却没有真正发出 tool_use。原来 30 秒延时太长，用户大概率会
 * 提前手动重发；这里缩短到 4 秒，保证主对话刚结束就能自动重试。
 */
const AUTO_CONTINUE_DELAY_MS = 4_000;

/**
 * 本地任务流工具（create/update_llsccai_task_workflow）拦截执行后的续推延时，
 * 单位毫秒。
 *
 * 此时上一轮 Claude Code 已经看到拦截器伪造的 tool_result 文本，需要等待它
 * 完成内部 turn 结束流程再触发下一轮；4 秒能在用户体感上"连贯执行"，又能
 * 给 Claude Code 留出消化时间，避免抢跑。
 */
const TOOL_CONTINUE_DELAY_MS = 4_000;

/**
 * 命中非任务流工具后「空闲看门狗」的等待时长，单位毫秒。
 *
 * 命中 Write/Edit 等非任务流工具后，本应由 Claude Code 自己发起 tool_result
 * 往返继续干活，扩展不该抢跑。看门狗只在 CLI 这轮结束后「持续静默」超过本
 * 时长（期间没有任何新请求）时，才判定 CLI 真停了并兜底续推一次。
 *
 * 取 30 秒而非 4 秒：CLI 在大任务里写完一个文件后，常常要花十几到几十秒做
 * 内部 turn 收尾、下一步规划、甚至本地工具执行，期间未必立刻发出下一条网络
 * 请求。4 秒太短会在 CLI 其实还要自己往下走时过早抢跑，导致看门狗与 CLI 各
 * 推一轮、出现重复续推观感。30 秒能覆盖绝大多数「CLI 自己接手」的间隙，只在
 * 确实长时间静默时才兜底。
 */
const IDLE_WATCHDOG_DELAY_MS = 30_000;

/**
 * 连续多少次"模型只回文字、未调用任何工具"后熔断自动续推。
 *
 * 上游模型偶尔会陷入"反复用文字声称已完成、却始终不发 tool_use"的死循环；
 * 此时无论再发多少轮续推都拿不到状态推进，反而让用户看到大量重复的
 * "请继续执行"提示。达到该阈值后调度器会停止自动续推，并通过 VS Code
 * 通知告知用户介入。计数会在任何"实际调用了任务流本地工具"的健康路径
 * 被重置为 0。
 */
const MAX_CONSECUTIVE_MISSING_TOOL_COUNT = 3;

/**
 * 自动续推调度器。
 *
 * 全局只维护一个定时器；每次 schedule 前都会 cancel 旧定时器。
 * 定时器触发时会重新检查 workflow 是否仍存在、是否未完成，避免过期补刀。
 *
 * 支持两种续推场景：
 *
 * - {@link schedule}：上一轮缺失任务流工具调用，重新粘贴 workflow 续推提示词；
 * - {@link scheduleAfterWorkflowTool}：本地执行了 workflow 工具，让模型继续推进任务。
 */
export class AutoContinueScheduler {
    /** 当前等待中的全局定时器句柄。 */
    private static timer: NodeJS.Timeout | undefined;

    /** 递增全局版本号，用于识别被取消的旧定时器。 */
    private static version = 0;

    /**
     * 连续"模型未调用任何工具"的次数。
     *
     * 仅由缺失工具路径 {@link schedule} 累加；任何健康路径
     * （{@link scheduleAfterWorkflowTool} / {@link resetMissingToolCounter}）
     * 都会清零。达到 {@link MAX_CONSECUTIVE_MISSING_TOOL_COUNT} 时熔断后续
     * 自动续推。
     */
    private static consecutiveMissingCount = 0;

    /**
     * 外部注入的"提交一条用户消息"回调；存在时优先于
     * {@link pasteToClaudeCode}。
     *
     * 在内置 Chat WebView 启用后由 `extension.ts` 通过
     * {@link setSubmitter} 注入。未注入时调度器回退到旧的剪贴板 + 系统级模拟
     * 回车路径，以兼容部署在外部 Claude Code 扩展旁边的旧用法。
     */
    private static submitter: AutoContinueSubmitter | undefined;

    /** 外部注入的续推提交前回调。 */
    private static beforeSubmit: AutoContinueBeforeSubmit | undefined;

    /**
     * 空闲看门狗:是否处于「命中非任务流工具后等待 CLI 自己往下走」的观察期。
     *
     * 设计目标:命中 Write/Edit 等非任务流工具时,本应由 Claude Code 自己发起
     * tool_result 往返继续干活,所以不立即续推。但部分情况下 CLI 这轮请求结束后
     * 并不自动续做剩余工作,任务流就卡在半截。于是引入「请求活动看门狗」:
     *   - 命中非任务流工具、这轮结束时 → {@link armIdleWatchdog} 置 true 并启动延时;
     *   - 期间任何新请求进来 → {@link notifyRequestStarted} 把它打回 false(CLI 仍在活动);
     *   - 延时到点仍为 true(这段时间没有任何新请求)→ 判定 CLI 真停了,兜底续推一次。
     *
     * 续推自身会触发新请求,又会把该标志打回 false,因此不会自激连环触发。
     */
    private static idleWatchdogPending = false;

    /** 空闲看门狗延时定时器句柄。 */
    private static idleWatchdogTimer: NodeJS.Timeout | undefined;

    /**
     * 创建自动续推调度器。
     *
     * @param service 任务流服务，用于读取快照与构造继续推进提示。
     */
    public constructor(private readonly service: LlsTaskService) {}

    /**
     * 注入续推提交回调。
     *
     * 设为 undefined 可恢复"剪贴板 + 模拟回车"旧路径。submitter 是静态字段，
     * 整个扩展进程共享同一份，调用方无需关心调度器实例数量。
     *
     * @param submitter 续推提交回调；传入 undefined 可清空。
     */
    public static setSubmitter(submitter: AutoContinueSubmitter | undefined): void {
        AutoContinueScheduler.submitter = submitter;
        Logger.info(`[LlsTask][AutoContinue] submitter 已${submitter ? '注入' : '清空'}`);
    }

    /**
     * 注入续推提交前回调。
     *
     * 设为 undefined 可清空前置动作。beforeSubmit 是静态字段，整个扩展进程共享。
     *
     * @param beforeSubmit 续推提交前回调；传入 undefined 可清空。
     */
    public static setBeforeSubmit(beforeSubmit: AutoContinueBeforeSubmit | undefined): void {
        AutoContinueScheduler.beforeSubmit = beforeSubmit;
        Logger.info(`[LlsTask][AutoContinue] beforeSubmit 已${beforeSubmit ? '注入' : '清空'}`);
    }

    /**
     * 调度一次 4 秒后的自动续推。
     *
     * 调用前会先取消旧定时器，保证全局同时只有一个定时器。
     *
     * 此方法是"缺失工具路径"的入口：仅当模型本轮未调用任何工具但 workflow
     * 仍活跃时由拦截器调用。每次进入都会把 {@link consecutiveMissingCount}
     * 累加 1；若达到 {@link MAX_CONSECUTIVE_MISSING_TOOL_COUNT} 则触发熔断，
     * 停止本次以及后续的自动续推，并通过 VS Code 通知告知用户介入。
     */
    public schedule(): void {
        AutoContinueScheduler.consecutiveMissingCount += 1;
        const count = AutoContinueScheduler.consecutiveMissingCount;
        Logger.info(`[LlsTask][AutoContinue] 缺失工具续推累计第 ${count}/${MAX_CONSECUTIVE_MISSING_TOOL_COUNT} 次`);
        if (count > MAX_CONSECUTIVE_MISSING_TOOL_COUNT) {
            this.tripCircuitBreaker(count);
            return;
        }
        this.scheduleAfter(AUTO_CONTINUE_DELAY_MS, '4 秒', 'workflow');
    }

    /**
     * 调度一次本地任务流工具返回后的自动续推。
     */
    public scheduleAfterWorkflowTool(): void {
        this.resetMissingToolCounter('workflow 工具命中');
        this.scheduleAfter(TOOL_CONTINUE_DELAY_MS, '4 秒', 'workflow');
    }

    /**
     * 通知「有新请求进来」,取消空闲看门狗。
     *
     * 只要 relay 收到任意一条新请求,就说明 CLI 仍在活动(自己发起了 tool_result
     * 往返或新一轮对话),无需空闲兜底续推。把看门狗标志打回 false 并清掉延时,
     * 让到点判断直接落空。由 `extension.ts` 在每次 relay 请求开始时调用。
     */
    public notifyRequestStarted(): void {
        if (!AutoContinueScheduler.idleWatchdogPending && !AutoContinueScheduler.idleWatchdogTimer) return;
        AutoContinueScheduler.idleWatchdogPending = false;
        if (AutoContinueScheduler.idleWatchdogTimer) {
            clearTimeout(AutoContinueScheduler.idleWatchdogTimer);
            AutoContinueScheduler.idleWatchdogTimer = undefined;
        }
        Logger.info('[LlsTask][AutoContinue] 收到新请求,空闲看门狗已撤销(CLI 仍在活动)');
    }

    /**
     * 启动空闲看门狗:命中非任务流工具、本轮结束后等待 CLI 是否自己往下走。
     *
     * 置 {@link idleWatchdogPending} 为 true 并起 {@link IDLE_WATCHDOG_DELAY_MS} 延时。延时到点时:
     *   - 若期间有新请求把标志打回 false → 不续推(CLI 自己接手了);
     *   - 若标志仍为 true 且任务流活跃未完成 → 走 {@link schedule} 兜底续推一次
     *     (计入熔断,连续无进展最终会熔断,避免任务流卡死又不至于无限自激)。
     */
    public armIdleWatchdog(): void {
        if (AutoContinueScheduler.idleWatchdogTimer) {
            clearTimeout(AutoContinueScheduler.idleWatchdogTimer);
        }
        AutoContinueScheduler.idleWatchdogPending = true;
        Logger.info('[LlsTask][AutoContinue] 命中非任务流工具,启动 30 秒空闲看门狗');
        AutoContinueScheduler.idleWatchdogTimer = setTimeout(() => {
            AutoContinueScheduler.idleWatchdogTimer = undefined;
            if (!AutoContinueScheduler.idleWatchdogPending) return;
            AutoContinueScheduler.idleWatchdogPending = false;
            if (!this.service.hasActiveWorkflow() || this.service.isWorkflowCompleted()) {
                Logger.info('[LlsTask][AutoContinue] 空闲看门狗到点:任务流已完成或不存在,跳过续推');
                return;
            }
            Logger.info('[LlsTask][AutoContinue] 空闲看门狗到点:30 秒内无新请求,CLI 已停,兜底续推');
            this.schedule();
        }, IDLE_WATCHDOG_DELAY_MS);
    }

    /**
     * 重置"连续缺失工具调用"计数器。
     *
     * 任何确认模型重新进入工具调用循环的健康路径都应调用本方法，避免之前
     * 累计的几次缺失把后续续推过早熔断。也可在外部（如 service.clear()
     * 启动新任务流时）显式调用以确保从干净状态开始计数。
     *
     * @param reason 重置原因，便于日志追踪。
     */
    public resetMissingToolCounter(reason: string): void {
        if (AutoContinueScheduler.consecutiveMissingCount === 0) return;
        Logger.info(`[LlsTask][AutoContinue] 重置缺失工具续推计数（原因：${reason}）`);
        AutoContinueScheduler.consecutiveMissingCount = 0;
    }

    /**
     * 触发"连续缺失工具调用"熔断。
     *
     * 取消已登记的续推定时器，弹出 VS Code 警告通知，让用户决定下一步动作。
     * 一旦熔断生效，需要由健康路径（模型重新调用工具）或外部主动调用
     * {@link resetMissingToolCounter} 才会恢复自动续推。
     *
     * @param count 触发熔断时的累计缺失次数，用于日志记录。
     */
    private tripCircuitBreaker(count: number): void {
        this.cancel(`连续 ${count} 次缺失工具调用，熔断自动续推`);
        const texts = this.service.getTexts();
        const message = texts.missingToolCircuitBreaker;
        Logger.warn(`[LlsTask][AutoContinue] 熔断生效：${message}`);
        void vscode.window.showWarningMessage(message);
    }

    /**
     * 按指定延时调度自动续推。
     *
     * @param delayMs 延迟毫秒数。
     * @param label 日志中展示的延迟标签。
     * @param kind 续推种类，目前只保留 `workflow`。
     */
    private scheduleAfter(delayMs: number, label: string, kind: 'workflow'): void {
        this.cancel(`重新调度 ${label} 自动续推`);
        if (!this.service.hasActiveWorkflow()) return;
        const myVersion = ++AutoContinueScheduler.version;
        AutoContinueScheduler.timer = setTimeout(() => {
            void this.runIfCurrent(myVersion);
        }, delayMs);
        Logger.info(`[LlsTask][AutoContinue] 已调度 ${label} 自动续推（kind=${kind}）`);
    }

    /**
     * 取消当前等待中的自动续推定时器。
     *
     * @param reason 取消定时器的调用来源或原因。
     */
    public cancel(reason = '未指定原因'): void {
        AutoContinueScheduler.version += 1;
        if (AutoContinueScheduler.timer) {
            clearTimeout(AutoContinueScheduler.timer);
            AutoContinueScheduler.timer = undefined;
            Logger.info(`[LlsTask][AutoContinue] 已取消自动续推定时器：${reason}`);
        } else {
            Logger.info(`[LlsTask][AutoContinue] 无待取消自动续推定时器：${reason}`);
        }
    }

    /**
     * 在定时器触发后执行快照检查并提交续推提示。
     *
     * 提交策略：
     *
     * 1. 优先调用 {@link AutoContinueScheduler.submitter}（内置 Chat 链路注入）
     *    直接把续推提示词作为新一轮用户消息提交到 CLI——同时在 Chat UI 中
     *    生成对应的 user 消息条目，不依赖系统级模拟回车，也不会抢焦点。
     * 2. 没有 submitter 时回退到旧的剪贴板 + `claude-vscode.focus` +
     *    `editor.action.clipboardPasteAction` + 系统级模拟回车路径，以兼容
     *    外部 Claude Code 扩展旁路用法。
     *
     * 旧版本默认 `autoSubmit: false` 是用户反馈"必须手动重发下才能执行"的
     * 直接成因；当前实现中 paster 回退分支仍打开 `autoSubmit: true`，但只要
     * 注入了 submitter，整条剪贴板路径就不会再被走到。
     *
     * @param expectedVersion 定时器创建时捕获的版本号。
     */
    private async runIfCurrent(expectedVersion: number): Promise<void> {
        AutoContinueScheduler.timer = undefined;
        if (expectedVersion !== AutoContinueScheduler.version) return;
        const prompt = this.resolvePromptForCurrentKind();
        if (!prompt) return;
        const submitter = AutoContinueScheduler.submitter;
        const beforeSubmit = AutoContinueScheduler.beforeSubmit;
        try {
            if (beforeSubmit) {
                Logger.info('[LlsTask][AutoContinue] 执行续推提交前回调');
                await beforeSubmit();
            }
            if (submitter) {
                Logger.info(`[LlsTask][AutoContinue] 通过 submitter 提交续推消息，长度=${prompt.length}`);
                await submitter(prompt);
            } else {
                Logger.info(`[LlsTask][AutoContinue] 无 submitter，回退到剪贴板续推，长度=${prompt.length}`);
                await pasteToClaudeCode(prompt, { autoSubmit: true });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error('[LlsTask][AutoContinue] 自动续推失败：' + message);
        }
    }

    /**
     * 解析 workflow 续推提示词。
     *
     * 若 workflow 已不存在或已完成则返回空串，调度器据此放弃本次续推。
     *
     * @returns 续推提示词；不需要续推时返回空串。
     */
    private resolvePromptForCurrentKind(): string {
        if (!this.service.hasActiveWorkflow() || this.service.isWorkflowCompleted()) return '';
        const snapshot = this.service.getSnapshot();
        if (!snapshot.workflow) return '';
        return this.service.buildContinuePrompt(snapshot);
    }
}
