/** @file 子智能体开关消息同步回归测试。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: {} });
const invokedCommands: string[] = [];
const vscodeStub = require('vscode');
vscodeStub.commands = {
    /** 记录配置页打开命令，不启动真实窗口。 */
    executeCommand: async (command: string) => { invokedCommands.push(command); }
};
const runtime = require('../../runtime') as typeof import('../../runtime');
const messages = require('../webviewMessages') as typeof import('../webviewMessages');

/** 验证设置链接仅打开本扩展配置页。 */
test('config/open 打开扩展配置页', async () => {
    invokedCommands.length = 0;
    await messages.handleChatWebviewMessage({ type: 'config/open' });
    assert.deepEqual(invokedCommands, ['claudeRouter.openConfigPanel']);
});

/** 验证消息分发保存状态并回推，写入失败时恢复真实状态。 */
test('子智能体消息保存、回填及失败恢复', async () => {
    let enabled = true;
    let fail = false;
    const received: unknown[] = [];
    runtime.setConfigManager({
        /** 读取测试中的持久状态。 */
        getChatSubagentsEnabled: () => enabled,
        /** 模拟保存以及存储失败。 */
        setChatSubagentsEnabled: async (value: boolean) => {
            if (fail) throw new Error('storage unavailable');
            enabled = value;
        }
    } as unknown as Parameters<typeof runtime.setConfigManager>[0]);
    runtime.setChatViewHost({
        /** 收集发给 Webview 的消息。 */
        postMessage: async (message: unknown) => { received.push(message); return true; }
    } as unknown as Parameters<typeof runtime.setChatViewHost>[0]);
    try {
        await messages.postChatSubagentsEnabled();
        assert.deepEqual(received.pop(), { type: 'subagents/current', enabled: true });
        await messages.handleChatWebviewMessage({ type: 'subagents/select', enabled: false });
        assert.equal(enabled, false);
        assert.deepEqual(received.pop(), { type: 'subagents/current', enabled: false });
        fail = true;
        await messages.handleChatWebviewMessage({ type: 'subagents/select', enabled: true });
        assert.equal(enabled, false);
        assert.deepEqual(received.pop(), { type: 'subagents/current', enabled: false });
        assert.match(JSON.stringify(received.pop()), /storage unavailable/);
        fail = false;
        await messages.handleChatWebviewMessage({ type: 'subagents/select', enabled: true });
        assert.equal(enabled, true);
        assert.deepEqual(received.pop(), { type: 'subagents/current', enabled: true });
    } finally {
        runtime.setConfigManager(undefined);
        runtime.setChatViewHost(undefined);
    }
});
