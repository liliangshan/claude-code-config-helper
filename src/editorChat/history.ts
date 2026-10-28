/** @file Deterministic parallel-task reopening and the shared editor admission limit. */
import type { EditorHistoryEntry } from './store';

/** Return unopened valid UUIDs in creation order; activity and title changes never reorder reopening. */
export function unopenedEditorHistory(entries: readonly EditorHistoryEntry[], openIds: ReadonlySet<string>): EditorHistoryEntry[] {
    return entries.filter(entry => !openIds.has(entry.id) && !entry.error && !!entry.conversation)
        .sort((a, b) => (a.conversation!.createdAt - b.conversation!.createdAt) || a.id.localeCompare(b.id));
}

/** Allow a lower configured limit but never more than three editors, including old settings above three. */
export function editorSessionLimit(configured: unknown): number {
    return typeof configured === 'number' && Number.isSafeInteger(configured) && configured >= 1 ? Math.min(configured, 3) : 3;
}
