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
        transformThink: false,
        preserveReasoningContent: false,
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
        }
    } as unknown as import('vscode').ExtensionContext;
    return new ConfigManager(context);
}

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
