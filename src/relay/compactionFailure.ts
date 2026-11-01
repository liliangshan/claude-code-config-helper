/** @file Dedicated compaction response transaction: report terminal errors without triggering CLI API retries. */
import * as http from 'node:http';
import type { UpstreamAdapter, UpstreamRequestContext } from './router';
import { extractUpstreamErrorMessage, sanitizeErrorMessage } from './converters/openAIErrorToAnthropic';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { RequestOutcomeReporter } from './requestOutcome';

/** Explicit indication that a selected summary model failed; original upstream status remains in the outcome report. */
export const COMPACTION_FAILED_CODE = 'dedicated_compaction_failed';
/** Error text is bounded and sanitized; optional outcome also stops extension recovery for preflight failures. */
export function writeCompactionFailure(res: http.ServerResponse, reason: string, outcome?: RequestOutcomeReporter): void {
    outcome?.disableRetry();
    outcome?.fail('upstream_inline_error', COMPACTION_FAILED_CODE);
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.end(); return; }
    for (const header of res.getHeaderNames()) res.removeHeader(header);
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('x-should-retry', 'false');
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: COMPACTION_FAILED_CODE,
        message: sanitizeErrorMessage(`Dedicated compaction model failed; automatic retry is disabled. ${reason}`).slice(0, 4000) } }));
}

/** Buffered downstream avoids publishing a successful SSE prefix before a summary fails mid-stream. */
class CompactionResponse extends http.ServerResponse {
    private readonly chunks: Buffer[] = [];
    private readonly decoder = new StringDecoder('utf8');
    private eventBuffer = '';
    private bytes = 0;
    public failure?: string;
    /** Track nonblank summary text without keeping a second unbounded copy of the response. */
    public hasSummary = false;
    public messageStopped = false;
    private readonly upstreamSocket: Socket;
    /** Reuse only the real request socket for adapter timeout checks; no buffered data is written to it. */
    public constructor(req: http.IncomingMessage) {
        super(req); this.upstreamSocket = req.socket;
        Object.defineProperty(this, 'socket', { configurable: true, get: () => this.upstreamSocket });
    }
    /** Retain one response within a strict host-memory cap and recognize Anthropic SSE errors before commit. */
    private capture(chunk: unknown, encoding?: BufferEncoding): void {
        if (this.failure || chunk === undefined || chunk === null) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
        this.bytes += bytes.length;
        if (this.bytes > 16 * 1024 * 1024) { this.failure = 'Compaction response exceeded 16 MiB'; return; }
        this.chunks.push(bytes); this.eventBuffer += this.decoder.write(bytes);
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(this.eventBuffer))) {
            const event = this.eventBuffer.slice(0, boundary.index); this.eventBuffer = this.eventBuffer.slice(boundary.index + boundary[0].length);
            const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            try {
                const value = JSON.parse(payload);
                if (value?.type === 'error') this.failure = extractUpstreamErrorMessage(payload);
                if (value?.type === 'content_block_delta' && value.delta?.type === 'text_delta' && typeof value.delta.text === 'string' && value.delta.text.trim()) this.hasSummary = true;
                if (value?.type === 'content_block_start' && value.content_block?.type === 'text' && typeof value.content_block.text === 'string' && value.content_block.text.trim()) this.hasSummary = true;
                if (value?.type === 'message_stop') this.messageStopped = true;
            } catch { /* Heartbeats do not complete or fail compaction. */ }
        }
    }
    /** Buffer streamed writes and execute callbacks without marking real response headers sent. */
    public override write(chunk: any, encoding?: any, callback?: any): boolean {
        this.capture(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
        const done = typeof encoding === 'function' ? encoding : callback; if (done) queueMicrotask(done); return true;
    }
    /** Buffer final data, then let native ServerResponse own writableEnded/finish semantics. */
    public override end(chunk?: any, encoding?: any, callback?: any): this {
        if (this.writableEnded) return this;
        if (typeof chunk !== 'function') this.capture(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
        const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
        return super.end(undefined, done);
    }
    /** Never send buffered headers to the actual socket before the transaction succeeds. */
    public override flushHeaders(): void {}
    /** The adapter may inspect the complete converted response after its own finalization. */
    public body(): Buffer { return Buffer.concat(this.chunks); }
}

/** Forward exactly once and commit a successful summary, otherwise emit one non-retryable Anthropic error. */
export async function forwardDedicatedCompaction(adapter: UpstreamAdapter, context: UpstreamRequestContext): Promise<void> {
    const response = new CompactionResponse(context.req);
    const outcome = context.outcome ?? new RequestOutcomeReporter(context.usageContext);
    const onClose = () => response.emit('close'); context.res.once('close', onClose);
    try {
        try { await adapter.handle({ ...context, res: response, outcome, onUpstreamTimeout: undefined }); }
        catch (error) {
            outcome?.fail('upstream_connect', (error as NodeJS.ErrnoException)?.code);
            response.failure = error instanceof Error ? error.message : 'Compaction request failed';
        }
        const body = response.body(), contentType = String(response.getHeader('content-type') ?? '');
        if (response.statusCode >= 400) response.failure ||= extractUpstreamErrorMessage(body.toString('utf8')) || `HTTP ${response.statusCode}`;
        if (contentType.includes('text/event-stream')) {
            if (!response.messageStopped || !response.hasSummary || (outcome && !outcome.hasStreamTerminal())) response.failure ||= 'Compaction stream ended without a complete summary';
        } else if (!response.failure) {
            try {
                const value = JSON.parse(body.toString('utf8'));
                if (value?.error || value?.type === 'error' || value?.status === 'failed') response.failure = extractUpstreamErrorMessage(body.toString('utf8'));
                else if (!Array.isArray(value?.content) || !value.content.some((item: any) => item?.type === 'text' && typeof item.text === 'string' && item.text.trim())) response.failure = 'Compaction returned no summary text';
            } catch { response.failure = 'Compaction returned invalid JSON'; }
        }
        const reported = outcome?.snapshot();
        if (reported?.status === 'error' || reported?.status === 'aborted' || response.failure) {
            writeCompactionFailure(context.res, response.failure || 'The upstream compaction request did not complete', outcome); return;
        }
        if (context.res.destroyed || context.res.writableEnded) return;
        context.res.statusCode = response.statusCode;
        for (const header of response.getHeaderNames()) {
            if (['content-length', 'transfer-encoding', 'connection', 'retry-after', 'x-should-retry'].includes(header.toLowerCase())) continue;
            const value = response.getHeader(header); if (value !== undefined) context.res.setHeader(header, value);
        }
        context.res.end(body);
    } finally { context.res.off('close', onClose); }
}

/** One session's failed compaction remains terminal until the next explicit user submission. */
interface CompactionAttempt {
    pending: Promise<void>;
    failed: boolean;
}

/** Block the CLI's internal summary fallback attempts from creating additional paid upstream requests. */
export class CompactionFailureGuard {
    private readonly attempts = new Map<string, CompactionAttempt>();
    /** A new user submission clears only its own session; old in-flight attempts cannot latch the new turn. */
    public reset(sessionId: string): void { this.attempts.delete(sessionId); }
    /** Check for a previously failed summary before resolving providers or opening another transport. */
    public hasFailed(sessionId: string): boolean { return this.attempts.get(sessionId)?.failed === true; }
    /** Retain a configuration failure just like an upstream failure, without storing any request or credential. */
    public fail(sessionId: string): void {
        this.attempts.set(sessionId, { pending: Promise.resolve(), failed: true });
    }
    /** Serialize summary attempts and replay only the terminal error after failure; success leaves no latch. */
    public async forward(sessionId: string, res: http.ServerResponse, outcome: RequestOutcomeReporter, send: () => Promise<void>): Promise<void> {
        const previous = this.attempts.get(sessionId);
        if (previous) {
            await previous.pending;
            if (previous.failed) {
                writeCompactionFailure(res, 'This compaction already failed. Submit a new message or run /compact manually to try again.', outcome);
                return;
            }
        }
        let finish!: () => void;
        const attempt: CompactionAttempt = { pending: new Promise<void>(resolve => { finish = resolve; }), failed: false };
        this.attempts.set(sessionId, attempt);
        try { await send(); }
        finally {
            attempt.failed = outcome.snapshot().retryable === false;
            if (!attempt.failed && this.attempts.get(sessionId) === attempt) this.attempts.delete(sessionId);
            finish();
        }
    }
}

/** Shared main-chat guard; independent editors and detached routers own separate instances. */
export const mainCompactionFailures = new CompactionFailureGuard();
