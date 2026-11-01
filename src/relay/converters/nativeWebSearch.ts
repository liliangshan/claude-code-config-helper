/** @file Native web-search schema mapping and real source conversion; never performs network requests. */

/** Require real search results whenever an Anthropic request declares a native search tool. */
export function requiresNativeWebSearch(body: unknown): boolean {
    return isRecord(body) && Array.isArray(body.tools) && body.tools.some(isNativeWebSearchTool);
}

/** Explicit compatibility error instead of silently replacing server-side search with a function tool. */
export class NativeWebSearchError extends Error {
    /** Stable machine-readable code for the relay outcome. */
    public readonly code = 'unsupported_web_search';
    /** Describe an unsupported search option without including credentials or request bodies. */
    public constructor(message: string) { super(message); this.name = 'NativeWebSearchError'; }
}

/** Only typed Anthropic server-side search schemas qualify; a normal function named WebSearch does not. */
export function isNativeWebSearchTool(value: unknown): boolean {
    return isRecord(value) && value.name === 'web_search' && typeof value.type === 'string' && /^web_search_\d{8}$/.test(value.type);
}

/** Responses-native tool; no function name or invented input schema is attached. */
export interface ResponsesWebSearchTool {
    type: 'web_search';
    filters?: { allowed_domains: string[] };
    user_location?: Record<string, string>;
    name?: never;
    parameters?: never;
    cache_control?: never;
    /** Keep existing function-tool access type-safe when used in a Chat tools union. */
    function?: never;
}

/** Map only supported filters; unsupported exclusions must not silently broaden the user's search. */
export function toResponsesWebSearch(tool: Record<string, unknown>): ResponsesWebSearchTool {
    const allowed = domains(tool.allowed_domains), blocked = domains(tool.blocked_domains);
    if (blocked.length) throw new NativeWebSearchError('This native search adapter cannot enforce blocked_domains. Use allowed_domains or an Anthropic search provider.');
    if (tool.max_uses !== undefined && (typeof tool.max_uses !== 'number' || !Number.isSafeInteger(tool.max_uses) || tool.max_uses < 1)) throw new NativeWebSearchError('Native web-search max_uses must be a positive integer.');
    const result: ResponsesWebSearchTool = { type: 'web_search' };
    if (allowed.length) result.filters = { allowed_domains: allowed };
    if (isRecord(tool.user_location)) {
        const location: Record<string, string> = { type: 'approximate' };
        for (const key of ['city', 'region', 'country', 'timezone']) {
            if (typeof tool.user_location[key] === 'string') location[key] = tool.user_location[key];
        }
        result.user_location = location;
    }
    return result;
}

/** Anthropic server blocks consumed by CLI WebSearch, not locally executable function calls. */
export type NativeSearchBlock =
    | { type: 'server_tool_use'; id: string; name: 'web_search'; input: { query: string } }
    | { type: 'web_search_tool_result'; tool_use_id: string; content: Array<{ type: 'web_search_result'; url: string; title: string }> | { type: 'web_search_tool_result_error'; error_code: 'unavailable' } };

/** Convert only an actual upstream search item; URLs come exclusively from structured sources/citations. */
export function searchResultBlocks(item: Record<string, unknown>, citations: unknown[] = [], allowCitationFallback = false): NativeSearchBlock[] {
    if (item.type !== 'web_search_call' || typeof item.id !== 'string' || !item.id) return [];
    const action = isRecord(item.action) ? item.action : {};
    const sources = Array.isArray(action.sources) ? action.sources : [];
    const links = new Map<string, { type: 'web_search_result'; url: string; title: string }>();
    const matchingCitations = citations.filter(value => isRecord(value) && (allowCitationFallback || sources.some(source => isRecord(source) && source.url === value.url)));
    for (const value of [...sources, ...matchingCitations]) {
        if (!isRecord(value) || typeof value.url !== 'string') continue;
        try { const url = new URL(value.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue; }
        catch { continue; }
        const title = typeof value.title === 'string' && value.title.trim() ? value.title : value.url;
        const previous = links.get(value.url);
        if (!previous || previous.title === previous.url) links.set(value.url, { type: 'web_search_result', url: value.url, title });
    }
    const query = typeof action.query === 'string' ? action.query : Array.isArray(action.queries) ? action.queries.filter(value => typeof value === 'string').join(' | ') : '';
    const id = `srvtoolu_${item.id}`;
    return [
        { type: 'server_tool_use', id, name: 'web_search', input: { query } },
        { type: 'web_search_tool_result', tool_use_id: id, content: item.status === 'completed' && links.size ? [...links.values()] : { type: 'web_search_tool_result_error', error_code: 'unavailable' } }
    ];
}

/** Read structured URL citations from Responses output messages, never from generated prose. */
export function responseSearchCitations(output: unknown): unknown[] {
    if (!Array.isArray(output)) return [];
    return output.flatMap(item => isRecord(item) && item.type === 'message' && Array.isArray(item.content)
        ? item.content.flatMap(part => isRecord(part) && Array.isArray(part.annotations) ? part.annotations.filter(annotation => isRecord(annotation) && annotation.type === 'url_citation') : []) : []);
}

/** Validate domain arrays rather than silently discarding malformed restrictions. */
function domains(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(domain => typeof domain !== 'string' || !domain.trim())) throw new NativeWebSearchError('Invalid native web-search domain filter.');
    return value as string[];
}

/** Narrow unknown wire values without inheriting array behavior. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
