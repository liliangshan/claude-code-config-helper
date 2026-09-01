/**
 * @file `ChatCliConfigService.getRoutedConfigsWithRelayEnv` 单元测试。
 *
 * 覆盖任务流模型方案下「normal 单路 ChatCliConfig 派生」的核心规则：
 * 1. normal 绑定 path-based `ANTHROPIC_BASE_URL`（`/normal`）与 relay 端口环境变量；
 * 2. 配置了 contextLength 时注入 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，未配置时不注入；
 * 3. 默认 `appendSystemPrompt` 含 Write 工具使用纪律、不含任何 ask_expert / @llsPlanTask 诱导；
 * 4. `chat.dispatcher.appendSystemPrompt` 非空时覆盖默认提示词文案；
 * 5. MCP servers（vscode 等内置桥）随 relayPort 注入并被 normal 继承。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub, type VscodeStubConfig } from './testUtils/vscodeStub';

// vscode stub 必须在导入 cliConfig 之前装好，否则模块顶层 `import * as vscode`
// 会拿到真实 vscode（在 node:test 下会抛模块未找到错误）。
const stub: VscodeStubConfig = installVscodeStub({
    values: { claudeCodeConfigHelper: {} },
    inspect: { claudeCodeConfigHelper: {} },
    workspaceFolderFsPath: '/tmp/workspace'
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ChatCliConfigService } = require('../cli/cliConfig') as typeof import('../cli/cliConfig');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VSCODE_MCP_SERVER_NAME } = require('../../vscodeTools/tools') as typeof import('../../vscodeTools/tools');

/**
 * 把指定的扩展配置写入 stub，模拟 VS Code 用户配置变更。
 *
 * @param values 命名空间下的 key -> value 字典。
 * @param inspect 命名空间下的 key -> inspect 结果字典。
 */
function setExtensionConfig(
    values: Record<string, unknown>,
    inspect: Record<string, { workspaceValue?: unknown; globalValue?: unknown }> = {}
): void {
    stub.values.claudeCodeConfigHelper = values;
    stub.inspect = { claudeCodeConfigHelper: inspect };
}

/**
 * 构造一个 ChatCliConfigService 实例，附带最小化的 ConfigManager stub。
 *
 * @param currentModel 当前模型 providerId/modelId；不传则视为未配置。
 * @param contextLength 模型手填的上下文长度；不传则视为未配置。
 * @returns 可直接调用 getRoutedConfigsWithRelayEnv 的服务实例。
 */
function makeService(
    currentModel?: { providerId: string; modelId: string },
    contextLength?: number
): InstanceType<typeof ChatCliConfigService> {
    const configManager = {
        getCurrentModel: () => currentModel,
        getProviderModel: (_providerId: string, modelId: string) => ({ modelId, contextLength })
    } as unknown as import('../../configManager').ConfigManager;
    return new ChatCliConfigService(configManager);
}

test('getRoutedConfigsWithRelayEnv: normal 绑定 path-based BASE_URL 与 relay 端口', async () => {
    setExtensionConfig({ 'chat.enabled': true });
    const service = makeService({ providerId: 'p1', modelId: 'm1' });
    const { normal } = await service.getRoutedConfigsWithRelayEnv(12345);

    assert.ok(normal);
    assert.equal(normal.cliEnv.LLS_CHAT_ROLE, undefined);
    assert.equal(normal.cliEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:12345/normal');
    assert.ok(normal.mcpServers?.[VSCODE_MCP_SERVER_NAME]);
    assert.equal(normal.mcpServers?.[VSCODE_MCP_SERVER_NAME]?.env?.LLS_VSCODE_TOOL_RELAY_PORT, '12345');
});

test('getRoutedConfigsWithRelayEnv: 配置了 contextLength 时注入 CLAUDE_CODE_MAX_CONTEXT_TOKENS', async () => {
    // CLI 不认识扩展的 provider 配置，不注入就会按内置默认窗口自行推算自动压缩线。
    setExtensionConfig({ 'chat.enabled': true });
    const service = makeService({ providerId: 'p1', modelId: 'm1' }, 200000);
    const { normal } = await service.getRoutedConfigsWithRelayEnv(12345);

    assert.equal(normal.cliEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '200000');
});

test('getRoutedConfigsWithRelayEnv: 未配置 contextLength 时不注入 CLAUDE_CODE_MAX_CONTEXT_TOKENS', async () => {
    setExtensionConfig({ 'chat.enabled': true });
    const service = makeService({ providerId: 'p1', modelId: 'm1' });
    const { normal } = await service.getRoutedConfigsWithRelayEnv(12345);

    assert.equal(normal.cliEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test('getRoutedConfigsWithRelayEnv: 默认 dispatcher 提示词含 Write 纪律且无 ask_expert/@llsPlanTask', async () => {
    setExtensionConfig({ 'chat.enabled': true });
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const { normal } = await service.getRoutedConfigsWithRelayEnv(9999);

    assert.ok(typeof normal.appendSystemPrompt === 'string');
    assert.ok(normal.appendSystemPrompt?.includes('Write tool discipline'));
    assert.ok(normal.appendSystemPrompt?.includes('seed segment'));
    assert.equal(normal.appendSystemPrompt?.includes('ask_expert'), false);
    assert.equal(normal.appendSystemPrompt?.includes('@llsExpert'), false);
    assert.equal(normal.appendSystemPrompt?.includes('@llsPlanTask'), false);
});

test('getRoutedConfigsWithRelayEnv: dispatcher override 覆盖默认提示词文案', async () => {
    setExtensionConfig({
        'chat.enabled': true,
        'chat.dispatcher.appendSystemPrompt': 'custom dispatcher prompt'
    });
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const { normal } = await service.getRoutedConfigsWithRelayEnv(9996);

    assert.equal(normal.appendSystemPrompt, 'custom dispatcher prompt');
});

test('getRoutedConfigsWithRelayEnv: normal 继承用户配置的 MCP servers', async () => {
    setExtensionConfig({
        'chat.enabled': true,
        'chat.includeVscodeMcpJson': false,
        'chat.mcpServers': {
            memory: { type: 'stdio', command: 'memory-server' }
        },
        'chat.skills': ['reviewer']
    });
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const { normal } = await service.getRoutedConfigsWithRelayEnv(9997);

    assert.ok(normal.mcpServers?.memory);
    assert.deepEqual(normal.skills, ['reviewer']);
});
