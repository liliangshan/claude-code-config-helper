/**
 * 定时唤醒（wakeup）到点回调与调度器实例托管。
 *
 * 拆分自 extension.ts：把「调度器到点 → 组装带任务元信息的唤醒正文 → 以用户
 * 消息形式发进聊天区并送往 CLI」这条回调链路，连同调度器实例的持有收敛到一个模块。
 *
 * 依赖方向：本模块位于 chatRuntime 之上，直接 import 发送链路；不被其反向引用。
 */
import { appendUserMessageAndSend } from '../chatRuntime/chatMessaging';
import { Logger } from '../logger';
import type { WakeupJob } from '../wakeupTools/wakeupStore';
import { WakeupScheduler } from '../wakeupTools/wakeupScheduler';

/** 模块级定时唤醒调度器实例（持有 timer，须全局唯一）。 */
let wakeupScheduler: WakeupScheduler | undefined;

/** 注入（或清空）定时唤醒调度器实例，由 activate/deactivate 调用。 */
export function setWakeupScheduler(value: WakeupScheduler | undefined): void {
    wakeupScheduler = value;
}

/** 读取当前定时唤醒调度器实例，未创建时返回 undefined。 */
export function getWakeupScheduler(): WakeupScheduler | undefined {
    return wakeupScheduler;
}

/**
 * 定时唤醒到点回调：把唤醒内容以用户消息形式发进聊天区并送往 CLI。
 *
 * 循环任务需要模型知道自己在跟哪条闹钟对话，所以正文前会附上任务 id、
 * 触发轮次与取消方法（否则模型只能靠 list 工具反查）。
 *
 * @param job 到点的唤醒任务（firedCount / remainingFires 已由调度器更新）。
 */
export async function fireWakeupJob(job: WakeupJob): Promise<void> {
    Logger.info(`定时唤醒触发：id=${job.id}, fireAt=${job.fireAt}, 第 ${job.firedCount ?? 1} 次`);
    await appendUserMessageAndSend(buildWakeupMessage(job));
}

/**
 * 组装唤醒消息正文：任务元信息头 + 原始 prompt。
 *
 * @param job 到点的唤醒任务。
 * @returns 发送到聊天区的完整文本。
 */
export function buildWakeupMessage(job: WakeupJob): string {
    const fired = job.firedCount ?? 1;
    const remaining = job.remainingFires ?? 0;
    const round = job.intervalSeconds !== undefined
        ? `第 ${fired} 次触发，剩余 ${remaining} 次`
        : '一次性触发';
    const header = `[定时唤醒 id=${job.id}｜${round}]\n`
        + `如需停止，调用 mcp__llsccaiWakeup__lls-ccai-cancel-wakeup，参数 {"id":"${job.id}"}。\n\n`;
    return header + job.prompt;
}
