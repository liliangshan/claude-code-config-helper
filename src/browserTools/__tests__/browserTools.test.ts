/**
 * @file Browser tools MCP server 与宿主执行器单元测试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BrowserToolHost } = require('../browserToolHost') as typeof import('../browserToolHost');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BrowserMcpServer } = require('../browserMcpServer') as typeof import('../browserMcpServer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BROWSER_TOOL_SCHEMAS, VSCODE_BROWSER_COMMANDS } = require('../tools') as typeof import('../tools');

type BrowserToolResult = import('../browserToolHost').BrowserToolResult;
type BrowserCommandExecutor = import('../browserToolHost').BrowserCommandExecutor;
type BrowserToolHostInstance = InstanceType<typeof BrowserToolHost>;

/** 记录到底层 VS Code command executor 的一次调用。 */
interface CommandCall {
    /** 被调用的 VS Code 命令 id。 */
    command: string;
    /** 传递给命令的参数。 */
    args: unknown[];
}

/** 构造可记录调用并返回固定结果的命令执行器。 */
function makeCommandExecutor(
    handler: (command: string, args: unknown[]) => unknown | Promise<unknown>,
    commands?: string[]
): {
    executor: BrowserCommandExecutor;
    calls: CommandCall[];
} {
    const calls: CommandCall[] = [];
    const executor: BrowserCommandExecutor = {
        async executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T> {
            calls.push({ command, args });
            return await handler(command, args) as T;
        }
    };
    if (commands) {
        executor.getCommands = async () => commands;
    }
    return { calls, executor };
}

/** 构造可注入 desktop/web 环境和命令执行器的 BrowserToolHost。 */
function makeHost(options: {
    uiKind?: number;
    handler?: (command: string, args: unknown[]) => unknown | Promise<unknown>;
    commands?: string[];
} = {}): { host: BrowserToolHostInstance; calls: CommandCall[] } {
    const { executor, calls } = makeCommandExecutor(
        options.handler ?? ((command) => `ok:${command}`),
        options.commands
    );
    return {
        calls,
        host: new BrowserToolHost({
            commands: executor,
            env: { uiKind: (options.uiKind ?? 1) as import('vscode').UIKind }
        })
    };
}

/** 驱动 BrowserMcpServer 处理一组 NDJSON JSON-RPC 请求并收集响应。 */
async function driveServer(
    host: BrowserToolHostInstance,
    lines: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new BrowserMcpServer({ host, stdin, stdout });
    server.start();

    const collected: Array<Record<string, unknown>> = [];
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line.length > 0) collected.push(JSON.parse(line));
            idx = buffer.indexOf('\n');
        }
    });

    for (const line of lines) {
        stdin.write(`${JSON.stringify(line)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.dispose();
    return collected;
}

test('tools/list: 暴露 browser_* 工具全集', async () => {
    const { host } = makeHost();
    const responses = await driveServer(host, [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    ]);

    assert.equal(responses.length, 1);
    const result = responses[0].result as { tools: Array<{ name: string }> };
    assert.deepEqual(result.tools.map((tool) => tool.name), BROWSER_TOOL_SCHEMAS.map((tool) => tool.name));
});

test('tools/call: browser_open 分发到底层 openBrowserPage 命令', async () => {
    const { host, calls } = makeHost();
    const responses = await driveServer(host, [
        {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'browser_open', arguments: { url: 'https://example.com' } }
        }
    ]);

    const result = responses[0].result as BrowserToolResult;
    assert.equal(result.content[0].type, 'text');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, VSCODE_BROWSER_COMMANDS.open);
    assert.deepEqual(calls[0].args, ['https://example.com']);
});

test('BrowserToolHost: browser_open 在 agent 命令缺失时回退到 integrated browser 命令', async () => {
    const { host, calls } = makeHost({ commands: ['browser.openIntegratedBrowser'] });
    const result = await host.execute('browser_open', { url: 'https://example.com' });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'browser.openIntegratedBrowser');
    assert.deepEqual(calls[0].args, ['https://example.com']);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /fallback command/);
});
test('BrowserToolHost: web 环境返回 desktop 门槛错误且不执行命令', async () => {
    const { host, calls } = makeHost({ uiKind: 2 });
    const result = await host.execute('browser_get_content', {});

    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /desktop/i);
    assert.equal(calls.length, 0);
});

test('BrowserToolHost: 底层命令失败时返回 isError 文本结果', async () => {
    const { host } = makeHost({
        handler: () => {
            throw new Error('command missing');
        }
    });
    const result = await host.execute('browser_get_content', {});

    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /command missing/);
});

test('BrowserToolHost: browser_get_content 通过 runPlaywrightCode 读取页面内容', async () => {
    const { host, calls } = makeHost({ handler: () => ({ title: 'T', text: 'hello' }) });
    const result = await host.execute('browser_get_content', {});

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, VSCODE_BROWSER_COMMANDS.eval);
    assert.equal(typeof calls[0].args[0], 'string');
    assert.match(String(calls[0].args[0]), /document\.body/);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].type === 'text' ? result.content[0].text : '', '{"title":"T","text":"hello"}');
});
test('BrowserToolHost: browser_screenshot 返回 image content 并剥离 data URL 头', async () => {
    const { host, calls } = makeHost({
        handler: () => ({ data: 'data:image/jpeg;base64,abc123', mimeType: 'image/jpeg' })
    });
    const result = await host.execute('browser_screenshot', {});

    assert.equal(result.isError, undefined);
    assert.equal(calls[0].command, VSCODE_BROWSER_COMMANDS.eval);
    assert.deepEqual(result.content[0], { type: 'image', data: 'abc123', mimeType: 'image/jpeg' });
});

test('BrowserToolHost: browser_eval 传递 script 参数到底层 runPlaywrightCode', async () => {
    const script = 'return await page.evaluate(() => document.title)';
    const { host, calls } = makeHost({ handler: () => ({ value: 'Title' }) });
    const result = await host.execute('browser_eval', { script });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, VSCODE_BROWSER_COMMANDS.eval);
    assert.deepEqual(calls[0].args, [script]);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].type === 'text' ? result.content[0].text : '', '{"value":"Title"}');
});

test('BrowserToolHost: browser_eval 缺失 script 时返回参数错误且不执行命令', async () => {
    const { host, calls } = makeHost();
    const result = await host.execute('browser_eval', { script: '' });

    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /script/);
    assert.equal(calls.length, 0);
});
