/** @file plan/review 编排 token parser 单元测试。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    containsPlanReviewToken,
    extractPlanReviewTokenTail,
    parsePlanReviewToken
} from '../routing/planReviewHandoff';
import { resolvePlanDoneRoutingAction } from '../routing/planReviewWorkflow';

test('containsPlanReviewToken: 支持大小写不敏感匹配和单词边界', () => {
    assert.equal(containsPlanReviewToken('@llsPlanTask 设计方案', '@llsPlanTask'), true);
    assert.equal(containsPlanReviewToken('@LLSPLANTASK 设计方案', '@llsPlanTask'), true);
    assert.equal(containsPlanReviewToken('@llsPlanTaskExtra 设计方案', '@llsPlanTask'), false);
});

test('extractPlanReviewTokenTail: 提取 token 后正文并 trim', () => {
    assert.equal(
        extractPlanReviewTokenTail('请处理 @llsPlanRevise   补充测试策略  ', '@llsPlanRevise'),
        '补充测试策略'
    );
    assert.equal(extractPlanReviewTokenTail('无 token', '@llsPlanDone'), '');
});

test('parsePlanReviewToken: 按 dispatcher 优先级返回第一个可执行 token', () => {
    assert.deepEqual(parsePlanReviewToken('@llsPlanTask 实现四路路由'), {
        token: '@llsPlanTask',
        tail: '实现四路路由'
    });
    assert.deepEqual(parsePlanReviewToken('@llsPlanReview'), {
        token: '@llsPlanReview',
        tail: ''
    });
    assert.deepEqual(parsePlanReviewToken('@llsPlanRevise 修改风险章节'), {
        token: '@llsPlanRevise',
        tail: '修改风险章节'
    });
    assert.deepEqual(parsePlanReviewToken('@llsPlanApproved 可以执行'), {
        token: '@llsPlanApproved',
        tail: '可以执行'
    });
});

test('parsePlanReviewToken: 空文本和未命中文本返回 undefined', () => {
    assert.equal(parsePlanReviewToken(''), undefined);
    assert.equal(parsePlanReviewToken('普通回复'), undefined);
});

test('resolvePlanDoneRoutingAction: 审查模型存在且方案未审查时转入 review', () => {
    assert.equal(resolvePlanDoneRoutingAction({
        active: true,
        latestPlanText: '方案文档：/tmp/plan.md',
        latestReviewText: ''
    }, true), 'review');

    assert.equal(resolvePlanDoneRoutingAction({
        active: true,
        latestPlanText: '方案文档：/tmp/plan.md',
        latestReviewText: 'VERDICT: APPROVED'
    }, true), 'finish');

    assert.equal(resolvePlanDoneRoutingAction({
        active: true,
        latestPlanText: '方案文档：/tmp/plan.md',
        latestReviewText: ''
    }, false), 'finish');
});
