import * as http from 'http';

import { LLSCCAI_SUMM_ACK_TEXT, LLSCCAI_SUMM_COMMAND } from './tokenBudget/service';

/** 压缩指令处理所需的最小 tokenBudget 能力。 */
export interface SummCommandTokenBudget {
    /** 处理压缩指令请求体并异步启动压缩。 */
    handleSummCommand(input: {
        sessionId: string;
        providerId: string;
        modelId: string;
        anthropicBody: string;
    }): boolean;
}

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

/** 判断 Anthropic 请求最后一条 user 消息是否为压缩指令。 */
export function isLlsCcaiSummCommandRequest(parsedBody: unknown): boolean {
    if (!parsedBody || typeof parsedBody !== 'object') return false;
    const messages = (parsedBody as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (!last || typeof last !== 'object') return false;
    const record = last as { role?: unknown; content?: unknown };
    if (record.role !== 'user') return false;
    return readTextContent(record.content).trim() === LLSCCAI_SUMM_COMMAND;
}

/** 触发压缩并向当前 CLI 写回即时 Anthropic JSON 响应。 */
export function handleLlsCcaiSummCommand(args: {
    res: http.ServerResponse;
    tokenBudget: SummCommandTokenBudget | undefined;
    sessionId: string;
    providerId: string;
    modelId: string;
    anthropicBody: string;
}): boolean {
    const started = args.tokenBudget?.handleSummCommand({
        sessionId: args.sessionId,
        providerId: args.providerId,
        modelId: args.modelId,
        anthropicBody: args.anthropicBody
    }) === true;
    writeAnthropicAck(args.res, started ? LLSCCAI_SUMM_ACK_TEXT : '当前上下文暂时无法压缩，请稍后重试。');
    return true;
}

/** 写入 Claude Code 可消费的非流式 Anthropic 文本响应。 */
function writeAnthropicAck(res: http.ServerResponse, text: string): void {
    const body = JSON.stringify({
        id: `msg_llsccai_summ_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'llsccai-compaction',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', String(Buffer.byteLength(body, 'utf-8')));
    res.end(body);
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
