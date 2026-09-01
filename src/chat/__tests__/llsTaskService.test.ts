/**
 * @file LLS CCAI 任务流继续提示词测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './testUtils/vscodeStub';

installVscodeStub({
    values: {
        claudeCodeConfigHelper: {
            language: 'zh-cn'
        }
    }
});

import type { ConfigManager } from '../../configManager';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LlsTaskService } = require('../../llsTask/service') as typeof import('../../llsTask/service');

test('buildContinuePrompt: 活跃任务流续推提示词只推第一条未完成任务（含编号与状态回写指示）', () => {
    const service = new LlsTaskService({
        getResolvedUiLanguage: () => 'zh-cn'
    } as ConfigManager);
    const prompt = service.buildContinuePrompt({
        updatedAt: Date.now(),
        workflow: {
            title: '测试任务流',
            summary: '验证普通模型续推',
            tasks: [
                {
                    id: 'task-1',
                    title: '继续执行',
                    description: '继续执行任务流',
                    status: 'in_progress'
                }
            ]
        }
    });

    // 续推消息只点名第一条未完成任务（带原始编号 + 状态 + 描述），不再罗列完整序列。
    assert.ok(prompt.startsWith('请继续执行当前 llsccai-task 任务流。'), '应以基础续推语开头');
    assert.ok(prompt.includes('下一个待执行任务: 1. [in_progress] 继续执行'), '应点名带编号与状态的下一个待执行任务');
    assert.ok(prompt.includes('继续执行任务流'), '应包含该任务的描述');
    assert.ok(prompt.includes('update_llsccai_task_workflow'), '应指示调用状态回写工具');
});

test('buildContinuePrompt: 同时有方案文档与说明文字时两者都续推', () => {
    const service = new LlsTaskService({
        getResolvedUiLanguage: () => 'zh-cn'
    } as ConfigManager);
    const prompt = service.buildContinuePrompt({
        updatedAt: Date.now(),
        planningDocumentPath: 'docs/PLAN.md',
        originalUserPrompt: '帮我实现登录功能',
        workflow: {
            title: '测试任务流',
            summary: '验证文档与说明文字同时续推',
            tasks: [
                {
                    id: 'task-1',
                    title: '继续执行',
                    description: '继续执行任务流',
                    status: 'in_progress'
                }
            ]
        }
    });

    assert.ok(prompt.includes('docs/PLAN.md'), '续推提示应包含方案文档路径');
    assert.ok(prompt.includes('Original request: 帮我实现登录功能'), '续推提示应包含原始说明文字');
});
