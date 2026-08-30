/**
 * @file 定时唤醒任务调度器：把 `.LLSOAI/wakeups.json` 中的任务变成真实定时器。
 *
 * 一次性语义：任务触发后即从磁盘删除，不支持重复 / cron。
 * 定时器只能活在扩展宿主进程里（MCP 子进程退出会带走 timer），
 * 因此本文件依赖 vscode 类型，只可被宿主侧引用。
 *
 * 设计见 docs/wakeup-mcp-tool-plan.md。
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { Logger } from '../logger';
import type { WakeupJob, WakeupStore } from './wakeupStore';

/**
 * Node `setTimeout` 的单次最大延迟（2^31-1 ms，约 24.8 天）。
 *
 * 超过该值会被截断成 1 并立即触发，因此长延迟必须分段续期。
 */
const MAX_TIMEOUT_MS = 2147483647;

/** 唤醒到点时的回调（由 extension.ts 注入，负责把 prompt 发进聊天区）。 */
export type WakeupFireHandler = (job: WakeupJob) => Promise<void>;

/** `schedule` 的入参：时间字段二选一，已由 host 层校验。 */
export interface WakeupScheduleInput {
    /** 到点时发送到聊天区的内容。 */
    prompt: string;
    /** 相对延迟秒数，与 `at` 二选一。 */
    delaySeconds?: number;
    /** 绝对触发时间（ISO 8601），与 `delaySeconds` 二选一，优先级更高。 */
    at?: string;
    /** 可选的一句话说明。 */
    reason?: string;
    /** 循环间隔秒数；给了才是循环任务。 */
    intervalSeconds?: number;
    /** 总触发次数；缺省 1（一次性）。 */
    repeatCount?: number;
}

/** 以 `.LLSOAI/wakeups.json` 为准的一次性定时唤醒调度器。 */
export class WakeupScheduler implements vscode.Disposable {
    /**
     * 已武装的定时器句柄，key 为 job id。
     *
     * 只存句柄不存任务体：任务列表以磁盘为准，避免内存与磁盘两份状态漂移。
     */
    private readonly timers = new Map<string, NodeJS.Timeout>();

    /**
     * @param store 任务持久化存储。
     * @param onFire 到点回调（发送唤醒内容到聊天区）。
     */
    public constructor(
        private readonly store: WakeupStore,
        private readonly onFire: WakeupFireHandler
    ) {}

    /**
     * 扩展激活时调用一次：补发错过的任务，并重新武装未到点的任务。
     *
     * 必须在 Chat 视图就绪之后调用，否则补发的唤醒会因聊天区未初始化而丢失。
     */
    public async restore(): Promise<void> {
        const jobs = await this.store.load();
        const now = Date.now();
        for (const job of jobs) {
            if (Date.parse(job.fireAt) <= now) {
                await this.fire(job);
            } else {
                this.arm(job);
            }
        }
    }

    /**
     * 下单一个新的定时唤醒。
     *
     * @param input 唤醒内容与触发时间（`at` 优先于 `delaySeconds`）。
     * @returns 已落盘并武装的任务。
     */
    public async schedule(input: WakeupScheduleInput): Promise<WakeupJob> {
        const fireAtMs = input.at !== undefined
            ? Date.parse(input.at)
            : Date.now() + (input.delaySeconds ?? 0) * 1000;
        const repeatCount = Math.max(1, Math.floor(input.repeatCount ?? 1));
        const job: WakeupJob = {
            id: crypto.randomUUID(),
            prompt: input.prompt,
            reason: input.reason,
            createdAt: new Date().toISOString(),
            fireAt: new Date(fireAtMs).toISOString(),
            intervalSeconds: repeatCount > 1 ? input.intervalSeconds : undefined,
            remainingFires: repeatCount,
            firedCount: 0
        };
        await this.store.add(job);
        this.arm(job);
        return job;
    }

    /**
     * 取消一个尚未触发的唤醒。
     *
     * @param id 任务 id。
     * @returns 磁盘上确实存在并被删除时返回 true。
     */
    public async cancel(id: string): Promise<boolean> {
        this.disarm(id);
        return this.store.remove(id);
    }

    /**
     * 列出全部未触发的唤醒任务。
     *
     * @returns 磁盘中的任务列表。
     */
    public async list(): Promise<WakeupJob[]> {
        return this.store.load();
    }

    /**
     * 清除全部内存定时器（不动磁盘，重启后由 `restore` 接手）。
     */
    public dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    /**
     * 为一个任务武装定时器。
     *
     * 延迟超过 `MAX_TIMEOUT_MS` 时先睡满上限再递归续期——Node 对超上限的延迟
     * 会直接按 1ms 处理，不分段会导致长任务立即触发。
     *
     * @param job 待武装的任务。
     */
    private arm(job: WakeupJob): void {
        this.disarm(job.id);
        const remaining = Math.max(0, Date.parse(job.fireAt) - Date.now());
        if (remaining > MAX_TIMEOUT_MS) {
            this.timers.set(job.id, setTimeout(() => this.arm(job), MAX_TIMEOUT_MS));
            return;
        }
        this.timers.set(job.id, setTimeout(() => { void this.fire(job); }, remaining));
    }

    /**
     * 触发一个任务：先落盘（删除或推进到下一轮）再回调。
     *
     * 写盘先于回调，保证发送过程崩溃时重启不会重复唤醒同一轮。
     *
     * @param job 到点的任务。
     */
    private async fire(job: WakeupJob): Promise<void> {
        this.disarm(job.id);
        const firedCount = (job.firedCount ?? 0) + 1;
        const remaining = Math.max(0, (job.remainingFires ?? 1) - 1);
        const interval = job.intervalSeconds;

        let next: WakeupJob | undefined;
        if (remaining > 0 && interval !== undefined) {
            next = {
                ...job,
                fireAt: new Date(Date.now() + interval * 1000).toISOString(),
                remainingFires: remaining,
                firedCount
            };
            await this.store.add(next);
            this.arm(next);
        } else {
            await this.store.remove(job.id);
        }

        try {
            await this.onFire({ ...job, firedCount, remainingFires: remaining });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`[wakeupScheduler] 唤醒回调失败：id=${job.id}, ${message}`);
        }
    }

    /**
     * 清除某个任务的内存定时器。
     *
     * @param id 任务 id。
     */
    private disarm(id: string): void {
        const timer = this.timers.get(id);
        if (timer === undefined) return;
        clearTimeout(timer);
        this.timers.delete(id);
    }
}
