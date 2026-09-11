/** @file 请求与 CLI 输出的精确关联；不按活动消息或时间猜测。 */
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

    /** 登记请求；缺少会话身份或压缩请求不参与普通标题关联。 */
    public registerRequest(context: RequestUsageContext): void {
        if (context.compactCommandTriggered || this.entries.has(context.requestId)) return;
        this.entries.set(context.requestId, { context, generation: this.generation });
    }

    /** 将响应 message.id / tool callId 绑定到已登记请求；返回是否成功。 */
    public bindResponseMessage(requestId: string, sessionId: string, id: string, kind: 'message' | 'tool' = 'message'): boolean {
        const entry = this.entries.get(requestId);
        if (!id || !entry || entry.generation !== this.generation || entry.context.sessionId !== sessionId) return false;
        const key = JSON.stringify([sessionId, kind, id]);
        const previous = this.identities.get(key);
        if (previous !== undefined && previous !== requestId) {
            this.identities.set(key, null);
            return false;
        }
        this.identities.set(key, requestId);
        return true;
    }

    /** 精确查找输出归属；任一身份冲突或身份互相矛盾时返回 undefined。 */
    public resolveRequestForSegment(sessionId: string, messageId?: string, callId?: string): RequestUsageContext | undefined {
        const keys = [messageId ? JSON.stringify([sessionId, 'message', messageId]) : '', callId ? JSON.stringify([sessionId, 'tool', callId]) : ''].filter(Boolean);
        const ids = keys.map(key => this.identities.get(key));
        if (ids.includes(null)) return undefined;
        const known = ids.filter((id): id is string => typeof id === 'string');
        if (!known.length || new Set(known).size !== 1) return undefined;
        return this.entries.get(known[0])?.context;
    }

    /** 保存乱序到达的统计；已清理请求的迟到报告被忽略。 */
    public recordRequestUsage(summary: RequestUsageSummary): boolean {
        const entry = this.entries.get(summary.context.requestId);
        if (!entry || entry.generation !== this.generation || entry.context.sessionId !== summary.context.sessionId) return false;
        entry.summary = summary;
        return true;
    }

    /** 查询缓存统计，供正文后到达时回填。 */
    public getSummary(requestId: string): RequestUsageSummary | undefined {
        return this.entries.get(requestId)?.summary;
    }

    /** 清理没有历史引用的已完成请求和关联身份。 */
    public prune(retained: ReadonlySet<string>): void {
        for (const [id, entry] of this.entries) {
            if (entry.summary && !retained.has(id)) this.entries.delete(id);
        }
        for (const [key, id] of this.identities) {
            if (id !== null && !this.entries.has(id)) this.identities.delete(key);
        }
    }

    /** 会话切换时清空绑定并进入新代次。 */
    public clearRequestUsageBindings(): void {
        this.generation++;
        this.entries.clear();
        this.identities.clear();
    }
}

/** 当前扩展宿主的请求关联表。 */
export const requestUsageRegistry = new RequestUsageRegistry();
