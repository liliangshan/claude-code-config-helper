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

test('buildContinuePrompt: 活跃任务流续推提示词不再强制 @llsExpert 前缀', () => {
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

    assert.equal(prompt, '请继续执行当前 llsccai-task 任务流。');
    assert.equal(prompt.startsWith('@llsExpert'), false);
});
