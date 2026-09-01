/**
 * @file getRoutedConfigsWithRelayEnv 返回结构断言（browser MCP 注入部分）。
 *
 * 任务流方案下 normal CLI 是唯一常驻进程，本文件验证 normal CLI 对 browser
 * MCP server 的注入策略：desktop 且开关开启时注入、web 环境不注入、默认注入、
 * 显式关闭时不注入。
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
        getCurrentModel: () => currentModel,
        getProviderModel: (_providerId: string, modelId: string) => ({ modelId, contextLength: undefined })
    } as unknown as import('../../../configManager').ConfigManager;
    return new ChatCliConfigService(configManager);
}

test('routedConfigs: desktop 且开关开启时注入 browser MCP server', async () => {
    stub.uiKind = 1;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.browserTools.enabled': true,
        'chat.includeVscodeMcpJson': false
    });

    const { normal } = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getRoutedConfigsWithRelayEnv(21005);

    assert.ok(normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], 'desktop 开关开启时应注入 browser MCP server');
    assert.equal(normal.mcpServers?.[BROWSER_MCP_SERVER_NAME]?.type, 'stdio');
    assert.equal(normal.mcpServers?.[BROWSER_MCP_SERVER_NAME]?.command, process.execPath);
});

test('routedConfigs: web 环境即使开关开启也不注入 browser MCP server', async () => {
    stub.uiKind = 2;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.browserTools.enabled': true,
        'chat.includeVscodeMcpJson': false
    });

    const { normal } = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getRoutedConfigsWithRelayEnv(21006);

    assert.equal(normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], undefined);
    stub.uiKind = 1;
});

test('routedConfigs: desktop 默认注入 browser MCP server', async () => {
    stub.uiKind = 1;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.includeVscodeMcpJson': false
    });

    const { normal } = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getRoutedConfigsWithRelayEnv(21007);

    assert.ok(normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], 'desktop 默认应注入 browser MCP server');
    assert.equal(normal.mcpServers?.[BROWSER_MCP_SERVER_NAME]?.env?.LLS_BROWSER_TOOL_RELAY_PORT, '21007');
});

test('routedConfigs: desktop 显式关闭时不注入 browser MCP server', async () => {
    stub.uiKind = 1;
    setExtensionConfig({
        'chat.enabled': true,
        'chat.browserTools.enabled': false,
        'chat.includeVscodeMcpJson': false
    });

    const { normal } = await makeService({ providerId: 'pNormal', modelId: 'mNormal' }).getRoutedConfigsWithRelayEnv(21008);

    assert.equal(normal.mcpServers?.[BROWSER_MCP_SERVER_NAME], undefined);
});
