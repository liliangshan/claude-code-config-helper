/**
 * @file ConfigManager.replaceProviderModels 单元测试：验证重新拉取模型时不覆盖本地配置。
 *
 * 覆盖四类场景：手工调过的参数保持不变、上游新模型按默认值追加、
 * 上游未返回的旧模型仍被保留、返回的合并统计数值正确。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub } from '../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ConfigManager } = require('../configManager') as typeof import('../configManager');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PROVIDERS_STATE_KEY } = require('../constants') as typeof import('../constants');

type ModelConfig = import('../types').ModelConfig;
type ProviderConfigWithoutSecrets = import('../types').ProviderConfigWithoutSecrets;
type ConfigManagerType = import('../configManager').ConfigManager;

/** 构造一条带默认高级参数的模型配置。 */
function makeModel(modelId: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
    return {
        modelId,
        displayName: modelId,
        contextLength: 0,
        maxTokens: 0,
        vision: false,
        toolCalling: true,
        temperature: 1,
        topP: 1,
        samplingMode: 'temperature',
        isUserSelectable: true,
        ...overrides
    };
}

/** 构造只用内存 globalState 的 ConfigManager，避免测试触碰真实扩展上下文。 */
function makeManager(models: ModelConfig[]): ConfigManagerType {
    const provider: ProviderConfigWithoutSecrets = {
        id: 'p1',
        name: '测试提供商',
        baseUrl: 'https://api.example.com',
        apiType: 'openai-compatible',
        authMode: 'api_key',
        models,
        enabled: true,
        autoFetchModels: true,
        createdAt: 1,
        updatedAt: 1,
        hasApiKey: true,
        customHeaders: []
    };
    const state = new Map<string, unknown>([[PROVIDERS_STATE_KEY, [provider]]]);
    const context = {
        globalState: {
            get: (key: string, fallback?: unknown) => state.get(key) ?? fallback,
            update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); }
        },
        // ConfigManager 构造时会把 settings.json 的文件监听器推进来。
        subscriptions: [] as Array<{ dispose(): void }>
    } as unknown as import('vscode').ExtensionContext;
    return new ConfigManager(context);
}

/** 验证默认关闭、工作区隔离、重载保留及旧全局值不继承。 */
test('子智能体开关默认关闭且仅在当前工作区保持选择', async () => {
    /** 创建独立工作区存储，模拟已有全局开启值。 */
    function makeContext(): import('vscode').ExtensionContext {
        const state = new Map<string, unknown>();
        return {
            globalState: {
                /** 旧全局开启值不得影响工作区默认值。 */
                get: () => true,
                /** 禁止开关写入全局存储。 */
                update: async () => { assert.fail('不得写入 globalState'); }
            },
            workspaceState: {
                /** 同工作区重载共享存储。 */
                get: (key: string) => state.get(key),
                /** 模拟工作区持久化。 */
                update: async (key: string, value: unknown) => { state.set(key, value); }
            },
            subscriptions: []
        } as unknown as import('vscode').ExtensionContext;
    }
    const context = makeContext();
    const first = new ConfigManager(context);
    const other = new ConfigManager(makeContext());
    assert.equal(first.getChatSubagentsEnabled(), false);
    await first.setChatSubagentsEnabled(true);
    const restored = new ConfigManager(context);
    assert.equal(restored.getChatSubagentsEnabled(), true);
    assert.equal(other.getChatSubagentsEnabled(), false);
    await assert.rejects(restored.setChatSubagentsEnabled('false' as unknown as boolean));
    assert.equal(restored.getChatSubagentsEnabled(), true);
    await restored.setChatSubagentsEnabled(false);
    assert.equal(first.getChatSubagentsEnabled(), false);
});

test('replaceProviderModels: 手工调过的参数在重新拉取后保持不变', async () => {
    const manager = makeManager([
        makeModel('gpt-x', { displayName: '我的模型', maxTokens: 8000, contextLength: 128000, vision: true })
    ]);

    await manager.replaceProviderModels('p1', [makeModel('gpt-x', { displayName: 'GPT X' })]);

    const model = manager.getProvider('p1')?.models[0];
    assert.equal(model?.displayName, '我的模型');
    assert.equal(model?.maxTokens, 8000);
    assert.equal(model?.contextLength, 128000);
    assert.equal(model?.vision, true);
});

test('replaceProviderModels: 显示名未改过时采纳上游显示名', async () => {
    const manager = makeManager([makeModel('gpt-x')]);

    await manager.replaceProviderModels('p1', [makeModel('gpt-x', { displayName: 'GPT X' })]);

    assert.equal(manager.getProvider('p1')?.models[0].displayName, 'GPT X');
});

test('replaceProviderModels: 上游新模型按默认值追加且旧模型顺序在前', async () => {
    const manager = makeManager([makeModel('old-a', { maxTokens: 4096 })]);

    await manager.replaceProviderModels('p1', [makeModel('new-z'), makeModel('old-a'), makeModel('new-b')]);

    const models = manager.getProvider('p1')?.models ?? [];
    assert.deepEqual(models.map((model) => model.modelId), ['old-a', 'new-b', 'new-z']);
    assert.equal(models[0].maxTokens, 4096);
    assert.equal(models[1].maxTokens, 0);
});

test('replaceProviderModels: 上游未返回的旧模型会被移除', async () => {
    const manager = makeManager([makeModel('kept-a', { maxTokens: 4096 }), makeModel('gone-b')]);

    await manager.replaceProviderModels('p1', [makeModel('kept-a')]);

    const models = manager.getProvider('p1')?.models ?? [];
    assert.deepEqual(models.map((model) => model.modelId), ['kept-a']);
    assert.equal(models[0].maxTokens, 4096);
});

test('replaceProviderModels: 返回的合并统计数值正确', async () => {
    const manager = makeManager([makeModel('a'), makeModel('b')]);

    const stats = await manager.replaceProviderModels('p1', [makeModel('a'), makeModel('c')]);

    assert.deepEqual(stats, { added: 1, kept: 1, removed: 1, total: 2 });
});

test('normalizeModel: 旧数据缺少 cacheMode 时补齐为 auto', async () => {
    const legacy = makeModel('legacy');
    delete (legacy as Partial<ModelConfig>).cacheMode;
    const manager = makeManager([legacy]);

    await manager.replaceProviderModels('p1', [makeModel('legacy')]);

    assert.equal(manager.getProvider('p1')?.models[0].cacheMode, 'auto');
});

test('normalizeModel: 非法 cacheMode 归一为 auto', async () => {
    const manager = makeManager([makeModel('weird', { cacheMode: 'nonsense' as ModelConfig['cacheMode'] })]);

    await manager.replaceProviderModels('p1', [makeModel('weird')]);

    assert.equal(manager.getProvider('p1')?.models[0].cacheMode, 'auto');
});

test('replaceProviderModels: 本地 passthrough 设置不会被上游默认值覆盖', async () => {
    const manager = makeManager([makeModel('gpt-x', { cacheMode: 'passthrough' })]);

    await manager.replaceProviderModels('p1', [makeModel('gpt-x')]);

    assert.equal(manager.getProvider('p1')?.models[0].cacheMode, 'passthrough');
});

test('normalizeModel: 旧数据缺少 reasoningMode 时补齐为 passthrough', async () => {
    const manager = makeManager([makeModel('legacy')]);

    await manager.replaceProviderModels('p1', [makeModel('legacy')]);

    assert.equal(manager.getProvider('p1')?.models[0].reasoningMode, 'passthrough');
});

test('normalizeModel: 非法 reasoningMode 归一为 passthrough', async () => {
    const manager = makeManager([makeModel('weird', { reasoningMode: 'auto' as ModelConfig['reasoningMode'] })]);

    await manager.replaceProviderModels('p1', [makeModel('weird')]);

    assert.equal(manager.getProvider('p1')?.models[0].reasoningMode, 'passthrough');
});

test('replaceProviderModels: 本地 reasoningMode=off 不会被默认值覆盖', async () => {
    const manager = makeManager([makeModel('gpt-r', { reasoningMode: 'off' })]);

    await manager.replaceProviderModels('p1', [makeModel('gpt-r')]);

    assert.equal(manager.getProvider('p1')?.models[0].reasoningMode, 'off');
});

test('normalizeModel: 显式缓存旧数据和非法值默认关闭', async () => {
    const legacy = makeModel('legacy');
    delete (legacy as Partial<ModelConfig>).explicitCache;
    const invalid = makeModel('invalid', { explicitCache: 'true' as unknown as boolean });
    const manager = makeManager([legacy, invalid]);

    await manager.replaceProviderModels('p1', [makeModel('legacy'), makeModel('invalid')]);

    const models = manager.getProvider('p1')?.models ?? [];
    assert.equal(models.find((model) => model.modelId === 'legacy')?.explicitCache, false);
    assert.equal(models.find((model) => model.modelId === 'invalid')?.explicitCache, false);
});

test('replaceProviderModels: 显式缓存 true 和 false 均保留且新模型默认关闭', async () => {
    const manager = makeManager([
        makeModel('enabled-cache', { explicitCache: true }),
        makeModel('disabled-cache', { explicitCache: false })
    ]);

    await manager.replaceProviderModels('p1', [
        makeModel('enabled-cache', { explicitCache: false }),
        makeModel('disabled-cache', { explicitCache: true }),
        makeModel('new-model', { explicitCache: true })
    ]);

    const models = manager.getProvider('p1')?.models ?? [];
    assert.equal(models.find((model) => model.modelId === 'enabled-cache')?.explicitCache, true);
    assert.equal(models.find((model) => model.modelId === 'disabled-cache')?.explicitCache, false);
    assert.equal(models.find((model) => model.modelId === 'new-model')?.explicitCache, false);
});

test('replaceProviders 与导入导出按提供商隔离显式缓存配置', async () => {
    const manager = makeManager([makeModel('same-id', { explicitCache: true })]);
    const first = manager.getProvider('p1')!;
    const second: ProviderConfigWithoutSecrets = {
        ...first,
        id: 'p2',
        name: '第二提供商',
        models: [makeModel('same-id', { explicitCache: false })]
    };

    await manager.replaceProviders([first, second]);
    const exported = manager.exportConfig();
    assert.equal(exported.providers.find((provider) => provider.id === 'p1')?.models[0].explicitCache, true);
    assert.equal(exported.providers.find((provider) => provider.id === 'p2')?.models[0].explicitCache, false);

    await manager.importConfig(exported);
    assert.equal(manager.getProvider('p1')?.models[0].explicitCache, true);
    assert.equal(manager.getProvider('p2')?.models[0].explicitCache, false);
});
