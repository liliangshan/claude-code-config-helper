/** @file 请求与 CLI 输出的精确关联；不按活动消息或时间猜测。 */
import type { ChatSegment } from '../chat/protocol';
import type { RequestUsageContext, RequestUsageSummary } from '../relay/requestUsage';

/** 请求级绑定记录，generation 隔离会话切换后的迟到事件。 */
interface Entry {
    context: RequestUsageContext;
    generation: number;
    summary?: RequestUsageSummary;
}

/** 请求关联表，实例可独立测试；身份冲突时拒绝归属而非覆盖。 */
export class RequestUsageRegistry {
    private generation = 0;
    private readonly entries = new Map<string, Entry>();
    private readonly identities = new Map<string, string | null>();
    private readonly sessionAliases = new Map<string, string>();

    /** Resolve the one-time provisional conversation identity to its confirmed native CLI session. */
    private sessionKey(sessionId: string): string { return this.sessionAliases.get(sessionId) ?? sessionId; }

    /** Confirm startup identity without rewriting frozen in-flight contexts or guessing another conversation's ownership. */
    public bindInitialSession(provisional: string, confirmed: string): void {
        if (!provisional || !confirmed || provisional === confirmed || this.sessionAliases.has(provisional)) return;
        this.sessionAliases.set(provisional, confirmed);
        for (const [key, requestId] of [...this.identities]) {
            const [session, kind, id] = JSON.parse(key) as string[];
            if (session !== provisional) continue;
            this.identities.delete(key);
            const target = JSON.stringify([confirmed, kind, id]);
            const previous = this.identities.get(target);
            this.identities.set(target, previous === undefined || previous === requestId ? requestId : null);
        }
    }

    /** Compare confirmed and provisional identities only within this owning registry. */
    public ownsSession(expected: string, actual: string): boolean {
        return !!expected && !!actual && this.sessionKey(expected) === this.sessionKey(actual);
    }

    /** Capture the current owner generation so delayed admissions cannot enter a replacement session. */
    public generationToken(): number { return this.generation; }

    /** 登记请求；缺少会话身份或压缩请求不参与普通标题关联。 */
    public registerRequest(context: RequestUsageContext, generation = this.generation): void {
        if (generation !== this.generation || !context.sessionId.trim() || !context.requestId || context.compactCommandTriggered || this.entries.has(context.requestId)) return;
        this.entries.set(context.requestId, { context, generation: this.generation });
    }

    /** 将响应 message.id / tool callId 绑定到已登记请求；返回是否成功。 */
    public bindResponseMessage(requestId: string, sessionId: string, id: string, kind: 'message' | 'tool' = 'message'): boolean {
        const entry = this.entries.get(requestId);
        if (!sessionId.trim() || !id || !entry || entry.generation !== this.generation || entry.context.sessionId !== sessionId) return false;
        const key = JSON.stringify([this.sessionKey(sessionId), kind, id]);
        const previous = this.identities.get(key);
        if (previous !== undefined && previous !== requestId) {
            this.identities.set(key, null);
            return false;
        }
        this.identities.set(key, requestId);
        return true;
    }

    /** Resolve exact response identity; a request-scoped message ID can disambiguate reused tool call IDs. */
    public resolveRequestForSegment(sessionId: string, messageId?: string, callId?: string): RequestUsageContext | undefined {
        if (!sessionId.trim()) return undefined;
        sessionId = this.sessionKey(sessionId);
        const message = messageId ? this.identities.get(JSON.stringify([sessionId, 'message', messageId])) : undefined;
        const call = callId ? this.identities.get(JSON.stringify([sessionId, 'tool', callId])) : undefined;
        if (message === null || (messageId && message === undefined)) return undefined;
        if (typeof message === 'string') {
            if (typeof call === 'string' && call !== message) return undefined;
            return this.entries.get(message)?.context;
        }
        return typeof call === 'string' ? this.entries.get(call)?.context : undefined;
    }

    /** Bind once, preserving persisted ownership and late reports instead of rebinding old segments to a new request. */
    public bindSegment(sessionId: string, segment: ChatSegment): boolean {
        if (segment.kind === 'usage') return false;
        const existing = segment.requestId;
        const context = existing ? this.entries.get(existing)?.context
            : this.resolveRequestForSegment(sessionId, segment.responseMessageId, segment.responseCallId);
        if (!context || !this.ownsSession(sessionId, context.sessionId)) return false;
        segment.requestId = context.requestId;
        segment.requestUsage = this.getSummary(context.requestId) ?? segment.requestUsage;
        return true;
    }

    /** Save out-of-order reports only for the exact registered context; reject compaction and identity changes. */
    public recordRequestUsage(summary: RequestUsageSummary): boolean {
        const entry = this.entries.get(summary.context.requestId);
        if (!entry || entry.generation !== this.generation || summary.context.compactCommandTriggered
            || !Object.keys(entry.context).every(key => entry.context[key as keyof RequestUsageContext] === summary.context[key as keyof RequestUsageContext])) return false;
        entry.summary = summary;
        return true;
    }

    /** Restore only exact saved summaries; no live or restored request is inferred from legacy provider IDs. */
    public restoreSegmentUsage(sessionId: string, messages: import('../chat/protocol').ChatMessage[], saved: import('../chat/protocol').ChatMessage[]): void {
        const summaries = new Map<string, RequestUsageSummary | null>();
        for (const message of saved) for (const segment of message.segments) {
            const summary = segment.requestUsage;
            if (!segment.responseMessageId?.startsWith('msg_llsccai_') || !summary || summary.context.compactCommandTriggered
                || !this.ownsSession(sessionId, summary.context.sessionId) || segment.requestId !== summary.context.requestId) continue;
            const old = summaries.get(segment.responseMessageId);
            summaries.set(segment.responseMessageId, old === null || (old && old.context.requestId !== summary.context.requestId) ? null : summary);
        }
        for (const message of messages) for (const segment of message.segments) {
            const summary = segment.responseMessageId && summaries.get(segment.responseMessageId);
            if (segment.kind !== 'usage' && !segment.requestId && summary) {
                segment.requestId = summary.context.requestId; segment.requestUsage = summary;
            }
        }
    }

    /** 查询缓存统计，供正文后到达时回填。 */
    public getSummary(requestId: string): RequestUsageSummary | undefined {
        return this.entries.get(requestId)?.summary;
    }

    /** Remove unreferenced terminal requests, retaining ambiguous tombstones to reject late reused IDs. */
    public prune(retained: ReadonlySet<string>): void {
        for (const [id, entry] of this.entries) {
            if (entry.summary && !retained.has(id)) this.entries.delete(id);
        }
        for (const [key, id] of this.identities) {
            if (id !== null && !this.entries.has(id)) this.identities.set(key, null);
        }
    }

    /** 会话切换时清空绑定并进入新代次。 */
    public clearRequestUsageBindings(): void {
        this.generation++;
        this.entries.clear();
        this.identities.clear();
        this.sessionAliases.clear();
    }
}

/** 当前扩展宿主的请求关联表。 */
export const requestUsageRegistry = new RequestUsageRegistry();
