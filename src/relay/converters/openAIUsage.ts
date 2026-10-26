/** @file OpenAI 总输入与缓存读写明细的统一归一化，不推测上游未提供的缓存写入。 */

/** 已拆分的普通输入、缓存读写及输出计数，供 JSON 与 SSE 共用。 */
export interface NormalizedOpenAIUsage {
    /** 不含缓存读写的普通输入。 */
    inputTokens: number;
    /** 输出 token。 */
    outputTokens: number;
    /** 缓存读取，未提供时保持未知。 */
    cacheReadTokens?: number;
    /** 缓存写入，未提供时保持未知。 */
    cacheWriteTokens?: number;
}

/** 只接受安全非负整数，非法计数不得隐式转型或参与费用/命中率计算。 */
function count(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 将未知协议节点收窄为对象；不递归扫描 attribution 或业务数据。 */
function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
}

/**
 * 将 OpenAI 含缓存总输入拆成普通输入、缓存读和缓存写，非法明细不产生负数。
 * cache_write_tokens 是网关扩充字段，已包含在总输入中，不能再次加进总量。
 * 写入优先级与网关解析一致：顶层别名优先，details 为回退；合法 0 不回退。
 * @param usage 原始 usage 对象。
 * @param protocol Chat 或 Responses 字段命名。
 * @returns 普通输入 + 缓存读 + 缓存写守恒的计数。
 */
export function normalizeOpenAIUsage(usage: unknown, protocol: 'chat' | 'responses'): NormalizedOpenAIUsage {
    const source = object(usage);
    const details = object(source[protocol === 'chat' ? 'prompt_tokens_details' : 'input_tokens_details']);
    const total = count(source[protocol === 'chat' ? 'prompt_tokens' : 'input_tokens']) ?? 0;
    const read = count(details.cached_tokens);
    const write = [source.cache_write_tokens, source.cache_creation_input_tokens,
        source.cache_creation_tokens, details.cache_write_tokens].map(count).find(value => value !== undefined);
    const cacheReadTokens = read === undefined ? undefined : Math.min(read, total);
    const remaining = total - (cacheReadTokens ?? 0);
    const cacheWriteTokens = write === undefined ? undefined : Math.min(write, remaining);
    return {
        inputTokens: remaining - (cacheWriteTokens ?? 0),
        outputTokens: count(source[protocol === 'chat' ? 'completion_tokens' : 'output_tokens']) ?? 0,
        cacheReadTokens,
        cacheWriteTokens
    };
}

/**
 * 输出 Anthropic 缓存字段；仅缺写入明细的旧读缓存响应沿用 write=0 的兼容展示。
 * 只有写入没有读取时仍保留写入，完全缺少缓存证据时不伪造字段。
 * @param usage 已归一化的缓存明细。
 * @returns 可直接展开进 Anthropic usage 的缓存读写字段。
 */
export function anthropicCacheFields(usage: Pick<NormalizedOpenAIUsage, 'cacheReadTokens' | 'cacheWriteTokens'>): {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
} {
    const result: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } = {};
    if (usage.cacheReadTokens !== undefined) result.cache_read_input_tokens = usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) result.cache_creation_input_tokens = usage.cacheWriteTokens;
    else if (usage.cacheReadTokens !== undefined) result.cache_creation_input_tokens = 0;
    return result;
}
