/** @file A prepared development reset is consumed before automatic onboarding, without manual commands. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { SETUP_KEY, SETUP_COMPLETE_KEY } from '../state';

const stub = installVscodeStub({ values: {} });
const vscode = require('vscode');
Object.assign(vscode, { ExtensionMode: { Production: 1, Development: 2, Test: 3 } });
const { applyPendingSetupReset, SETUP_RESET_REQUEST } = require('../resetRequest') as typeof import('../resetRequest');

/** Mimic stale VS Code memory despite an already-cleared disk value; clear it through the live Memento API once. */
test('a queued development reset clears cached completion before setup and is consumed only once', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-reset-'));
    const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace);
    stub.workspaceFolderFsPath = workspace;
    const values = new Map<string, unknown>([[SETUP_KEY, { completed: true }], [SETUP_COMPLETE_KEY, true], ['providers', { id: 'unchanged' }]]);
    const writes: string[] = [];
    const context = { extensionMode: 2, globalStorageUri: { fsPath: directory }, globalState: {
        update: async (key: string, value: unknown) => { writes.push(key); if (value === undefined) values.delete(key); else values.set(key, value); }
    } } as unknown as import('vscode').ExtensionContext;
    const file = path.join(directory, SETUP_RESET_REQUEST);
    try {
        await fs.writeFile(file, JSON.stringify({ version: 1, workspaceFolder: workspace }));
        await applyPendingSetupReset(context);
        assert.deepEqual(writes, [SETUP_COMPLETE_KEY, SETUP_KEY]);
        assert.equal(values.has(SETUP_COMPLETE_KEY), false); assert.equal(values.has(SETUP_KEY), false);
        assert.deepEqual(values.get('providers'), { id: 'unchanged' });
        await assert.rejects(fs.access(file), { code: 'ENOENT' });
        await applyPendingSetupReset(context); assert.equal(writes.length, 2);
        const source = readFileSync(path.resolve(__dirname, '../../../src/extension.ts'), 'utf8');
        const reset = source.indexOf('    await applyPendingSetupReset(context);');
        assert.ok(reset > 0 && reset < source.indexOf('    const services = createCoreServices(context);'));
        assert.ok(reset < source.indexOf('    configureSetup(context, services.configManager);'));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

/** Production windows, unrelated workspaces and malformed requests cannot trigger the development reset. */
test('reset request ignores production and other workspaces, and preserves state when invalid or unwritable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-reset-guard-'));
    const workspace = path.join(directory, 'workspace'); const other = path.join(directory, 'other');
    await fs.mkdir(workspace); await fs.mkdir(other); stub.workspaceFolderFsPath = other;
    let mode = 1; const writes: string[] = [];
    const context = { get extensionMode() { return mode; }, globalStorageUri: { fsPath: directory }, globalState: {
        update: async (key: string) => { writes.push(key); throw new Error('State is not writable'); }
    } } as unknown as import('vscode').ExtensionContext;
    const file = path.join(directory, SETUP_RESET_REQUEST);
    try {
        await fs.writeFile(file, JSON.stringify({ version: 1, workspaceFolder: workspace }));
        await applyPendingSetupReset(context); assert.deepEqual(writes, []);
        mode = 2; await applyPendingSetupReset(context); assert.deepEqual(writes, []); await fs.access(file);
        stub.workspaceFolderFsPath = workspace;
        await assert.rejects(applyPendingSetupReset(context), /not writable/); await fs.access(file);
        await fs.writeFile(file, JSON.stringify({ version: 99, workspaceFolder: workspace }));
        await assert.rejects(applyPendingSetupReset(context), /Invalid setup reset request/);
        await fs.unlink(file); await fs.symlink(path.join(directory, 'missing'), file);
        await assert.rejects(applyPendingSetupReset(context), /Invalid setup reset request/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
