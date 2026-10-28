/** @file Host clipboard acknowledgement tests; no real system clipboard writes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from './testUtils/vscodeStub';
installVscodeStub({ values: {} });
const vscode = require('vscode');
const { ChatViewHost } = require('../chatViewHost') as typeof import('../chatViewHost');

test('host writes requested text and reports real success/failure to the originating webview', async () => {
    const values: string[] = [], replies: any[] = [];
    let fail = false;
    Object.assign(vscode.env, { clipboard: { writeText: async (text: string) => { if (fail) throw new Error('denied'); values.push(text); } } });
    const host = new ChatViewHost({} as import('vscode').ExtensionContext) as unknown as { writeClipboard(view: unknown, message: unknown): Promise<void> };
    const view = { postMessage: async (value: unknown) => { replies.push(value); return true; } };
    await host.writeClipboard(view, { requestId: 'a', text: 'selected' });
    assert.deepEqual(values, ['selected']); assert.equal(replies[0].message.ok, true);
    fail = true; await host.writeClipboard(view, { requestId: 'b', text: 'not copied' });
    assert.equal(replies[1].message.ok, false);
    await host.writeClipboard(view, { requestId: 'c', text: 123 });
    assert.equal(replies[2].message.ok, false);
    assert.deepEqual(values, ['selected']);
});
