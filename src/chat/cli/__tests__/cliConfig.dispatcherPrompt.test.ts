/**
 * @file dispatcher prompt 按需专家化断言。
 *
 * 按需专家方案下，dispatcher（normal CLI）默认 appendSystemPrompt 不再用
 * `@llsExpert` 文本路由，也不再含「MUST delegate」式强制委托诱导，而是改为
 * 「可选 ask_expert 工具，仅在显式请求或确实无法决策时调用」的软引导。
 *
 * 本测试通过 vscode stub 驱动 ChatCliConfigService，断言 normal CLI 在
 * expertMode 启用时的 appendSystemPrompt 文案满足上述约束。
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
        getCurrentModel: () => currentModel
    } as unknown as import('../../../configManager').ConfigManager;
    return new ChatCliConfigService(configManager);
}

test('dispatcher prompt: 专家启用时不再含 @llsExpert 文本路由标记', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(20001);
    const prompt = result.normal.appendSystemPrompt ?? '';
    assert.equal(prompt.includes('@llsExpert'), false);
});

test('dispatcher prompt: 不含「MUST delegate」式强制委托诱导', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(20002);
    const prompt = result.normal.appendSystemPrompt ?? '';
    assert.equal(/MUST delegate/i.test(prompt), false);
});

test('dispatcher prompt: 改为软引导 ask_expert 工具（仅显式或无法决策时调用）', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(20003);
    const prompt = result.normal.appendSystemPrompt ?? '';
    assert.match(prompt, /ask_expert/);
    assert.match(prompt, /no conversation history|NO conversation history/i);
});

test('dispatcher prompt: 专家关闭时仍不含 @llsExpert，且不诱导调用专家', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: false },
            'chat.expertMode.project.model': { workspaceValue: '' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(20004);
    const prompt = result.normal.appendSystemPrompt ?? '';
    assert.equal(prompt.includes('@llsExpert'), false);
});

test('dispatcher prompt: 要求先自己检查上下文，不把专家当常规步骤', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(20005);
    const prompt = result.normal.appendSystemPrompt ?? '';
    assert.match(prompt, /rare\s+escalation\s+path/i);
    assert.match(prompt, /first inspect the relevant local context yourself/i);
    assert.match(prompt, /normal debugging, test failures, compile errors, or refactors/i);
});
