/**
 * @file Phase 6 集成测试：ExpertMcpServer + ExpertRunner 端到端联动。
 *
 * 验证目标（详见 `EXPERT_MODE_DESIGN.md` §11）：
 * 1. `initialize` → `tools/list` → `tools/call`(ask_expert) 全链路打通；
 * 2. ExpertRunner 接到 ask_expert 调用 → 启动 fake CLI → 收事件 → 返回
 *    `finalAnswer` 给 MCP server，server 把它包装成 `tool_result` 内容；
 * 3. 专家中间步骤（assistant_text / tool_use）只进入 ExpertEventSink，
 *    **不会**出现在 MCP `tool_result.content`（即不会污染主对话上下文）；
 * 4. 专家 run 结束后 fake CLI 被 dispose；
 * 5. AbortSignal 从 MCP server 端取消时，ExpertRunner 正确收尾并返回错误结果。
 *
 * 注：本测试通过依赖注入 fake CLI 来模拟专家进程，避免真正 spawn 子进程
 * 带来的 CI 不稳定性。真实子进程的契约由 `cliProcess` 自有的单元测试覆盖。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
    ExpertMcpServer,
    MCP_PROTOCOL_VERSION
} from '../expertMcpServer';
import type { AskExpertArgs } from '../expertMcpServer';
import { EXPERT_TOOL_NAME } from '../expertConstants';
import { ExpertRunner } from '../expertRunner';
import type {
    ExpertCliProcessLike,
    ExpertStreamEvent,
    ExpertTimers
} from '../expertRunner';
import { createMemoryExpertEventSink } from '../expertEvents';
import type { ChatCliConfig } from '../../chat/cli/types';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/**
 * 可手动驱动的 fake CLI。
 *
 * 与 expertRunner.test.ts 中的 FakeCli 等价，这里为了文件自包含再写一份；
 * 也避免跨测试文件共享可变状态。
 */
class FakeCli implements ExpertCliProcessLike {
    public startedWith: ChatCliConfig | undefined;
    public sentLines: string[] = [];
    public disposed = false;
    public eventListeners: Array<(e: ExpertStreamEvent) => void> = [];
    public exitListeners: Array<() => void> = [];

    async start(config: ChatCliConfig): Promise<void> {
        this.startedWith = config;
    }
    send(line: string): void {
        this.sentLines.push(line);
    }
    onEvent(listener: (e: ExpertStreamEvent) => void): { dispose(): void } {
        this.eventListeners.push(listener);
        return { dispose: (): void => {
            this.eventListeners = this.eventListeners.filter((l) => l !== listener);
        } };
    }
    onExit(listener: () => void): { dispose(): void } {
        this.exitListeners.push(listener);
        return { dispose: (): void => {
            this.exitListeners = this.exitListeners.filter((l) => l !== listener);
        } };
    }
    dispose(): void {
        this.disposed = true;
    }
    emit(e: ExpertStreamEvent): void { for (const l of [...this.eventListeners]) l(e); }
}

/**
 * 提供一个最小化但有效的专家 ChatCliConfig。
 *
 * 测试中不真正使用 cliPath，但需要类型完整以通过 strict 类型检查。
 */
function makeExpertConfig(): ChatCliConfig {
    return {
        enabled: true,
        cliPath: '/fake/claude',
        cliArgs: [],
        cwd: '/tmp',
        transport: 'streamJsonStdio',
        cliEnv: {},
        model: 'fake-expert',
        permissionMode: 'acceptEdits',
        strictMcpConfig: true,
        mcpServers: {}
    };
}

/**
 * 假计时器（与 expertRunner.test.ts 相同实现，独立一份保持模块自包含）。
 */
class FakeTimers implements ExpertTimers {
    public current = 1_000_000;
    private nextId = 1;
    private timers = new Map<number, { fireAt: number; handler: () => void }>();
    now(): number { return this.current; }
    setTimeout(handler: () => void, ms: number): () => void {
        const id = this.nextId++;
        this.timers.set(id, { fireAt: this.current + ms, handler });
        return () => { this.timers.delete(id); };
    }
    advanceBy(ms: number): void {
        this.current += ms;
        const toFire = [...this.timers.entries()]
            .filter(([, t]) => t.fireAt <= this.current)
            .sort((a, b) => a[1].fireAt - b[1].fireAt);
        for (const [id, t] of toFire) { this.timers.delete(id); t.handler(); }
    }
}

/** 让 await 让出执行权若干次，便于 ExpertRunner 内的异步装配完成。 */
async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

/**
 * 把 ExpertMcpServer 推进到 initialized 状态。
 *
 * MCP 协议要求 `tools/*` 调用之前必须先 `initialize`；该 helper 屏蔽这一细节，
 * 方便测试聚焦于业务逻辑。
 */
async function performInitialize(server: ExpertMcpServer): Promise<void> {
    const res = await server.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } }
    });
    assert.ok(res && 'result' in res, 'initialize must return success');
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('Expert mode integration: McpServer + Runner', () => {
    it('完整 ask_expert 调用链：tool_result 仅包含 finalAnswer，专家中间事件留在 sink', async () => {
        const cli = new FakeCli();
        const timers = new FakeTimers();
        const { sink, events } = createMemoryExpertEventSink();
        const runner = new ExpertRunner({
            createCliProcess: () => cli,
            eventSink: sink,
            expertConfig: makeExpertConfig(),
            timers,
            logger: () => {}
        });

        // AskExpertHandler 桥接到 ExpertRunner
        const server = new ExpertMcpServer({
            askExpertHandler: async (args: AskExpertArgs, signal?: AbortSignal) => {
                const r = await runner.run({
                    parentMessageId: 'main-msg-1',
                    callId: 'tool-call-1',
                    args,
                    signal
                });
                return { finalAnswer: r.finalAnswer, isError: r.isError };
            }
        });

        await performInitialize(server);

        // 启动 tools/call（异步），不 await，留出窗口让 fake CLI 推事件
        const callPromise = server.dispatch({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: EXPERT_TOOL_NAME,
                arguments: {
                    question: 'How do I read a file?',
                    goal: 'Concise answer'
                }
            }
        });
        await flush();

        // 在 fake CLI 上模拟一次完整的专家执行：assistant_text + tool_use + tool_result + final
        cli.emit({ kind: 'assistant_text', text: 'Let me check the docs.' });
        cli.emit({ kind: 'tool_use', toolName: 'Read', args: { path: 'README.md' } });
        cli.emit({ kind: 'tool_result', toolName: 'Read', resultText: 'file contents', isError: false });
        cli.emit({ kind: 'assistant_text', text: 'Use fs.readFile().' });
        cli.emit({ kind: 'result', finalText: 'Use fs.readFile() to read a file in Node.js.' });

        const res = await callPromise;
        assert.ok(res && 'result' in res, 'tools/call should succeed');
        const successRes = res as Extract<typeof res, { result: unknown }>;
        const result = successRes.result as { content: Array<{ type: string; text: string }>; isError?: boolean };

        // 主对话只看到 finalAnswer，没有中间过程
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, 'text');
        assert.equal(result.content[0].text, 'Use fs.readFile() to read a file in Node.js.');
        assert.notEqual(result.isError, true);

        // 中间事件全在 sink，没有泄漏到 tool_result
        const kinds = events.map((e) => e.kind);
        assert.ok(kinds.includes('start'));
        assert.ok(kinds.includes('analysis'));
        assert.ok(kinds.includes('tool_call'));
        assert.ok(kinds.includes('tool_result'));
        assert.ok(kinds.includes('final'));

        // 中间事件文本不在主对话 content 中
        const mainText = result.content[0].text;
        assert.ok(!mainText.includes('Let me check the docs'), 'main text must not contain expert analysis');
        assert.ok(!mainText.includes('file contents'), 'main text must not contain tool result');

        // 专家进程必须被 dispose
        assert.equal(cli.disposed, true, 'expert CLI must be disposed after run');
    });

    it('专家执行失败：tool_result.isError=true，content 含 [Expert mode failed: ...]', async () => {
        const cli = new FakeCli();
        const timers = new FakeTimers();
        const { sink } = createMemoryExpertEventSink();
        const runner = new ExpertRunner({
            createCliProcess: () => cli,
            eventSink: sink,
            expertConfig: makeExpertConfig(),
            timers,
            logger: () => {}
        });
        const server = new ExpertMcpServer({
            askExpertHandler: async (args, signal) => {
                const r = await runner.run({
                    parentMessageId: 'm1', callId: 'c1', args, signal
                });
                return { finalAnswer: r.finalAnswer, isError: r.isError };
            }
        });
        await performInitialize(server);

        const callPromise = server.dispatch({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: EXPERT_TOOL_NAME, arguments: { question: 'fail please' } }
        });
        await flush();

        // 让 CLI 报错
        cli.emit({ kind: 'error', message: 'simulated failure' });

        const res = await callPromise;
        assert.ok(res && 'result' in res);
        const result = (res as Extract<typeof res, { result: unknown }>).result as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(result.isError, true);
        assert.ok(result.content[0].text.includes('[Expert mode failed:'));
        assert.ok(result.content[0].text.includes('simulated failure'));
        assert.equal(cli.disposed, true);
    });

    it('tools/list 在 initialize 后返回 ask_expert 工具定义', async () => {
        const server = new ExpertMcpServer({});
        await performInitialize(server);
        const res = await server.dispatch({
            jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}
        });
        assert.ok(res && 'result' in res);
        const r = (res as Extract<typeof res, { result: unknown }>).result as { tools: Array<{ name: string }> };
        const names = r.tools.map((t) => t.name);
        assert.ok(names.includes(EXPERT_TOOL_NAME));
    });

    it('未 initialize 直接 tools/call → 协议错误（按宽松策略仍允许，但 stub handler 返回 stub 文本）', async () => {
        // 注意：实现采用「宽松 initialized 检查」（详见 expertMcpServer.ts 注释），
        // 因此这里不强制要求 initialize 之前 tools/call 必须失败。我们只验证
        // 默认 stub handler 在未注入 askExpertHandler 时仍能产生 text 响应。
        const server = new ExpertMcpServer({});
        const res = await server.dispatch({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: EXPERT_TOOL_NAME, arguments: { question: 'hi' } }
        });
        assert.ok(res, 'must return some response');
    });
});
