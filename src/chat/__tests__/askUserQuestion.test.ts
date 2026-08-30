/**
 * @file AskUserQuestion 授权通道单元测试。
 *
 * 覆盖：
 * 1. respondToToolPermission 携带 updatedInput.answers 时写回的
 *    control_response JSON 结构；
 * 2. parseAskUserQuestions 对 CLI 输入的宽松解析与非法结构兜底；
 * 3. buildAskUserUpdatedInput 的 answers / annotations 合并约定。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { installVscodeStub } from './testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StreamJsonCliAdapter } = require('../cli/cliAdapter') as typeof import('../cli/cliAdapter');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseAskUserQuestions, buildAskUserUpdatedInput } = require('../askUserQuestion') as typeof import('../askUserQuestion');
type CliChunk = import('../cli/types').CliChunk;
type CliExitEvent = import('../cli/types').CliExitEvent;
type CliProcessStatus = import('../cli/types').CliProcessStatus;

/**
 * 构造可捕获 stdin 写入的最小 CliProcess 替身。
 *
 * @returns fake 进程与捕获到的 send 行列表。
 */
function createFakeCliProcess() {
    const emitter = new EventEmitter();
    const sentLines: string[] = [];
    const fake = {
        onChunk(listener: (chunk: CliChunk) => void) {
            emitter.on('chunk', listener);
            return { dispose: () => emitter.off('chunk', listener) };
        },
        onExit(listener: (event: CliExitEvent) => void) {
            emitter.on('exit', listener);
            return { dispose: () => emitter.off('exit', listener) };
        },
        onStatus(listener: (status: CliProcessStatus) => void) {
            emitter.on('status', listener);
            return { dispose: () => emitter.off('status', listener) };
        },
        getCwd: () => process.cwd(),
        send: (line: string) => { sentLines.push(line); },
        cancel: () => undefined,
        isRunning: () => true
    } as unknown as ConstructorParameters<typeof StreamJsonCliAdapter>[0];
    return { fake, sentLines };
}

test('respondToToolPermission 携带 updatedInput.answers 时写回正确的 control_response 结构', () => {
    const { fake, sentLines } = createFakeCliProcess();
    const adapter = new StreamJsonCliAdapter(fake);
    const updatedInput = {
        questions: [{ question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }],
        answers: { '选哪个方案？': 'A' },
        annotations: { '选哪个方案？': { notes: '优先兼容旧版本' } }
    };
    adapter.respondToToolPermission('req_ask_1', {
        behavior: 'allow',
        updatedInput,
        updatedPermissions: []
    });
    assert.equal(sentLines.length, 1);
    const parsed = JSON.parse(sentLines[0]);
    // 顶层 control_response 包裹结构须符合官方 SDK stdio 约定。
    assert.equal(parsed.type, 'control_response');
    assert.equal(parsed.response.subtype, 'success');
    assert.equal(parsed.response.request_id, 'req_ask_1');
    assert.equal(parsed.response.response.behavior, 'allow');
    // answers 必须原样出现在 updatedInput 中，CLI 据此打包 tool_result。
    assert.deepEqual(parsed.response.response.updatedInput.answers, { '选哪个方案？': 'A' });
    assert.deepEqual(parsed.response.response.updatedInput.annotations, { '选哪个方案？': { notes: '优先兼容旧版本' } });
    assert.deepEqual(parsed.response.response.updatedPermissions, []);
});

test('respondToToolPermission deny 分支不携带 updatedInput', () => {
    const { fake, sentLines } = createFakeCliProcess();
    const adapter = new StreamJsonCliAdapter(fake);
    adapter.respondToToolPermission('req_ask_2', { behavior: 'deny', message: '用户拒绝' });
    const parsed = JSON.parse(sentLines[0]);
    assert.equal(parsed.response.request_id, 'req_ask_2');
    assert.equal(parsed.response.response.behavior, 'deny');
    assert.equal(parsed.response.response.message, '用户拒绝');
    assert.equal('updatedInput' in parsed.response.response, false);
});

test('parseAskUserQuestions 解析合法输入并过滤非法条目', () => {
    const items = parseAskUserQuestions({
        questions: [
            {
                question: '部署到哪个环境？',
                header: '部署',
                multiSelect: true,
                options: [{ label: 'staging', description: '预发' }, { label: 'prod' }]
            },
            // 非法：question 为空。
            { question: '  ', options: [{ label: 'X' }] },
            // 非法：options 为空数组。
            { question: '无选项？', options: [] },
            // 非法：option 缺 label。
            { question: '坏选项？', options: [{ description: '没有 label' }] },
            // 非法：不是对象。
            'not-an-object'
        ]
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].question, '部署到哪个环境？');
    assert.equal(items[0].header, '部署');
    assert.equal(items[0].multiSelect, true);
    assert.deepEqual(items[0].options, [
        { label: 'staging', description: '预发' },
        { label: 'prod', description: undefined }
    ]);
});

test('parseAskUserQuestions 对非法顶层结构返回空数组', () => {
    assert.deepEqual(parseAskUserQuestions(null), []);
    assert.deepEqual(parseAskUserQuestions('str'), []);
    assert.deepEqual(parseAskUserQuestions({}), []);
    assert.deepEqual(parseAskUserQuestions({ questions: 'oops' }), []);
});

test('buildAskUserUpdatedInput 合并 answers 并把 notes 挂到第一个问题的 annotations', () => {
    const baseInput = { questions: [{ question: 'Q1', options: [{ label: 'A' }] }] };
    const result = buildAskUserUpdatedInput(baseInput, { Q1: 'A' }, '  额外说明  ');
    assert.deepEqual(result.questions, baseInput.questions);
    assert.deepEqual(result.answers, { Q1: 'A' });
    assert.deepEqual(result.annotations, { Q1: { notes: '额外说明' } });
});

test('buildAskUserUpdatedInput 无 notes 时不生成 annotations，且容忍非对象 baseInput', () => {
    const result = buildAskUserUpdatedInput(undefined, { Q1: 'B' });
    assert.deepEqual(result, { answers: { Q1: 'B' } });
    const blankNotes = buildAskUserUpdatedInput({}, { Q1: 'B' }, '   ');
    assert.equal('annotations' in blankNotes, false);
});


