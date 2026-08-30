/**
 * @file 定时唤醒 MCP server 子进程启动回归测试。
 *
 * 该 server 由 Claude CLI 以独立 node 子进程拉起，进程里没有 `vscode` 模块。
 * wakeupMcpServer / httpBridge 一旦静态 import 到宿主侧模块（链式 require('vscode')），
 * server 会一启动就崩溃、三个 lls-ccai-* 工具整组消失且没有任何可见报错
 * （3.2.23 browser 工具同款事故）。这里用真实子进程守住这条边界。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { WAKEUP_TOOL_RELAY_PORT_ENV } from '../httpBridge';

/**
 * 在无 vscode 模块的干净 node 子进程里启动 MCP server，并跑一轮 JSON-RPC 握手。
 *
 * @returns 子进程的 stdout、stderr 与退出码。
 */
function bootServer(): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const entry = path.resolve(__dirname, '../wakeupMcpServer.js');
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(entry)}).startWakeupMcpServer();`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, [WAKEUP_TOOL_RELAY_PORT_ENV]: '58999' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
    return new Promise((resolve) => {
        setTimeout(() => {
            const code = child.exitCode;
            child.kill();
            resolve({ stdout, stderr, code });
        }, 2500);
    });
}

test('wakeup MCP server 在没有 vscode 模块的子进程里能启动并列出三个 lls-ccai-* 工具', async () => {
    const { stdout, stderr, code } = await bootServer();
    assert.ok(!stderr.includes("Cannot find module 'vscode'"), `子进程不应依赖 vscode 模块：${stderr}`);
    assert.equal(code, null, `子进程不应提前退出：${stderr}`);
    assert.ok(stdout.includes('"llsccai-wakeup"'), `initialize 应返回 serverInfo：${stdout}`);
    assert.ok(stdout.includes('"lls-ccai-schedule-wakeup"'), `tools/list 应包含 schedule 工具：${stdout}`);
    assert.ok(stdout.includes('"lls-ccai-list-wakeups"'), `tools/list 应包含 list 工具：${stdout}`);
    assert.ok(stdout.includes('"lls-ccai-cancel-wakeup"'), `tools/list 应包含 cancel 工具：${stdout}`);
});

test('relay 端口缺失时工具调用返回明确错误，而非整组消失', async () => {
    const entry = path.resolve(__dirname, '../wakeupMcpServer.js');
    const env = { ...process.env };
    delete env[WAKEUP_TOOL_RELAY_PORT_ENV];
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(entry)}).startWakeupMcpServer();`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lls-ccai-list-wakeups"}}\n');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.kill();

    assert.ok(stdout.includes('"lls-ccai-list-wakeups"'), `工具仍应出现在 tools/list：${stdout}`);
    assert.ok(stdout.includes('extension host relay'), `调用应回明确错误文本：${stdout}`);
});
