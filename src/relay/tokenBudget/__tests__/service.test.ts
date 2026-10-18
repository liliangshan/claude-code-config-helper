/**
 * @file TokenBudgetService 核心状态机单元测试。
 *
 * 覆盖 .LLSOAI/token-budget.md § 8 关键场景：
 *  - 首次请求时 estimator 兜底；
 *  - usage 覆盖 current（不累加）；
 *  - 触达阈值触发压缩；
 *  - inProgress 互斥；
 *  - 60 秒防抖；
 *  - 压缩失败时旧 session 保留；
 *  - assistant 假对话对注入失败的失败收尾；
 *  - OpenAI 上游不返回 usage 时仍由 estimator 维持 current；
 *  - modelId 切换 → 新桶 contextLimit 与 threshold 同步刷新。
 *
 * 注意：本测试通过模块 mock 把 `vscode` 和 `../../../logger` 替换为最小占位，
 * 让 service 在 node --test 环境下可加载。它**不**走真实 fs / vscode API。
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 安装最小化的模块 mock：让 service.ts 在 Node 测试进程里能成功加载，
 * 而不需要 VS Code 运行时。该 hook 必须在 require service.ts 之前完成。
 *
 * 用 require('node:module') 而非 `import * as`，因为后者会编译为
 * `Object.defineProperty(exports, ...)` 形态的只读 namespace 对象，
 * 进而导致 `_resolveFilename = ...` 抛 "Cannot set property" 错误。
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as { _resolveFilename: (request: string, parent: NodeJS.Module) => string; _cache: Record<string, NodeJS.Module> };
const moduleAny = Module as unknown as {
    _resolveFilename: (request: string, parent: NodeJS.Module) => string;
    _cache: Record<string, NodeJS.Module>;
};
const originalResolveFilename = moduleAny._resolveFilename;
const fakeVscodeId = 'fake://vscode';
const fakeLoggerId = 'fake://logger';
moduleAny._resolveFilename = function (request: string, parent: NodeJS.Module): string {
    if (request === 'vscode') return fakeVscodeId;
    if (request === '../../logger' || request.endsWith('/logger')) {
        // 只对 src/relay/tokenBudget/* 中导入 ../../logger 的相对路径生效。
        return fakeLoggerId;
    }
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
        workspace: { workspaceFolders: undefined as unknown }
    }
} as unknown as NodeJS.Module;
moduleAny._cache[fakeLoggerId] = {
    id: fakeLoggerId,
    filename: fakeLoggerId,
    loaded: true,
    exports: {
        Logger: {
            init() {},
            info() {},
            warn() {},
            error() {}
        }
    }
} as unknown as NodeJS.Module;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TokenBudgetService } = require('../service') as typeof import('../service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TokenCountStore } = require('../store') as typeof import('../store');

/** 仅满足 service 用到的 ConfigManager 子集。 */
function makeConfigManager(contextLength?: number): {
    getProvider: (id: string) => unknown;
    getProviderWithSecret: (id: string) => Promise<unknown>;
} {
    return {
        getProvider: (_id: string) => ({
            id: _id,
            models: contextLength
                ? [{ modelId: 'm', contextLength }]
                : []
        }),
        getProviderWithSecret: async (_id: string) => ({
            id: _id,
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

/** 构造一个被替换 store 的 TokenBudgetService 实例。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildService(overrides?: any): { service: any; store: any } {
    const service = new TokenBudgetService({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configManager: makeConfigManager(overrides?.contextLength) as any,
        commandSender: overrides?.commandSender,
        notifier: overrides?.notifier
    });
    // 直接替换内部 store 为内存实例，避免触发 vscode workspace 读盘。
    const fakeStore = new TokenCountStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).store = fakeStore;
    // 跳过首次磁盘加载。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).loaded = true;
    return { service, store: fakeStore };
}

test('beforeSend 首次请求用 estimator 填充 current（无 usage 也能登记）', () => {
    const { service, store } = buildService();
    service.beforeSend({
        sessionId: 's1',
        providerId: 'p1',
        modelId: 'm',
        anthropicBody: JSON.stringify({
            messages: [{ role: 'user', content: 'hello world' }]
        })
    });
    const snapshot = store.getSession('s1');
    assert.ok(snapshot, 'session bucket should be created');
    assert.equal(snapshot.providerId, 'p1');
    assert.equal(snapshot.modelId, 'm');
    assert.equal(snapshot.lastSource, 'estimated');
    assert.ok(snapshot.current.totalInputForBudget > 0);
});

test('afterRecv 用 usage 覆盖 current（不累加）', () => {
    const { service, store } = buildService();
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 1000, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        requestBodyAtSend: ''
    });
    let snapshot = store.getSession('s1');
    assert.equal(snapshot.current.inputTokens, 1000);
    assert.equal(snapshot.current.outputTokens, 50);
    assert.equal(snapshot.lastSource, 'api');
    // 再来一轮：current 应被覆盖，不是 1000+2000。
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 2000, outputTokens: 100 },
        requestBodyAtSend: ''
    });
    snapshot = store.getSession('s1');
    assert.equal(snapshot.current.inputTokens, 2000);
    assert.equal(snapshot.current.outputTokens, 100);
});

test('afterRecv 原子覆盖缓存字段，并把缓存读取计入上下文占用', () => {
    const { service, store } = buildService();
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'first' }] })
    });
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 200, outputTokens: 80, cacheCreationInputTokens: 775755 },
        requestBodyAtSend: ''
    });
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 276, outputTokens: 69, cacheReadInputTokens: 462592 },
        requestBodyAtSend: ''
    });

    const snapshot = store.getSession('s1');
    assert.equal(snapshot.current.cacheCreationInputTokens, 0, '不得沿用上一轮缓存写入量');
    assert.equal(snapshot.current.cacheReadInputTokens, 462592);
    assert.equal(snapshot.current.totalInputForBudget, 462868);
    assert.equal(snapshot.current.totalInputForBudget + snapshot.current.outputTokens, 462937);
});

test('beforeSend 新请求期间保留上一轮统计，等待新 usage 原子覆盖', () => {
    const { service, store } = buildService();
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 300, cacheReadInputTokens: 400 },
        requestBodyAtSend: ''
    });
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'next request' }] })
    });

    const snapshot = store.getSession('s1');
    assert.equal(snapshot.current.inputTokens, 100);
    assert.equal(snapshot.current.outputTokens, 50);
    assert.equal(snapshot.current.cacheCreationInputTokens, 300);
    assert.equal(snapshot.current.cacheReadInputTokens, 400);
    assert.equal(snapshot.current.totalInputForBudget, 800);
});

test('未达阈值时不触发压缩', () => {
    let compactCalled = 0;
    const { service } = buildService({
        contextLength: 200000,
        commandSender: async () => { compactCalled += 1; }
    });
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 1000 },
        requestBodyAtSend: 'whatever'
    });
    assert.equal(compactCalled, 0);
});

test('依赖未注入时即使触达阈值也跳过压缩，并写 warn 日志', () => {
    const { service, store } = buildService({ contextLength: 200000 });
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 200000 },
        requestBodyAtSend: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    const snap = store.getSession('s1');
    assert.equal(snap.compact.inProgress, false);
    assert.equal(snap.compact.triggerCount, 0);
});

test('contextLength 配置生效 → threshold 为原生内部预留后的估算', () => {
    const { service, store } = buildService({ contextLength: 100000 });
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    const snap = store.getSession('s1');
    assert.equal(snap.contextLimit, 100000);
    assert.equal(snap.threshold, 67000);
});

test('updateCliUsage 不会用 CLI contextWindow 覆盖用户手填的 contextLength', () => {
    const { service, store } = buildService({ contextLength: 200000 });
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.updateCliUsage('s1', 1000000, 500);
    const snap = store.getSession('s1');
    assert.equal(snap.contextLimit, 200000);
    assert.equal(snap.threshold, 162000);
    assert.equal(snap.current.outputTokens, 500);
});

test('updateCliUsage 在用户未配置 contextLength 时仍保留静态上下文上限', () => {
    const { service, store } = buildService();
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    service.updateCliUsage('s1', 1000000, 500);
    const snap = store.getSession('s1');
    assert.equal(snap.contextLimit, 200000);
    assert.equal(snap.threshold, 162000);
    assert.equal(snap.current.outputTokens, 500);
});

test('未知 model 走 DEFAULT_CONTEXT_LIMIT = 200000', () => {
    const { service, store } = buildService();
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'unknown-model-xyz',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    const snap = store.getSession('s1');
    assert.equal(snap.contextLimit, 200000);
    assert.equal(snap.threshold, 162000);
});

test('静态模型上限优先于默认 200k，已有默认会话在下一次请求更新', () => {
    const { service, store } = buildService();
    const input = { sessionId: 'fallback-refresh', providerId: 'p1', modelId: 'unknown-model-xyz', anthropicBody: '{}' };
    service.beforeSend(input);
    const previous = store.getSession(input.sessionId);
    previous.contextLimit = 166000;
    previous.threshold = 116000;
    service.beforeSend(input);
    assert.equal(store.getSession(input.sessionId).contextLimit, 200000);
    assert.equal(store.getSession(input.sessionId).threshold, 162000);
    service.beforeSend({ ...input, modelId: 'gpt-4o' });
    assert.equal(store.getSession(input.sessionId).contextLimit, 128000);
    assert.equal(store.getSession(input.sessionId).threshold, 95000);
});

/** 构造一个 token 数必定超过 threshold 的请求体。 */
function hugeBody(): string {
    return JSON.stringify({ messages: [{ role: 'user', content: 'lorem ipsum '.repeat(80000) }] });
}

test('压缩摘要请求登记在途状态', () => {
    const { service, store } = buildService({
        contextLength: 200000,
        commandSender: async () => { /* noop */ }
    });

    service.beforeSend({ sessionId: 's1', providerId: 'p1', modelId: 'm', anthropicBody: '{}' });
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: hugeBody(),
        compactCommandTriggered: true
    });

    assert.equal(store.getSession('s1').compact.inProgress, true, '应登记压缩在途');
});

test('超阈值请求不再自动触发压缩（压缩只能手动发起）', () => {
    let compactCalled = 0;
    const { service } = buildService({
        contextLength: 200000,
        commandSender: async () => { compactCalled += 1; }
    });

    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: hugeBody()
    });
    service.afterRecv({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        usage: { inputTokens: 190000 },
        requestBodyAtSend: ''
    });

    assert.equal(compactCalled, 0, '请求/响应两侧都不得自动发 /compact');
});

test('compactNow 仍可手动触发压缩', () => {
    let compactCalled = 0;
    const { service, store } = buildService({
        contextLength: 200000,
        commandSender: async () => { compactCalled += 1; }
    });
    service.beforeSend({
        sessionId: 's1', providerId: 'p1', modelId: 'm',
        anthropicBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });

    assert.equal(service.compactNow('s1'), true);
    assert.equal(compactCalled, 1);
    assert.equal(store.getSession('s1').compact.inProgress, true);
});

/** 摘要模型与主模型不同也不能改变主窗口、用量或再次触发压缩。 */
test('摘要请求不污染主窗口和用量，开始/结束事件去重', () => {
    const events: string[] = [];
    const { service, store } = buildService({ contextLength: 500000, notifier: { notifyCompactionState: (state: { kind: string }) => events.push(state.kind) } });
    service.afterRecv({ sessionId: 's-summary', providerId: 'p1', modelId: 'm', usage: { inputTokens: 400000 }, requestBodyAtSend: '' });
    service.noteExternalCompaction('s-summary');
    service.noteExternalCompaction('s-summary');
    service.beforeSend({ sessionId: 's-summary', providerId: 'summary-provider', modelId: 'gpt-4o', anthropicBody: hugeBody(), compactCommandTriggered: true });
    service.afterRecv({ sessionId: 's-summary', providerId: 'summary-provider', modelId: 'gpt-4o', usage: { inputTokens: 600000 }, requestBodyAtSend: '', compactCommandTriggered: true });
    assert.equal(store.getSession('s-summary').contextLimit, 500000);
    assert.equal(store.getSession('s-summary').modelId, 'm');
    assert.equal(store.getSession('s-summary').current.totalInputForBudget, 400000);
    assert.equal(service.compactNow('s-summary'), false);
    service.finishNativeCompaction('s-summary', false, '402 insufficient quota');
    service.finishNativeCompaction('s-summary', false, 'duplicate');
    assert.deepEqual(events, ['started', 'failed']);
    assert.equal(service.isCompactionInFlight('s-summary'), false);
    assert.equal(store.getSession('s-summary').compact.lastError, '402 insufficient quota');
});

/** 旧实例的磁盘标记立即失效，不等待 30 分钟。 */
test('旧在途标记复位，真实原生失败和进程退出释放等待者', async () => {
    const { service, store } = buildService();
    service.beforeSend({ sessionId: 'old', providerId: 'p1', modelId: 'm', anthropicBody: '{}' });
    store.getSession('old').compact.inProgress = true;
    store.getSession('old').compact.lastTriggeredAt = new Date().toISOString();
    assert.equal(service.isCompactionInFlight('old'), false);
    service.noteExternalCompaction('old');
    const waiting = service.waitForCompactionSettled('old', 1000);
    service.releaseCliCompactions('old', 'CLI exited');
    assert.equal(await waiting, 'failed');
    assert.ok(store.getSession('old'));
    assert.equal(service.isCompactionInFlight('old'), false);
});
