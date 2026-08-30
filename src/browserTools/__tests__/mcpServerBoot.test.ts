/**
 * @file browser MCP server 子进程启动回归测试。
 *
 * 该 server 由 Claude CLI 以独立 node 子进程拉起，进程里没有 `vscode` 模块。
 * 历史上 browserMcpServer / httpBridge 静态 import 了 browserToolHost
 * （链式 require('vscode')），导致 server 一启动就崩溃、browser_* 工具整组消失
 * 且没有任何可见报错。这里用真实子进程守住这条边界。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { BROWSER_TOOL_RELAY_PORT_ENV } from '../httpBridge';

/**
 * 在无 vscode 模块的干净 node 子进程里启动 MCP server，并跑一轮 JSON-RPC 握手。
 *
 * @returns 子进程的 stdout、stderr 与退出码。
 */
function bootServer(): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const entry = path.resolve(__dirname, '../browserMcpServer.js');
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(entry)}).startBrowserMcpServer();`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // 与扩展实际拉起 server 的方式一致：带上 relay 端口，走 HTTP 转发到宿主。
        env: { ...process.env, [BROWSER_TOOL_RELAY_PORT_ENV]: '58999' }
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

test('browser MCP server 在没有 vscode 模块的子进程里能启动并列出 browser_* 工具', async () => {
    const { stdout, stderr, code } = await bootServer();
    assert.ok(!stderr.includes("Cannot find module 'vscode'"), `子进程不应依赖 vscode 模块：${stderr}`);
    assert.equal(code, null, `子进程不应提前退出：${stderr}`);
    assert.ok(stdout.includes('"llsccai-browser"'), `initialize 应返回 serverInfo：${stdout}`);
    assert.ok(stdout.includes('"browser_open"'), `tools/list 应包含 browser_open：${stdout}`);
});
