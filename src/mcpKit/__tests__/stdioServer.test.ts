/**
 * @file McpStdioServer 的 JSON-RPC 分派与行缓冲回归测试。
 *
 * 该 server 跑在没有 `vscode` 的 MCP 子进程里，输入是 NDJSON 流，
 * 任何分帧或错误码回归都会让整组工具在模型侧静默失效，这里用假流守住。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { McpStdioServer } from '../stdioServer';
import type { McpBridgeDescriptor } from '../registry';
import type { McpToolExecutor, McpToolResult } from '../types';

/** 测试用工具名集合。 */
type TestToolName = 'demo_tool';

/** 测试用桥声明，字段取值与真实桥同构但互不影响。 */
const TEST_BRIDGE: McpBridgeDescriptor<TestToolName> = {
    serverName: 'llsccaiTest',
    serverInfoName: 'llsccai-test',
    displayName: 'Test',
    httpPath: '/llsccai/test-tool',
    relayPortEnv: 'LLS_TEST_TOOL_RELAY_PORT',
    entryModule: '../../mcpKit/stdioServer',
    entryStarter: 'startTestMcpServer',
    schemas: [{
        name: 'demo_tool',
        description: '测试工具。',
        inputSchema: { type: 'object', properties: {}, required: [] }
    }],
    unavailableMessage: 'Test tools require the extension host relay.',
    bodyTooLargeMessage: 'Test tool request body is too large.'
};

/** 可手动推送 chunk 的假 stdin。 */
class FakeStdin extends EventEmitter {
    /** 记录 server 是否设置过编码。 */
    public encoding: string | undefined;

    /**
     * 兼容 NodeJS.ReadableStream 的 setEncoding。
     *
     * @param encoding 编码名。
     * @returns 自身，便于链式调用。
     */
    public setEncoding(encoding: string): this {
        this.encoding = encoding;
        return this;
    }

    /**
     * 推送一段输入文本。
     *
     * @param chunk 任意长度的片段，可以不含换行。
     */
    public push(chunk: string): void {
        this.emit('data', chunk);
    }
}

/** 收集 NDJSON 输出行的假 stdout。 */
class FakeStdout {
    /** 已写出的完整行。 */
    public readonly lines: string[] = [];

    /**
     * 接收 server 写出的一行 NDJSON。
     *
     * @param chunk 以换行结尾的文本。
     * @returns 始终为 true，与 Writable.write 语义一致。
     */
    public write(chunk: string): boolean {
        this.lines.push(chunk.trim());
        return true;
    }
}

/**
 * 装配一台接好假流的 server。
 *
 * @param host 工具执行器；缺省走 descriptor 的 UNAVAILABLE 兜底。
 * @returns server 与两端假流。
 */
function createServer(host?: McpToolExecutor<TestToolName, McpToolResult>) {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const server = new McpStdioServer<TestToolName>({
        descriptor: TEST_BRIDGE,
        host,
        stdin: stdin as unknown as NodeJS.ReadableStream,
        stdout: stdout as unknown as NodeJS.WritableStream
    });
    server.start();
    return { server, stdin, stdout };
}

/**
 * 等待若干次微任务轮转，让 server 的异步分派落地。
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test('跨 chunk 分帧：一行 JSON 被拆成多段仍能完整解析', async () => {
    const { stdin, stdout } = createServer();
    stdin.push('{"jsonrpc":"2.0","id":1,');
    stdin.push('"method":"tools/li');
    await settle();
    assert.equal(stdout.lines.length, 0, '不完整的行不应产生响应');

    stdin.push('st"}\n');
    await settle();
    assert.equal(stdout.lines.length, 1);
    const parsed = JSON.parse(stdout.lines[0]) as { id: number; result: { tools: unknown[] } };
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result.tools.length, 1);
});

test('一个 chunk 内的多行会被逐条处理', async () => {
    const { stdin, stdout } = createServer();
    stdin.push('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"initialize"}\n');
    await settle();
    assert.equal(stdout.lines.length, 2);
    assert.equal((JSON.parse(stdout.lines[1]) as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'llsccai-test');
});

test('非法 JSON 返回 -32700 parse error 且 id 为 null', async () => {
    const { stdin, stdout } = createServer();
    stdin.push('{ not json }\n');
    await settle();
    const parsed = JSON.parse(stdout.lines[0]) as { id: null; error: { code: number; message: string } };
    assert.equal(parsed.id, null);
    assert.equal(parsed.error.code, -32700);
    assert.match(parsed.error.message, /Parse error/);
});

test('宿主执行器抛错时返回 -32603 内部错误', async () => {
    const { stdin, stdout } = createServer({
        execute: () => Promise.reject(new Error('host exploded'))
    });
    stdin.push('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"demo_tool","arguments":{}}}\n');
    await settle();
    const parsed = JSON.parse(stdout.lines[0]) as { id: number; error: { code: number; message: string } };
    assert.equal(parsed.id, 7);
    assert.equal(parsed.error.code, -32603);
    assert.equal(parsed.error.message, 'host exploded');
});

test('未知方法返回 -32603 且带 Method not found 文案', async () => {
    const { stdin, stdout } = createServer();
    stdin.push('{"jsonrpc":"2.0","id":3,"method":"resources/list"}\n');
    await settle();
    const parsed = JSON.parse(stdout.lines[0]) as { error: { code: number; message: string } };
    assert.equal(parsed.error.code, -32603);
    assert.match(parsed.error.message, /Method not found: resources\/list/);
});

test('未知工具名返回 isError 文本而非 JSON-RPC 错误', async () => {
    const { stdin, stdout } = createServer();
    stdin.push('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope","arguments":{}}}\n');
    await settle();
    const parsed = JSON.parse(stdout.lines[0]) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(parsed.result.isError, true);
    assert.equal(parsed.result.content[0].text, 'Unknown tool: nope');
});

test('缺省宿主返回 descriptor 的 UNAVAILABLE 文案', async () => {
    const { stdin, stdout } = createServer();
    stdin.push('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"demo_tool"}}\n');
    await settle();
    const parsed = JSON.parse(stdout.lines[0]) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(parsed.result.isError, true);
    assert.equal(parsed.result.content[0].text, TEST_BRIDGE.unavailableMessage);
});

test('通知类消息不产生任何响应', async () => {
    const { stdin, stdout } = createServer();
    stdin.push('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    stdin.push('{"jsonrpc":"2.0","method":"notifications/cancelled"}\n');
    await settle();
    assert.equal(stdout.lines.length, 0);
});
