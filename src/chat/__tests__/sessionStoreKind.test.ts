/**
 * @file `ChatCliSessionStore` 双 CLI kind 参数测试。
 *
 * 验证双 CLI 路由方案下 normal / expert 两条 CLI 各自的 session_id 文件互不串扰：
 * - 默认 kind='normal' 写 `chat-session.json`（保持与旧版本兼容）；
 * - kind='expert' 写 `chat-session.expert.json`；
 * - read / write / clear 三个方法都按 kind 路由到对应文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ChatCliSessionStore } from '../cli/sessionStore';

/**
 * 创建一个临时工作目录给单条用例使用，避免互相串扰。
 *
 * @returns 临时目录绝对路径。
 */
async function makeTempCwd(): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), 'lls-session-test-'));
}

test('sessionStore: 默认 kind 写 chat-session.json，expert 写 chat-session.expert.json', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();

    await store.writeSessionId(cwd, 'sess-normal-1');
    await store.writeSessionId(cwd, 'sess-expert-1', 'expert');

    const normalRaw = await fs.readFile(path.join(cwd, '.LLSOAI', 'chat-session.json'), 'utf8');
    const expertRaw = await fs.readFile(path.join(cwd, '.LLSOAI', 'chat-session.expert.json'), 'utf8');
    assert.match(normalRaw, /"sessionId":\s*"sess-normal-1"/);
    assert.match(expertRaw, /"sessionId":\s*"sess-expert-1"/);
});

test('sessionStore: plan/review kind 写入各自独立文件', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();

    await store.writeSessionId(cwd, 'sess-plan-1', 'plan');
    await store.writeSessionId(cwd, 'sess-review-1', 'review');

    const planRaw = await fs.readFile(path.join(cwd, '.LLSOAI', 'chat-session.plan.json'), 'utf8');
    const reviewRaw = await fs.readFile(path.join(cwd, '.LLSOAI', 'chat-session.review.json'), 'utf8');
    assert.match(planRaw, /"sessionId":\s*"sess-plan-1"/);
    assert.match(reviewRaw, /"sessionId":\s*"sess-review-1"/);
    assert.equal(await store.readSessionId(cwd, 'plan'), 'sess-plan-1');
    assert.equal(await store.readSessionId(cwd, 'review'), 'sess-review-1');
});
test('sessionStore: read 按 kind 路由，互不串扰', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();

    await store.writeSessionId(cwd, 'normal-x');
    await store.writeSessionId(cwd, 'expert-y', 'expert');

    assert.equal(await store.readSessionId(cwd), 'normal-x');
    assert.equal(await store.readSessionId(cwd, 'normal'), 'normal-x');
    assert.equal(await store.readSessionId(cwd, 'expert'), 'expert-y');
});

test('sessionStore: clear 按 kind 只删对应文件', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();

    await store.writeSessionId(cwd, 'a');
    await store.writeSessionId(cwd, 'b', 'expert');

    await store.clearSessionId(cwd, 'normal');
    assert.equal(await store.readSessionId(cwd, 'normal'), undefined);
    assert.equal(await store.readSessionId(cwd, 'expert'), 'b');

    await store.clearSessionId(cwd, 'expert');
    assert.equal(await store.readSessionId(cwd, 'expert'), undefined);
});

test('sessionStore: clear 对不存在的文件应静默忽略', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();
    await assert.doesNotReject(() => store.clearSessionId(cwd));
    await assert.doesNotReject(() => store.clearSessionId(cwd, 'expert'));
});
