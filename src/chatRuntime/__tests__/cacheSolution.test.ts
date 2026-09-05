/**
 * @file 低缓存命中率解决方案阈值单元测试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';

/** 前端共享模块的 CommonJS 测试类型。 */
interface CacheSolutionModule {
    /** 判断是否显示低命中率解决方案。 */
    shouldShowCacheSolution(usage: unknown): boolean;
}

const modulePath = path.resolve(__dirname, '../../../media/chat/cacheSolution.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shouldShowCacheSolution } = require(modulePath) as CacheSolutionModule;

/** 从目标百分比构造输入侧 token 统计。 */
function usageAt(cacheRead: number, total = 10000): Record<string, number> {
    return { inputTokens: total - cacheRead, cacheCreationInputTokens: 0, cacheReadInputTokens: cacheRead };
}

test('原始命中率低于 80% 时显示，80% 及以上隐藏', () => {
    assert.equal(shouldShowCacheSolution(usageAt(0)), true);
    assert.equal(shouldShowCacheSolution(usageAt(2800)), true);
    assert.equal(shouldShowCacheSolution(usageAt(7990)), true);
    assert.equal(shouldShowCacheSolution(usageAt(7996)), true);
    assert.equal(shouldShowCacheSolution(usageAt(8000)), false);
    assert.equal(shouldShowCacheSolution(usageAt(10000)), false);
});

test('实际 28% 示例显示，缺失非法与空总量不显示', () => {
    assert.equal(shouldShowCacheSolution({
        inputTokens: 1133526,
        outputTokens: 1649,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 441856
    }), true);
    assert.equal(shouldShowCacheSolution(undefined), false);
    assert.equal(shouldShowCacheSolution({}), false);
    assert.equal(shouldShowCacheSolution({ inputTokens: -1, cacheReadInputTokens: Number.NaN }), false);
});
