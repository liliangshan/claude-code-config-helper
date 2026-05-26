/**
 * @file estimator 轻量单元测试。
 *
 * 不依赖 vscode、ConfigManager 等扩展运行时；仅校验 Anthropic 请求体 token
 * 估算的口径与边界。
 */

import * as assert from 'assert';
import { test } from 'node:test';

// estimator.ts 间接依赖 ../../logger，后者 import 'vscode'。在 node 测试进程里
// 用 _resolveFilename 钩子把这两个模块替换为最小占位，避免 MODULE_NOT_FOUND。
// 用 require('node:module') 而非 `import * as`，避免命名空间对象只读导致赋值失败。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as { _resolveFilename: (request: string, parent: NodeJS.Module) => string; _cache: Record<string, NodeJS.Module> };
const moduleAny = Module as unknown as {
    _resolveFilename: (request: string, parent: NodeJS.Module) => string;
    _cache: Record<string, NodeJS.Module>;
};
const originalResolveFilename = moduleAny._resolveFilename;
const fakeVscodeId = 'fake://vscode-estimator';
moduleAny._resolveFilename = function (request: string, parent: NodeJS.Module): string {
    if (request === 'vscode') return fakeVscodeId;
    return originalResolveFilename.call(this, request, parent);
};
moduleAny._cache[fakeVscodeId] = {
    id: fakeVscodeId,
    filename: fakeVscodeId,
    loaded: true,
    exports: {
        workspace: { workspaceFolders: undefined as unknown },
        window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
    }
} as unknown as NodeJS.Module;

// js-tiktoken 编码器初次加载需要读 ~1.5MB 词表 JSON；本测试只验证 token 数大小关系，
// 用 require 直接拿到 estimator 即可。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { estimateAnthropicInputTokens } = require('../estimator') as typeof import('../estimator');

test('estimateAnthropicInputTokens 对 null/非对象返回 0', () => {
    assert.strictEqual(estimateAnthropicInputTokens(null), 0);
    assert.strictEqual(estimateAnthropicInputTokens(undefined), 0);
    assert.strictEqual(estimateAnthropicInputTokens(123 as unknown), 0);
});

test('estimateAnthropicInputTokens 简单 user text 应返回正整数', () => {
    const tokens = estimateAnthropicInputTokens({
        messages: [{ role: 'user', content: 'hello world' }]
    });
    assert.ok(tokens > 0);
    // 'hello world' + per-message overhead 应小于 32
    assert.ok(tokens < 32);
});

test('estimateAnthropicInputTokens 含 image 块应包含固定 +1500', () => {
    const tokens = estimateAnthropicInputTokens({
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: 'x' },
                { type: 'image', source: { type: 'base64' } }
            ]
        }]
    });
    assert.ok(tokens >= 1500);
});

test('estimateAnthropicInputTokens 接受 JSON 字符串输入', () => {
    const body = JSON.stringify({
        system: 'be concise',
        messages: [{ role: 'user', content: 'hi' }]
    });
    const tokens = estimateAnthropicInputTokens(body);
    assert.ok(tokens > 0);
});

test('estimateAnthropicInputTokens tools 字段也计入 token', () => {
    const withoutTools = estimateAnthropicInputTokens({
        messages: [{ role: 'user', content: 'hi' }]
    });
    const withTools = estimateAnthropicInputTokens({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'foo', description: 'do foo', input_schema: { type: 'object' } }]
    });
    assert.ok(withTools > withoutTools);
});

test('estimateAnthropicInputTokens 解析失败的字符串走兜底字符估算', () => {
    const tokens = estimateAnthropicInputTokens('not a json {{{');
    assert.ok(tokens >= 1);
});
