/** @file TaskFlowStore 持久化层单元测试（Node 内置 test runner）。 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { installVscodeStub, workspaceFolders } from './vscodeStub';

installVscodeStub();

// 必须在安装桩之后再 require store，确保其顶层 import 'vscode' 命中桩。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TaskFlowStore } = require('../store') as typeof import('../store');

import type { LlsTaskSnapshot } from '../types';

/**
 * 创建临时目录并设为唯一工作区根，返回该根与对应 task-flow.json 路径。
 *
 * @returns 临时根目录与 .LLSOAI/task-flow.json 绝对路径。
 */
async function withTempWorkspace(): Promise<{ root: string; file: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llstask-store-'));
    workspaceFolders.length = 0;
    workspaceFolders.push({ uri: { fsPath: root } });
    return { root, file: path.join(root, '.LLSOAI', 'task-flow.json') };
}

/** 构造一个最小可用的未完成任务流快照。 */
function makeSnapshot(): LlsTaskSnapshot {
    return {
        workflow: {
            title: 'Demo',
            summary: 'demo flow',
            tasks: [
                { id: '1', title: 'A', description: 'desc A', status: 'in_progress' },
                { id: '2', title: 'B', description: '', status: 'pending' }
            ]
        },
        planningDocumentPath: 'PLAN.md',
        originalUserPrompt: 'do the thing',
        updatedAt: 1748592000000
    };
}

test('save then load round-trips the snapshot', async () => {
    const { root } = await withTempWorkspace();
    const store = new TaskFlowStore();
    const snapshot = makeSnapshot();
    await store.save(snapshot);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded?.workflow?.title, 'Demo');
    assert.equal(loaded?.workflow?.tasks.length, 2);
    assert.equal(loaded?.workflow?.tasks[0].status, 'in_progress');
    assert.equal(loaded?.planningDocumentPath, 'PLAN.md');
    assert.equal(loaded?.originalUserPrompt, 'do the thing');
    await fs.rm(root, { recursive: true, force: true });
});

test('load returns null when file is missing', async () => {
    const { root } = await withTempWorkspace();
    const store = new TaskFlowStore();
    const loaded = await store.load();
    assert.equal(loaded, null);
    await fs.rm(root, { recursive: true, force: true });
});

test('load returns null and does not throw on corrupt JSON', async () => {
    const { root, file } = await withTempWorkspace();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not valid json', 'utf-8');
    const store = new TaskFlowStore();
    const loaded = await store.load();
    assert.equal(loaded, null);
    await fs.rm(root, { recursive: true, force: true });
});

test('load returns null when tasks field is missing', async () => {
    const { root, file } = await withTempWorkspace();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
        file,
        JSON.stringify({ version: 1, savedAt: new Date().toISOString(), snapshot: { workflow: {} } }),
        'utf-8'
    );
    const store = new TaskFlowStore();
    const loaded = await store.load();
    assert.equal(loaded, null);
    await fs.rm(root, { recursive: true, force: true });
});

test('clear removes the file and is safe when file is absent', async () => {
    const { root, file } = await withTempWorkspace();
    const store = new TaskFlowStore();
    await store.save(makeSnapshot());
    await store.clear();
    await assert.rejects(fs.access(file));
    // 再次 clear 不应抛出。
    await store.clear();
    await fs.rm(root, { recursive: true, force: true });
});
