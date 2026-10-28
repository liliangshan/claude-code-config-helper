/** @file Parallel-task opening order and three-slot admission tests without running a CLI. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
const stub = installVscodeStub({ values: { claudeCodeConfigHelper: { 'chat.editorSessions.maxOpen': 8 } } });
const vscode = require('vscode');
const { EditorChatManager } = require('../manager') as typeof import('../manager');
const { EditorConversationStore } = require('../store') as typeof import('../store');
const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');

test('plus reopens UUIDs in order without a picker, creates only after all are open and caps rapid clicks at three', async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-manager-'));
    stub.workspaceFolderFsPath = cwd; Object.assign(vscode.workspace, { isTrusted: true });
    let picker = 0; let nextChoice: unknown; let foldersPicked = 0;
    Object.assign(vscode.window, {
        showQuickPick: async () => { picker++; return nextChoice; },
        showWorkspaceFolderPick: async () => { foldersPicked++; throw new Error('Plus must not ask for a folder'); }
    });
    const settings = { normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' } as const;
    const entries = [20, 10].map(createdAt => {
        const id = randomUUID(); return { id, occupied: false, conversation: { version: 1, conversationId: id, cwd, title: `Task ${createdAt}`, createdAt, updatedAt: createdAt, revision: 0, settings, messages: [], lastRunState: 'closed' } };
    }) as import('../store').EditorHistoryEntry[];
    t.mock.method(EditorConversationStore, 'list', async () => entries);
    t.mock.method(ChatCliConfigService.prototype, 'getConfig', () => ({ cliPath: '/synthetic/cli' } as any));
    const manager = new EditorChatManager({} as never, { getResolvedUiLanguage: () => 'zh-cn' } as never);
    const internal = manager as any; const opened: string[] = []; let focused = 0;
    t.mock.method(internal, 'defaults', () => ({ ...settings }));
    t.mock.method(internal, 'createPanel', async (data: import('../store').EditorConversation, store: import('../store').EditorConversationStore) => {
        opened.push(data.conversationId);
        internal.active.set(data.conversationId, { panel: { reveal: () => { focused++; } } });
        await store.release();
    });
    try {
        await manager.open(); await manager.open();
        assert.deepEqual(opened, [entries[1].id, entries[0].id]); assert.equal(picker, 0); assert.equal(foldersPicked, 0);
        const clicks = await Promise.allSettled([manager.open(), manager.open(), manager.open()]);
        assert.equal(clicks.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(opened.length, 3); assert.equal(internal.active.size, 3);
        const denied = clicks.find(result => result.status === 'rejected') as PromiseRejectedResult;
        assert.match(String(denied.reason), /已达上限/);
        nextChoice = { id: opened[0] }; await manager.open(true);
        assert.equal(picker, 1); assert.equal(focused, 1, 'The explicit list still focuses an already open tab at capacity');
        internal.active.get(opened[0]).closing = Promise.resolve();
        await assert.rejects(manager.open(), /已达上限/, 'A closing tab still occupies its slot');
        internal.active.delete(opened[0]); await manager.open();
        assert.equal(opened.at(-1), entries[1].id, 'Closed task reuses the original UUID instead of creating another');
    } finally { internal.active.clear(); await manager.shutdown(); await fs.rm(cwd, { recursive: true, force: true }); }
});
