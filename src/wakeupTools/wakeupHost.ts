/**
 * @file 定时唤醒工具的宿主侧执行器。
 *
 * 持有 WakeupScheduler（进而持有 timer 与磁盘存储），
 * 把三个 MCP 工具调用翻译成调度器操作并回文本结果。
 *
 * 只可被扩展宿主引用；MCP 子进程通过 httpBridge 转发到这里。
 */

import type { WakeupToolName } from './tools';
import type { WakeupJob } from './wakeupStore';
import type { WakeupScheduler } from './wakeupScheduler';

/** MCP tools/call 的返回体。 */
export interface WakeupToolResult {
    /** 为 true 时表示工具执行失败。 */
    isError?: boolean;
    /** 文本内容块列表。 */
    content: { type: 'text'; text: string }[];
}

/** 定时唤醒工具执行器接口（宿主实现与 HTTP 转发实现共用）。 */
export interface WakeupToolExecutor {
    /**
     * 执行一个定时唤醒工具。
     *
     * @param name 工具裸名。
     * @param args 工具入参。
     * @returns 工具结果。
     */
    execute(name: WakeupToolName, args?: Record<string, unknown>): Promise<WakeupToolResult>;
}

/** 在扩展宿主内直接操作调度器的执行器实现。 */
export class WakeupHost implements WakeupToolExecutor {
    /**
     * @param scheduler 定时唤醒调度器（须与 extension.ts 中注册的是同一个实例）。
     */
    public constructor(private readonly scheduler: WakeupScheduler) {}

    /**
     * 按工具名分派，并把任何异常统一转成错误文本结果。
     *
     * @param name 工具裸名。
     * @param args 工具入参。
     * @returns 工具结果。
     */
    public async execute(name: WakeupToolName, args?: Record<string, unknown>): Promise<WakeupToolResult> {
        try {
            switch (name) {
                case 'lls-ccai-schedule-wakeup':
                    return await this.runSchedule(args ?? {});
                case 'lls-ccai-list-wakeups':
                    return await this.runList();
                case 'lls-ccai-cancel-wakeup':
                    return await this.runCancel(args ?? {});
                default:
                    return this.error(`Unknown wakeup tool: ${String(name)}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return this.error(`Wakeup tool failed: ${message}`);
        }
    }

    /**
     * 下单一个定时唤醒。
     *
     * 时间字段的二选一在这里做运行时校验（schema 层刻意不写 oneOf）。
     *
     * @param args 工具入参。
     * @returns 成功文本或参数错误。
     */
    private async runSchedule(args: Record<string, unknown>): Promise<WakeupToolResult> {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) return this.error('`prompt` is required and must be a non-empty string.');

        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined;
        const at = this.parseAt(args.at);
        const delaySeconds = this.parseDelaySeconds(args.delaySeconds);
        const intervalSeconds = this.parseDelaySeconds(args.intervalSeconds);
        const repeatCount = this.parseRepeatCount(args.repeatCount);
        if (at === undefined && delaySeconds === undefined) {
            return this.error(
                'Provide a time: either `delaySeconds` (a positive number of seconds from now) '
                + 'or `at` (an ISO 8601 timestamp in the future).'
            );
        }
        if (repeatCount > 1 && intervalSeconds === undefined) {
            return this.error('`intervalSeconds` (a positive number) is required when `repeatCount` is greater than 1.');
        }

        const job = await this.scheduler.schedule({ prompt, reason, at, delaySeconds, intervalSeconds, repeatCount });
        const inSeconds = Math.max(0, Math.round((Date.parse(job.fireAt) - Date.now()) / 1000));
        const repeatNote = repeatCount > 1
            ? ` Repeats ${repeatCount} times every ${intervalSeconds}s.`
            : '';
        return this.text(
            `Wakeup scheduled: id=${job.id}, fireAt=${job.fireAt}, in ${inSeconds}s.${repeatNote}`
            + ` Cancel with mcp__llsccaiWakeup__lls-ccai-cancel-wakeup {"id":"${job.id}"}.`
        );
    }

    /**
     * 列出未触发的唤醒，按触发时间升序。
     *
     * @returns 多行文本；无任务时为固定文案。
     */
    private async runList(): Promise<WakeupToolResult> {
        const jobs = await this.scheduler.list();
        if (jobs.length === 0) return this.text('No scheduled wakeups.');
        const lines = [...jobs]
            .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))
            .map((job) => this.formatJob(job));
        return this.text(lines.join('\n'));
    }

    /**
     * 取消一个唤醒。
     *
     * @param args 工具入参。
     * @returns 是否命中的文本结果。
     */
    private async runCancel(args: Record<string, unknown>): Promise<WakeupToolResult> {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return this.error('`id` is required and must be a non-empty string.');
        const removed = await this.scheduler.cancel(id);
        return this.text(removed ? `Wakeup cancelled: id=${id}.` : `No scheduled wakeup with id=${id}.`);
    }

    /**
     * 把一条任务格式化成单行摘要。
     *
     * prompt 可能很长，截断避免列表刷屏。
     *
     * @param job 任务。
     * @returns 单行文本。
     */
    private formatJob(job: WakeupJob): string {
        const summary = job.prompt.replace(/\s+/g, ' ').trim();
        const clipped = summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
        const reason = job.reason ? ` reason=${job.reason}` : '';
        const repeat = job.intervalSeconds !== undefined
            ? ` every=${job.intervalSeconds}s remaining=${job.remainingFires ?? 1} fired=${job.firedCount ?? 0}`
            : '';
        return `id=${job.id} fireAt=${job.fireAt}${repeat}${reason} prompt=${clipped}`;
    }

    /**
     * 校验 `at` 入参。
     *
     * @param raw 原始值。
     * @returns 可解析且在未来时返回原字符串，否则 undefined。
     */
    private parseAt(raw: unknown): string | undefined {
        if (typeof raw !== 'string' || !raw.trim()) return undefined;
        const parsed = Date.parse(raw);
        if (Number.isNaN(parsed) || parsed <= Date.now()) return undefined;
        return raw;
    }

    /**
     * 校验 `delaySeconds` 入参。
     *
     * @param raw 原始值。
     * @returns 正有限数时返回该值，否则 undefined。
     */
    private parseDelaySeconds(raw: unknown): number | undefined {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
        return raw;
    }

    /**
     * 校验 `repeatCount` 入参。
     *
     * @param raw 原始值。
     * @returns 有效的正整数次数；非法或缺省时为 1。
     */
    private parseRepeatCount(raw: unknown): number {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 1;
        return Math.floor(raw);
    }

    /**
     * 构造成功文本结果。
     *
     * @param text 文本内容。
     * @returns 工具结果。
     */
    private text(text: string): WakeupToolResult {
        return { content: [{ type: 'text', text }] };
    }

    /**
     * 构造错误文本结果。
     *
     * @param text 错误说明。
     * @returns 带 isError 的工具结果。
     */
    private error(text: string): WakeupToolResult {
        return { isError: true, content: [{ type: 'text', text }] };
    }
}
