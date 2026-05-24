/**
 * @file expertMcpServer 端到端 HTTP 转发冒烟测试。
 *
 * 启动：
 *   1) 本进程内开一个最小 HTTP server，模拟扩展宿主侧的 `/__expert/run` 入口；
 *   2) spawn 真实的 `out/expertMode/expertMcpServer.js`，并通过 env 注入
 *      `LLS_EXPERT_RELAY_URL` + `LLS_EXPERT_RELAY_TOKEN`；
 *   3) 通过 stdin 发送 initialize → initialized → tools/call ask_expert；
 *   4) 断言 `tools/call` 的响应 content[0].text === mock server 返回的 finalAnswer。
 *
 * 该测试覆盖方案 3 的核心拼装：expertMcpServer 在收到 ask_expert 时确实通过
 * HTTP 把请求转发到扩展宿主，并把响应包成 MCP tool_result 返回主 CLI。
 */

import { spawn } from 'child_process';
import { createServer } from 'http';
import * as path from 'path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_PATH = path.resolve(
    __dirname,
    '../../../out/expertMode/expertMcpServer.js'
);

/**
 * 启动一个本机 HTTP server 模拟扩展宿主侧 `/__expert/run`。
 *
 * 行为：
 * - 校验 `Authorization: Bearer <expectedToken>`；不匹配返回 401；
 * - 读 body，要求是 JSON 且含非空 `question`；不满足返回 400；
 * - 返回固定的 `{ finalAnswer: '<mock answer for: ' + question + '>', isError: false }`。
 *
 * @param expectedToken 期望的鉴权 token。
 * @returns 包含端口与 close 函数的对象。
 */
async function startMockRelay(expectedToken: string): Promise<{
    port: number;
    close: () => Promise<void>;
    receivedBodies: unknown[];
}> {
    const receivedBodies: unknown[] = [];
    const server = createServer((req, res) => {
        if (req.url !== '/__expert/run' || req.method !== 'POST') {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${expectedToken}`) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(text);
            } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'bad_json' }));
                return;
            }
            receivedBodies.push(parsed);
            const question =
                parsed && typeof parsed === 'object'
                    ? String((parsed as Record<string, unknown>).question ?? '')
                    : '';
            const out = {
                finalAnswer: `<mock answer for: ${question}>`,
                isError: false,
                durationMs: 12,
                endReason: 'completed'
            };
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(out));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('failed to bind');
    return {
        port: address.port,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
        receivedBodies
    };
}

/**
 * spawn expertMcpServer 子进程，并通过 stdin 顺序发送 initialize / initialized / tools/call。
 *
 * 返回收集到的所有 stdout JSON 响应行（按到达顺序），便于测试断言。
 */
async function runStdioRoundTrip(env: NodeJS.ProcessEnv): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT_PATH], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env }
        });

        const responses: string[] = [];
        let stdoutBuf = '';

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdoutBuf += chunk;
            for (;;) {
                const idx = stdoutBuf.indexOf('\n');
                if (idx < 0) break;
                const line = stdoutBuf.slice(0, idx);
                stdoutBuf = stdoutBuf.slice(idx + 1);
                if (line.trim().length > 0) {
                    responses.push(line);
                }
                // 收满 2 条响应（initialize、tools/call）即完工
                if (responses.length >= 2) {
                    child.kill('SIGTERM');
                }
            }
        });

        child.stderr.on('data', (c: Buffer) => {
            // 仅用于调试输出，不参与断言
            process.stderr.write(`[child.stderr] ${c.toString('utf8')}`);
        });

        child.on('error', reject);
        child.on('exit', () => resolve(responses));

        // 发送 3 条消息
        const send = (msg: unknown) => {
            child.stdin.write(JSON.stringify(msg) + '\n');
        };
        send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
        });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'ask_expert',
                arguments: { question: 'integration smoke test question' }
            }
        });
    });
}

test('expertMcpServer 在配置 LLS_EXPERT_RELAY_URL/TOKEN 时会转发到回环 HTTP', async () => {
    const token = 'smoke-test-token-' + Math.random().toString(36).slice(2);
    const mock = await startMockRelay(token);
    try {
        const lines = await runStdioRoundTrip({
            LLS_EXPERT_RELAY_URL: `http://127.0.0.1:${mock.port}`,
            LLS_EXPERT_RELAY_TOKEN: token
        });
        assert.ok(lines.length >= 2, `期望至少 2 条响应，实际 ${lines.length}: ${JSON.stringify(lines)}`);

        // 第二条应当是 tools/call 响应
        const toolsCallResp = lines
            .map((l) => JSON.parse(l))
            .find((m) => m && m.id === 2) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } } | undefined;
        assert.ok(toolsCallResp, 'tools/call 响应未到达');
        assert.equal(toolsCallResp.result?.isError, false, 'isError 应为 false');
        const text = toolsCallResp.result?.content?.[0]?.text ?? '';
        assert.match(text, /mock answer for: integration smoke test question/);

        // mock relay 应当确实收到了 question
        assert.equal(mock.receivedBodies.length, 1);
        const body = mock.receivedBodies[0] as Record<string, unknown>;
        assert.equal(body.question, 'integration smoke test question');
    } finally {
        await mock.close();
    }
});

test('expertMcpServer 未配置 relay env 时回落到 stub 文案', async () => {
    const lines = await runStdioRoundTrip({
        // 显式清空 env（process.env 中可能残留），保证 stub 分支生效
        LLS_EXPERT_RELAY_URL: '',
        LLS_EXPERT_RELAY_TOKEN: ''
    });
    const toolsCallResp = lines
        .map((l) => JSON.parse(l))
        .find((m) => m && m.id === 2) as { result?: { content?: Array<{ text?: string }> } } | undefined;
    assert.ok(toolsCallResp, 'tools/call 响应未到达');
    const text = toolsCallResp.result?.content?.[0]?.text ?? '';
    assert.match(text, /Expert mode stub/);
    assert.match(text, /No relay env/);
});
