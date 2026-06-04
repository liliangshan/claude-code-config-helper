/**
 * @file Browser tools MCP server 与宿主执行器单元测试（lm.invokeTool 模型）。
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
const { BROWSER_TOOL_SCHEMAS, LM_BROWSER_TOOLS } = require('../tools') as typeof import('../tools');

type BrowserToolResult = import('../browserToolHost').BrowserToolResult;
type LmToolInvoker = import('../browserToolHost').LmToolInvoker;
type BrowserToolHostInstance = InstanceType<typeof BrowserToolHost>;

const PAGE_ID = '11111111-2222-3333-4444-555555555555';

/** 记录一次底层 lm.invokeTool 调用。 */
interface ToolCall {
    /** 被调用的 LM 工具名（snake_case）。 */
    name: string;
    /** 传入的 input。 */
    input: Record<string, unknown>;
}

/** 构造一个返回纯文本内容块的 LanguageModelToolResult。 */
function textResult(text: string): unknown {
    return { content: [{ value: text }] };
}

/** 构造可记录调用并按工具名返回固定结果的 lm.invokeTool 桩。 */
function makeHost(options: {
    uiKind?: number;
    results?: Partial<Record<string, unknown>>;
    invokeTool?: LmToolInvoker['invokeTool'];
} = {}): { host: BrowserToolHostInstance; calls: ToolCall[] } {
    const calls: ToolCall[] = [];
    const defaults: Record<string, unknown> = {
        [LM_BROWSER_TOOLS.open]: textResult(`Page ID: ${PAGE_ID}\nSummary: ok`),
        [LM_BROWSER_TOOLS.navigate]: textResult('navigated'),
        [LM_BROWSER_TOOLS.read]: textResult('Page Title: T\nRecent events:\n  error X\nSnapshot:\n  node'),
        [LM_BROWSER_TOOLS.eval]: textResult('"Title"')
    };
    const lm: LmToolInvoker = {
        invokeTool(name, opts) {
            const input = (opts.input ?? {}) as Record<string, unknown>;
            calls.push({ name, input });
            const result = options.results?.[name] ?? defaults[name] ?? textResult(`ok:${name}`);
            return Promise.resolve(result);
        }
    };
    const host = new BrowserToolHost({
        lm: options.invokeTool ? { invokeTool: options.invokeTool } : lm,
        env: { uiKind: (options.uiKind ?? 1) as import('vscode').UIKind },
        createCancellation: () => ({ token: {}, dispose() { /* noop */ } })
    });
    return { host, calls };
}

/** 先 open 拿到 pageId，再执行目标工具。 */
async function openThen(
    host: BrowserToolHostInstance,
    name: Parameters<BrowserToolHostInstance['execute']>[0],
    args: Record<string, unknown> = {}
): Promise<BrowserToolResult> {
    await host.execute('browser_open', { url: 'https://example.com' });
    return host.execute(name, args);
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

test('browser_open: 解析 Page ID 并存为 currentPageId', async () => {
    const { host, calls } = makeHost();
    const result = await host.execute('browser_open', { url: 'https://example.com' });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, LM_BROWSER_TOOLS.open);
    assert.deepEqual(calls[0].input, { url: 'https://example.com' });
    assert.equal(result.content[0].type, 'text');
});

test('browser_open: 缺失 url 时返回参数错误且不调用工具', async () => {
    const { host, calls } = makeHost();
    const result = await host.execute('browser_open', { url: '' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /url/);
    assert.equal(calls.length, 0);
});

test('browser_navigate: 携带 currentPageId 与 type=url 调用 navigate_page', async () => {
    const { host, calls } = makeHost();
    const result = await openThen(host, 'browser_navigate', { url: 'https://next.example' });

    assert.equal(result.isError, undefined);
    assert.equal(calls[1].name, LM_BROWSER_TOOLS.navigate);
    assert.deepEqual(calls[1].input, { pageId: PAGE_ID, type: 'url', url: 'https://next.example' });
});

test('browser_get_content: 携带 pageId 调用 read_page', async () => {
    const { host, calls } = makeHost();
    const result = await openThen(host, 'browser_get_content');

    assert.equal(result.isError, undefined);
    assert.equal(calls[1].name, LM_BROWSER_TOOLS.read);
    assert.deepEqual(calls[1].input, { pageId: PAGE_ID });
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /Snapshot/);
});

test('browser_console: 从 read_page 文本抽取 Recent events 段', async () => {
    const { host } = makeHost();
    const result = await openThen(host, 'browser_console');

    assert.equal(result.isError, undefined);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    assert.match(text, /Recent events:/);
    assert.doesNotMatch(text, /Snapshot/);
});

test('browser_eval: 携带 pageId 与 code 调用 run_playwright_code', async () => {
    const script = 'return page.evaluate(() => document.title)';
    const { host, calls } = makeHost();
    const result = await openThen(host, 'browser_eval', { script });

    assert.equal(result.isError, undefined);
    assert.equal(calls[1].name, LM_BROWSER_TOOLS.eval);
    assert.deepEqual(calls[1].input, { pageId: PAGE_ID, code: script });
});

test('browser_eval: 缺失 script 时返回参数错误且不调用工具', async () => {
    const { host, calls } = makeHost();
    await host.execute('browser_open', { url: 'https://example.com' });
    const result = await host.execute('browser_eval', { script: '' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /script/);
    assert.equal(calls.length, 1); // 只有 open
});

test('未先 open 时 read_page 返回 No browser page 错误', async () => {
    const { host, calls } = makeHost();
    const result = await host.execute('browser_get_content', {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /Call browser_open first/);
    assert.equal(calls.length, 0);
});

test('web 环境返回 desktop 门槛错误且不调用工具', async () => {
    const { host, calls } = makeHost({ uiKind: 2 });
    const result = await host.execute('browser_open', { url: 'https://example.com' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /desktop/i);
    assert.equal(calls.length, 0);
});

test('invokeTool 不存在时返回升级提示错误', async () => {
    const host = new BrowserToolHost({
        lm: {} as LmToolInvoker,
        env: { uiKind: 1 as import('vscode').UIKind },
        createCancellation: () => ({ token: {}, dispose() { /* noop */ } })
    });
    const result = await host.execute('browser_open', { url: 'https://example.com' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /invokeTool/);
});

test('invokeTool 抛错时包成 isError 文本结果', async () => {
    const { host } = makeHost({
        invokeTool: () => Promise.reject(new Error('tool exploded'))
    });
    const result = await host.execute('browser_open', { url: 'https://example.com' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /tool exploded/);
});

test('browser_screenshot: Uint8Array 二进制部件 base64 编码为 image content', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { host } = makeHost({
        results: { [LM_BROWSER_TOOLS.screenshot]: { content: [{ mimeType: 'image/jpeg', data: bytes }] } }
    });
    const result = await openThen(host, 'browser_screenshot');

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content[0], {
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: 'image/jpeg'
    });
});

test('browser_screenshot: {type:Buffer,data} 形态 base64 编码', async () => {
    const data = [10, 20, 30];
    const { host } = makeHost({
        results: { [LM_BROWSER_TOOLS.screenshot]: { content: [{ mimeType: 'image/png', data: { type: 'Buffer', data } }] } }
    });
    const result = await openThen(host, 'browser_screenshot');

    assert.deepEqual(result.content[0], {
        type: 'image',
        data: Buffer.from(data).toString('base64'),
        mimeType: 'image/png'
    });
});

test('browser_screenshot: VSBuffer.buffer 形态 base64 编码并缺省 jpeg', async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const { host } = makeHost({
        results: { [LM_BROWSER_TOOLS.screenshot]: { content: [{ data: { buffer: bytes } }] } }
    });
    const result = await openThen(host, 'browser_screenshot');

    assert.deepEqual(result.content[0], {
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: 'image/jpeg'
    });
});

test('browser_screenshot: 无图片数据时返回 isError 文本', async () => {
    const { host } = makeHost({
        results: { [LM_BROWSER_TOOLS.screenshot]: textResult('no image here') }
    });
    const result = await openThen(host, 'browser_screenshot');

    assert.equal(result.isError, true);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /no image here/);
});
