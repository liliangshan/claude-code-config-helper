/** @file Native CLI history listing for a single editor, independent of sidebar state. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionListItem } from '../chat/protocol';
import { extractSessionTitle } from '../chatRuntime/chatSession';

/** Resolve the CLI history directory using the conversation's saved configuration directory. */
export function editorProjectHistory(cwd: string, configDir: string): string {
    return path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** List native histories without reading entire transcripts or silently selecting another session. */
export async function listEditorNativeHistory(cwd: string, configDir: string): Promise<SessionListItem[]> {
    const directory = editorProjectHistory(cwd, configDir);
    let names: string[];
    try { names = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const items: SessionListItem[] = [];
    await Promise.all(names.filter(name => /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(name)).map(async name => {
        const file = path.join(directory, name);
        if ((await fs.lstat(file)).isSymbolicLink()) return;
        const handle = await fs.open(file, 'r');
        try {
            const stat = await handle.stat(); const buffer = Buffer.alloc(65536);
            const read = await handle.read(buffer, 0, buffer.length, 0); const head = buffer.toString('utf8', 0, read.bytesRead);
            if (/"isSidechain"\s*:\s*true/.test(head.split('\n')[0])) return;
            const sessionId = name.slice(0, -6);
            items.push({ sessionId, summary: await extractSessionTitle(file) || sessionId, lastModified: stat.mtimeMs, fileSize: stat.size });
        } finally { await handle.close(); }
    }));
    return items.sort((a, b) => b.lastModified - a.lastModified);
}
