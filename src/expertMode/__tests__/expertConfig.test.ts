/**
 * @file expertConfig 单元测试。
 *
 * 覆盖纯函数逻辑：
 * 1. `resolveExpertConfig` 三层合并优先级（项目 > 全局 > 默认）；
 * 2. `resolveExpertConfig` 对 undefined / 空串 / 错误类型的容忍。
 *
 * 自双 CLI 路由方案落地后，旧 `buildExpertConfig` 已被
 * `ChatCliConfigService.getDualConfigsWithRelayEnv` 取代，本文件不再覆盖派生逻辑，
 * 派生测试由 `src/chat/cli/__tests__/cliConfig.test.ts` 接管。
 *
 * 本文件不依赖 vscode（仅测试纯函数），可以在 `node --test` 下直接运行。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    defaultExpertModeConfig,
    defaultRoutedModelModeConfig,
    resolveExpertConfig,
    resolveRoutedModelModeConfig
} from '../expertConfig';

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


// ---------------------------------------------------------------------------
// resolveRoutedModelModeConfig
// ---------------------------------------------------------------------------

test('resolveRoutedModelModeConfig: 两层都未设置时使用默认值', () => {
    const result = resolveRoutedModelModeConfig(undefined, undefined, defaultRoutedModelModeConfig);
    assert.deepEqual(result, { enabled: false, model: '' });
});

test('resolveRoutedModelModeConfig: 项目级优先于全局级', () => {
    const result = resolveRoutedModelModeConfig(
        { enabled: true, model: 'plan-model' },
        { enabled: false, model: 'review-model' },
        defaultRoutedModelModeConfig
    );
    assert.deepEqual(result, { enabled: true, model: 'plan-model' });
});

test('resolveRoutedModelModeConfig: 项目级显式 false 不回退到全局级', () => {
    const result = resolveRoutedModelModeConfig(
        { enabled: false, model: '' },
        { enabled: true, model: 'global-model' },
        defaultRoutedModelModeConfig
    );
    assert.deepEqual(result, { enabled: false, model: 'global-model' });
});

test('resolveRoutedModelModeConfig: 空 model 逐层回退到默认值', () => {
    const result = resolveRoutedModelModeConfig(
        { enabled: undefined, model: '' },
        { enabled: undefined, model: '' },
        { enabled: true, model: 'default-model' }
    );
    assert.deepEqual(result, { enabled: true, model: 'default-model' });
});
