/**
 * @file LLS 任务流请求注入轻量测试。
 *
 * 覆盖诊断工具系统规则注入位置，避免工具说明污染 user 消息历史。
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
        name: '诊断工具使用说明应注入 system 而不是 user message',
        run: () => {
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                messages: [{ role: 'user', content: 'hello' }]
            }), undefined);
            const body = JSON.parse(result.bodyText) as { system?: unknown; messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ name?: string }> };
            assert.strictEqual(result.injected, true);
            assert.strictEqual(typeof body.system, 'string');
            assert.ok(String(body.system).includes('get_llsccai_vscode_diagnostics'));
            assert.strictEqual(body.messages?.length, 1);
            assert.strictEqual(body.messages?.[0].role, 'user');
            assert.strictEqual(body.messages?.[0].content, 'hello');
            assert.ok(body.tools?.some((tool) => tool.name === 'get_llsccai_vscode_diagnostics'));
        }
    },
    {
        name: '已有 system text block 数组时诊断规则应追加为新的 system text block',
        run: () => {
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                system: [{ type: 'text', text: 'base-system' }],
                messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
            }), undefined);
            const body = JSON.parse(result.bodyText) as { system?: Array<{ type?: string; text?: string }>; messages?: Array<{ content?: unknown }> };
            assert.ok(Array.isArray(body.system));
            assert.strictEqual(body.system?.[0].text, 'base-system');
            assert.ok(body.system?.[1].text?.includes('get_llsccai_vscode_diagnostics'));
            assert.deepStrictEqual(body.messages?.[0].content, [{ type: 'text', text: 'hello' }]);
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
        name: '全局和工作区系统提示词应注入 Anthropic system 字段',
        run: () => {
            const fakeDeps = {
                configManager: {
                    getResolvedUiLanguage: () => 'en' as const,
                    getGlobalSystemPrompt: () => 'global-rule',
                    getWorkspaceSystemPrompt: () => 'workspace-rule'
                },
                llsTaskService: {
                    hasActiveWorkflow: () => false,
                    hasPendingWorkflowCreation: () => false
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
            const body = JSON.parse(result.bodyText) as { system?: unknown; messages?: Array<{ content?: unknown }> };
            assert.strictEqual(result.injected, true);
            assert.strictEqual(typeof body.system, 'string');
            assert.ok(String(body.system).includes('base-system'));
            assert.ok(String(body.system).includes('[Global System Prompt]\nglobal-rule'));
            assert.ok(String(body.system).includes('[Workspace System Prompt]\nworkspace-rule'));
            assert.strictEqual(body.messages?.[0].content, 'hello');
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
            assert.ok(body.messages?.[0].content?.[0].text?.includes('Active llsccai-task workflow'));
            assert.ok(body.messages?.[0].content?.[0].text?.includes('Workflow JSON'));
            assert.strictEqual(body.messages?.[0].content?.[1].text, '你是什么模型');
        }
    },
    {
        name: '诊断触发结果应无条件插入最后一条 user content 索引 0',
        run: () => {
            const result = injectLlsTaskRequestBody(JSON.stringify({
                model: 'm',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: '<system-reminder>skills</system-reminder>' },
                        { type: 'text', text: '<ide_opened_file>file</ide_opened_file>' },
                        { type: 'text', text: `请检查 ${'@llsccai-get-errors'}` }
                    ]
                }]
            }), undefined);
            const body = JSON.parse(result.bodyText) as { messages?: Array<{ content?: Array<{ text?: string }> }> };
            assert.ok(body.messages?.[0].content?.[0].text?.includes('[get_llsccai_vscode_diagnostics]'));
            assert.strictEqual(body.messages?.[0].content?.[1].text, '<system-reminder>skills</system-reminder>');
            assert.strictEqual(body.messages?.[0].content?.[2].text, '<ide_opened_file>file</ide_opened_file>');
        }
    },
    {
        name: '标题生成侧请求应跳过全部任务流和诊断工具注入',
        run: () => {
            const input = JSON.stringify({
                model: 'm',
                system: 'Generate a concise, sentence-case title for this conversation.',
                messages: [{ role: 'user', content: '请给这个会话生成标题' }],
                output_config: { format: { type: 'json_schema' } }
            });
            const result = injectLlsTaskRequestBody(input, undefined);
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
