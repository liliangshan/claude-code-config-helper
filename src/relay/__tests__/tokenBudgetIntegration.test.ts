/**
 * @file Token 预算自动压缩端到端集成测试。
 *
 * 不启动 VS Code 进程，使用模块 mock 跳过 vscode 与 logger，串起
 * TokenBudgetService → CompactionClient（mock）→ SessionResetter（mock）→
 * SeedInjector（mock），校验：
 *  1. afterRecv 触达阈值后异步触发压缩；
 *  2. 压缩成功 → 旧桶归档、新桶创建、notifier 发出 started/finished；
 *  3. 假对话对注入失败 → notifier 发出 failed，旧桶 inProgress 复位、错误持久化。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

// 用 require('node:module') 而非 `import * as`，避免命名空间对象只读导致赋值失败。
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
const { TokenBudgetService } = serviceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TokenCountStore } = require('../tokenBudget/store') as typeof import('../tokenBudget/store');

/** 构造 ConfigManager 最小子集，模型 contextLength=100000 → threshold=40000。 */
function makeConfigManager(): {
    getProvider: (id: string) => unknown;
    getProviderWithSecret: (id: string) => Promise<unknown>;
} {
    return {
        getProvider: (id: string) => ({ id, models: [{ modelId: 'm', contextLength: 100000 }] }),
        getProviderWithSecret: async (id: string) => ({
            id,
            apiType: 'anthropic',
            authMode: 'api_key',
            apiKey: 'sk-x',
            baseUrl: 'https://example.test/v1',
            customHeaders: [],
            enabled: true,
            models: []
        })
    };
}

/** 等待若干 microtask 让异步压缩流程落定。 */
async function flushAsync(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
}

test('集成：触达阈值 → 压缩成功 → 切 session → notifier 推送 finished', async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    let compactionRunCount = 0;
    let resetCount = 0;
    let seedSentText = '';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service: any = new TokenBudgetService({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configManager: makeConfigManager() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compactionClient: ({
            run: async () => {
                compactionRunCount += 1;
                const summaryText = '## 任务目标\n演示压缩\n## 关键决策\n用 mock 上游\n## 未完成\n无\n'
                    + '## 约束\n无\n## 引用\n无\n' + 'x'.repeat(60);
                return {
                    ok: true,
                    summaryText,
                    wrapped: `<summ>${summaryText}</summ>`
                };
            }
        }) as any,
        sessionResetter: {
            reset: async () => {
                resetCount += 1;
                return { newSessionId: 's-new-1' };
            }
        },
        seedInjector: {
            sendUserMessage: async (text: string) => {
                seedSentText = text;
            }
        },
        notifier: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            notifyCompactionState: (state: any) => {
                events.push({ kind: state.kind, payload: state });
            }
        }
    });
    // 替换 store 为干净实例，避免污染其它测试。
    service.store = new TokenCountStore();
    service.loaded = true;

    service.beforeSend({
        sessionId: 's-old', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.afterRecv({
        sessionId: 's-old', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 50000 }, // > threshold 40000
        requestBodyAtSend: JSON.stringify({
            messages: [
                { role: 'user', content: 'history-msg-1' },
                { role: 'assistant', content: 'reply-1' }
            ]
        })
    });

    await flushAsync();

    assert.equal(compactionRunCount, 1, '压缩客户端应被调用一次');
    assert.equal(resetCount, 1, 'SessionResetter.reset 应被调用一次');
    assert.ok(seedSentText.includes('<CONTEXT>'), '假对话对必须包 <CONTEXT> 标签');
    assert.ok(seedSentText.includes('<summ>'), '假对话对必须包 <summ> 标签');
    assert.ok(seedSentText.includes('上下文已就绪'), '假对话对必须要求模型回复"上下文已就绪"');

    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['started', 'finished'], '应按顺序触发 started → finished');

    // 旧桶应被归档（store 中不再存在）。
    assert.equal(service.store.getSession('s-old'), undefined);
    // 新桶应存在，并把旧 sessionId 写入归档列表。
    const newBucket = service.store.getSession('s-new-1');
    assert.ok(newBucket, '新桶应已创建');
    assert.equal(newBucket.providerId, 'p1');
    assert.equal(newBucket.modelId, 'm');
    assert.equal(newBucket.compact.lastOutcome, 'success');
    assert.equal(newBucket.compact.lastBeforeTokens, 50000);
    assert.ok(newBucket.compact.archivedSessionIds.includes('s-old'));
    assert.ok((newBucket.compact.lastSummary || '').length > 0);
});

test('集成：假对话对注入失败 → notifier failed + 旧桶保留可用', async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service: any = new TokenBudgetService({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configManager: makeConfigManager() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compactionClient: ({
            run: async () => ({
                ok: true,
                summaryText: 'x'.repeat(200),
                wrapped: '<summ>' + 'x'.repeat(200) + '</summ>'
            })
        }) as any,
        sessionResetter: {
            reset: async () => ({ newSessionId: 's-new-2' })
        },
        seedInjector: {
            sendUserMessage: async () => {
                throw new Error('webview not ready');
            }
        },
        notifier: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            notifyCompactionState: (state: any) => events.push({ kind: state.kind, payload: state })
        }
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
        requestBodyAtSend: JSON.stringify({ messages: [{ role: 'user', content: 'history' }] })
    });

    await flushAsync();

    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['started', 'failed']);
    // 旧桶仍在 store 中（不丢上下文）。
    const bucket = service.store.getSession('s-old-2');
    assert.ok(bucket);
    assert.equal(bucket.compact.inProgress, false);
    assert.equal(bucket.compact.lastOutcome, 'failed');
    assert.match(String(bucket.compact.lastError), /webview not ready/);
});

test('集成：压缩在途互斥 → 第二次 afterRecv 不再触发 compactionClient', async () => {
    let runCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveCompaction: ((value: any) => void) | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service: any = new TokenBudgetService({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configManager: makeConfigManager() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compactionClient: ({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            run: () => new Promise<any>((resolve) => {
                runCount += 1;
                resolveCompaction = resolve;
            })
        }) as any,
        sessionResetter: { reset: async () => ({ newSessionId: 's-new-3' }) },
        seedInjector: { sendUserMessage: async () => undefined },
        notifier: { notifyCompactionState: () => undefined }
    });
    service.store = new TokenCountStore();
    service.loaded = true;

    service.beforeSend({
        sessionId: 's-old-3', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    // 第 1 次触达：启动压缩（pending）。
    service.afterRecv({
        sessionId: 's-old-3', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 50000 },
        requestBodyAtSend: JSON.stringify({ messages: [{ role: 'user', content: 'h' }] })
    });
    await flushAsync();
    // 第 2 次触达：因 inProgress=true 直接跳过。
    service.afterRecv({
        sessionId: 's-old-3', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 60000 },
        requestBodyAtSend: JSON.stringify({ messages: [{ role: 'user', content: 'h' }] })
    });
    await flushAsync();

    assert.equal(runCount, 1, '压缩客户端只能被并发触发一次');
    // 解开压缩，避免悬挂 Promise 影响后续 dispose。
    resolveCompaction?.({
        ok: true,
        summaryText: 'x'.repeat(200),
        wrapped: '<summ>' + 'x'.repeat(200) + '</summ>'
    });
    await flushAsync();
});
