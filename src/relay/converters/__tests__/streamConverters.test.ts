/**
 * @file OpenAI Chat SSE 转换与 LLS 任务流流式拦截轻量测试。
 */

import * as assert from 'assert';

import { installVscodeStub } from '../../../chat/__tests__/testUtils/vscodeStub';

// 拦截器链路在加载期就会读取 vscode 配置，桩必须先于 require 装好，
// 因此这里用 require 延迟加载而非静态 import。
installVscodeStub({ values: {} });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LlsTaskStreamingInterceptor } =
    require('../../../llsTask/streamingInterceptor') as typeof import('../../../llsTask/streamingInterceptor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { OpenAIChatToAnthropicStreamConverter } =
    require('../openAIChatToAnthropic') as typeof import('../openAIChatToAnthropic');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { OpenAIResponsesToAnthropicStreamConverter } =
    require('../openAIResponsesToAnthropic') as typeof import('../openAIResponsesToAnthropic');

/** 单个测试用例。 */
interface TestCase {
    /** 测试名称。 */
    name: string;
    /** 测试函数。 */
    run: () => void;
}

/** 简化的自动续推调度器 stub。 */
interface SchedulerStub {
    /** 普通续推次数。 */
    scheduled: number;
    /** 工具后续推次数。 */
    scheduledAfterTool: number;
    /** 取消次数。 */
    canceled: number;
    /** 普通续推。 */
    schedule: () => void;
    /** workflow tool 后续推。 */
    scheduleAfterWorkflowTool: () => void;
    /** 取消续推。 */
    cancel: () => void;
}

/** 简化的任务流服务 stub。 */
interface ServiceStub {
    /** 更新调用次数。 */
    updates: number;
    /** 是否清理了缺失标记。 */
    cleared: number;
    /** 是否标记缺失。 */
    missing: number;
    /** 更新任务状态。 */
    updateTaskStatuses: (updates: unknown[]) => { message: string };
    /** 创建 workflow。 */
    createWorkflow: (workflow: unknown) => { message: string };
    /** 清理缺失状态。 */
    clearWorkflowUpdateMissing: () => void;
    /** 是否有活跃 workflow。 */
    hasActiveWorkflow: () => boolean;
    /** workflow 是否完成。 */
    isWorkflowCompleted: () => boolean;
    /** 标记缺失更新。 */
    markWorkflowUpdateMissing: () => void;
}

/** SSE 测试集合。 */
const tests: TestCase[] = [
    {
        name: '普通 OpenAI SSE 文本逐字流可转换为 Anthropic SSE',
        run: () => {
            const converter = new OpenAIChatToAnthropicStreamConverter();
            const out = converter.feed(sse({ id: 'c1', model: 'm', choices: [{ delta: { content: '你' }, finish_reason: null }] }))
                + converter.feed(sse({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }))
                + converter.end();
            assert.ok(out.includes('event: message_start'));
            assert.ok(out.includes('text_delta'));
            assert.ok(out.includes('你好'.slice(0, 1)));
            assert.ok(out.includes('message_stop'));
            assert.ok(out.includes('"stop_reason":"end_turn"'));
        }
    },
    {
        name: 'OpenAI 多 tool_call 按 index 交错流可转换为多个 Anthropic tool_use block',
        run: () => {
            const converter = new OpenAIChatToAnthropicStreamConverter();
            const out = converter.feed(sse({
                id: 'c2',
                model: 'm',
                choices: [{ delta: { tool_calls: [
                    { index: 1, id: 'call_b', function: { name: 'b', arguments: '{"b"' } },
                    { index: 0, id: 'call_a', function: { name: 'a', arguments: '{"a"' } }
                ] }, finish_reason: null }]
            })) + converter.feed(sse({
                choices: [{ delta: { tool_calls: [
                    { index: 0, function: { arguments: ':1}' } },
                    { index: 1, function: { arguments: ':2}' } }
                ] }, finish_reason: 'tool_calls' }]
            })) + converter.end();
            assert.ok(out.includes('"name":"a"'));
            assert.ok(out.includes('"name":"b"'));
            assert.ok(out.includes('input_json_delta'));
            assert.strictEqual(countOccurrences(out, '"partial_json":"{\\"a\\""'), 1);
            assert.strictEqual(countOccurrences(out, '"partial_json":":1}"'), 1);
            assert.strictEqual(countOccurrences(out, '"partial_json":"{\\"b\\""'), 1);
            assert.strictEqual(countOccurrences(out, '"partial_json":":2}"'), 1);
            assert.ok(out.includes('"stop_reason":"tool_use"'));
        }
    },
    {
        name: 'OpenAI Chat SSE Write/Edit 对象型 arguments 可转换为 input_json_delta',
        run: () => {
            const converter = new OpenAIChatToAnthropicStreamConverter();
            const writeInput = { file_path: '/tmp/a.txt', content: 'hello' };
            const editInput = { file_path: '/tmp/a.txt', old_string: 'hello', new_string: 'hi' };
            const out = converter.feed(sse({
                id: 'c-write-edit',
                model: 'm',
                choices: [{ delta: { tool_calls: [
                    { index: 0, id: 'call_write', function: { name: 'Write', arguments: writeInput } },
                    { index: 1, id: 'call_edit', function: { name: 'Edit', arguments: editInput } }
                ] }, finish_reason: 'tool_calls' }]
            })) + converter.end();
            assert.ok(out.includes('"type":"tool_use","id":"call_write","name":"Write"'));
            assert.ok(out.includes('"type":"tool_use","id":"call_edit","name":"Edit"'));
            assert.ok(out.includes(JSON.stringify(JSON.stringify(writeInput))));
            assert.ok(out.includes(JSON.stringify(JSON.stringify(editInput))));
        }
    },
    {
        name: '[DONE] 缺 finish_reason 时可安全收尾',
        run: () => {
            const converter = new OpenAIChatToAnthropicStreamConverter();
            const out = converter.feed(sse({ id: 'c3', model: 'm', choices: [{ delta: { content: 'x' }, finish_reason: null }] }))
                + converter.feed('data: [DONE]\n\n')
                + converter.end();
            assert.ok(out.includes('message_stop'));
            assert.ok(out.includes('"stop_reason":"end_turn"'));
        }
    },
    {
        name: '任务流 update tool_use 可被本地执行并改写为 text block',
        run: () => {
            const service = createServiceStub();
            const scheduler = createSchedulerStub();
            const interceptor = new LlsTaskStreamingInterceptor({ service: service as never, autoContinueScheduler: scheduler as never });
            const out = interceptor.feed(anthropicEvent('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'toolu_1', name: 'update_llsccai_task_workflow', input: {} }
            })) + interceptor.feed(anthropicEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"updates":[{"taskId":"1","status":"completed"}]}' }
            })) + interceptor.feed(anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
                + interceptor.feed(anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }))
                + interceptor.end();
            assert.strictEqual(service.updates, 1);
            assert.ok(out.includes('"content_block":{"type":"text"'));
            assert.ok(out.includes('updated'));
            assert.ok(out.includes('"stop_reason":"end_turn"'));
            assert.strictEqual(scheduler.scheduledAfterTool, 1);
        }
    },
    {
        name: 'Responses SSE function_call 经 Anthropic 转换后可被任务流流式拦截器本地执行',
        run: () => {
            const service = createServiceStub();
            const scheduler = createSchedulerStub();
            const converter = new OpenAIResponsesToAnthropicStreamConverter();
            const interceptor = new LlsTaskStreamingInterceptor({ service: service as never, autoContinueScheduler: scheduler as never });
            const converted = converter.feed(responsesEvent('response.created', { type: 'response.created', response: { id: 'resp_task', model: 'm' } }))
                + converter.feed(responsesEvent('response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: { type: 'function_call', id: 'fc_task', call_id: 'call_task', name: 'update_llsccai_task_workflow' }
                }))
                + converter.feed(responsesEvent('response.function_call_arguments.delta', {
                    type: 'response.function_call_arguments.delta',
                    output_index: 0,
                    delta: '{"updates":[{"taskId":"1","status":"completed"}]}'
                }))
                + converter.feed(responsesEvent('response.completed', { type: 'response.completed', response: { id: 'resp_task', model: 'm', status: 'completed' } }))
                + converter.end();
            const out = interceptor.feed(converted) + interceptor.end();
            assert.strictEqual(service.updates, 1);
            assert.ok(!out.includes('"type":"tool_use"'));
            assert.ok(out.includes('"content_block":{"type":"text"'));
            assert.ok(out.includes('updated'));
            assert.ok(out.includes('"stop_reason":"end_turn"'));
            assert.strictEqual(scheduler.scheduledAfterTool, 1);
        }
    }
];

/**
 * 创建 OpenAI SSE event 文本。
 *
 * @param payload event payload。
 * @returns SSE 文本。
 */
function sse(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 创建 Anthropic SSE event 文本。
 *
 * @param event 事件名。
 * @param payload event payload。
 * @returns SSE 文本。
 */
function anthropicEvent(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 创建 OpenAI Responses SSE event 文本。
 *
 * @param event 事件名。
 * @param payload event payload。
 * @returns SSE 文本。
 */
function responsesEvent(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 统计子串出现次数。
 *
 * @param text 待搜索文本。
 * @param needle 子串。
 * @returns 出现次数。
 */
function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}

/**
 * 创建任务流服务 stub。
 *
 * @returns 服务 stub。
 */
function createServiceStub(): ServiceStub {
    return {
        updates: 0,
        cleared: 0,
        missing: 0,
        updateTaskStatuses() {
            this.updates += 1;
            return { message: 'updated' };
        },
        createWorkflow() {
            return { message: 'created' };
        },
        clearWorkflowUpdateMissing() {
            this.cleared += 1;
        },
        hasActiveWorkflow() {
            return true;
        },
        isWorkflowCompleted() {
            return false;
        },
        markWorkflowUpdateMissing() {
            this.missing += 1;
        }
    };
}

/**
 * 创建自动续推调度器 stub。
 *
 * @returns 调度器 stub。
 */
function createSchedulerStub(): SchedulerStub {
    return {
        scheduled: 0,
        scheduledAfterTool: 0,
        canceled: 0,
        schedule() {
            this.scheduled += 1;
        },
        scheduleAfterWorkflowTool() {
            this.scheduledAfterTool += 1;
        },
        cancel() {
            this.canceled += 1;
        }
    };
}

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
