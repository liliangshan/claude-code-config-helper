/**
 * @file expertConfig 单元测试。
 *
 * 覆盖纯函数逻辑：
 * 1. `resolveExpertConfig` 三层合并优先级（项目 > 全局 > 默认）；
 * 2. `resolveExpertConfig` 对 undefined / 空串 / 错误类型的容忍；
 * 3. `buildExpertConfig` 派生时正确剥除 `llsExpert` 并保留其他 MCP server；
 * 4. `buildExpertConfig` 强制 `strictMcpConfig=true` / 清空 `resumeSessionId` / 注入 LLS_CHAT_ROLE；
 * 5. `buildExpertConfig` 对 `expertMode.model` 为空时回退到主模型；
 * 6. `buildExpertConfig` 输出中**不再**包含 `expertMode` 字段（防止专家递归）。
 *
 * 本文件不依赖 vscode（仅测试纯函数），可以在 `node --test` 下直接运行。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildExpertConfig,
    defaultExpertModeConfig,
    resolveExpertConfig
} from '../expertConfig';
import {
    EXPERT_MCP_SERVER_NAME,
    EXPERT_PERMISSION_MODE,
    EXPERT_ROLE_ENV_KEY,
    EXPERT_ROLE_ENV_VALUE
} from '../expertConstants';
import type { ChatCliConfig } from '../../chat/cli/types';

// ---------------------------------------------------------------------------
// resolveExpertConfig
// ---------------------------------------------------------------------------

test('resolveExpertConfig: 两层都未设置时使用默认值', () => {
    const result = resolveExpertConfig(undefined, undefined, defaultExpertModeConfig);
    assert.deepEqual(result, { enabled: false, model: '' });
});

test('resolveExpertConfig: 项目级优先于全局级', () => {
    const result = resolveExpertConfig(
        { enabled: true, model: 'sonnet-4' },
        { enabled: false, model: 'opus-4' },
        defaultExpertModeConfig
    );
    assert.deepEqual(result, { enabled: true, model: 'sonnet-4' });
});

test('resolveExpertConfig: 项目级未设置时回退到全局级', () => {
    const result = resolveExpertConfig(
        { enabled: undefined, model: '' },
        { enabled: true, model: 'opus-4' },
        defaultExpertModeConfig
    );
    assert.deepEqual(result, { enabled: true, model: 'opus-4' });
});

test('resolveExpertConfig: 全局级也未设置时回退到默认', () => {
    const result = resolveExpertConfig(
        { enabled: undefined, model: undefined },
        { enabled: undefined, model: '' },
        { enabled: true, model: 'default-model' }
    );
    assert.deepEqual(result, { enabled: true, model: 'default-model' });
});

test('resolveExpertConfig: 项目级 enabled=false 应当被视为显式设置（不是回退）', () => {
    const result = resolveExpertConfig(
        { enabled: false, model: '' },
        { enabled: true, model: 'opus-4' },
        defaultExpertModeConfig
    );
    // 项目级显式关闭，应当为 false；model 因为项目级是空串故回退到全局
    assert.deepEqual(result, { enabled: false, model: 'opus-4' });
});

test('resolveExpertConfig: 项目级 model="" 视为未设置，应回退到全局级', () => {
    const result = resolveExpertConfig(
        { enabled: true, model: '' },
        { enabled: false, model: 'opus-4' },
        defaultExpertModeConfig
    );
    assert.deepEqual(result, { enabled: true, model: 'opus-4' });
});

test('resolveExpertConfig: 传入 undefined partial 不应抛错', () => {
    assert.doesNotThrow(() =>
        resolveExpertConfig(undefined, undefined, defaultExpertModeConfig)
    );
});

// ---------------------------------------------------------------------------
// buildExpertConfig
// ---------------------------------------------------------------------------

/**
 * 构造一个最小可用的主进程 ChatCliConfig，作为派生测试的输入。
 *
 * @param overrides 需要覆盖的字段。
 */
function makeMainConfig(overrides: Partial<ChatCliConfig> = {}): ChatCliConfig {
    return {
        enabled: true,
        cliPath: '/usr/local/bin/claude',
        cliArgs: [],
        model: 'main-model-id',
        cwd: '/workspace',
        transport: 'streamJsonStdio',
        cliEnv: { FOO: 'bar' },
        permissionMode: 'acceptEdits',
        mcpServers: {
            [EXPERT_MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: ['expert-server.js'] },
            other: { type: 'stdio', command: 'node', args: ['other.js'] }
        },
        strictMcpConfig: false,
        skills: 'all',
        resumeSessionId: 'main-session-abc',
        expertMode: { enabled: true, model: 'expert-model-id' },
        ...overrides
    };
}

test('buildExpertConfig: 从 mcpServers 中剥除 llsExpert，保留其他 server', () => {
    const expert = buildExpertConfig(makeMainConfig());
    assert.ok(expert.mcpServers, 'mcpServers 应被保留');
    assert.equal(
        expert.mcpServers?.[EXPERT_MCP_SERVER_NAME],
        undefined,
        'llsExpert 必须被剥除'
    );
    assert.ok(expert.mcpServers?.other, '其他 server 应保留');
});

test('buildExpertConfig: 当 llsExpert 是唯一 server 时 mcpServers 应为 undefined', () => {
    const expert = buildExpertConfig(
        makeMainConfig({
            mcpServers: {
                [EXPERT_MCP_SERVER_NAME]: { type: 'stdio', command: 'x' }
            }
        })
    );
    assert.equal(expert.mcpServers, undefined);
});

test('buildExpertConfig: mainConfig.mcpServers 为 undefined 时输出也是 undefined', () => {
    const expert = buildExpertConfig(makeMainConfig({ mcpServers: undefined }));
    assert.equal(expert.mcpServers, undefined);
});

test('buildExpertConfig: strictMcpConfig 强制为 true', () => {
    const expert = buildExpertConfig(makeMainConfig({ strictMcpConfig: false }));
    assert.equal(expert.strictMcpConfig, true);
});

test('buildExpertConfig: resumeSessionId 必须被清空', () => {
    const expert = buildExpertConfig(makeMainConfig());
    assert.equal(expert.resumeSessionId, undefined);
});

test('buildExpertConfig: permissionMode 强制为 EXPERT_PERMISSION_MODE', () => {
    const expert = buildExpertConfig(
        makeMainConfig({ permissionMode: 'bypassPermissions' })
    );
    assert.equal(expert.permissionMode, EXPERT_PERMISSION_MODE);
});

test('buildExpertConfig: cliEnv 中注入 LLS_CHAT_ROLE=expert 并保留原有 env', () => {
    const expert = buildExpertConfig(makeMainConfig());
    assert.equal(expert.cliEnv[EXPERT_ROLE_ENV_KEY], EXPERT_ROLE_ENV_VALUE);
    assert.equal(expert.cliEnv.FOO, 'bar', '原有 env 必须保留');
});

test('buildExpertConfig: expertMode.model 非空时优先使用它', () => {
    const expert = buildExpertConfig(
        makeMainConfig({
            model: 'main-model',
            expertMode: { enabled: true, model: 'expert-model-x' }
        })
    );
    assert.equal(expert.model, 'expert-model-x');
});

test('buildExpertConfig: expertMode.model 为空时回退到主模型', () => {
    const expert = buildExpertConfig(
        makeMainConfig({
            model: 'main-model',
            expertMode: { enabled: true, model: '' }
        })
    );
    assert.equal(expert.model, 'main-model');
});

test('buildExpertConfig: expertMode 整体为 undefined 时也回退到主模型', () => {
    const expert = buildExpertConfig(
        makeMainConfig({ model: 'main-model', expertMode: undefined })
    );
    assert.equal(expert.model, 'main-model');
});

test('buildExpertConfig: 派生结果中不再包含 expertMode 字段', () => {
    const expert = buildExpertConfig(makeMainConfig());
    assert.equal(
        Object.prototype.hasOwnProperty.call(expert, 'expertMode'),
        false,
        '专家进程的 ChatCliConfig 不应再持有 expertMode 字段'
    );
});

test('buildExpertConfig: 不修改原 mainConfig（输入对象保持不变）', () => {
    const main = makeMainConfig();
    const mainSnapshot = JSON.parse(JSON.stringify(main));
    buildExpertConfig(main);
    assert.deepEqual(main, mainSnapshot, 'mainConfig 应当未被修改');
});

test('buildExpertConfig: cliPath / cliArgs / cwd / transport / skills 原样继承', () => {
    const main = makeMainConfig();
    const expert = buildExpertConfig(main);
    assert.equal(expert.cliPath, main.cliPath);
    assert.deepEqual(expert.cliArgs, main.cliArgs);
    assert.equal(expert.cwd, main.cwd);
    assert.equal(expert.transport, main.transport);
    assert.equal(expert.skills, main.skills);
});
