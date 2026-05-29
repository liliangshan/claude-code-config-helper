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
    if (lastText.includes(CLAUDE_COMPACT_COMMAND_MARKER) || lastText === '/compact') return true;
    if (!isClaudeCompactSummaryPrompt(lastText)) return false;
    return readAllUserMessageText(parsedBody).includes(CLAUDE_COMPACT_COMMAND_MARKER);
}

/** 读取 Anthropic 请求最后一条 user 消息文本。 */
function readLastUserMessageText(parsedBody: unknown): string {
    if (!parsedBody || typeof parsedBody !== 'object') return '';
    const messages = (parsedBody as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const last = messages[messages.length - 1];
    if (!last || typeof last !== 'object') return '';
    const record = last as { role?: unknown; content?: unknown };
    if (record.role !== 'user') return '';
    return readTextContent(record.content);
}

function readAllUserMessageText(parsedBody: unknown): string {
    if (!parsedBody || typeof parsedBody !== 'object') return '';
    const messages = (parsedBody as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return '';
    const parts: string[] = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const record = message as { role?: unknown; content?: unknown };
        if (record.role !== 'user') continue;
        parts.push(readTextContent(record.content));
    }
    return parts.join('\n');
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
