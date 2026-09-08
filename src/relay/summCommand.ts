/** Claude CLI 原生压缩请求的 command-name 标记。 */
export const CLAUDE_COMPACT_COMMAND_MARKER = '<command-name>/compact</command-name>';

/** 从 Anthropic 请求体 metadata 中提取 CLI session_id。 */
export function extractAnthropicSessionId(parsedBody: unknown): string {
    if (!parsedBody || typeof parsedBody !== 'object') return '';
    const metadata = (parsedBody as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') return '';
    const meta = metadata as Record<string, unknown>;
    if (typeof meta.session_id === 'string' && meta.session_id) return meta.session_id;
    if (typeof meta.user_id === 'string' && meta.user_id) {
        const raw = meta.user_id.trim();
        if (raw.startsWith('{')) {
            try {
                const parsed = JSON.parse(raw) as { session_id?: unknown };
                if (typeof parsed.session_id === 'string' && parsed.session_id) return parsed.session_id;
            } catch {
                return raw;
            }
        }
        return raw;
    }
    return '';
}

/** 判断 Anthropic 请求最后一条 user 消息是否为 Claude CLI 原生压缩指令。 */
export function isClaudeCompactCommandRequest(parsedBody: unknown): boolean {
    const lastText = readLastUserMessageText(parsedBody).trim();
    // 关键：`/compact` 跑完后，Claude CLI 会把含 `<command-name>/compact</command-name>`
    // 的 local-command 摘要 caveat 作为历史 text block 塞进**下一条** user 消息，
    // 而用户真正的新输入会作为该消息的**最后一个** text block 追加在其后。若仍按
    // 「整条 user 消息拼接后 includes 标记」判定，则每条压缩后的普通消息都会被误判
    // 为 /compact、误路由到压缩专用模型（任务流长会话尤甚）。因此 marker 必须只在
    // 「最后一个非空 text block」上判定，历史 caveat 里的 marker 不再触发压缩。
    const lastBlock = readLastUserMessageLastTextBlock(parsedBody).trim();
    // 路径一：当前这一轮 user 输入本身就是 /compact 指令（TUI 标记或纯文本）。
    if (containsCompactCommandMarker(lastBlock) || lastBlock === '/compact') return true;
    // 路径二：最后一条是 Claude CLI 压缩摘要 prompt。该 prompt 文案高度特定，
    // 足以单独判定为压缩请求；不再要求 user 消息里另带 command marker —— 因为
    // token-budget 程序化发送的 /compact、以及新版 CLI 的摘要请求可能不携带该标记，
    // 旧逻辑会把这类摘要请求误判为普通请求、回退到主模型而非压缩专用模型。
    return isClaudeCompactSummaryPrompt(lastText);
}

/** 容错匹配 /compact 指令标记：兼容有无前导斜杠、大小写差异等形态。 */
function containsCompactCommandMarker(text: string): boolean {
    if (text.includes(CLAUDE_COMPACT_COMMAND_MARKER)) return true;
    return /<command-name>\s*\/?compact\s*<\/command-name>/i.test(text);
}

/**
 * 定位 Anthropic 请求中「最后一条 user 消息」。
 *
 * 从数组末尾向前扫描，跳过尾部的 `system` 消息：Claude CLI 2.1.260+ 启用
 * `mid-conversation-system` beta 后，会在每条 user 消息之后追加一条
 * `role: "system"` 的 system-reminder，压缩摘要请求也不例外。若仍只看
 * `messages[-1]`，会因其 role 为 system 而把压缩请求当成普通请求，导致
 * 压缩专用模型路由失效。遇到 assistant 消息即停止（说明末尾没有 user 输入）。
 *
 * @param parsedBody Anthropic 请求体。
 * @returns 最后一条 user 消息的 content；不存在时返回 undefined。
 */
function findLastUserMessageContent(parsedBody: unknown): unknown {
    if (!parsedBody || typeof parsedBody !== 'object') return undefined;
    const messages = (parsedBody as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const item = messages[i];
        if (!item || typeof item !== 'object') return undefined;
        const record = item as { role?: unknown; content?: unknown };
        if (record.role === 'user') return record.content;
        if (record.role !== 'system') return undefined;
    }
    return undefined;
}

/** 读取 Anthropic 请求最后一条 user 消息文本（跳过尾部 system 消息）。 */
function readLastUserMessageText(parsedBody: unknown): string {
    return readTextContent(findLastUserMessageContent(parsedBody));
}

/**
 * 读取 Anthropic 请求最后一条 user 消息的「最后一个非空 text block」。
 *
 * 用于把当前轮用户真正的新输入，与历史 caveat / system-reminder 等被 CLI 塞进
 * 同一条 user 消息的前置 text block 区分开。`/compact` 跑完后嵌入的命令 caveat
 * 永远在前置 block 里，用户新输入永远是最后一个 block，据此避免误判压缩。
 * 「最后一条 user 消息」的定位见 {@link findLastUserMessageContent}，兼容尾部 system 消息。
 *
 * @param parsedBody Anthropic 请求体。
 * @returns 最后一个非空 text block 文本；无则空串。
 */
function readLastUserMessageLastTextBlock(parsedBody: unknown): string {
    const content = findLastUserMessageContent(parsedBody);
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    for (let i = content.length - 1; i >= 0; i -= 1) {
        const block = content[i];
        if (!block || typeof block !== 'object') continue;
        const rec = block as { type?: unknown; text?: unknown };
        if ((rec.type === 'text' || rec.type === undefined) && typeof rec.text === 'string' && rec.text.trim()) {
            return rec.text;
        }
    }
    return '';
}

function isClaudeCompactSummaryPrompt(text: string): boolean {
    return text.includes('CRITICAL: Respond with TEXT ONLY')
        && text.includes('Your task is to create a detailed summary of the conversation so far')
        && text.includes('Do NOT call any tools');
}

/** 读取 Anthropic content 中的文本块。 */
function readTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
        if (block && typeof block === 'object') {
            const rec = block as { type?: unknown; text?: unknown };
            if ((rec.type === 'text' || rec.type === undefined) && typeof rec.text === 'string') parts.push(rec.text);
        }
    }
    return parts.join('\n');
}
