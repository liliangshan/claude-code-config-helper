import * as assert from 'node:assert/strict';
import { test } from 'node:test';

/** 安装 logger 依赖的 vscode mock。 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as { _resolveFilename: (request: string, parent: NodeJS.Module) => string; _cache: Record<string, NodeJS.Module> };
const moduleAny = Module as unknown as {
    _resolveFilename: (request: string, parent: NodeJS.Module) => string;
    _cache: Record<string, NodeJS.Module>;
};
const originalResolveFilename = moduleAny._resolveFilename;
const fakeVscodeId = 'fake://vscode-compactor';
const fakeLoggerId = 'fake://logger-compactor';
moduleAny._resolveFilename = function (request: string, parent: NodeJS.Module): string {
    if (request === 'vscode') return fakeVscodeId;
    if (request === '../../logger' || request.endsWith('/logger')) return fakeLoggerId;
    return originalResolveFilename.call(this, request, parent);
};
moduleAny._cache[fakeVscodeId] = {
    id: fakeVscodeId,
    filename: fakeVscodeId,
    loaded: true,
    exports: {}
} as unknown as NodeJS.Module;
moduleAny._cache[fakeLoggerId] = {
    id: fakeLoggerId,
    filename: fakeLoggerId,
    loaded: true,
    exports: { Logger: { warn() {}, info() {}, error() {}, init() {} } }
} as unknown as NodeJS.Module;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CompactionClient } = require('../compactor') as typeof import('../compactor');

/** 读取私有方法，验证压缩上下文会丢弃工具块。 */
test('compactor flattens messages into one user message without tool blocks', () => {
    const client = new CompactionClient() as unknown as {
        buildSingleUserContextMessage(messages: unknown[]): { role: 'user'; content: Array<{ type: 'text'; text: string }> };
    };
    const message = client.buildSingleUserContextMessage([
        { role: 'user', content: [{ type: 'text', text: '用户目标' }] },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: '助手结论' },
                { type: 'tool_use', name: 'Bash', input: { command: 'secret' } }
            ]
        },
        { role: 'user', content: [{ type: 'tool_result', content: '工具输出' }] }
    ]);

    assert.equal(message.role, 'user');
    assert.equal(message.content.length, 1);
    assert.match(message.content[0].text, /用户目标/);
    assert.match(message.content[0].text, /助手结论/);
    assert.doesNotMatch(message.content[0].text, /tool_use/);
    assert.doesNotMatch(message.content[0].text, /工具输出/);
});

/**
 * 回归：ask_expert 的 tool_use 与配对 tool_result 在压缩成单条 user context 时，
 * 既不会把工具块原文塞进摘要（避免泄漏 / 体积膨胀），也不会因「拆散 pair」导致
 * 后续上游请求里出现孤立 tool_use 或孤立 tool_result（compactor 把整段历史折叠成
 * 一条纯文本 user message，原始 pair 结构整体被替换，不存在中途截断的半个 pair）。
 */
test('compactor: ask_expert tool_use/tool_result pair 折叠后不残留孤立工具块', () => {
    const client = new CompactionClient() as unknown as {
        buildSingleUserContextMessage(messages: unknown[]): { role: 'user'; content: Array<{ type: 'text'; text: string }> };
    };
    const message = client.buildSingleUserContextMessage([
        { role: 'user', content: [{ type: 'text', text: '请用专家分析迁移失败' }] },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: '我来委托专家。' },
                { type: 'tool_use', id: 'toolu_ask_x', name: 'mcp__askExpert__ask_expert', input: { question: '迁移为何失败' } }
            ]
        },
        {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'toolu_ask_x', content: '专家结论：缺少索引' }
            ]
        },
        { role: 'assistant', content: [{ type: 'text', text: '综合专家意见后的最终答复。' }] }
    ]);

    // 折叠结果是单条 user 文本：保留对话文本，剔除工具块，pair 不会被拆成半个。
    assert.equal(message.role, 'user');
    assert.equal(message.content.length, 1);
    const text = message.content[0].text;
    assert.match(text, /请用专家分析迁移失败/);
    assert.match(text, /最终答复/);
    // tool_use / tool_result 结构与其 id 都不应出现在摘要里。
    assert.doesNotMatch(text, /tool_use/);
    assert.doesNotMatch(text, /tool_result/);
    assert.doesNotMatch(text, /toolu_ask_x/);
    assert.doesNotMatch(text, /专家结论：缺少索引/);
});
