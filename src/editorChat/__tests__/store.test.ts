/** @file Editor conversation storage, ownership and settings isolation tests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EditorConversationStore, validateConversation, type EditorConversation, type EditorSettings } from '../store';

/** Create independent records with equal initial settings and distinct identities. */
function record(cwd: string): EditorConversation {
    const settings: EditorSettings = { normalModel: 'p/main', taskFlowModel: '', compactionModel: 'p/summary', reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' };
    return { version: 1, cwd, conversationId: randomUUID(), title: 'Same title', createdAt: Date.now(), updatedAt: Date.now(), revision: 0, settings, messages: [], lastRunState: 'idle' };
}

test('two equal-title conversations save independently; reopening preserves per-session settings', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-session-'));
    const a = record(cwd), b = record(cwd);
    const sa = new EditorConversationStore(cwd, a.conversationId), sb = new EditorConversationStore(cwd, b.conversationId);
    try {
        await Promise.all([sa.acquire(), sb.acquire()]);
        a.settings.normalModel = 'p/a'; b.settings.reasoningEffort = 'high';
        await Promise.all([sa.save(a), sb.save(b)]);
        assert.equal((await sa.load()).settings.normalModel, 'p/a');
        assert.equal((await sb.load()).settings.normalModel, 'p/main');
        assert.equal((await sa.load()).settings.reasoningEffort, 'auto');
        await assert.rejects(new EditorConversationStore(cwd, a.conversationId).acquire(), /EEXIST/);
        assert.equal((await EditorConversationStore.list(cwd)).filter(item => item.occupied).length, 2);
        await sa.release(); const reopened = new EditorConversationStore(cwd, a.conversationId); await reopened.acquire();
        assert.equal((await reopened.load()).settings.normalModel, 'p/a'); await reopened.release();
        await assert.rejects(fs.access(path.join(cwd, '.LLSOAI/chat-session.json')));
    } finally { await sa.release(); await sb.release(); await fs.rm(cwd, { recursive: true, force: true }); }
});

test('dead-host recovery is automatic but live and inaccessible hosts keep their locks', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-recover-'));
    const data = record(cwd), store = new EditorConversationStore(cwd, data.conversationId);
    const directory = await store.resolveDirectory(); const lock = path.join(directory, 'runtime.lock');
    const original = JSON.stringify({ ownerToken: randomUUID(), pid: 12345, createdAt: 1 });
    try {
        await fs.writeFile(lock, original);
        const probe = t.mock.method(process, 'kill', (() => true) as typeof process.kill);
        await assert.rejects(store.recover(), /still running/);
        assert.equal(await fs.readFile(lock, 'utf8'), original);
        probe.mock.mockImplementation((() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }) as typeof process.kill);
        await assert.rejects(store.recover(), /denied/);
        assert.equal(await fs.readFile(lock, 'utf8'), original);
        probe.mock.mockImplementation((() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }) as typeof process.kill);
        await store.recover();
        await assert.rejects(fs.access(lock), { code: 'ENOENT' });
        await store.acquire(); await store.save(data);
        assert.equal((await store.load()).conversationId, data.conversationId);
        await store.release();
    } finally { await store.release(); await fs.rm(cwd, { recursive: true, force: true }); }
});

test('malformed conversation remains visible and path traversal identifiers are rejected', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-broken-'));
    const data = record(cwd), store = new EditorConversationStore(cwd, data.conversationId);
    try {
        const dir = await store.resolveDirectory(); await fs.writeFile(path.join(dir, 'meta.json'), '{bad');
        const listed = await EditorConversationStore.list(cwd); assert.ok(listed[0].error);
        assert.throws(() => new EditorConversationStore(cwd, '../../other'));
        assert.throws(() => validateConversation({ ...data, settings: { ...data.settings, reasoningEffort: 'unknown' } }));
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
