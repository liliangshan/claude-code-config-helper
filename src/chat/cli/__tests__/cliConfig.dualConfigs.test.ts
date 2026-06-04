/**
 * @file getDualConfigsWithRelayEnv 返回结构按需专家化断言。
 *
 * 按需专家方案下，normal CLI 是唯一常驻进程；expert 不再常驻，仅在用户显式配置了
 * `chat.expert.appendSystemPrompt` 覆盖时才作为兼容字段返回，默认应为 undefined。
 * 同时验证 normal CLI 在 expert 可用时注入 askExpert MCP server，不可用时不注入。
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ASK_EXPERT_MCP_SERVER_NAME } = require('../../../expertMode/askExpertMcpServer') as typeof import('../../../expertMode/askExpertMcpServer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BROWSER_MCP_SERVER_NAME } = require('../../../browserTools/tools') as typeof import('../../../browserTools/tools');

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

test('dualConfigs: 默认不产出常驻 expert CLI（expert=undefined）', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(21001);
    // 按需专家：未配置 chat.expert.appendSystemPrompt 覆盖时不派生常驻 expert CLI。
    assert.equal(result.expert, undefined);
    assert.ok(result.normal);
});

test('dualConfigs: expert 可用时 normal CLI 注入 askExpert MCP server', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(21002);
    assert.ok(result.normal.mcpServers);
    assert.ok(result.normal.mcpServers?.[ASK_EXPERT_MCP_SERVER_NAME], 'expert 可用时应注入 askExpert MCP server');
});

test('dualConfigs: expert 不可用时 normal CLI 不注入 askExpert MCP server', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: false },
            'chat.expertMode.project.model': { workspaceValue: '' }
        }
    );
    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(21003);
    assert.equal(result.normal.mcpServers?.[ASK_EXPERT_MCP_SERVER_NAME], undefined);
});

test('dualConfigs: desktop 且开关开启时注入 browser MCP server', async () => {
    stub.uiKind = 1;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.browserTools.enabled': true,
        'chat.includeVscodeMcpJson': false
    });

    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(21005);

    assert.ok(result.normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], 'desktop 开关开启时应注入 browser MCP server');
    assert.equal(result.normal.mcpServers?.[BROWSER_MCP_SERVER_NAME]?.type, 'stdio');
    assert.equal(result.normal.mcpServers?.[BROWSER_MCP_SERVER_NAME]?.command, process.execPath);
});

test('dualConfigs: web 环境即使开关开启也不注入 browser MCP server', async () => {
    stub.uiKind = 2;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.browserTools.enabled': true,
        'chat.includeVscodeMcpJson': false
    });

    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(21006);

    assert.equal(result.normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], undefined);
    stub.uiKind = 1;
});

test('dualConfigs: desktop 默认注入 browser MCP server', async () => {
    stub.uiKind = 1;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.includeVscodeMcpJson': false
    });

    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(21007);

    assert.ok(result.normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], 'desktop 默认应注入 browser MCP server');
    assert.equal(result.normal.mcpServers?.[BROWSER_MCP_SERVER_NAME]?.env?.LLS_BROWSER_TOOL_RELAY_PORT, '21007');
});

test('dualConfigs: desktop 显式关闭时不注入 browser MCP server', async () => {
    stub.uiKind = 1;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.browserTools.enabled': false,
        'chat.includeVscodeMcpJson': false
    });

    const result = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getDualConfigsWithRelayEnv(21008);

    assert.equal(result.normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], undefined);
});
