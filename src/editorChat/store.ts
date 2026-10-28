/** @file Independent editor conversation persistence and single-writer ownership. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatComposerAttachment } from '../chat/protocol';
import type { ChatCliPermissionMode } from '../chat/cli/types';

/** No provider credentials are copied into session settings. */
export interface EditorSettings {
    normalModel: string; taskFlowModel: string; compactionModel: string;
    reasoningEffort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh';
    permissionMode: ChatCliPermissionMode; subagentsEnabled: boolean; autoCompactEnabled: boolean;
    codePreviewEnabled: boolean; cacheTtl: 'default' | '5m' | '1h';
}
/** Durable conversation, distinct from a panel instance and CLI process generation. */
export interface EditorConversation {
    version: 1; conversationId: string; cwd: string; title: string; createdAt: number; updatedAt: number;
    revision: number; cliSessionId?: string; cliConfigDir?: string; settings: EditorSettings;
    messages: ChatMessage[]; draft?: { text: string; attachments: ChatComposerAttachment[] };
    lastRunState: 'idle' | 'running' | 'interrupted' | 'closed';
}
/** List entry preserves corrupt or occupied conversations rather than treating them as missing. */
export interface EditorHistoryEntry { id: string; conversation?: EditorConversation; error?: string; occupied: boolean }

/** Constrain filesystem keys to host-generated UUIDs. */
export function assertConversationId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid conversation ID');
}
/** Validate persisted identity and settings before launching any process. */
export function validateConversation(raw: unknown): EditorConversation {
    const value = raw as EditorConversation;
    if (!value || value.version !== 1 || typeof value.conversationId !== 'string') throw new Error('Invalid conversation schema');
    assertConversationId(value.conversationId);
    if (!path.isAbsolute(value.cwd) || !Array.isArray(value.messages) || !Number.isSafeInteger(value.revision)) throw new Error('Invalid conversation data');
    const s = value.settings;
    if (!s || !['auto', 'low', 'medium', 'high', 'xhigh'].includes(s.reasoningEffort)
        || !['default', 'acceptEdits', 'bypassPermissions', 'auto', 'dontAsk', 'plan'].includes(s.permissionMode)
        || !['default', '5m', '1h'].includes(s.cacheTtl)) throw new Error('Invalid conversation settings');
    for (const key of ['normalModel', 'taskFlowModel', 'compactionModel'] as const) if (typeof s[key] !== 'string') throw new Error('Invalid model reference');
    for (const key of ['subagentsEnabled', 'autoCompactEnabled', 'codePreviewEnabled'] as const) if (typeof s[key] !== 'boolean') throw new Error('Invalid switch');
    if (value.cliSessionId) assertConversationId(value.cliSessionId);
    return value;
}

/** One file queue and exclusive lock per conversation; sidebar files are never touched. */
export class EditorConversationStore {
    private queue: Promise<void> = Promise.resolve();
    private owner?: fs.FileHandle;
    private readonly ownerToken = randomUUID();
    private heartbeat?: NodeJS.Timeout;
    private directory = '';
    /** @param cwd Explicit workspace root; @param id Stable conversation UUID. */
    public constructor(public readonly cwd: string, public readonly id: string) { assertConversationId(id); }
    /** Resolve private storage and reject symlink components. */
    public async resolveDirectory(): Promise<string> {
        let current = await fs.realpath(this.cwd);
        for (const part of ['.LLSOAI', 'editor-sessions', this.id]) {
            current = path.join(current, part); await fs.mkdir(current, { recursive: true, mode: 0o700 });
            if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Session storage symlink rejected');
        }
        this.directory = current; return current;
    }
    /** Acquire process ownership before restoring a CLI history. */
    public async acquire(): Promise<void> {
        await this.resolveDirectory();
        this.owner = await fs.open(path.join(this.directory, 'runtime.lock'), 'wx', 0o600);
        await this.owner.writeFile(JSON.stringify({ ownerToken: this.ownerToken, pid: process.pid, createdAt: Date.now() }));
        this.heartbeat = setInterval(() => { if (this.owner) void this.owner.utimes(new Date(), new Date()).catch(() => {}); }, 10000);
    }
    /** Load a recoverable atomic checkpoint, never silently replace a broken record. */
    public async load(): Promise<EditorConversation> {
        const directory = await this.resolveDirectory();
        const file = path.join(directory, 'meta.json');
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Session metadata symlink rejected');
        const value = validateConversation(JSON.parse(await fs.readFile(file, 'utf8')));
        if (value.conversationId !== this.id || await fs.realpath(value.cwd) !== await fs.realpath(this.cwd)) throw new Error('Session identity mismatch');
        return value;
    }
    /** Serialize detached checkpoints and atomically replace only this conversation's metadata. */
    public save(value: EditorConversation): Promise<void> {
        const snapshot = JSON.parse(JSON.stringify(value)) as EditorConversation;
        validateConversation(snapshot);
        if (snapshot.conversationId !== this.id) return Promise.reject(new Error('Wrong conversation store'));
        const operation = this.queue.then(async () => {
            if (!this.owner) throw new Error('Session ownership lost');
            const lock = JSON.parse(await fs.readFile(path.join(this.directory, 'runtime.lock'), 'utf8'));
            if (lock.ownerToken !== this.ownerToken) throw new Error('Session owner changed');
            const target = path.join(this.directory, 'meta.json');
            try {
                if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Metadata symlink rejected');
                const previous = validateConversation(JSON.parse(await fs.readFile(target, 'utf8')));
                if (previous.revision >= snapshot.revision) throw new Error('Conversation revision conflict');
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const file = path.join(this.directory, `${randomUUID()}.tmp`);
            const handle = await fs.open(file, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); } finally { await handle.close(); }
            try { await fs.rename(file, path.join(this.directory, 'meta.json')); } finally { await fs.rm(file, { force: true }); }
        });
        this.queue = operation.catch(() => {}); return operation;
    }
    /** Release ownership only after pending writes finish; crashed locks remain visible for inspection. */
    public async release(): Promise<void> {
        if (this.heartbeat) clearInterval(this.heartbeat); await this.queue;
        if (!this.owner) return;
        await this.owner.close(); this.owner = undefined;
        const file = path.join(this.directory, 'runtime.lock');
        const owner = JSON.parse(await fs.readFile(file, 'utf8'));
        if (owner.ownerToken === this.ownerToken) await fs.unlink(file);
    }
    /** Automatically reclaim a dead host's lock; live, inaccessible or malformed owners remain blocked. */
    public async recover(): Promise<void> {
        const directory = await this.resolveDirectory(); const file = path.join(directory, 'runtime.lock');
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Lock symlink rejected');
        const raw = await fs.readFile(file, 'utf8'); const owner = JSON.parse(raw);
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.ownerToken !== 'string') throw new Error('Invalid session lock');
        try { process.kill(owner.pid, 0); throw new Error('Session owner is still running'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        if (await fs.readFile(file, 'utf8') !== raw) throw new Error('Session owner changed');
        await fs.unlink(file);
    }
    /** Enumerate records and locks without creating folders or discarding malformed histories. */
    public static async list(cwd: string): Promise<EditorHistoryEntry[]> {
        const directory = path.join(cwd, '.LLSOAI', 'editor-sessions');
        let names: string[];
        try { if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Session list directory symlink rejected'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        return Promise.all(names.filter(name => /^[0-9a-f-]{36}$/i.test(name)).map(async id => {
            let occupied = false;
            try { await fs.lstat(path.join(directory, id, 'runtime.lock')); occupied = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            try { return { id, occupied, conversation: await new EditorConversationStore(cwd, id).load() }; }
            catch (error) { return { id, occupied, error: String(error) }; }
        }));
    }
}
