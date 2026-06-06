/**
 * @file LLS 任务流请求注入轻量测试。
 *
 * 覆盖任务流注入路径，以及"诊断工具已被彻底移除"的回归断言。
 */

import * as assert from 'assert';

import { buildSharedSystemPrompt, injectLlsTaskRequestBody } from '../taskRequestInjection';

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
        name: '无任务流时仍应注入内置身份 system 提示词（system 字段 + 末尾 user 兜底）',
        run: () => {
            const input = JSON.stringify({
                model: 'm',
                messages: [{ role: 'user', content: 'hello' }]
            });
            const result = injectLlsTaskRequestBody(input, undefined, { modelName: 'gpt-x' });
            assert.strictEqual(result.injected, true);
            const body = JSON.parse(result.bodyText) as {
                system?: unknown;
                messages?: Array<{ content?: Array<{ text?: string }> }>;
            };
            // system 字段应包含内置身份提示词。
            assert.strictEqual(typeof body.system, 'string');
            assert.ok(String(body.system).includes('lls: gpt-x'));
            // 末尾 user 消息兜底前置同一段提示词，原始文本保留在其后。
            assert.ok(Array.isArray(body.messages?.[0].content));
            assert.ok(body.messages?.[0].content?.[0].text?.includes('lls: gpt-x'));
            assert.strictEqual(body.messages?.[0].content?.[1].text, 'hello');
        }
    },
    {
        name: '普通对话（无任务流）也应注入用户全局/工作区共享提示词',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
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
        name: '任务流用户控制消息应插入最后一条 user content 的索引 0',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
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
            const body = JSON.parse(result.bodyText) as { messages?: Array<{ content?: Array<{ text?: string }> }> };
            assert.ok(Array.isArray(body.messages?.[0].content));
            // 注入顺序：任务流控制规则在最前，其次是内置 system 兜底文本，最后才是原始用户文本。
            assert.ok(body.messages?.[0].content?.[0].text?.includes('Active llsccai-task workflow'));
            assert.ok(body.messages?.[0].content?.[0].text?.includes('Workflow JSON'));
            assert.ok(body.messages?.[0].content?.[1].text?.includes('lls:'));
            const content = body.messages?.[0].content ?? [];
            assert.strictEqual(content[content.length - 1].text, '你是什么模型');
        }
    },
    {
        name: '标题生成侧请求应跳过全部任务流注入',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
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
            assert.strictEqual(result.injected, false);
            assert.strictEqual(result.bodyText, input);
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
