/** @file 请求级用量契约与纯计算；总输入只用于内部计算。 */
import { randomUUID } from 'node:crypto';
import type { ChatRoute } from '../chat/protocol';

/** 请求开始时冻结的身份，不从响应结束时的活动会话反推。 */
export interface RequestUsageContext {
    readonly requestId: string;
    readonly sessionId: string;
    readonly route: ChatRoute;
    readonly providerId: string;
    readonly modelId: string;
    /** 上游协议类型，用于决定是否在消息底部重复显示用量。 */
    readonly apiType: string;
    readonly compactCommandTriggered: boolean;
    readonly startedAt: number;
}

/** 只接受请求显式提供的 session_id，未知 user_id 不冒充会话 ID。 */
export function readRequestSessionId(body: unknown): string {
    if (!body || typeof body !== 'object') return '';
    const metadata = (body as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') return '';
    const meta = metadata as Record<string, unknown>;
    if (typeof meta.session_id === 'string' && meta.session_id.trim()) return meta.session_id.trim();
    if (typeof meta.user_id !== 'string') return '';
    try {
        const parsed = JSON.parse(meta.user_id);
        return parsed && typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
    } catch { return ''; }
}

/** 为每次转发创建唯一、不可变的身份快照。 */
export function createRequestUsageContext(
    body: unknown, route: ChatRoute, providerId: string, modelId: string, compactCommandTriggered = false,
    apiType = ''
): RequestUsageContext {
    return Object.freeze({
        requestId: randomUUID(), sessionId: readRequestSessionId(body), route, providerId, modelId, apiType,
        compactCommandTriggered, startedAt: Date.now()
    });
}

/** 每次请求的终止状态，与 CLI 整轮状态无关。 */
export type RequestUsageStatus = 'pending' | 'completed' | 'error' | 'timeout' | 'aborted';

/** 归一化后的输入不包含缓存读取、缓存写入，缺失值保持 undefined。 */
export interface RequestUsageTokens {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
}

/** 可持久化并推送至标题的请求统计；totalInputTokens 不在界面展示。 */
export interface RequestUsageSummary extends RequestUsageTokens {
    context: RequestUsageContext;
    status: RequestUsageStatus;
    totalInputTokens?: number;
    cacheHitRate?: number;
    completeness: 'complete' | 'partial' | 'missing';
}

/** 严格保留有限非负整数，非法值不转换成零。 */
function token(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 统一计算统计；缓存字段缺失时不猜测总输入和命中率。 */
export function normalizeRequestUsage(
    context: RequestUsageContext, usage: RequestUsageTokens, status: RequestUsageStatus
): RequestUsageSummary {
    const inputTokens = token(usage.inputTokens);
    const outputTokens = token(usage.outputTokens);
    const cacheReadInputTokens = token(usage.cacheReadInputTokens);
    const cacheCreationInputTokens = token(usage.cacheCreationInputTokens);
    const values = [inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens];
    const sum = inputTokens !== undefined && cacheReadInputTokens !== undefined && cacheCreationInputTokens !== undefined
        ? inputTokens + cacheReadInputTokens + cacheCreationInputTokens : undefined;
    const totalInputTokens = token(sum);
    return {
        context, status, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
        totalInputTokens,
        cacheHitRate: totalInputTokens && cacheReadInputTokens !== undefined
            ? Number((cacheReadInputTokens / totalInputTokens * 100).toFixed(2)) : undefined,
        completeness: values.every(value => value === undefined) ? 'missing'
            : values.every(value => value !== undefined) && totalInputTokens !== undefined && status === 'completed'
                ? 'complete' : 'partial'
    };
}
