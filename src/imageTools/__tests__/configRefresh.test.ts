/** @file Saved image revisions safely refresh running CLIs without replaying image work. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { defaultImageConfig } from '../types';
import { ImageConfigStore } from '../configStore';

installVscodeStub({ values: {} });
const vscode = require('vscode');
const { ImageToolHost } = require('../imageToolHost') as typeof import('../imageToolHost');
const lifecycle = require('../../chatRuntime/cliLifecycle') as typeof import('../../chatRuntime/cliLifecycle');

/** Checks/failures do not restart; multiple revisions coalesce independently while a busy owner waits. */
test('committed image settings refresh all running owners once and ignore duplicate notifications', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-config-refresh-'));
    vscode.workspace.isTrusted = true;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, get: () => [{ uri: { fsPath: root, scheme: 'file' } }] });
    const secrets = new Map<string, string>();
    const vault = { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } };
    const manager = { listProviders: () => [], onDidChange: () => ({ dispose() {} }), getResolvedUiLanguage: () => 'en' } as any;
    const host = new ImageToolHost({ globalStorageUri: { fsPath: root }, secrets: vault } as any, manager);
    const peer = new ImageConfigStore(root, vault, manager);
    const scope = { cwd: root, id: 'b'.repeat(64), title: 'refresh' }, posted: any[] = [];
    let main = 0, idle = 0, busy = true, delayed = 0;
    t.mock.method(lifecycle, 'refreshImageToolsCli', async () => { main++; return true; });
    const view = { scope: async () => scope, post: (message: any) => { posted.push(message); }, refreshCli: async () => { idle++; return true; } };
    const held = { scope: async () => scope, post() {}, refreshCli: async () => { if (busy) return false; delayed++; return true; } };
    const config = { ...defaultImageConfig(), enabled: true, modelId: 'image', baseUrl: 'https://example.com', authMode: 'none' };
    /** Flush the local broadcast/restart scheduler deterministically without waiting for timers. */
    async function flush() { await (host as any).broadcast(); await (host as any).refreshClis(); }
    try {
        await host.initialize(); host.attach(view); host.attach(held); await flush();
        assert.equal(main, 0); assert.equal(idle, 0);
        await host.receive({ type: 'imageGeneration/configCheck', requestId: 'check', input: { expectedRevision: 0, config, keyAction: 'keep' } }, view);
        await flush(); assert.equal(main, 0);
        await host.receive({ type: 'imageGeneration/configSave', requestId: 'failed', input: { expectedRevision: 8, config, keyAction: 'keep' } }, view);
        assert.equal(posted.at(-1).ok, false); await flush(); assert.equal(main, 0);
        await host.receive({ type: 'imageGeneration/configSave', requestId: 'save', input: { expectedRevision: 0, config: { ...config, supportsGif: true }, keyAction: 'keep' } }, view);
        assert.equal(posted.at(-1).ok, true); await flush(); assert.equal(main, 1); assert.equal(idle, 1); assert.equal(delayed, 0);
        host.config.refresh(); await flush(); assert.equal(main, 1); assert.equal(idle, 1);
        const latest = await peer.read(); await peer.save({ expectedRevision: latest.revision, config: { ...latest, supportsGif: false }, keyAction: 'keep' });
        await flush(); assert.equal(main, 2); assert.equal(idle, 2); assert.equal(delayed, 0);
        busy = false; await flush(); assert.equal(delayed, 1, 'Busy owner applies only the newest configuration');
        await flush(); assert.equal(main, 2); assert.equal(idle, 2); assert.equal(delayed, 1);
        assert.equal((await host.config.read()).supportsGif, false);
    } finally { peer.dispose(); await host.close(); await fs.rm(root, { recursive: true, force: true }); }
});
