/** @file Chat-native search result collection; answer links are never promoted to verified search evidence. */
import { NativeWebSearchError, requiresNativeWebSearch, searchResultBlocks, type NativeSearchBlock } from './nativeWebSearch';

/** Search conversion adds only actual source blocks or an explicit evidence disclaimer. */
export type ChatSearchBlock = NativeSearchBlock | { type: 'text'; text: string };

/** Request query comes from the CLI's dedicated search prompt, never from a guessed model response. */
export function chatSearchQuery(body: unknown): string | undefined {
    if (!requiresNativeWebSearch(body) || !isRecord(body)) return undefined;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const message of [...messages].reverse()) {
        if (!isRecord(message) || message.role !== 'user') continue;
        const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
            ? message.content.filter(isRecord).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
        if (text) return text.replace(/^Perform a web search for the query:\s*/, '');
    }
    return '';
}

/** Collect only public structured sources and visible answer text from one selected Chat completion. */
export class ChatWebSearchResult {
    private hasText = false;
    private readonly sources: unknown[] = [];
    private failed = false;
    /** Bind the explicit search query for a single response; this class never sends requests. */
    public constructor(private readonly query: string) {}
    /** Read top-level/selected-message metadata, including late citation-only chunks, without following any URL. */
    public collect(value: unknown): void {
        if (!isRecord(value)) return;
        if (value.error) this.failed = true;
        if (typeof value.content === 'string' && value.content.trim()) this.hasText = true;
        for (const key of ['annotations', 'citations', 'search_results', 'web_search_results']) {
            if (!Array.isArray(value[key])) continue;
            for (const entry of value[key]) {
                if (typeof entry === 'string') this.sources.push({ url: entry });
                else if (isRecord(entry)) this.sources.push(isRecord(entry.url_citation) ? entry.url_citation : entry);
            }
        }
    }
    /** Reject an upstream request for client-side tool execution in place of server-side search. */
    public rejectToolCall(): void { this.failed = true; }
    /** Return sources only when structured metadata provides them; text-only replies carry a visible evidence warning. */
    public blocks(id: string, completed: boolean): ChatSearchBlock[] {
        if (!completed || this.failed) throw new NativeWebSearchError('Chat native web search did not complete successfully. No search result was accepted.');
        const blocks = searchResultBlocks({ id, type: 'web_search_call', status: 'completed', action: { query: this.query, sources: this.sources } });
        const result = blocks.find(block => block.type === 'web_search_tool_result');
        if (result && Array.isArray(result.content) && result.content.length) return blocks;
        if (!this.hasText) throw new NativeWebSearchError('Chat provider returned neither search sources nor answer text. Native web_search may be unsupported.');
        return [{ type: 'text', text: '\n\n[Search evidence: the provider returned answer text without structured search records. Any links above are provider-generated answer links; live search execution is not independently verified.]' }];
    }
}

/** Narrow unknown wire objects without treating arrays as records. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
