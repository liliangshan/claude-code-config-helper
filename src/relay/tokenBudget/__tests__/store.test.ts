/**
 * @file TokenCountStore 单元测试。
 *
 * 用临时目录代替 VS Code 工作区根，覆盖 saveSession / archiveSession /
 * appendHistory / pushArchivedSessionId 的内存语义，避免真实文件 IO。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

// 安装与 service.test.ts 一致的 vscode mock：workspaceFolders 指向临时目录。
// 用 require('node:module') 而非 `import * as`，避免命名空间对象只读导致赋值失败。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as { _resolveFilename: (request: string, parent: NodeJS.Module) => string; _cache: Record<string, NodeJS.Module> };
const moduleAny = Module as unknown as {
    _resolveFilename: (request: string, parent: NodeJS.Module) => string;
    _cache: Record<string, NodeJS.Module>;
};
const originalResolveFilename = moduleAny._resolveFilename;
const fakeVscodeId = 'fake://vscode-store';
const fakeLoggerId = 'fake://logger-store';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lls-token-budget-'));
moduleAny._resolveFilename = function (request: string, parent: NodeJS.Module): string {
    if (request === 'vscode') return fakeVscodeId;
    if (request === '../../logger' || request.endsWith('/logger')) return fakeLoggerId;
    return originalResolveFilename.call(this, request, parent);
};
moduleAny._cache[fakeVscodeId] = {
    id: fakeVscodeId,
    filename: fakeVscodeId,
    loaded: true,
    exports: {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: tmpRoot } }]
        }
    }
} as unknown as NodeJS.Module;
moduleAny._cache[fakeLoggerId] = {
    id: fakeLoggerId,
    filename: fakeLoggerId,
    loaded: true,
    exports: { Logger: { init() {}, info() {}, warn() {}, error() {} } }
} as unknown as NodeJS.Module;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TokenCountStore, createEmptySession } = require('../store') as typeof import('../store');

test('createEmptySession 生成符合 schema 的桶', () => {
    const session = createEmptySession('s1', 'p1', 'm', 200000);
    assert.equal(session.sessionId, 's1');
    assert.equal(session.providerId, 'p1');
    assert.equal(session.modelKey, 'p1/m');
    assert.equal(session.contextLimit, 200000);
    assert.equal(session.threshold, 150000);
    assert.equal(session.current.totalInputForBudget, 0);
    assert.equal(session.compact.inProgress, false);
    assert.deepEqual(session.compact.archivedSessionIds, []);
    assert.deepEqual(session.history, []);
});

test('saveSession + getSession 内存视图一致', () => {
    const store = new TokenCountStore();
    const session = createEmptySession('s1', 'p1', 'm', 200000);
    session.current.inputTokens = 1234;
    store.saveSession(session);
    const got = store.getSession('s1');
    assert.equal(got?.current.inputTokens, 1234);
});

test('appendHistory 滚动窗口最多 50 条', () => {
    const store = new TokenCountStore();
    store.saveSession(createEmptySession('s1', 'p1', 'm', 200000));
    for (let i = 0; i < 60; i += 1) {
        store.appendHistory('s1', {
            ts: new Date().toISOString(),
            phase: 'response',
            source: 'api',
            inputTokens: i
        });
    }
    const got = store.getSession('s1');
    assert.equal(got?.history.length, 50);
    assert.equal(got?.history[0].inputTokens, 10);
    assert.equal(got?.history[49].inputTokens, 59);
});

test('archiveSession 从内存中移除该桶', () => {
    const store = new TokenCountStore();
    store.saveSession(createEmptySession('s1', 'p1', 'm', 200000));
    assert.ok(store.getSession('s1'));
    store.archiveSession('s1');
    assert.equal(store.getSession('s1'), undefined);
});

test('pushArchivedSessionId 维持最多 10 条记录', () => {
    const store = new TokenCountStore();
    store.saveSession(createEmptySession('s1', 'p1', 'm', 200000));
    for (let i = 0; i < 15; i += 1) store.pushArchivedSessionId('s1', 'old-' + i);
    const got = store.getSession('s1');
    assert.equal(got?.compact.archivedSessionIds.length, 10);
    // 最新 push 的应在首位（unshift 语义）。
    assert.equal(got?.compact.archivedSessionIds[0], 'old-14');
});

test('pruneSessions: 超过 200 个桶时只保留最新的 200 个', () => {
    const store = new TokenCountStore();
    const internal = store as unknown as { pruneSessions: () => void };
    const now = Date.now();
    for (let i = 0; i < 201; i += 1) {
        const session = createEmptySession(`s${i}`, 'p1', 'm', 200000);
        store.saveSession(session);
        // saveSession 会把 lastUpdated 覆盖为当前时间，因此保存后再改；
        // 序号越大越新，裁剪后应保留 s1..s200。
        session.lastUpdated = new Date(now - (201 - i) * 1000).toISOString();
    }
    internal.pruneSessions();
    const kept = store.getAllSessions();
    assert.equal(Object.keys(kept).length, 200);
    assert.equal(kept.s0, undefined);
    assert.ok(kept.s200);
});

test('pruneSessions: lastUpdated 超过 30 天的桶被淘汰', () => {
    const store = new TokenCountStore();
    const internal = store as unknown as { pruneSessions: () => void };
    const stale = createEmptySession('stale', 'p1', 'm', 200000);
    store.saveSession(stale);
    // 同上：saveSession 内部会重置 lastUpdated，必须在保存后回写测试时间。
    stale.lastUpdated = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const fresh = createEmptySession('fresh', 'p1', 'm', 200000);
    store.saveSession(fresh);

    internal.pruneSessions();
    const kept = store.getAllSessions();
    assert.equal(kept.stale, undefined);
    assert.ok(kept.fresh);
});
