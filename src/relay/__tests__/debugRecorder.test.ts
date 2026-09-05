/**
 * @file DebugRecorder 落盘开关与追加写行为回归测试（B5）。
 *
 * 覆盖：开关关闭时完全不落盘、开启后同一 messages 重复请求只追加一行、
 * image block 被替换为体积占位。
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

/** 本次测试的假工作区根；DebugRecorder 会在其下创建 .LLSOAI 目录。 */
const WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'ccai-debugrec-'));

installVscodeStub({ values: { claudeCodeConfigHelper: {} }, workspaceFolderFsPath: WORKSPACE_ROOT });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DebugRecorder } = require('../debugRecorder') as typeof import('../debugRecorder');

/** 调试目录路径。 */
const DEBUG_DIR = path.join(WORKSPACE_ROOT, '.LLSOAI');

/**
 * 构造一条最小可用的转发快照。
 *
 * @param body 请求体文本。
 * @returns DebugRecorder.record 可接受的 entry。
 */
function makeEntry(body: string): Parameters<InstanceType<typeof DebugRecorder>['record']>[0] {
    return {
        providerId: 'p1',
        modelId: 'm1',
        upstreamUrl: 'https://example.com/v1/messages',
        method: 'POST',
        requestHeaders: {},
        requestBody: body,
        responseStatus: 200,
        responseHeaders: {},
        responseBody: '',
        startedAt: Date.now(),
        endedAt: Date.now()
    };
}

/**
 * 列出调试目录下的 jsonl 文件。
 *
 * @returns 文件名数组；目录不存在时为空数组。
 */
async function listJsonl(): Promise<string[]> {
    try {
        return (await fs.readdir(DEBUG_DIR)).filter((name) => name.endsWith('.jsonl'));
    } catch {
        return [];
    }
}

test('开关关闭时 record() 完全不落盘', async () => {
    const recorder = new DebugRecorder(() => false);
    await recorder.record(makeEntry(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })));
    assert.deepEqual(await listJsonl(), []);
});

test('开关开启时同一 messages 重复写只追加一行', async () => {
    const recorder = new DebugRecorder(() => true);
    const body = JSON.stringify({ messages: [{ role: 'user', content: '重复内容' }] });
    await recorder.record(makeEntry(body));
    await recorder.record(makeEntry(body));
    await recorder.record(makeEntry(body));

    const files = await listJsonl();
    assert.equal(files.length, 1);
    const text = await fs.readFile(path.join(DEBUG_DIR, files[0]), 'utf-8');
    const lines = text.split('\n').filter((line) => line.trim());
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]) as { message: { content: string } }).message.content, '重复内容');
});

test('image block 被替换为体积占位，不写入 base64 原文', async () => {
    const recorder = new DebugRecorder(() => true);
    const base64 = 'A'.repeat(64);
    await recorder.record(makeEntry(JSON.stringify({
        messages: [{
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }]
        }]
    })));

    const files = await listJsonl();
    const text = await fs.readFile(path.join(DEBUG_DIR, files[0]), 'utf-8');
    assert.equal(text.includes(base64), false);
    assert.equal(text.includes('"omitted":true'), true);
    assert.equal(text.includes(`"bytes":${base64.length}`), true);
});

test('recordUpstreamError: 连写 25 次后目录内最多保留 20 个快照，且请求体已瘦身', async () => {
    // 错误快照不受开关控制，这里显式用关闭态构造以验证这一点。
    const recorder = new DebugRecorder(() => false);
    const bigBody = JSON.stringify({
        model: 'm1',
        system: 'sys',
        tools: [{ name: 'Read' }, { name: 'Write' }],
        messages: Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg-${i}` }))
    });
    for (let i = 0; i < 25; i += 1) {
        await recorder.recordUpstreamError(400, bigBody, 'upstream error');
    }

    const names = (await fs.readdir(DEBUG_DIR)).filter((name) => name.startsWith('error-'));
    assert.equal(names.length, 20);

    const snapshot = JSON.parse(await fs.readFile(path.join(DEBUG_DIR, names[0]), 'utf-8')) as {
        request: { model: string; tools: string[]; messages: unknown[] };
    };
    assert.equal(snapshot.request.model, 'm1');
    assert.deepEqual(snapshot.request.tools, ['Read', 'Write']);
    // 只保留最后 2 条 messages。
    assert.equal(snapshot.request.messages.length, 2);

    await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});
