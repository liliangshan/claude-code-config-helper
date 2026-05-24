/**
 * @file ExpertRunner 单元测试。
 *
 * 使用 fake CLI 与 fake timer，验证以下分支：
 * 1. CLI 推送 `result` → 正常完成，dispose 被调用；
 * 2. 总超时 → settle('timeout') + dispose + error event；
 * 3. 空闲超时 → settle('idle_timeout') + dispose；
 * 4. 步数上限 → settle('max_steps') + dispose；
 * 5. AbortSignal → settle('cancelled') + cancelled event；
 * 6. CLI 异常退出 → settle('cli_exit') + error event；
 * 7. inFlight 冲突 → 立即失败、不 spawn 第二个进程；
 * 8. finalText 缺失时回退拼接 collectedTexts；
 * 9. tool_use / tool_result 事件被正确转发；
 * 10. send() 接收到包含 question 的 user 消息行。
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { ExpertRunner } from '../expertRunner';
import type {
    ExpertCliProcessLike,
    ExpertRunnerDeps,
    ExpertStreamEvent,
    ExpertTimers
} from '../expertRunner';
import { createMemoryExpertEventSink } from '../expertEvents';
import type { ChatCliConfig } from '../../chat/cli/types';
import {
    EXPERT_IDLE_TIMEOUT_MS,
    EXPERT_MAX_STEPS,
    EXPERT_TIMEOUT_MS
} from '../expertConstants';

// ---------------------------------------------------------------------------
// 测试辅助：FakeTimers + FakeCli
// ---------------------------------------------------------------------------

/**
 * 假计时器：手动推进时间，触发到期的 setTimeout 回调。
 */
class FakeTimers implements ExpertTimers {
    public current = 1_000_000; // 任意非零起点
    private nextId = 1;
    private timers = new Map<number, { fireAt: number; handler: () => void }>();

    now(): number {
        return this.current;
    }

    setTimeout(handler: () => void, ms: number): () => void {
        const id = this.nextId++;
        this.timers.set(id, { fireAt: this.current + ms, handler });
        return () => {
            this.timers.delete(id);
        };
    }

    /** 推进时间至指定时刻，触发所有到期 timer（按 fireAt 升序）。 */
    advanceTo(targetMs: number): void {
        this.current = targetMs;
        const toFire = [...this.timers.entries()]
            .filter(([, t]) => t.fireAt <= targetMs)
            .sort((a, b) => a[1].fireAt - b[1].fireAt);
        for (const [id, t] of toFire) {
            this.timers.delete(id);
            t.handler();
        }
    }

    /** 推进时间相对量。 */
    advanceBy(ms: number): void {
        this.advanceTo(this.current + ms);
    }
}

/**
 * 假 CLI：手动驱动 onEvent / onExit。
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
    send(jsonLine: string): void {
        this.sentLines.push(jsonLine);
    }
    onEvent(listener: (e: ExpertStreamEvent) => void): { dispose(): void } {
        this.eventListeners.push(listener);
        return {
            dispose: (): void => {
                this.eventListeners = this.eventListeners.filter((l) => l !== listener);
            }
        };
    }
    onExit(listener: () => void): { dispose(): void } {
        this.exitListeners.push(listener);
        return {
            dispose: (): void => {
                this.exitListeners = this.exitListeners.filter((l) => l !== listener);
            }
        };
    }
    dispose(): void {
        this.disposed = true;
    }

    /** 测试用：广播一条事件。 */
    emit(event: ExpertStreamEvent): void {
        for (const l of [...this.eventListeners]) l(event);
    }

    /** 测试用：模拟 CLI 进程退出。 */
    emitExit(): void {
        for (const l of [...this.exitListeners]) l();
    }
}

/**
 * 标准化的测试夹具构建器。
 */
function makeFixture(opts?: { signal?: AbortSignal }): {
    runner: ExpertRunner;
    cli: FakeCli;
    timers: FakeTimers;
    events: ReturnType<typeof createMemoryExpertEventSink>['events'];
    runArgs: Parameters<ExpertRunner['run']>[0];
} {
    const cli = new FakeCli();
    const timers = new FakeTimers();
    const { sink, events } = createMemoryExpertEventSink();
    const expertConfig: ChatCliConfig = {
        enabled: true,
        cliPath: '/fake/claude',
        cliArgs: [],
        cwd: '/tmp',
        transport: 'streamJsonStdio',
        cliEnv: {},
        model: 'fake-expert-model',
        permissionMode: 'acceptEdits',
        strictMcpConfig: true,
        mcpServers: {}
    };

    const deps: ExpertRunnerDeps = {
        createCliProcess: () => cli,
        eventSink: sink,
        expertConfig,
        timers,
        logger: () => {}
    };
    const runner = new ExpertRunner(deps);

    const runArgs: Parameters<ExpertRunner['run']>[0] = {
        parentMessageId: 'msg-1',
        callId: 'tool_use-1',
        args: {
            question: 'What is the answer?',
            goal: 'Explain clearly',
            constraints: 'No external libraries'
        },
        signal: opts?.signal
    };

    return { runner, cli, timers, events, runArgs };
}

/**
 * 在 microtask 边界推进一次，确保 await 链交出执行权。
 */
async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('ExpertRunner', () => {
    let fixture: ReturnType<typeof makeFixture>;

    beforeEach(() => {
        fixture = makeFixture();
    });

    it('正常完成：result 事件 → completed + disposed + final 事件', async () => {
        const { runner, cli, events, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        // 验证 start 事件已推送
        assert.equal(events[0].kind, 'start');
        assert.equal(events[0].question, 'What is the answer?');
        assert.equal(events[0].expertModel, 'fake-expert-model');

        // 验证 send() 被调用，且 payload 包含问题
        assert.equal(cli.sentLines.length, 1);
        const sentObj = JSON.parse(cli.sentLines[0]);
        assert.equal(sentObj.type, 'user');
        assert.ok(sentObj.message.content.includes('What is the answer?'));
        assert.ok(sentObj.message.content.includes('Explain clearly'));

        cli.emit({ kind: 'assistant_text', text: 'partial answer' });
        cli.emit({ kind: 'message_end' });
        cli.emit({ kind: 'result', finalText: 'final answer' });

        const result = await runPromise;
        assert.equal(result.endReason, 'completed');
        assert.equal(result.isError, false);
        assert.equal(result.finalAnswer, 'final answer');
        assert.equal(cli.disposed, true);

        const finalEv = events.find((e) => e.kind === 'final');
        assert.ok(finalEv, 'final event must be present');
        assert.equal(finalEv!.text, 'final answer');
    });

    it('CLI 未提供 finalText 时回退拼接 assistant 文本', async () => {
        const { runner, cli, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        cli.emit({ kind: 'assistant_text', text: 'part-1' });
        cli.emit({ kind: 'assistant_text', text: 'part-2' });
        cli.emit({ kind: 'result' }); // 无 finalText

        const result = await runPromise;
        assert.equal(result.endReason, 'completed');
        assert.equal(result.finalAnswer, 'part-1\npart-2');
    });

    it('总超时 → settle("timeout") + 错误 final', async () => {
        const { runner, cli, timers, events, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        // 总超时 30min、idle 5min；用「每 ~4min 注入一条事件」的方式持续重置 idle，
        // 直到累计超过总超时阈值，从而单独触发 timeout 分支。
        const tickMs = EXPERT_IDLE_TIMEOUT_MS - 60_000; // 4min
        let elapsed = 0;
        while (elapsed < EXPERT_TIMEOUT_MS + 1) {
            timers.advanceBy(tickMs);
            elapsed += tickMs;
            cli.emit({ kind: 'assistant_text', text: 'keepalive' });
            await flush();
        }

        const result = await runPromise;
        assert.equal(result.endReason, 'timeout');
        assert.equal(result.isError, true);
        assert.ok(result.finalAnswer.includes('[Expert mode failed: timeout]'));

        const errEv = events.find((e) => e.kind === 'error');
        assert.ok(errEv, 'error event expected');
    });

    it('空闲超时 → settle("idle_timeout")', async () => {
        const { runner, cli, timers, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        // 推进略小于 idle 上限，再来个事件重置 idle
        timers.advanceBy(EXPERT_IDLE_TIMEOUT_MS - 1);
        cli.emit({ kind: 'assistant_text', text: 'still alive' });
        // 再推进略小于 idle 上限，但累计已超过总 idle，无新事件 → 触发 idle
        timers.advanceBy(EXPERT_IDLE_TIMEOUT_MS + 1);

        const result = await runPromise;
        assert.equal(result.endReason, 'idle_timeout');
        assert.equal(result.isError, true);
    });

    it('步数上限 → settle("max_steps")', async () => {
        const { runner, cli, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        for (let i = 0; i < EXPERT_MAX_STEPS; i++) {
            cli.emit({ kind: 'tool_use', toolName: 'Read', args: { i } });
        }

        const result = await runPromise;
        assert.equal(result.endReason, 'max_steps');
        assert.equal(result.isError, true);
        assert.equal(fixture.cli.disposed, true);
    });

    it('AbortSignal → settle("cancelled") + cancelled 事件', async () => {
        const ac = new AbortController();
        fixture = makeFixture({ signal: ac.signal });
        const { runner, events, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        ac.abort();

        const result = await runPromise;
        assert.equal(result.endReason, 'cancelled');
        assert.equal(result.isError, true);

        const cancelledEv = events.find((e) => e.kind === 'cancelled');
        assert.ok(cancelledEv, 'cancelled event expected');
    });

    it('AbortSignal 在 run 开始前已 abort → 立即取消', async () => {
        const ac = new AbortController();
        ac.abort();
        fixture = makeFixture({ signal: ac.signal });
        const { runner, runArgs } = fixture;

        const result = await runner.run(runArgs);
        assert.equal(result.endReason, 'cancelled');
        assert.equal(result.isError, true);
    });

    it('CLI 异常退出 → settle("cli_exit")', async () => {
        const { runner, cli, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        cli.emitExit();

        const result = await runPromise;
        assert.equal(result.endReason, 'cli_exit');
        assert.equal(result.isError, true);
    });

    it('CLI 报错事件 → settle("cli_error") 带 message', async () => {
        const { runner, cli, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        cli.emit({ kind: 'error', message: 'spawn failed' });

        const result = await runPromise;
        assert.equal(result.endReason, 'cli_error');
        assert.ok(result.finalAnswer.includes('spawn failed'));
    });

    it('并发 run → 第二次立即失败', async () => {
        const { runner, runArgs } = fixture;
        const first = runner.run(runArgs);
        await flush();

        const second = await runner.run({
            ...runArgs,
            parentMessageId: 'msg-2',
            callId: 'tool_use-2'
        });
        assert.equal(second.endReason, 'internal_error');
        assert.ok(second.finalAnswer.includes('already in progress'));

        // 让第一次正常收尾
        fixture.cli.emit({ kind: 'result', finalText: 'ok' });
        const firstResult = await first;
        assert.equal(firstResult.endReason, 'completed');
    });

    it('tool_use 与 tool_result 事件被转发并附带 isError 字段', async () => {
        const { runner, cli, events, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();

        cli.emit({ kind: 'tool_use', toolName: 'Bash', args: { command: 'ls' } });
        cli.emit({
            kind: 'tool_result',
            toolName: 'Bash',
            resultText: 'permission denied',
            isError: true
        });
        cli.emit({ kind: 'result', finalText: 'done' });

        await runPromise;

        const toolCall = events.find((e) => e.kind === 'tool_call');
        const toolResult = events.find((e) => e.kind === 'tool_result');
        assert.equal(toolCall?.toolName, 'Bash');
        assert.deepEqual(toolCall?.toolArgs, { command: 'ls' });
        assert.equal(toolResult?.toolName, 'Bash');
        assert.equal(toolResult?.toolIsError, true);
        assert.equal(toolResult?.toolResultSummary, 'permission denied');
    });

    it('CLI 启动时使用注入的 expertConfig', async () => {
        const { runner, cli, runArgs } = fixture;
        const runPromise = runner.run(runArgs);
        await flush();
        cli.emit({ kind: 'result', finalText: 'done' });
        await runPromise;
        assert.equal(cli.startedWith?.model, 'fake-expert-model');
        assert.equal(cli.startedWith?.strictMcpConfig, true);
    });
});
