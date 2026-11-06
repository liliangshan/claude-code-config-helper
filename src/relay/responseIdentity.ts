/** @file Request-scoped downstream message identities; provider tool IDs and payload content remain unchanged. */
import type { RequestUsageContext } from './requestUsage';
import { SseStreamPrefix } from './sseStreamPrefix';

/** Stable opaque Anthropic message ID used only on the downstream CLI boundary. */
export function requestUsageMessageId(context: RequestUsageContext): string {
    return `msg_llsccai_${context.requestId}`;
}

/** Replace only a complete assistant response's message ID, never nested tool IDs or signatures. */
export function bindJsonResponseIdentity(body: string, context?: RequestUsageContext): string {
    if (!context?.sessionId || context.compactCommandTriggered) return body;
    try {
        const value = JSON.parse(body);
        if (!value || value.type !== 'message' || value.role !== 'assistant') return body;
        return JSON.stringify({ ...value, id: requestUsageMessageId(context) });
    } catch { return body; }
}

/** Incrementally rewrite only message_start.message.id; never buffer an entire streamed response. */
export class ResponseIdentityStream {
    private buffer = '';
    private readonly prefix = new SseStreamPrefix();
    /** Freeze the request's message identity; absent/compaction contexts are byte-for-byte passthrough. */
    public constructor(private readonly context?: RequestUsageContext) {}
    /** Accept decoded SSE fragments and emit complete events without changing field contents except message ID. */
    public feed(chunk: string): string {
        if (!this.context?.sessionId || this.context.compactCommandTriggered) return chunk;
        this.buffer += this.prefix.feed(chunk);
        let output = '', marker: RegExpExecArray | null;
        while ((marker = /\r?\n\r?\n/.exec(this.buffer))) {
            const event = this.buffer.slice(0, marker.index);
            this.buffer = this.buffer.slice(marker.index + marker[0].length);
            output += this.event(event) + marker[0];
        }
        return output;
    }
    /** Flush an unterminated final event without manufacturing a successful protocol terminal. */
    public end(): string { const tail = this.buffer; this.buffer = ''; return this.event(tail); }
    /** Rewrite the start event while preserving event names, comments and non-start events verbatim. */
    private event(raw: string): string {
        if (!this.context || !raw) return raw;
        const lines = raw.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        try {
            const value = JSON.parse(data);
            if (value?.type !== 'message_start' || !value.message || typeof value.message !== 'object') return raw;
            value.message = { ...value.message, id: requestUsageMessageId(this.context) };
            let inserted = false;
            return lines.flatMap(line => {
                if (!line.startsWith('data:')) return [line];
                if (inserted) return [];
                inserted = true; return [`data: ${JSON.stringify(value)}`];
            }).join(raw.includes('\r\n') ? '\r\n' : '\n');
        } catch { return raw; }
    }
}
