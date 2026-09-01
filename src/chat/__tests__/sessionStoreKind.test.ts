/**
 * @file `ChatCliSessionStore` kind 参数测试。
 *
 * 任务流方案下只剩 normal / taskFlow 两种 kind，且 taskFlow 复用 normal CLI 进程、
 * 共用同一个 session 文件：
 * - 默认 kind='normal' 写 `chat-session.json`（保持与旧版本兼容）；
 * - kind='taskFlow' 读写同一文件；
 * - read / write / clear 三个方法行为一致。
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

test('sessionStore: normal 与 taskFlow 共用 chat-session.json', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();

    await store.writeSessionId(cwd, 'sess-normal-1');
    assert.equal(
        await store.readSessionId(cwd, 'taskFlow'),
        'sess-normal-1',
        'taskFlow 应与 normal 读同一 session 文件'
    );

    await store.writeSessionId(cwd, 'sess-taskflow-2', 'taskFlow');
    const normalRaw = await fs.readFile(path.join(cwd, '.LLSOAI', 'chat-session.json'), 'utf8');
    assert.match(normalRaw, /"sessionId":\s*"sess-taskflow-2"/);
    assert.equal(await store.readSessionId(cwd), 'sess-taskflow-2');
});

test('sessionStore: read 默认 kind 即 normal', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();

    await store.writeSessionId(cwd, 'normal-x');
    assert.equal(await store.readSessionId(cwd), 'normal-x');
    assert.equal(await store.readSessionId(cwd, 'normal'), 'normal-x');
});

test('sessionStore: clear 删除共用的 session 文件', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();

    await store.writeSessionId(cwd, 'a', 'taskFlow');
    await store.clearSessionId(cwd, 'normal');
    assert.equal(await store.readSessionId(cwd, 'taskFlow'), undefined);
});

test('sessionStore: clear 对不存在的文件应静默忽略', async () => {
    const cwd = await makeTempCwd();
    const store = new ChatCliSessionStore();
    await assert.doesNotReject(() => store.clearSessionId(cwd));
    await assert.doesNotReject(() => store.clearSessionId(cwd, 'taskFlow'));
});
