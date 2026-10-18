/** @file 原生比例策略、环境冲突和窗口解析回归测试。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNativeCompactionPolicy, compactionPercentage, estimateCompactionThreshold, resolveContextWindow, supportsNativeCompaction } from '../nativeCompactionPolicy';

/** 构造已核验版本策略，不依赖本机配置。 */
function policy(limit: unknown, enabled = true, env: NodeJS.ProcessEnv = {}) {
    return buildNativeCompactionPolicy('unknown', limit, enabled, env, [], '2.1.280 (Claude Code)');
}

test('窗口解析：配置、静态表、200k 默认优先级与非法值', () => {
    assert.deepEqual(resolveContextWindow('unknown'), { contextLimit: 200000, source: 'default' });
    assert.deepEqual(resolveContextWindow('gpt-4o'), { contextLimit: 128000, source: 'static' });
    assert.deepEqual(resolveContextWindow('gpt-4o', 300000.8), { contextLimit: 300000, source: 'configured' });
    for (const value of [NaN, Infinity, -1, 0, 0.5, '500000', null]) {
        assert.equal(resolveContextWindow('gpt-4o', value).contextLimit, 128000);
        assert.equal(resolveContextWindow('unknown', value).contextLimit, 200000);
    }
});

test('200k 边界与环境值：不重复折减，也不传入 10/20', () => {
    for (const [limit, percentage] of [[100000, 90], [128000, 90], [200000, 90], [200001, 80], [500000, 80], [1000000, 80]]) {
        const result = policy(limit);
        assert.equal(result.policy.status, 'managed');
        assert.equal(compactionPercentage(limit), percentage);
        assert.deepEqual(result.env, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(limit), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(limit), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(percentage) });
    }
});

test('阈值包含内部预留，不能等同纯比例容量', () => {
    for (const [limit, threshold] of [[100000, 67000], [200000, 162000], [300000, 224000], [500000, 384000], [1000000, 784000]]) {
        assert.equal(estimateCompactionThreshold(limit), threshold);
        assert.notEqual(threshold, limit * compactionPercentage(limit) / 100);
    }
    assert.equal(estimateCompactionThreshold(200000, 32000), 162000);
    assert.equal(estimateCompactionThreshold(200000, 8000), 172800);
});

test('环境冲突：不接管，不解除用户禁用或改写父进程', () => {
    for (const env of [{ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' }, { DISABLE_AUTO_COMPACT: '1' }, { DISABLE_COMPACT: 'true' }]) {
        const before = { ...env };
        const result = policy(200000, true, env);
        assert.equal(result.policy.status, 'conflict');
        assert.deepEqual(result.env, {});
        assert.deepEqual(env, before);
        assert.ok(result.policy.conflicts.length);
    }
    assert.equal(policy(200000, true, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90', DISABLE_AUTO_COMPACT: '0' }).policy.status, 'managed');
});

test('关闭只禁用自动，重新开启从原始环境重建，无旧模型残留', () => {
    const raw = {};
    assert.deepEqual(policy(500000, false, raw).env, { DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000' });
    assert.equal(policy(200000, true, raw).env.DISABLE_AUTO_COMPACT, undefined);
    assert.equal(policy(200000, true, raw).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '90');
    assert.equal(policy(200000, false, { DISABLE_COMPACT: '1' }).env.DISABLE_COMPACT, undefined);
});

test('不支持范围或旧 CLI 不声称托管成功，不扩大用户窗口', () => {
    for (const limit of [32000, 50000, 1000001]) {
        assert.equal(policy(limit).policy.status, 'unsupported');
        assert.equal(policy(limit).policy.contextLimit, limit);
        assert.deepEqual(policy(limit).env, {});
    }
    assert.equal(supportsNativeCompaction('2.1.141 (Claude Code)'), false);
    assert.equal(supportsNativeCompaction('2.1.280 (Claude Code)'), true);
    assert.equal(buildNativeCompactionPolicy('m', 200000, true, {}, [], '2.1.141').policy.status, 'unsupported');
    assert.equal(buildNativeCompactionPolicy('m', 200000, true, {}).policy.status, 'unsupported');
    assert.equal(buildNativeCompactionPolicy('m', 200000, true, {}, ['autoCompactEnabled'], '2.1.280').policy.status, 'conflict');
});
