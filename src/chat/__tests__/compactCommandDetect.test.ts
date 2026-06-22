/**
 * @file Claude CLI 原生 /compact 压缩请求识别测试。
 *
 * 覆盖 isClaudeCompactCommandRequest 的判定规则：仅当「最后一个非空 text block」
 * 是真正的 /compact 命令或命中压缩摘要 prompt 时才判为压缩请求。历史会话里
 * 嵌入的 `<command-name>/compact</command-name>` caveat（压缩后下一轮普通消息里
 * 会带）不得误判，否则普通对话与任务流续推会被错误路由到压缩专用模型。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isClaudeCompactCommandRequest } = require('../../relay/summCommand') as typeof import('../../relay/summCommand');

/** 构造单条 user 消息的 Anthropic 请求体。 */
function userBody(content: unknown): Record<string, unknown> {
    return { messages: [{ role: 'user', content }] };
}

test('compact: 纯文本 /compact 命令判为压缩请求', () => {
    assert.equal(isClaudeCompactCommandRequest(userBody('/compact')), true);
});

test('compact: 命令标记作为最后一个 block 判为压缩请求', () => {
    const body = userBody([
        { type: 'text', text: '<local-command-caveat>...</local-command-caveat>' },
        { type: 'text', text: '<command-name>/compact</command-name>' }
    ]);
    assert.equal(isClaudeCompactCommandRequest(body), true);
});

test('compact: 命中压缩摘要 prompt 判为压缩请求', () => {
    const summary = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n'
        + 'Your task is to create a detailed summary of the conversation so far.';
    assert.equal(isClaudeCompactCommandRequest(userBody(summary)), true);
});

test('compact: 历史 caveat 含 /compact 标记但末块是真实用户输入不误判', () => {
    const body = userBody([
        { type: 'text', text: '<local-command-caveat>历史压缩 caveat</local-command-caveat>' },
        { type: 'text', text: '<command-name>/compact</command-name>' },
        { type: 'text', text: '<local-command-stdout>Compacted </local-command-stdout>' },
        { type: 'text', text: '现在是只有任务流会出现这情况' }
    ]);
    assert.equal(isClaudeCompactCommandRequest(body), false);
});

test('compact: 任务流续推提示词不误判为压缩请求', () => {
    const body = userBody([
        { type: 'text', text: '<command-name>/compact</command-name>' },
        { type: 'text', text: '请继续执行当前 llsccai-task 任务流。\n\n方案文件路径: PLAN.md' }
    ]);
    assert.equal(isClaudeCompactCommandRequest(body), false);
});

test('compact: 普通对话不判为压缩请求', () => {
    assert.equal(isClaudeCompactCommandRequest(userBody('帮我看下这段代码')), false);
});

