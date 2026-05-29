/**
 * @file AskExpertMcpServer 单元测试。
 *
 * 通过内存 stdin/stdout 流驱动 NDJSON JSON-RPC，验证：
 * - tools/list 仅暴露唯一的 ask_expert 工具；
 * - tools/call 命中 ask_expert 时触发 ExpertSubturnService.run() 并回写最终文本；
 * - 未知工具名 / 缺失 question 返回 isError；
 * - 专家未配置（noModel）时返回固定降级文本而非 isError。
 *
 * 通过注入 fake deps（getExpertModel/getRelayPort/getOptions）避免真实网络与 vscode。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';

// askExpertMcpServer 经 expertSubturnService 顶层 `import * as vscode`，
// 需先装 stub 再 require。
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
    AskExpertMcpServer,
    ASK_EXPERT_TOOL_NAME,
    NO_EXPERT_AVAILABLE_MESSAGE,
    getDefaultExpertSubturnOptions
} = require('../askExpertMcpServer') as typeof import('../askExpertMcpServer');
type ExpertSubturnServiceDeps = import('../expertSubturnService').ExpertSubturnServiceDeps;

/**
 * 构造一组 fake deps；默认 getExpertModel 返回空串（专家未配置），
 * 这样 ExpertSubturnService.run() 会在 noModel 分支提前返回，无需真实网络。
 */
function makeDeps(overrides: Partial<ExpertSubturnServiceDeps> = {}): ExpertSubturnServiceDeps {
    return {
        getRelayPort: () => 12345,
        getExpertModel: () => '',
        getOptions: () => getDefaultExpertSubturnOptions(),
        ...overrides
    };
}

/**
 * 驱动一个 server 实例：把若干 JSON-RPC 请求按 NDJSON 写入 stdin，
 * 收集 stdout 上回写的响应行并解析为对象数组。
 *
 * @param deps   注入到 server 的依赖。
 * @param lines  要逐行写入 stdin 的请求对象。
 * @returns 解析后的响应对象数组（按写出顺序）。
 */
async function driveServer(
    deps: ExpertSubturnServiceDeps,
    lines: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AskExpertMcpServer({ deps, stdin, stdout });
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
    // 给事件循环时间冲刷异步响应（handleToolCall 是 async）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.dispose();
    return collected;
}

test('tools/list: 仅暴露唯一的 ask_expert 工具', async () => {
    const responses = await driveServer(makeDeps(), [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    ]);
    assert.equal(responses.length, 1);
    const result = responses[0].result as { tools: Array<{ name: string }> };
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, ASK_EXPERT_TOOL_NAME);
});

test('tools/call: 未知工具名返回 isError', async () => {
    const responses = await driveServer(makeDeps(), [
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'something_else', arguments: {} } }
    ]);
    const result = responses[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
});

test('tools/call: 缺失 question 返回 isError', async () => {
    const responses = await driveServer(makeDeps(), [
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: ASK_EXPERT_TOOL_NAME, arguments: {} } }
    ]);
    const result = responses[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /question/);
});

test('tools/call: 专家未配置（noModel）时返回固定降级文本而非 isError', async () => {
    const responses = await driveServer(makeDeps({ getExpertModel: () => '' }), [
        {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: ASK_EXPERT_TOOL_NAME, arguments: { question: 'Why does X fail?' } }
        }
    ]);
    const result = responses[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].text, NO_EXPERT_AVAILABLE_MESSAGE);
});

test('initialize: 返回 protocolVersion 与 serverInfo', async () => {
    const responses = await driveServer(makeDeps(), [
        { jsonrpc: '2.0', id: 5, method: 'initialize' }
    ]);
    const result = responses[0].result as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(typeof result.protocolVersion, 'string');
    assert.ok(result.serverInfo.name.length > 0);
});

test('notifications/initialized: 通知不回写响应', async () => {
    const responses = await driveServer(makeDeps(), [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 6, method: 'tools/list' }
    ]);
    // 仅 tools/list 有响应；通知不产生输出。
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 6);
});
