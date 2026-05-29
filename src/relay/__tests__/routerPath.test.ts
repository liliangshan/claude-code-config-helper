/**
 * @file 本地 HTTP CLI path 路由解析与 Relay 归因测试。
 */

import * as assert from 'assert';
import * as http from 'http';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub({
    values: {
        claudeCodeConfigHelper: {
            'chat.compactionMode.project.enabled': true,
            'chat.compactionMode.project.model': 'p/compact-model'
        }
    },
    inspect: {
        claudeCodeConfigHelper: {
            'chat.compactionMode.project.enabled': { workspaceValue: true },
            'chat.compactionMode.project.model': { workspaceValue: 'p/compact-model' }
        }
    }
});

const { isRelayMessagesPath } = require('../server') as typeof import('../server');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRelayRouter, parseLocalCliPath } = require('../router') as typeof import('../router');
type RelayUpstreamRequestInfo = import('../router').RelayUpstreamRequestInfo;
type UpstreamAdapter = import('../router').UpstreamAdapter;
type ProviderConfig = import('../../types').ProviderConfig;
type LlsTaskService = import('../../llsTask/service').LlsTaskService;

/** 单个 path 解析测试用例。 */
interface TestCase {
    /** 测试名称。 */
    name: string;
    /** 测试函数。 */
    run: () => void | Promise<void>;
}

/** 构造测试用 provider。 */
function buildProvider(): ProviderConfig {
    return {
        id: 'p',
        name: 'Provider',
        baseUrl: 'https://example.test',
        apiType: 'anthropic',
        models: [],
        enabled: true,
        autoFetchModels: false,
        createdAt: 0,
        updatedAt: 0,
        authMode: 'api_key',
        customHeaders: [],
        apiKey: 'secret'
    };
}

/** 用临时 HTTP server 执行一次 router 请求。 */
async function requestRouter(
    path: string,
    onStart: (info: RelayUpstreamRequestInfo) => void,
    body: Record<string, unknown> = { model: 'p/same-model', messages: [] },
    onHandle?: () => void,
    llsTaskService?: LlsTaskService
): Promise<{ status: number; body: string; contentType: string }> {
    const provider = buildProvider();
    const adapter: UpstreamAdapter = {
        apiType: 'anthropic',
        async handle(ctx) {
            onHandle?.();
            ctx.res.statusCode = 200;
            ctx.res.setHeader('content-type', 'application/json');
            ctx.res.end(JSON.stringify({ ok: true }));
        }
    };
    const router = createRelayRouter({
        configManager: {
            getCurrentModel: () => ({ providerId: 'p', modelId: 'same-model' }),
            getProviderWithSecret: async () => provider
        } as never,
        adapters: [adapter],
        llsTaskService,
        onUpstreamRequestStart: onStart
    });
    const server = http.createServer((req, res) => { void router(req, res); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { status: response.status, body: await response.text(), contentType: response.headers.get('content-type') || '' };
    } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
}

/** 构造可计数的任务流续推前压缩标记服务桩。 */
function buildCountingPreContinueCompactionService(): LlsTaskService & { consumed: () => number } {
    let pending = true;
    let count = 0;
    return {
        hasActiveWorkflow: () => true,
        consumePreContinueCompactionPending: () => {
            if (!pending) return false;
            pending = false;
            count += 1;
            return true;
        },
        consumed: () => count
    } as LlsTaskService & { consumed: () => number };
}

/** 构造只暴露续推前压缩标记消费能力的任务流服务桩。 */
function buildPreContinueCompactionService(): LlsTaskService {
    let pending = true;
    return {
        hasActiveWorkflow: () => true,
        consumePreContinueCompactionPending: () => {
            if (!pending) return false;
            pending = false;
            return true;
        }
    } as LlsTaskService;
}

/** path 解析与 Relay 归因测试集合。 */
const tests: TestCase[] = [
    {
        name: '裸 /v1/messages 应兼容为 normal 路由',
        run: () => {
            assert.deepStrictEqual(parseLocalCliPath('/v1/messages'), {
                route: 'normal',
                upstreamPath: '/v1/messages'
            });
        }
    },
    {
        name: '/normal/v1/messages 应解析为 normal 路由',
        run: () => {
            assert.deepStrictEqual(parseLocalCliPath('/normal/v1/messages'), {
                route: 'normal',
                upstreamPath: '/v1/messages'
            });
        }
    },
    {
        name: '/expert/v1/messages 应解析为 expert 路由',
        run: () => {
            assert.deepStrictEqual(parseLocalCliPath('/expert/v1/messages'), {
                route: 'expert',
                upstreamPath: '/v1/messages'
            });
        }
    },
    {
        name: '/plan/v1/messages 应解析为 plan 路由',
        run: () => {
            assert.deepStrictEqual(parseLocalCliPath('/plan/v1/messages'), {
                route: 'plan',
                upstreamPath: '/v1/messages'
            });
        }
    },
    {
        name: '/review/v1/messages 应解析为 review 路由',
        run: () => {
            assert.deepStrictEqual(parseLocalCliPath('/review/v1/messages'), {
                route: 'review',
                upstreamPath: '/v1/messages'
            });
        }
    },
    {
        name: '未知 route 前缀应返回 undefined',
        run: () => {
            assert.strictEqual(parseLocalCliPath('/bad/v1/messages'), undefined);
        }
    },
    {
        name: 'route 前缀下的非 messages 路径只负责剥离 route',
        run: () => {
            assert.deepStrictEqual(parseLocalCliPath('/expert/other'), {
                route: 'expert',
                upstreamPath: '/other'
            });
        }
    },
    {
        name: 'Relay 命中路径应包含四路 CLI messages path',
        run: () => {
            assert.strictEqual(isRelayMessagesPath('/v1/messages'), true);
            assert.strictEqual(isRelayMessagesPath('/normal/v1/messages'), true);
            assert.strictEqual(isRelayMessagesPath('/expert/v1/messages'), true);
            assert.strictEqual(isRelayMessagesPath('/plan/v1/messages'), true);
            assert.strictEqual(isRelayMessagesPath('/review/v1/messages'), true);
            assert.strictEqual(isRelayMessagesPath('/plan/other'), false);
            assert.strictEqual(isRelayMessagesPath('/bad/v1/messages'), false);
        }
    },
    {
        name: 'Relay 生命周期归因应优先使用 path route 而不是 model',
        run: async () => {
            const starts: RelayUpstreamRequestInfo[] = [];
            const result = await requestRouter('/expert/v1/messages', (info) => starts.push(info));
            assert.strictEqual(result.status, 200);
            assert.strictEqual(JSON.parse(result.body).ok, true);
            assert.strictEqual(starts.length, 1);
            assert.strictEqual(starts[0].route, 'expert');
            assert.strictEqual(starts[0].providerId, 'p');
            assert.strictEqual(starts[0].modelId, 'same-model');
        }
    },
    {
        name: '/compact 请求应使用压缩专用模型而不是请求体模型',
        run: async () => {
            const starts: RelayUpstreamRequestInfo[] = [];
            const result = await requestRouter('/v1/messages', (info) => starts.push(info), {
                model: 'p/same-model',
                messages: [{ role: 'user', content: '/compact' }]
            });
            assert.strictEqual(result.status, 200);
            assert.strictEqual(starts.length, 1);
            assert.strictEqual(starts[0].providerId, 'p');
            assert.strictEqual(starts[0].modelId, 'compact-model');
            assert.strictEqual(JSON.parse(result.body).ok, true);
        }
    },
    {
        name: '任务流续推前 compact 标记命中时应直接返回 SSE 且不调用上游 adapter',
        run: async () => {
            const starts: RelayUpstreamRequestInfo[] = [];
            let handled = 0;
            const result = await requestRouter('/v1/messages', (info) => starts.push(info), {
                model: 'p/same-model',
                stream: true,
                messages: [
                    { role: 'user', content: [{ type: 'text', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' }] },
                    { role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far.' }
                ]
            }, () => { handled += 1; }, buildPreContinueCompactionService());
            assert.strictEqual(result.status, 200);
            assert.strictEqual(starts.length, 0);
            assert.strictEqual(handled, 0);
            assert.match(result.contentType, /text\/event-stream/);
            assert.match(result.body, /event: message_start/);
            assert.match(result.body, /event: content_block_delta/);
            assert.match(result.body, /Task-flow pre-continue compaction completed/);
        }
    },
    {
        name: '任务流续推前 compact 标记只应消费一次',
        run: async () => {
            const service = buildCountingPreContinueCompactionService();
            const firstStarts: RelayUpstreamRequestInfo[] = [];
            const first = await requestRouter('/v1/messages', (info) => firstStarts.push(info), {
                model: 'p/same-model',
                stream: true,
                messages: [
                    { role: 'user', content: '/compact' }
                ]
            }, undefined, service);
            assert.strictEqual(first.status, 200);
            assert.strictEqual(firstStarts.length, 0);
            assert.strictEqual(service.consumed(), 1);
            assert.match(first.contentType, /text\/event-stream/);

            const secondStarts: RelayUpstreamRequestInfo[] = [];
            const second = await requestRouter('/v1/messages', (info) => secondStarts.push(info), {
                model: 'p/same-model',
                stream: true,
                messages: [
                    { role: 'user', content: '/compact' }
                ]
            }, undefined, service);
            assert.strictEqual(second.status, 200);
            assert.strictEqual(secondStarts.length, 1);
            assert.strictEqual(secondStarts[0].modelId, 'compact-model');
            assert.strictEqual(JSON.parse(second.body).ok, true);
            assert.strictEqual(service.consumed(), 1);
        }
    },
    {
        name: 'Claude 内部 summary 压缩请求也应使用压缩专用模型',
        run: async () => {
            const starts: RelayUpstreamRequestInfo[] = [];
            const result = await requestRouter('/v1/messages', (info) => starts.push(info), {
                model: 'p/same-model',
                stream: true,
                messages: [
                    { role: 'user', content: [{ type: 'text', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' }] },
                    { role: 'assistant', content: [{ type: 'text', text: 'previous reply' }] },
                    { role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far.' }
                ]
            });
            assert.strictEqual(result.status, 200);
            assert.strictEqual(starts.length, 1);
            assert.strictEqual(starts[0].modelId, 'compact-model');
            assert.strictEqual(JSON.parse(result.body).ok, true);
        }
    }
];

/** 执行全部测试。 */
async function main(): Promise<void> {
    for (const test of tests) {
        await test.run();
        // eslint-disable-next-line no-console
        console.log(`✓ ${test.name}`);
    }
}

void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
});
