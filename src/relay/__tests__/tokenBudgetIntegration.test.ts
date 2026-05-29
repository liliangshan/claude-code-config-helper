/**
 * @file Token 预算自动压缩集成测试。
 *
 * 不启动 VS Code 进程，使用模块 mock 跳过 vscode 与 logger，校验：
 *  1. afterRecv 触达阈值后向 CLI 发送原生 /compact；
 *  2. 压缩在途时不会重复发送 /compact；
 *  3. 发送失败时 notifier 发出 failed，旧桶 inProgress 复位。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as { _resolveFilename: (request: string, parent: NodeJS.Module) => string; _cache: Record<string, NodeJS.Module> };
const moduleAny = Module as unknown as {
    _resolveFilename: (request: string, parent: NodeJS.Module) => string;
    _cache: Record<string, NodeJS.Module>;
};
const originalResolveFilename = moduleAny._resolveFilename;
const fakeVscodeId = 'fake://vscode-int';
const fakeLoggerId = 'fake://logger-int';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lls-token-budget-int-'));
moduleAny._resolveFilename = function (request: string, parent: NodeJS.Module): string {
    if (request === 'vscode') return fakeVscodeId;
    if (request === '../../logger' || request.endsWith('/logger')) return fakeLoggerId;
    return originalResolveFilename.call(this, request, parent);
};
moduleAny._cache[fakeVscodeId] = {
    id: fakeVscodeId,
    filename: fakeVscodeId,
    loaded: true,
    exports: {
        EventEmitter: class FakeEventEmitter<T> {
            private listeners: Array<(value: T) => void> = [];
            public readonly event = (handler: (value: T) => void): { dispose: () => void } => {
                this.listeners.push(handler);
                return { dispose: () => { this.listeners = this.listeners.filter(l => l !== handler); } };
            };
            public fire(value: T): void { for (const l of this.listeners.slice()) l(value); }
            public dispose(): void { this.listeners = []; }
        },
        workspace: { workspaceFolders: [{ uri: { fsPath: tmpRoot } }] }
    }
} as unknown as NodeJS.Module;
moduleAny._cache[fakeLoggerId] = {
    id: fakeLoggerId,
    filename: fakeLoggerId,
    loaded: true,
    exports: { Logger: { init() {}, info() {}, warn() {}, error() {} } }
} as unknown as NodeJS.Module;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const serviceMod = require('../tokenBudget/service') as typeof import('../tokenBudget/service');
const { TokenBudgetService, CLAUDE_COMPACT_COMMAND } = serviceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TokenCountStore } = require('../tokenBudget/store') as typeof import('../tokenBudget/store');

function makeConfigManager(): { getProvider: (id: string) => unknown } {
    return {
        getProvider: (id: string) => ({ id, models: [{ modelId: 'm', contextLength: 100000 }] })
    };
}

async function flushAsync(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
}

test('集成：触达阈值 → 向 CLI 发送原生 /compact', async () => {
    const sentCommands: string[] = [];
    const events: Array<{ kind: string; payload: unknown }> = [];

    const service: any = new TokenBudgetService({
        configManager: makeConfigManager() as any,
        commandSender: async (command: string) => { sentCommands.push(command); },
        notifier: {
            notifyCompactionState: (state: any) => events.push({ kind: state.kind, payload: state })
        }
    });
    service.store = new TokenCountStore();
    service.loaded = true;

    service.beforeSend({
        sessionId: 's-old', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.afterRecv({
        sessionId: 's-old', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 50000 },
        requestBodyAtSend: ''
    });

    await flushAsync();

    assert.deepEqual(sentCommands, [CLAUDE_COMPACT_COMMAND]);
    assert.deepEqual(events.map((e) => e.kind), []);
    const bucket = service.store.getSession('s-old');
    assert.equal(bucket.compact.inProgress, true);
    assert.equal(bucket.compact.triggerCount, 0);
});

test('集成：压缩在途互斥 → 第二次 afterRecv 不再发送 /compact', async () => {
    const sentCommands: string[] = [];
    const service: any = new TokenBudgetService({
        configManager: makeConfigManager() as any,
        commandSender: async (command: string) => { sentCommands.push(command); },
        notifier: { notifyCompactionState: () => undefined }
    });
    service.store = new TokenCountStore();
    service.loaded = true;

    service.beforeSend({
        sessionId: 's-old-2', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.afterRecv({
        sessionId: 's-old-2', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 50000 },
        requestBodyAtSend: ''
    });
    await flushAsync();
    service.afterRecv({
        sessionId: 's-old-2', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 60000 },
        requestBodyAtSend: ''
    });
    await flushAsync();

    assert.deepEqual(sentCommands, [CLAUDE_COMPACT_COMMAND]);
});

test('集成：含 ask_expert tool_use/tool_result pair 的会话触达阈值仍按 session 发送一次 /compact', async () => {
    // 回归：主对话里有 ask_expert 的 tool_use 与配对 tool_result 时，token budget
    // 仍以原生 /compact 形式委托 CLI 压缩，不会在 Relay 侧自行截断半个 pair。
    const sentCommands: string[] = [];
    const service: any = new TokenBudgetService({
        configManager: makeConfigManager() as any,
        commandSender: async (command: string) => { sentCommands.push(command); },
        notifier: { notifyCompactionState: () => undefined }
    });
    service.store = new TokenCountStore();
    service.loaded = true;

    const bodyWithPair = JSON.stringify({
        messages: [
            { role: 'user', content: [{ type: 'text', text: '请用专家分析' }] },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: '委托专家' },
                    { type: 'tool_use', id: 'toolu_ask_p', name: 'mcp__askExpert__ask_expert', input: { question: 'q' } }
                ]
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_ask_p', content: '专家结论' }]
            }
        ]
    });

    service.beforeSend({
        sessionId: 's-pair', providerId: 'p1', modelId: 'm',
        anthropicBody: bodyWithPair
    });
    service.afterRecv({
        sessionId: 's-pair', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 50000 },
        requestBodyAtSend: ''
    });
    await flushAsync();

    // 仅发送一次原生 /compact；pair 结构由 CLI 内部压缩处理，Relay 不拆 pair。
    assert.deepEqual(sentCommands, [CLAUDE_COMPACT_COMMAND]);
    const bucket = service.store.getSession('s-pair');
    assert.equal(bucket.compact.inProgress, true);
});

test('集成：主 CLI 与专家 sub-turn 并发命中同一 Relay 时按各自 sessionId 独立计量，不误判', async () => {
    // 回归：专家 sub-turn 走独立 sessionId（无历史），不应与主 CLI 的 session 共享
    // token 桶。主 session 达阈值触发 /compact，专家 session 不应被牵连触发。
    const sentCommands: string[] = [];
    const service: any = new TokenBudgetService({
        configManager: makeConfigManager() as any,
        commandSender: async (command: string) => { sentCommands.push(command); },
        notifier: { notifyCompactionState: () => undefined }
    });
    service.store = new TokenCountStore();
    service.loaded = true;

    // 主 CLI session：大上下文，达阈值。
    service.beforeSend({
        sessionId: 's-main', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'main' }] })
    });
    // 专家 sub-turn session：小上下文（无历史），远低于阈值。
    service.beforeSend({
        sessionId: 's-expert-subturn', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'expert q' }] })
    });

    service.afterRecv({
        sessionId: 's-main', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 50000 },
        requestBodyAtSend: ''
    });
    service.afterRecv({
        sessionId: 's-expert-subturn', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 500 },
        requestBodyAtSend: ''
    });
    await flushAsync();

    // 仅主 session 触发一次 /compact；专家 session 桶不在压缩中。
    assert.deepEqual(sentCommands, [CLAUDE_COMPACT_COMMAND]);
    assert.equal(service.store.getSession('s-main').compact.inProgress, true);
    assert.equal(service.store.getSession('s-expert-subturn').compact.inProgress, false);
});

test('集成：发送 /compact 失败 → notifier failed + inProgress 复位', async () => {
    const events: Array<{ kind: string; payload: any }> = [];
    const service: any = new TokenBudgetService({
        configManager: makeConfigManager() as any,
        commandSender: async () => { throw new Error('stdin closed'); },
        notifier: { notifyCompactionState: (state: any) => events.push({ kind: state.kind, payload: state }) }
    });
    service.store = new TokenCountStore();
    service.loaded = true;

    service.beforeSend({
        sessionId: 's-old-3', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.afterRecv({
        sessionId: 's-old-3', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 50000 },
        requestBodyAtSend: ''
    });
    await flushAsync();

    assert.deepEqual(events.map((e) => e.kind), ['failed']);
    assert.match(String(events[0].payload.error), /stdin closed/);
    const bucket = service.store.getSession('s-old-3');
    assert.equal(bucket.compact.inProgress, false);
    assert.equal(bucket.compact.lastOutcome, 'failed');
});
