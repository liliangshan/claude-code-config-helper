/** @file Smart-entry decision and per-instance continuation tests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorSessionLimit, unopenedEditorHistory } from '../history';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: {} });
const { EditorContinuation } = require('../continuation') as typeof import('../continuation');

test('parallel entry reopens valid UUIDs in stable creation order without mutating the list', () => {
    const entries = [
        { id: 'c', conversation: { createdAt: 30 }, occupied: false },
        { id: 'a', conversation: { createdAt: 10 }, occupied: false },
        { id: 'b', conversation: { createdAt: 20 }, occupied: true },
        { id: 'bad', occupied: false, error: 'bad JSON' }
    ] as import('../store').EditorHistoryEntry[];
    assert.deepEqual(unopenedEditorHistory(entries, new Set(['a'])).map(entry => entry.id), ['b', 'c']);
    assert.deepEqual(unopenedEditorHistory(entries, new Set(['a', 'b', 'c'])), []);
    assert.deepEqual(entries.map(entry => entry.id), ['c', 'a', 'b', 'bad']);
    assert.deepEqual(unopenedEditorHistory([], new Set()), []);
});

test('parallel task limit defaults to three and clamps legacy higher or invalid settings', () => {
    assert.equal(editorSessionLimit(undefined), 3); assert.equal(editorSessionLimit(4), 3);
    assert.equal(editorSessionLimit(100), 3); assert.equal(editorSessionLimit(2), 2);
    for (const value of [0, -1, 1.5, NaN, '3']) assert.equal(editorSessionLimit(value), 3);
});

test('deactivation closes runtimes without disposing restorable editor tabs', async () => {
    const { EditorChatManager } = require('../manager') as typeof import('../manager');
    const manager = new EditorChatManager({} as never, {} as never);
    let stopped = 0;
    (manager as unknown as { active: Map<string, unknown> }).active.set('test', {
        runtime: { close: async () => { stopped++; } },
        panel: { dispose: () => assert.fail('deactivation must preserve the VS Code tab') }
    });
    await manager.shutdown(); assert.equal(stopped, 1);
});

test('editor continuation cancellation and circuit breaker never share another window state', () => {
    const a = new EditorContinuation({} as never), b = new EditorContinuation({} as never);
    a.scheduleAfterWorkflowTool(); b.scheduleAfterWorkflowTool(); a.cancel();
    assert.equal(a.consume(), false); assert.equal(b.consume(), true);
    a.disposeAll(); a.scheduleAfterWorkflowTool(); assert.equal(a.consume(), false);
    for (let i = 0; i < 3; i++) { b.schedule(); assert.equal(b.consume(), true); }
    b.schedule(); assert.equal(b.consume(), false);
});
