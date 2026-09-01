/** @file LlsTaskService 持久化接入单元测试（Node 内置 test runner）。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installVscodeStub } from './vscodeStub';

installVscodeStub();

// 安装 vscode 桩后再 require service，确保其顶层 import 'vscode' 命中桩。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LlsTaskService } = require('../service') as typeof import('../service');

import type { TaskFlowStore } from '../store';
import type { LlsTaskSnapshot } from '../types';

/** 记录 save/clear 调用的内存桩 store。 */
class FakeStore {
    public saved: LlsTaskSnapshot[] = [];
    public clearCount = 0;
    public loadResult: LlsTaskSnapshot | null = null;

    public async load(): Promise<LlsTaskSnapshot | null> {
        return this.loadResult;
    }

    public async save(snapshot: LlsTaskSnapshot): Promise<void> {
        this.saved.push(snapshot);
    }

    public async clear(): Promise<void> {
        this.clearCount += 1;
    }
}

/** 构造最小可用 configManager 桩。 */
function makeConfigManager() {
    return { getResolvedUiLanguage: () => 'en' } as unknown as ConstructorParameters<typeof LlsTaskService>[0];
}

/** 把 FakeStore 适配成 TaskFlowStore 的形参类型。 */
function asStore(store: FakeStore): TaskFlowStore {
    return store as unknown as TaskFlowStore;
}

/** 等待 service 内 250ms 防抖落盘触发。 */
function waitForPersist(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 320));
}

test('createWorkflow triggers a debounced save', async () => {
    const store = new FakeStore();
    const service = new LlsTaskService(makeConfigManager(), asStore(store));
    service.createWorkflow({
        title: 'Demo',
        summary: '',
        tasks: [{ id: '1', title: 'A', description: '', status: 'pending' }]
    });
    await waitForPersist();
    assert.ok(store.saved.length >= 1);
    assert.equal(store.saved[store.saved.length - 1].workflow?.title, 'Demo');
});

test('updateTaskStatuses saves the latest status', async () => {
    const store = new FakeStore();
    const service = new LlsTaskService(makeConfigManager(), asStore(store));
    service.createWorkflow({
        title: 'Demo',
        summary: '',
        tasks: [{ id: '1', title: 'A', description: '', status: 'pending' }]
    });
    service.updateTaskStatuses([{ taskId: '1', status: 'completed' }]);
    await waitForPersist();
    const last = store.saved[store.saved.length - 1];
    assert.equal(last.workflow?.tasks[0].status, 'completed');
});

test('clear delegates to store.clear', () => {
    const store = new FakeStore();
    const service = new LlsTaskService(makeConfigManager(), asStore(store));
    service.createWorkflow({
        title: 'Demo',
        summary: '',
        tasks: [{ id: '1', title: 'A', description: '', status: 'pending' }]
    });
    service.clear();
    assert.equal(store.clearCount, 1);
    assert.equal(service.hasActiveWorkflow(), false);
});

test('restore recovers an unfinished workflow', async () => {
    const store = new FakeStore();
    store.loadResult = {
        workflow: {
            title: 'Resumed',
            summary: '',
            tasks: [
                { id: '1', title: 'A', description: '', status: 'completed' },
                { id: '2', title: 'B', description: '', status: 'pending' }
            ]
        },
        updatedAt: Date.now()
    };
    const service = new LlsTaskService(makeConfigManager(), asStore(store));
    const restored = await service.restore();
    assert.equal(restored, true);
    assert.equal(service.hasActiveWorkflow(), true);
    assert.equal(service.getSnapshot().workflow?.title, 'Resumed');
});

test('restore skips a fully completed workflow', async () => {
    const store = new FakeStore();
    store.loadResult = {
        workflow: {
            title: 'Done',
            summary: '',
            tasks: [{ id: '1', title: 'A', description: '', status: 'completed' }]
        },
        updatedAt: Date.now()
    };
    const service = new LlsTaskService(makeConfigManager(), asStore(store));
    const restored = await service.restore();
    assert.equal(restored, false);
    assert.equal(service.hasActiveWorkflow(), false);
});

test('buildContinuePrompt returns empty when no pending or in_progress task remains', async () => {
    // 历史落盘数据里可能残留 blocked 任务：既不算全部完成，也没有可执行的下一步。
    // 若此时仍返回续推提示，调度器会无限续推。
    const store = new FakeStore();
    store.loadResult = {
        workflow: {
            title: 'Stuck',
            summary: '',
            tasks: [
                { id: '1', title: 'A', description: '', status: 'completed' },
                { id: '2', title: 'B', description: '', status: 'blocked' }
            ]
        },
        updatedAt: Date.now()
    };
    const service = new LlsTaskService(makeConfigManager(), asStore(store));
    await service.restore();
    assert.equal(service.isWorkflowCompleted(), false);
    assert.equal(service.buildContinuePrompt(), '');
});

test('createWorkflow downgrades an unsupported blocked status to pending', () => {
    const service = new LlsTaskService(makeConfigManager(), asStore(new FakeStore()));
    service.createWorkflow({
        title: 'Demo',
        summary: '',
        tasks: [{ id: '1', title: 'A', description: '', status: 'blocked' }]
    });
    assert.equal(service.getSnapshot().workflow?.tasks[0].status, 'pending');
});

test('updateTaskStatuses rejects the blocked status', () => {
    const service = new LlsTaskService(makeConfigManager(), asStore(new FakeStore()));
    service.createWorkflow({
        title: 'Demo',
        summary: '',
        tasks: [{ id: '1', title: 'A', description: '', status: 'pending' }]
    });
    const result = service.updateTaskStatuses([{ taskId: '1', status: 'blocked' }]);
    assert.equal(result.updated, 0);
    assert.equal(service.getSnapshot().workflow?.tasks[0].status, 'pending');
});

test('restore does not write back on load (no save during restore)', async () => {
    const store = new FakeStore();
    store.loadResult = {
        workflow: {
            title: 'Resumed',
            summary: '',
            tasks: [{ id: '1', title: 'A', description: '', status: 'pending' }]
        },
        updatedAt: Date.now()
    };
    const service = new LlsTaskService(makeConfigManager(), asStore(store));
    await service.restore();
    await waitForPersist();
    assert.equal(store.saved.length, 0);
});
