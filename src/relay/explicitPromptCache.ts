/**
 * @file OpenAI 风格显式 Prompt Cache 的纯请求处理函数。
 */

/** Chat 显式缓存写入结果。 */
export interface ExplicitPromptCacheResult {
    /** 是否写入了完整显式缓存参数。 */
    applied: boolean;
    /** 未应用时的机器可读原因。 */
    reason?: 'missing_session_id' | 'missing_system_message' | 'missing_instructions';
}

/** 可附加 Chat 显式断点的最小消息结构。 */
interface ChatCacheMessage {
    /** 消息角色。 */
    role?: unknown;
    /** 消息内容。 */
    content?: unknown;
    /** 网关显式缓存断点。 */
    cache_control?: unknown;
}

/** 可写入显式缓存字段的最小 Chat 请求结构。 */
export interface ChatExplicitCacheBody {
    /** OpenAI Chat 消息列表。 */
    messages: ChatCacheMessage[];
    /** 会话级缓存分组键。 */
    prompt_cache_key?: string;
    /** 网关显式缓存参数。 */
    prompt_cache_options?: { mode: 'explicit'; ttl: '30m' };
}

/**
 * 从 Anthropic 请求 metadata 中严格提取纯 session_id。
 *
 * 只接受 metadata.session_id 或 JSON user_id 内的 session_id；不把原始 user_id、
 * device_id 或 account_uuid 当作缓存键，避免跨会话共享错误前缀。
 *
 * @param anthropicBody Anthropic 请求体。
 * @returns 非空 session_id；无法严格提取时返回空串。
 */
export function extractExplicitCacheSessionId(anthropicBody: unknown): string {
    if (!isRecord(anthropicBody) || !isRecord(anthropicBody.metadata)) return '';
    const metadata = anthropicBody.metadata;
    if (typeof metadata.session_id === 'string' && metadata.session_id.trim()) {
        return metadata.session_id.trim();
    }
    if (typeof metadata.user_id !== 'string') return '';
    try {
        const parsed = JSON.parse(metadata.user_id) as unknown;
        return isRecord(parsed) && typeof parsed.session_id === 'string'
            ? parsed.session_id.trim()
            : '';
    } catch {
        return '';
    }
}

/**
 * 为 OpenAI Chat 请求原地写入完整显式缓存字段。
 *
 * 只有 session_id 与非空 system 消息同时存在时才写入，避免只发送部分参数。
 * 重复调用会覆盖为相同值，因此保持幂等。
 *
 * @param body 已转换的 Chat 请求体。
 * @param sessionId 严格提取的会话 ID。
 * @returns 是否成功应用及未应用原因。
 */
export function applyChatExplicitPromptCache(
    body: ChatExplicitCacheBody,
    sessionId: string
): ExplicitPromptCacheResult {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return { applied: false, reason: 'missing_session_id' };
    const systemMessage = body.messages.find((message) =>
        message.role === 'system' && hasNonEmptyContent(message.content)
    );
    if (!systemMessage) return { applied: false, reason: 'missing_system_message' };

    body.prompt_cache_key = normalizedSessionId;
    body.prompt_cache_options = { mode: 'explicit', ttl: '30m' };
    systemMessage.cache_control = { prompt_cache_breakpoint: { mode: 'explicit' } };
    return { applied: true };
}

/** 可写入显式缓存字段的最小 Responses 请求结构。 */
export interface ResponsesExplicitCacheBody {
    /** 静态 system 前缀。 */
    instructions?: string;
    /** 会话级缓存分组键。 */
    prompt_cache_key?: string;
    /** 网关显式缓存参数。 */
    prompt_cache_options?: { mode: 'explicit'; ttl: '30m' };
}

/**
 * 为 OpenAI Responses 请求原地写入显式缓存字段。
 *
 * Responses 的 instructions 天然作为静态前缀，不允许添加 Chat 的消息断点。
 * 只有 session_id 和非空 instructions 同时存在时才写入，重复调用保持幂等。
 *
 * @param body 已转换的 Responses 请求体。
 * @param sessionId 严格提取的会话 ID。
 * @returns 是否成功应用及未应用原因。
 */
export function applyResponsesExplicitPromptCache(
    body: ResponsesExplicitCacheBody,
    sessionId: string
): ExplicitPromptCacheResult {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return { applied: false, reason: 'missing_session_id' };
    if (typeof body.instructions !== 'string' || !body.instructions.trim()) {
        return { applied: false, reason: 'missing_instructions' };
    }
    body.prompt_cache_key = normalizedSessionId;
    body.prompt_cache_options = { mode: 'explicit', ttl: '30m' };
    return { applied: true };
}

/** 判断消息内容是否能形成静态 system 前缀。 */
function hasNonEmptyContent(content: unknown): boolean {
    if (typeof content === 'string') return content.trim().length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((part) => isRecord(part) && typeof part.text === 'string' && part.text.trim().length > 0);
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

