/**
 * @file 任务流模型切换与还原单元测试。
 *
 * 覆盖 applyTaskFlowModelForContinue 的三条返回路径（未配置 / 已是目标模型 /
 * 需要切换）、切换失败时不抛错的降级行为，以及 restoreMainModelAfterTaskFlow
 * 的还原与键清空。
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} }, inspect: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const modelSelection = require('../modelSelection') as typeof import('../modelSelection');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtime = require('../../runtime') as typeof import('../../runtime');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CHAT_TASK_FLOW_MODEL_KEY } = require('../../constants') as typeof import('../../constants');

/** 任务流模型切换前保存原主模型的 workspaceState 键，与实现保持一致。 */
const PREVIOUS_MODEL_KEY = 'llsccai.taskFlow.previousMainModel';

/** 记录 setCurrentModel 调用的假配置管理器状态。 */
interface FakeManagerState {
    /** 当前主模型。 */
    current: { providerId: string; modelId: string };
    /** setCurrentModel 收到的全部调用。 */
    calls: { providerId: string; modelId: string }[];
    /** 已注册的可选模型 ID 列表。 */
    modelIds: string[];
}

/** 内存版 workspaceState，只实现 get/update 两个被用到的方法。 */
function makeMemoryWorkspaceState(): { store: Map<string, unknown> } & Record<string, unknown> {
    const store = new Map<string, unknown>();
    return {
        store,
        get: (key: string) => store.get(key),
        update: async (key: string, value: unknown) => {
            if (value === undefined) store.delete(key);
            else store.set(key, value);
        }
    };
}

/** 装配 runtime 的假 ConfigManager / ExtensionContext，返回可断言的状态对象。 */
function installFakes(options: { current: { providerId: string; modelId: string }; modelIds?: string[] }): {
    state: FakeManagerState;
    workspaceState: Map<string, unknown>;
} {
    const state: FakeManagerState = {
        current: options.current,
        calls: [],
        modelIds: options.modelIds ?? ['fast', 'strong']
    };
    const manager = {
        getCurrentModel: () => state.current,
        setCurrentModel: async (value: { providerId: string; modelId: string }) => {
            state.calls.push(value);
            state.current = value;
        },
        getProvider: (providerId: string) => providerId !== 'p1'
            ? undefined
            : {
                id: 'p1',
                name: '测试提供商',
                enabled: true,
                models: state.modelIds.map((modelId) => ({ modelId, displayName: modelId, enabled: true, isUserSelectable: true }))
            },
        listProviders: () => [],
        notifyChanged: () => undefined
    };
    runtime.setConfigManager(manager as unknown as Parameters<typeof runtime.setConfigManager>[0]);
    const workspaceState = makeMemoryWorkspaceState();
    runtime.setExtensionContext({ workspaceState } as unknown as Parameters<typeof runtime.setExtensionContext>[0]);
    return { state, workspaceState: workspaceState.store };
}

beforeEach(() => {
    modelSelection.configureModelSelection({
        postChatModelOptions: async () => undefined,
        postModelsSnapshot: async () => undefined,
        showChatToast: async () => undefined
    });
    stub.inspect = { claudeCodeConfigHelper: {} };
});

/** 设置工作区级任务流模型配置。 */
function setTaskFlowModel(value: string): void {
    stub.inspect = { claudeCodeConfigHelper: { [CHAT_TASK_FLOW_MODEL_KEY]: { workspaceValue: value } } };
}

test('未配置任务流模型时返回 skipped 且不切换', async () => {
    const { state, workspaceState } = installFakes({ current: { providerId: 'p1', modelId: 'strong' } });
    assert.equal(await modelSelection.applyTaskFlowModelForContinue(), 'skipped');
    assert.equal(state.calls.length, 0);
    assert.equal(workspaceState.size, 0);
});

test('当前已是任务流模型时返回 unchanged 且不重启', async () => {
    setTaskFlowModel('p1/fast');
    const { state, workspaceState } = installFakes({ current: { providerId: 'p1', modelId: 'fast' } });
    assert.equal(await modelSelection.applyTaskFlowModelForContinue(), 'unchanged');
    assert.equal(state.calls.length, 0);
    assert.equal(workspaceState.size, 0);
});

test('模型不同时切换并把原主模型存入 workspaceState', async () => {
    setTaskFlowModel('p1/fast');
    const { state, workspaceState } = installFakes({ current: { providerId: 'p1', modelId: 'strong' } });
    assert.equal(await modelSelection.applyTaskFlowModelForContinue(), 'switched');
    assert.deepEqual(state.calls, [{ providerId: 'p1', modelId: 'fast' }]);
    assert.equal(workspaceState.get(PREVIOUS_MODEL_KEY), 'p1/strong');
    assert.equal(modelSelection.hasPendingTaskFlowModelRestore(), true);
});

test('目标模型不存在时降级为 skipped 而不抛错', async () => {
    setTaskFlowModel('p1/missing');
    const { state } = installFakes({ current: { providerId: 'p1', modelId: 'strong' } });
    assert.equal(await modelSelection.applyTaskFlowModelForContinue(), 'skipped');
    assert.equal(state.calls.length, 0);
});

test('还原后主模型回到原值且 workspaceState 键被清空', async () => {
    setTaskFlowModel('p1/fast');
    const { state, workspaceState } = installFakes({ current: { providerId: 'p1', modelId: 'strong' } });
    await modelSelection.applyTaskFlowModelForContinue();
    await modelSelection.restoreMainModelAfterTaskFlow('test');
    assert.deepEqual(state.current, { providerId: 'p1', modelId: 'strong' });
    assert.equal(workspaceState.has(PREVIOUS_MODEL_KEY), false);
    assert.equal(modelSelection.hasPendingTaskFlowModelRestore(), false);
});

test('没有待还原记录时还原是空操作', async () => {
    const { state } = installFakes({ current: { providerId: 'p1', modelId: 'strong' } });
    await modelSelection.restoreMainModelAfterTaskFlow('test');
    assert.equal(state.calls.length, 0);
});
