/** @file Stream-local handling of the single optional UTF-8 BOM at the start of an SSE response. */

/** Preserve every character except one leading U+FEFF; use a fresh instance for each response. */
export class SseStreamPrefix {
    private atStart = true;

    /**
     * Consume decoded text without losing the stream boundary on empty UTF-8 decoder output.
     * @param chunk Text decoded with a streaming decoder; the BOM bytes may span network chunks.
     * @returns The unchanged chunk, except for one BOM at the absolute start of the response.
     */
    public feed(chunk: string): string {
        if (!this.atStart || chunk.length === 0) return chunk;
        this.atStart = false;
        return chunk.charCodeAt(0) === 0xFEFF ? chunk.slice(1) : chunk;
    }
}
