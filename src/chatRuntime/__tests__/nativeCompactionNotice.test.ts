/** @file 兼容性弹窗分类、路径、去重及显式操作回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNativeCompactionPolicy } from '../../nativeCompactionPolicy';
import { notifyNativeCompactionUnsupported } from '../nativeCompactionNotice';

test('旧版本弹窗显示实际路径，重复启动仅提示一次，用户可重新检测', async () => {
    const policy = buildNativeCompactionPolicy('m', 200000, true, {}, [], 'v2.1.279').policy;
    let count = 0; let retry = 0;
    const deps = { language: 'zh-cn', warn: async (message: string) => {
        count++;
        assert.ok(message.includes('2.1.279') && message.includes('2.1.280') && message.includes('C:\\Claude\\old.cmd'));
        return '重新检测';
    }, select: async () => {}, retry: () => { retry++; } };
    await notifyNativeCompactionUnsupported(policy, 'C:\\Claude\\old.cmd', deps);
    await notifyNativeCompactionUnsupported(policy, 'C:\\Claude\\old.cmd', deps);
    assert.equal(count, 1); assert.equal(retry, 1);
});

test('未知版本不能说过低；窗口问题不要求升级；选择入口不擅自重启', async () => {
    let selected = 0;
    await notifyNativeCompactionUnsupported(buildNativeCompactionPolicy('m', 200000, true, {}).policy, '/unknown', {
        language: 'en', warn: async message => { assert.ok(message.includes('Could not verify') && message.includes('/unknown')); return 'Select CLI'; },
        select: async () => { selected++; }, retry: () => assert.fail('unexpected retry')
    });
    assert.equal(selected, 1);
    await notifyNativeCompactionUnsupported(buildNativeCompactionPolicy('m', 1048576, true, {}, [], '2.1.303').policy, '/window', {
        language: 'zh-cn', warn: async message => { assert.ok(message.includes('1048576') && message.includes('不是 CLI 版本问题')); return undefined; },
        select: async () => assert.fail('unexpected select'), retry: () => assert.fail('unexpected retry')
    });
});

test('303 合格或开关关闭时不弹窗', async () => {
    const deps = { language: 'en', warn: async () => { assert.fail('unexpected warning'); return undefined; }, select: async () => {}, retry: () => {} };
    await notifyNativeCompactionUnsupported(buildNativeCompactionPolicy('m', 200000, true, {}, [], 'v2.1.303').policy, '/modern', deps);
    await notifyNativeCompactionUnsupported(buildNativeCompactionPolicy('m', 200000, false, {}).policy, '/off', deps);
});
