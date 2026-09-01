/**
 * @file dispatcher prompt 任务流方案断言。
 *
 * 任务流方案下，dispatcher（normal CLI）默认 appendSystemPrompt 只保留「主助手直接处理 +
 * Write 工具使用纪律」两部分，不再含任何 `@llsExpert` 文本路由、`ask_expert` 工具引导或
 * 「MUST delegate」式强制委托诱导。
 *
 * 本测试通过 vscode stub 驱动 ChatCliConfigService，断言 normal CLI 默认提示词满足上述约束。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub, type VscodeStubConfig } from '../../__tests__/testUtils/vscodeStub';

const stub: VscodeStubConfig = installVscodeStub({
    values: { claudeCodeConfigHelper: {} },
    inspect: { claudeCodeConfigHelper: {} },
    workspaceFolderFsPath: '/tmp/workspace'
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ChatCliConfigService } = require('../cliConfig') as typeof import('../cliConfig');

/**
 * 写入扩展配置到 stub。
 *
 * @param values  命名空间下 key->value。
 * @param inspect 命名空间下 key->inspect 结果。
 */
function setExtensionConfig(
    values: Record<string, unknown>,
    inspect: Record<string, { workspaceValue?: unknown; globalValue?: unknown }> = {}
): void {
    stub.values.claudeCodeConfigHelper = values;
    stub.inspect = { claudeCodeConfigHelper: inspect };
}

/**
 * 构造 ChatCliConfigService（带最小化 ConfigManager stub）。
 *
 * @param currentModel 当前模型；不传视为未配置。
 */
function makeService(currentModel?: { providerId: string; modelId: string }): InstanceType<typeof ChatCliConfigService> {
    const configManager = {
        getCurrentModel: () => currentModel,
        getProviderModel: (_providerId: string, modelId: string) => ({ modelId, contextLength: undefined })
    } as unknown as import('../../../configManager').ConfigManager;
    return new ChatCliConfigService(configManager);
}

/** 读取默认（未覆盖时）dispatcher 提示词。 */
async function readDefaultPrompt(): Promise<string> {
    setExtensionConfig({ 'chat.enabled': true });
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getRoutedConfigsWithRelayEnv(20001);
    return result.normal.appendSystemPrompt ?? '';
}

test('dispatcher prompt: 不含 @llsExpert 文本路由标记', async () => {
    const prompt = await readDefaultPrompt();
    assert.equal(prompt.includes('@llsExpert'), false);
});

test('dispatcher prompt: 不含「MUST delegate」式强制委托诱导', async () => {
    const prompt = await readDefaultPrompt();
    assert.equal(/MUST delegate/i.test(prompt), false);
});

test('dispatcher prompt: 不再引导 ask_expert 工具', async () => {
    const prompt = await readDefaultPrompt();
    assert.equal(prompt.includes('ask_expert'), false);
});

test('dispatcher prompt: 以「主助手直接处理」开头', async () => {
    const prompt = await readDefaultPrompt();
    assert.match(prompt, /primary engineering assistant/i);
    assert.match(prompt, /Handle requests directly by default/i);
});

test('dispatcher prompt: 含 Write 工具使用纪律', async () => {
    const prompt = await readDefaultPrompt();
    assert.match(prompt, /Write tool discipline/i);
    assert.ok(prompt.includes('seed segment'));
});
