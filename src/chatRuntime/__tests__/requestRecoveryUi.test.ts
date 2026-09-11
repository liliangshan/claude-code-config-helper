/** @file 恢复 UI 格式化回归，执行实际前端函数。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

/** 七语言倒计时不依赖发送器；过期仅显示零，不自动提交。 */
test('seven languages show countdown, exhaustion and terminal hiding', () => {
    const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');
    const start = source.indexOf('    var recoveryTranslations =');
    const end = source.indexOf('    /** 原地更新独立状态行', start);
    const format = runInNewContext(source.slice(start, end) + '\nformatRecoveryStatus;');
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        assert.match(format({ state: 'waiting_recovery', attemptsUsed: 0, nextRetryAt: 121000 }, language, 1000), /120 .*\(1\/5\)/);
        assert.match(format({ state: 'waiting_recovery', attemptsUsed: 4, nextRetryAt: 1 }, language, 1000), /0 .*\(5\/5\)/);
        assert.match(format({ state: 'exhausted', attemptsUsed: 5 }, language, 0), /5\/5/);
        for (const state of ['cancelled', 'succeeded', 'running']) assert.equal(format({ state }, language, 0), '');
        assert.ok(format({ state: 'native_retry' }, language, 0));
    }
});
