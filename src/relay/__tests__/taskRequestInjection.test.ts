/**
 * @file LLS 任务流请求注入轻量测试。
 *
 * 覆盖任务流注入路径，以及"诊断工具已被彻底移除"的回归断言。
 */

import * as assert from 'assert';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

// 被测模块在加载期就会解析 vscode 配置，桩必须先于 require 装好，
// 因此这里用 require 延迟加载而非静态 import。
installVscodeStub({ values: {} });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
    applyCacheTtlToRequest,
    buildSharedSystemPrompt,
    injectLlsTaskRequestBody,
    stripLegacyInjectedPromptArtifacts
} = require('../taskRequestInjection') as typeof import('../taskRequestInjection');

/** 单个测试用例。 */
interface TestCase {
    /** 测试名称。 */
    name: string;
    /** 测试函数。 */
    run: () => void;
}

/** 请求注入测试集合。 */
const tests: TestCase[] = [
    {
        name: '子智能体开关统一控制所有请求，Ask 保持原任务流规则',
        /** 覆盖默认、开启、关闭及再次开启，检查普通、执行、创建和标题侧轨。 */
        run: () => {
            for (const enabled of [undefined, true, false, true]) {
            for (const stage of ['execution', 'ordinary', 'creation', 'sideTrack']) {
                const fakeDeps = {
                    configManager: {
                        /** 模拟每轮读取当前开关，缺省保持关闭。 */
                        getChatSubagentsEnabled: () => enabled,
                        /** 返回测试语言。 */
                        getResolvedUiLanguage: () => 'en' as const,
                        /** 保留默认缓存策略。 */
                        getChatCacheTtl: () => 'default' as const,
                        /** 不追加全局提示词。 */
                        getGlobalSystemPrompt: () => '',
                        /** 不追加工作区提示词。 */
                        getWorkspaceSystemPrompt: () => ''
                    },
                    llsTaskService: {
                        /** 仅执行和侧轨场景存在活跃任务流。 */
                        hasActiveWorkflow: () => stage === 'execution' || stage === 'sideTrack',
                        /** 创建场景模拟待创建任务流。 */
                        hasPendingWorkflowCreation: () => stage === 'creation'
                    },
                    autoContinueScheduler: {
                        /** 测试不启动真实定时器。 */
                        cancel: () => undefined
                    }
                };
                const names = ['AskUserQuestion', 'Agent', 'SendMessage', 'ListAgents', 'Read'];
                const result = injectLlsTaskRequestBody(JSON.stringify({
                    model: 'm',
                    system: stage === 'sideTrack'
                        ? 'Generate a concise, sentence-case title for this conversation.'
                        : 'base-system',
                    messages: [{ role: 'user', content: '继续' }],
                    tools: names.map((name) => ({ name, input_schema: { type: 'object', properties: {} } }))
                }), fakeDeps as never);
                assert.strictEqual(result.injected, true, stage);
                const body = JSON.parse(result.bodyText) as { tools: Array<{ name: string }> };
                const actual = body.tools.map((tool) => tool.name);
                const retained = names.filter((name) =>
                    !(enabled !== true && ['Agent', 'SendMessage', 'ListAgents'].includes(name))
                    && !(stage === 'execution' && name === 'AskUserQuestion'));
                const expected = stage === 'execution'
                    ? [...retained, 'update_llsccai_task_workflow']
                    : stage === 'creation'
                        ? [...retained, 'create_llsccai_task_workflow']
                        : retained;
                assert.deepStrictEqual(actual, expected, `${stage}, enabled=${enabled}`);
            }
            }
        }
    },
    {
        name: '无任务流时仍应注入内置身份 system 提示词',
        run: () => {
            const input = JSON.stringify({
                model: 'm',
                messages: [{ role: 'user', content: 'hello' }]
            });
            const result = injectLlsTaskRequestBody(input, undefined, { modelName: 'gpt-x' });
            assert.strictEqual(result.injected, true);
            const body = JSON.parse(result.bodyText) as {
                system?: unknown;
                messages?: Array<{ content?: string }>;
            };
            // system 字段应包含内置身份提示词，原始用户文本不应被基础提示词前置污染。
            assert.strictEqual(typeof body.system, 'string');
            assert.ok(String(body.system).includes('lls: gpt-x'));
            assert.strictEqual(body.messages?.[0].content, 'hello');
        }
    },
    {
        name: '普通对话（无任务流）也应注入用户全局/工作区共享提示词',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
                    // 注入链路会读取缓存 TTL 决定 cache_control，桩里必须提供，否则整段注入被 catch 吞掉。
                    getChatCacheTtl: () => 'default' as const,
                    getGlobalSystemPrompt: () => 'global-rule',
                    getWorkspaceSystemPrompt: () => 'workspace-rule'
                },
                llsTaskService: {
                    hasActiveWorkflow: () => false,
                    hasPendingWorkflowCreation: () => false,
                    getSnapshot: () => ({ workflow: undefined })
                },
                autoContinueScheduler: {
                    cancel: () => undefined
                }
            };
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                system: 'base-system',
                messages: [{ role: 'user', content: 'hello' }]
            }), fakeDeps as never);
            assert.strictEqual(result.injected, true);
            const body = JSON.parse(result.bodyText) as { system?: unknown };
            assert.ok(String(body.system).includes('base-system'));
            assert.ok(String(body.system).includes('[Global System Prompt]\nglobal-rule'));
            assert.ok(String(body.system).includes('[Workspace System Prompt]\nworkspace-rule'));
        }
    },
    {
        name: '诊断工具与 @llsccai-get-errors 触发词不应再被注入到出站请求',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
                    // 注入链路会读取缓存 TTL 决定 cache_control，桩里必须提供，否则整段注入被 catch 吞掉。
                    getChatCacheTtl: () => 'default' as const,
                    getGlobalSystemPrompt: () => '',
                    getWorkspaceSystemPrompt: () => ''
                },
                llsTaskService: {
                    hasActiveWorkflow: () => true,
                    hasPendingWorkflowCreation: () => false,
                    getSnapshot: () => ({ workflow: { title: 't', tasks: [] } })
                },
                autoContinueScheduler: {
                    cancel: () => undefined
                }
            };
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: '请检查 @llsccai-get-errors' }
                    ]
                }]
            }), fakeDeps as never);
            const serialized = result.bodyText;
            assert.ok(!serialized.includes('get_llsccai_vscode_diagnostics'),
                '出站请求不应再包含诊断工具名');
            assert.ok(!serialized.includes('buildGetLlsCcaiDiagnosticsSystemRule'),
                '出站请求不应再包含诊断 system 规则函数名');
            // @llsccai-get-errors 文本如果是用户自己输入的，应当原样保留、不再被识别为触发词改写。
            assert.ok(serialized.includes('@llsccai-get-errors'),
                '用户原始文本中的 @llsccai-get-errors 应当被当作普通文本保留');
        }
    },
    {
        name: '全局和工作区系统提示词应合并到共享 system prompt',
        run: () => {
            const prompt = buildSharedSystemPrompt({
                getGlobalSystemPrompt: () => 'global-rule',
                getWorkspaceSystemPrompt: () => 'workspace-rule'
            });
            assert.ok(prompt.includes('[Global System Prompt]\nglobal-rule'));
            assert.ok(prompt.includes('[Workspace System Prompt]\nworkspace-rule'));
        }
    },
    {
        name: '全局和工作区系统提示词应在任务流活跃时注入 Anthropic system 字段',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
                    // 注入链路会读取缓存 TTL 决定 cache_control，桩里必须提供，否则整段注入被 catch 吞掉。
                    getChatCacheTtl: () => 'default' as const,
                    getGlobalSystemPrompt: () => 'global-rule',
                    getWorkspaceSystemPrompt: () => 'workspace-rule'
                },
                llsTaskService: {
                    hasActiveWorkflow: () => true,
                    hasPendingWorkflowCreation: () => false,
                    getSnapshot: () => ({ workflow: { title: 't', tasks: [] } })
                },
                autoContinueScheduler: {
                    cancel: () => undefined
                }
            };
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                system: 'base-system',
                messages: [{ role: 'user', content: 'hello' }]
            }), fakeDeps as never);
            const body = JSON.parse(result.bodyText) as { system?: unknown };
            assert.strictEqual(result.injected, true);
            assert.strictEqual(typeof body.system, 'string');
            assert.ok(String(body.system).includes('base-system'));
            assert.ok(String(body.system).includes('[Global System Prompt]\nglobal-rule'));
            assert.ok(String(body.system).includes('[Workspace System Prompt]\nworkspace-rule'));
        }
    },
    {
        name: '任务流活跃时只注入 update 工具，不再把控制规则或 Workflow JSON 快照写进 system/messages',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
                    // 注入链路会读取缓存 TTL 决定 cache_control，桩里必须提供，否则整段注入被 catch 吞掉。
                    getChatCacheTtl: () => 'default' as const,
                    getGlobalSystemPrompt: () => '',
                    getWorkspaceSystemPrompt: () => ''
                },
                llsTaskService: {
                    hasActiveWorkflow: () => true,
                    hasPendingWorkflowCreation: () => false,
                    getSnapshot: () => ({ workflow: { title: 't', tasks: [] } })
                },
                autoContinueScheduler: {
                    cancel: () => undefined
                }
            };
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                messages: [{ role: 'user', content: '你是什么模型' }]
            }), fakeDeps as never);
            const serialized = result.bodyText;
            const body = JSON.parse(serialized) as {
                tools?: Array<{ name?: string }>;
                messages?: Array<{ content?: unknown }>;
            };
            // 续推执行阶段只注入 update 工具定义，请求体保持稳定缓存前缀。
            assert.ok(body.tools?.some((tool) => tool.name === 'update_llsccai_task_workflow'),
                '应注入 update_llsccai_task_workflow 工具');
            // 易变的任务流控制规则与 Workflow JSON 快照不应再进入请求体的任何位置。
            assert.ok(!serialized.includes('Active llsccai-task workflow'),
                '请求体不应再包含任务流控制规则');
            assert.ok(!serialized.includes('Workflow JSON'),
                '请求体不应再包含易变的 Workflow JSON 快照');
            // user 消息原文应原样保留。
            assert.strictEqual(body.messages?.[0].content, '你是什么模型');
        }
    },
    {
        name: '任务流活跃时不再向历史消息追加易变缓存断点（续推改由自包含用户消息驱动）',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
                    // 注入链路会读取缓存 TTL 决定 cache_control，桩里必须提供，否则整段注入被 catch 吞掉。
                    getChatCacheTtl: () => 'default' as const,
                    getGlobalSystemPrompt: () => '',
                    getWorkspaceSystemPrompt: () => ''
                },
                llsTaskService: {
                    hasActiveWorkflow: () => true,
                    hasPendingWorkflowCreation: () => false,
                    getSnapshot: () => ({ workflow: { title: 't', tasks: [] } })
                },
                autoContinueScheduler: {
                    cancel: () => undefined
                }
            };
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                messages: [{
                    role: 'user',
                    content: [{ type: 'text', text: '继续执行任务流' }]
                }]
            }), fakeDeps as never);
            const body = JSON.parse(result.bodyText) as {
                messages?: Array<{ content?: Array<{ cache_control?: unknown }> }>;
            };
            const lastContent = body.messages?.[0].content ?? [];
            const lastBlock = lastContent[lastContent.length - 1];
            // 不再注入任何缓存断点，保持历史消息字节稳定以命中前缀缓存。
            assert.strictEqual(lastBlock?.cache_control, undefined);
        }
    },
    {
        name: '最后一条 user 消息以 tool_result 开头时不得在其前面插入 text（避免破坏 Anthropic tool_use/tool_result 紧邻约束）',
        run: () => {
            const input = JSON.stringify({
                model: 'm',
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }
                ]
            });
            const result = injectLlsTaskRequestBody(input, undefined, { modelName: 'gpt-x' });
            assert.strictEqual(result.injected, true);
            const body = JSON.parse(result.bodyText) as {
                messages?: Array<{ role: string; content?: Array<{ type?: string }> }>;
            };
            // 原工具往返消息保持不变：content[0] 仍是 tool_result，没有被 text 顶掉。
            const toolResultMsg = body.messages?.[2];
            assert.strictEqual(toolResultMsg?.content?.[0].type, 'tool_result');
            // 基础身份提示词只进入 system，不再追加成新的 user 消息。
            assert.strictEqual(body.messages?.length, 3);
        }
    },
    {
        name: '标题生成侧请求应跳过全部任务流注入',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
                    // 注入链路会读取缓存 TTL 决定 cache_control，桩里必须提供，否则整段注入被 catch 吞掉。
                    getChatCacheTtl: () => 'default' as const,
                    getGlobalSystemPrompt: () => '',
                    getWorkspaceSystemPrompt: () => ''
                },
                llsTaskService: {
                    hasActiveWorkflow: () => true,
                    hasPendingWorkflowCreation: () => false,
                    getSnapshot: () => ({ workflow: { title: 't', tasks: [] } })
                },
                autoContinueScheduler: {
                    cancel: () => undefined
                }
            };
            const input = JSON.stringify({
                model: 'm',
                system: 'Generate a concise, sentence-case title for this conversation.',
                messages: [{ role: 'user', content: '请给这个会话生成标题' }],
                output_config: { format: { type: 'json_schema' } }
            });
            const result = injectLlsTaskRequestBody(input, fakeDeps as never);
            // 侧轨请求仍会走 always-blocked 工具过滤与缓存 ttl 统一（见 taskRequestInjection.ts:154-164），
            // 因此 injected 为 true；这里断言的是「没有任何提示词/任务流工具被塞进去」。
            const body = JSON.parse(result.bodyText) as {
                system?: unknown;
                messages?: Array<{ role: string; content?: unknown }>;
                tools?: unknown[];
            };
            assert.strictEqual(body.system, 'Generate a concise, sentence-case title for this conversation.');
            assert.strictEqual(body.messages?.length, 1);
            assert.strictEqual(body.messages?.[0].content, '请给这个会话生成标题');
            assert.ok(!JSON.stringify(body.tools ?? []).includes('update_llsccai_task_workflow'));
        }
    },
    {
        name: '历史 system 里旧版每秒变化的 currentDate 段应被清理',
        run: () => {
            const parsed: Record<string, unknown> = {
                system: 'keep-this\n\n# currentDate\n当前时间：2026年6月16日 06:07:11\n\ntail'
            };
            stripLegacyInjectedPromptArtifacts(parsed);
            assert.strictEqual(typeof parsed.system, 'string');
            assert.ok(!String(parsed.system).includes('当前时间'),
                'system 中旧版动态时间段应被删除');
            assert.ok(String(parsed.system).includes('keep-this'),
                '非时间段内容应保留');
            assert.ok(String(parsed.system).includes('tail'),
                '时间段之后的内容应保留');
            // 删除后相邻段落必须保留单个空行分隔，且不得粘连成新的字节序列。
            assert.strictEqual(parsed.system, 'keep-this\n\ntail',
                '清理后应折叠为单个空行分隔，避免粘连或多余空行破坏缓存前缀');
        }
    },
    {
        name: '计费 header 里每轮变化的 cch 值应被归一化为固定占位符（稳定缓存前缀）',
        run: () => {
            const header =
                'x-anthropic-billing-header: cc_version=2.1.141.7ae; cc_entrypoint=claude-vscode; cch=2c828;';
            // 字符串形态 system。
            const parsedStr: Record<string, unknown> = { system: header };
            stripLegacyInjectedPromptArtifacts(parsedStr);
            assert.ok(!String(parsedStr.system).includes('cch=2c828'),
                '易变 cch 值应被改写');
            assert.ok(String(parsedStr.system).includes('cch=stable;'),
                'cch 应归一化为固定占位符');
            assert.ok(String(parsedStr.system).includes('cc_version=2.1.141.7ae'),
                'cc_version 等稳定字段应原样保留');
            assert.ok(String(parsedStr.system).includes('cc_entrypoint=claude-vscode'),
                'cc_entrypoint 等稳定字段应原样保留');
            // 数组形态 system（Claude Code 实际使用的形态）。
            const parsedArr: Record<string, unknown> = {
                system: [{ type: 'text', text: header }]
            };
            stripLegacyInjectedPromptArtifacts(parsedArr);
            const block = (parsedArr.system as Array<{ text: string }>)[0];
            assert.ok(!block.text.includes('cch=2c828'),
                '数组形态下易变 cch 值也应被改写');
            assert.ok(block.text.includes('cch=stable;'),
                '数组形态下 cch 也应归一化为固定占位符');
        }
    },
    {
        name: 'applyCacheTtlToRequest 1h 应同时覆盖 tools 断点（避免 1h 排在 tools 的 5m 之后被拒）',
        run: () => {
            const parsed: Record<string, unknown> = {
                tools: [
                    { name: 'X', cache_control: { type: 'ephemeral' } },
                    { name: 'Y' }
                ],
                system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
                messages: [
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok', cache_control: { type: 'ephemeral' } }] }
                ]
            };
            applyCacheTtlToRequest(parsed, '1h');
            const tools = parsed.tools as Array<{ cache_control?: { ttl?: string } }>;
            assert.strictEqual(tools[0].cache_control?.ttl, '1h', 'tools 断点应被补上 ttl=1h');
            // 全量扫描：请求里不得残留任何无 ttl（即 5m）的 ephemeral 断点。
            const seen = new Set<string>();
            const walk = (o: unknown): void => {
                if (o && typeof o === 'object') {
                    const cc = (o as { cache_control?: { type?: string; ttl?: string } }).cache_control;
                    if (cc && cc.type === 'ephemeral') seen.add(cc.ttl ?? '5m-default');
                    for (const v of Object.values(o as Record<string, unknown>)) walk(v);
                }
            };
            walk(parsed);
            assert.deepStrictEqual([...seen], ['1h'], '所有 ephemeral 断点 ttl 必须统一为 1h');
        }
    },
    {
        name: 'applyCacheTtlToRequest 1h 应给 system/messages 的 ephemeral 断点补上 ttl=1h',
        run: () => {
            const parsed: Record<string, unknown> = {
                system: [
                    { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: 'b' }
                ],
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', cache_control: { type: 'ephemeral' } }]
                    }
                ]
            };
            applyCacheTtlToRequest(parsed, '1h');
            const sys = parsed.system as Array<{ cache_control?: { ttl?: string } }>;
            assert.strictEqual(sys[0].cache_control?.ttl, '1h', 'system 断点应被补上 ttl=1h');
            assert.strictEqual(sys[1].cache_control, undefined, '无断点的块不应被改写');
            const msgContent = (parsed.messages as Array<{ content: Array<{ cache_control?: { ttl?: string } }> }>)[0].content;
            assert.strictEqual(msgContent[0].cache_control?.ttl, '1h', 'messages 断点应被补上 ttl=1h');
        }
    },
    {
        name: 'applyCacheTtlToRequest 5m 应删除 ttl 字段，保持 Anthropic 默认最短形态',
        run: () => {
            const parsed: Record<string, unknown> = {
                system: [
                    { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }
                ]
            };
            applyCacheTtlToRequest(parsed, '5m');
            const cc = (parsed.system as Array<{ cache_control: Record<string, unknown> }>)[0].cache_control;
            assert.strictEqual(cc.type, 'ephemeral', 'type 应保留');
            assert.ok(!('ttl' in cc), '5m 应删除 ttl 字段');
        }
    },
    {
        name: 'applyCacheTtlToRequest default 应原样保留请求里的 cache_control，不做任何改写',
        run: () => {
            const parsed: Record<string, unknown> = {
                system: [
                    { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }
                ]
            };
            applyCacheTtlToRequest(parsed, 'default');
            const cc = (parsed.system as Array<{ cache_control: Record<string, unknown> }>)[0].cache_control;
            assert.strictEqual(cc.type, 'ephemeral', 'type 应保留');
            assert.strictEqual(cc.ttl, '1h', 'default 不应改写已有 ttl');
        }
    },
    {
        name: '历史 user 消息里旧版基础提示词 text block 应被剔除',
        run: () => {
            const legacyPrompt =
                'You are an expert AI programming assistant, working with a user in the VS Code editor.\n更多旧版内容';
            const parsed: Record<string, unknown> = {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: legacyPrompt },
                            { type: 'text', text: '真实用户输入' }
                        ]
                    }
                ]
            };
            stripLegacyInjectedPromptArtifacts(parsed);
            const content = (parsed.messages as Array<{ content: Array<{ text?: string }> }>)[0].content;
            assert.strictEqual(content.length, 1, '旧版基础提示词 text block 应被剔除');
            assert.strictEqual(content[0].text, '真实用户输入', '真实用户输入应保留');
        }
    },
    {
        name: 'currentDate 注入清理对纯字符串 user content 不应误删',
        run: () => {
            const parsed: Record<string, unknown> = {
                messages: [
                    { role: 'user', content: '这是一段普通文本，不应被改写' }
                ]
            };
            stripLegacyInjectedPromptArtifacts(parsed);
            const message = (parsed.messages as Array<{ content: unknown }>)[0];
            assert.strictEqual(message.content, '这是一段普通文本，不应被改写',
                '字符串形态的 user content 不应被清理逻辑改写');
        }
    }
];

/**
 * 执行全部测试。
 */
function main(): void {
    for (const test of tests) {
        test.run();
        // eslint-disable-next-line no-console
        console.log(`✓ ${test.name}`);
    }
}

main();
