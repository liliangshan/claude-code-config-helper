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
