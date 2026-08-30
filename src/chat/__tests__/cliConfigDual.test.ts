/**
 * @file `ChatCliConfigService.getDualConfigsWithRelayEnv` 单元测试。
 *
 * 覆盖双 CLI 路由方案下「按需派生 normal / expert 两条 ChatCliConfig」的核心规则：
 * 1. expertMode 关闭（enabled=false 或 model=''）时只产出 normal，expert=undefined；
 * 2. 启用时产出两条配置，expert 覆盖 `--model` 与 `ANTHROPIC_MODEL`，并强制 `strictMcpConfig=true`；
 * 3. 两条配置都剥除残留的 `llsExpert` MCP server（兜底兼容历史 settings.json）；
 * 4. normal / expert 各自绑定不同的 path-based `ANTHROPIC_BASE_URL` 与默认 `appendSystemPrompt`；
 * 5. `chat.dispatcher.appendSystemPrompt` / `chat.expert.appendSystemPrompt` 非空时
 *    覆盖默认提示词文案。
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
const { ASK_EXPERT_MCP_SERVER_NAME } = require('../../expertMode/askExpertMcpServer') as typeof import('../../expertMode/askExpertMcpServer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VSCODE_MCP_SERVER_NAME } = require('../../vscodeTools/tools') as typeof import('../../vscodeTools/tools');
type ChatCliConfig = import('../cli/types').ChatCliConfig;

/**
 * 把指定的扩展配置写入 stub，模拟 VS Code 用户配置变更。
 *
 * @param values 命名空间下的 key -> value 字典。
 * @param inspect 命名空间下的 key -> inspect 结果字典；用于 expertConfig 的 inspect() 调用。
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
 * @returns 可直接调用 getDualConfigsWithRelayEnv 的服务实例。
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

// ---------------------------------------------------------------------------
// 关闭专家时只产出 normal
// ---------------------------------------------------------------------------

test('getDualConfigsWithRelayEnv: expertMode 关闭时只产出 normal', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: false },
            'chat.expertMode.project.model': { workspaceValue: '' },
            'chat.expertMode.global.enabled': { globalValue: false },
            'chat.expertMode.global.model': { globalValue: '' }
        }
    );
    const service = makeService({ providerId: 'p1', modelId: 'm1' });
    const result = await service.getDualConfigsWithRelayEnv(12345);

    assert.equal(result.expert, undefined);
    assert.ok(result.normal);
    assert.equal(result.normal.cliEnv.LLS_CHAT_ROLE, undefined);
    assert.equal(result.normal.cliEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:12345/normal');
    assert.ok(typeof result.normal.appendSystemPrompt === 'string' && result.normal.appendSystemPrompt.includes('ask_expert'));
    assert.equal(result.normal.mcpServers?.[ASK_EXPERT_MCP_SERVER_NAME], undefined);
    assert.ok(result.normal.mcpServers?.[VSCODE_MCP_SERVER_NAME]);
    assert.equal(result.normal.mcpServers?.[VSCODE_MCP_SERVER_NAME]?.env?.LLS_VSCODE_TOOL_RELAY_PORT, '12345');
    // 未启用方案模型时 dispatcher 提示词不得出现 `@llsPlanTask` 诱导。
    assert.equal(result.normal.appendSystemPrompt?.includes('@llsPlanTask'), false);
    assert.equal(result.normal.appendSystemPrompt?.includes('Routing priority'), false);
});

test('getDualConfigsWithRelayEnv: 配置了 contextLength 时注入 CLAUDE_CODE_MAX_CONTEXT_TOKENS', async () => {
    // CLI 不认识扩展的 provider 配置，不注入就会按内置默认窗口自行推算自动压缩线。
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: false },
            'chat.expertMode.project.model': { workspaceValue: '' },
            'chat.expertMode.global.enabled': { globalValue: false },
            'chat.expertMode.global.model': { globalValue: '' }
        }
    );
    const service = makeService({ providerId: 'p1', modelId: 'm1' }, 200000);
    const result = await service.getDualConfigsWithRelayEnv(12345);

    assert.equal(result.normal?.cliEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '200000');
});

test('getDualConfigsWithRelayEnv: 未配置 contextLength 时不注入 CLAUDE_CODE_MAX_CONTEXT_TOKENS', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: false },
            'chat.expertMode.project.model': { workspaceValue: '' },
            'chat.expertMode.global.enabled': { globalValue: false },
            'chat.expertMode.global.model': { globalValue: '' }
        }
    );
    const service = makeService({ providerId: 'p1', modelId: 'm1' });
    const result = await service.getDualConfigsWithRelayEnv(12345);

    assert.equal(result.normal?.cliEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test('getDualConfigsWithRelayEnv: planMode 关闭时 dispatcher 提示词不含 @llsPlanTask', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' },
            'chat.planMode.project.enabled': { workspaceValue: false },
            'chat.planMode.project.model': { workspaceValue: '' }
        }
    );
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const result = await service.getDualConfigsWithRelayEnv(12346);

    assert.ok(result.normal.appendSystemPrompt?.includes('ask_expert'));
    assert.equal(result.normal.appendSystemPrompt?.includes('@llsPlanTask'), false);
    assert.equal(result.normal.appendSystemPrompt?.includes('Routing priority'), false);
    assert.equal(result.normal.appendSystemPrompt?.includes('HIGHEST PRIORITY plan/review'), false);
});

test('getDualConfigsWithRelayEnv: expertMode model 为空时也按关闭处理', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: '' },
            'chat.expertMode.global.enabled': { globalValue: undefined },
            'chat.expertMode.global.model': { globalValue: '' }
        }
    );
    const service = makeService({ providerId: 'p1', modelId: 'm1' });
    const result = await service.getDualConfigsWithRelayEnv(12345);
    assert.equal(result.expert, undefined);
});

// ---------------------------------------------------------------------------
// 启用专家时同时产出 normal / expert
// ---------------------------------------------------------------------------

test('getDualConfigsWithRelayEnv: 启用专家时产出两条配置且 expert 覆盖 model', async () => {
    setExtensionConfig(
        { 'chat.enabled': true },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' },
            'chat.expertMode.global.enabled': { globalValue: undefined },
            'chat.expertMode.global.model': { globalValue: undefined }
        }
    );
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const result = await service.getDualConfigsWithRelayEnv(9999);

    assert.equal(result.expert, undefined);
    assert.ok(result.normal.mcpServers?.[ASK_EXPERT_MCP_SERVER_NAME]);
    assert.equal(result.normal.mcpServers?.[ASK_EXPERT_MCP_SERVER_NAME]?.args?.[0], '__LLS_ASK_EXPERT_PLACEHOLDER__');
    assert.ok(result.normal.mcpServers?.[VSCODE_MCP_SERVER_NAME]);
    assert.equal(result.normal.mcpServers?.[VSCODE_MCP_SERVER_NAME]?.env?.LLS_VSCODE_TOOL_RELAY_PORT, '9999');

    assert.equal(result.normal.model, 'pNormal/mNormal');
    assert.equal(result.normal.cliEnv.LLS_CHAT_ROLE, undefined);

    // dispatcher 默认提示词应包含 Write 工具使用纪律
    assert.ok(result.normal.appendSystemPrompt?.includes('Write tool discipline'));
    assert.ok(result.normal.appendSystemPrompt?.includes('seed segment'));
});

// ---------------------------------------------------------------------------
// 残留 llsExpert MCP 应被剥除
// ---------------------------------------------------------------------------

test('getDualConfigsWithRelayEnv: 残留 llsExpert MCP 应在两条配置上都被剥除', async () => {
    setExtensionConfig(
        {
            'chat.enabled': true,
            'chat.includeVscodeMcpJson': false,
            'chat.mcpServers': {
                llsExpert: { type: 'stdio', command: 'node', args: ['legacy.js'] },
                memory: { type: 'stdio', command: 'memory-server' }
            }
        },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pX/mX' }
        }
    );
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const result = await service.getDualConfigsWithRelayEnv(7777);

    assert.ok(result.normal.mcpServers);
    assert.equal(result.normal.mcpServers?.llsExpert, undefined);
    assert.ok(result.normal.mcpServers?.memory);
    assert.ok(result.normal.mcpServers?.[ASK_EXPERT_MCP_SERVER_NAME]);
    assert.ok(result.normal.mcpServers?.[VSCODE_MCP_SERVER_NAME]);
});

// ---------------------------------------------------------------------------
// dispatcher / expert appendSystemPrompt 用户覆盖
// ---------------------------------------------------------------------------

test('getDualConfigsWithRelayEnv: 启用 plan/review 时产出四路配置', async () => {
    setExtensionConfig(
        {
            'chat.enabled': true,
            'chat.plan.appendSystemPrompt': 'custom plan prompt',
            'chat.review.appendSystemPrompt': 'custom review prompt'
        },
        {
            'chat.expertMode.project.enabled': { workspaceValue: true },
            'chat.expertMode.project.model': { workspaceValue: 'pExpert/mExpert' },
            'chat.planMode.project.enabled': { workspaceValue: true },
            'chat.planMode.project.model': { workspaceValue: 'pPlan/mPlan' },
            'chat.reviewMode.project.enabled': { workspaceValue: true },
            'chat.reviewMode.project.model': { workspaceValue: 'pReview/mReview' }
        }
    );
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const result = await service.getDualConfigsWithRelayEnv(9998);

    assert.equal(result.normal.cliEnv.LLS_CHAT_ROLE, undefined);
    assert.equal(result.normal.cliEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9998/normal');
    assert.ok(result.normal.appendSystemPrompt?.includes('@llsPlanTask'));

    assert.equal(result.expert, undefined);
    assert.ok(result.normal.mcpServers?.[ASK_EXPERT_MCP_SERVER_NAME]);

    const plan = result.plan as ChatCliConfig;
    assert.equal(plan.model, 'pPlan/mPlan');
    assert.equal(plan.cliEnv.ANTHROPIC_MODEL, 'pPlan/mPlan');
    assert.equal(plan.cliEnv.LLS_CHAT_ROLE, undefined);
    assert.equal(plan.cliEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9998/plan');
    assert.equal(plan.strictMcpConfig, true);
    assert.equal(plan.appendSystemPrompt, 'custom plan prompt');

    const review = result.review as ChatCliConfig;
    assert.equal(review.model, 'pReview/mReview');
    assert.equal(review.cliEnv.ANTHROPIC_MODEL, 'pReview/mReview');
    assert.equal(review.cliEnv.LLS_CHAT_ROLE, undefined);
    assert.equal(review.cliEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9998/review');
    assert.equal(review.strictMcpConfig, true);
    assert.equal(review.appendSystemPrompt, 'custom review prompt');
});

test('getDualConfigsWithRelayEnv: dispatcher override 仍追加 plan/review 协议', async () => {
    setExtensionConfig(
        {
            'chat.enabled': true,
            'chat.dispatcher.appendSystemPrompt': 'custom dispatcher prompt'
        },
        {
            'chat.planMode.project.enabled': { workspaceValue: true },
            'chat.planMode.project.model': { workspaceValue: 'pPlan/mPlan' }
        }
    );
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const result = await service.getDualConfigsWithRelayEnv(9996);

    assert.ok(result.normal.appendSystemPrompt?.startsWith('custom dispatcher prompt'));
    assert.ok(result.normal.appendSystemPrompt?.includes('@llsPlanTask'));
    assert.ok(result.normal.appendSystemPrompt?.includes('Do NOT reply with `@llsExpert` for planning/design requests'));
});

test('getDualConfigsWithRelayEnv: plan/review 与 expert 一样继承 MCP servers 和 skills', async () => {
    setExtensionConfig(
        {
            'chat.enabled': true,
            'chat.includeVscodeMcpJson': false,
            'chat.mcpServers': {
                llsExpert: { type: 'stdio', command: 'node', args: ['legacy.js'] },
                memory: { type: 'stdio', command: 'memory-server' }
            },
            'chat.skills': ['reviewer']
        },
        {
            'chat.planMode.project.enabled': { workspaceValue: true },
            'chat.planMode.project.model': { workspaceValue: 'pPlan/mPlan' },
            'chat.reviewMode.project.enabled': { workspaceValue: true },
            'chat.reviewMode.project.model': { workspaceValue: 'pReview/mReview' }
        }
    );
    const service = makeService({ providerId: 'pNormal', modelId: 'mNormal' });
    const result = await service.getDualConfigsWithRelayEnv(9997);

    const plan = result.plan as ChatCliConfig;
    assert.ok(plan.mcpServers?.memory);
    assert.equal(plan.mcpServers?.llsExpert, undefined);
    assert.deepEqual(plan.skills, ['reviewer']);

    const review = result.review as ChatCliConfig;
    assert.ok(review.mcpServers?.memory);
    assert.equal(review.mcpServers?.llsExpert, undefined);
    assert.deepEqual(review.skills, ['reviewer']);

    // plan 默认提示词也应包含 Write 工具使用纪律
    assert.ok(plan.appendSystemPrompt?.includes('Write tool discipline'));
    assert.ok(plan.appendSystemPrompt?.includes('seed segment'));
});

