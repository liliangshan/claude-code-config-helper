/**
 * @file expertTriggers 单元测试。
 *
 * 覆盖用户级专家触发前缀的纯函数：
 * - startsWithExpertPrefix：仅匹配开头的 `@llsExpert` / `/expert`（大小写不敏感），
 *   正文中提及不应误触发；
 * - stripExpertPrefix：仅剥除开头前缀并 trim，正文中同名 token 保留。
 *
 * 纯函数测试，可直接在 `node --test` 下运行（无 vscode 依赖）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startsWithExpertPrefix, stripExpertPrefix } from '../expertTriggers';

test('startsWithExpertPrefix: 识别 @llsExpert 开头', () => {
    assert.equal(startsWithExpertPrefix('@llsExpert refactor X'), true);
    assert.equal(startsWithExpertPrefix('  @llsExpert refactor X'), true);
});

test('startsWithExpertPrefix: 识别 /expert 开头', () => {
    assert.equal(startsWithExpertPrefix('/expert analyze this'), true);
    assert.equal(startsWithExpertPrefix('  /expert analyze this'), true);
});

test('startsWithExpertPrefix: 大小写不敏感', () => {
    assert.equal(startsWithExpertPrefix('@LLSEXPERT do it'), true);
    assert.equal(startsWithExpertPrefix('/EXPERT do it'), true);
});

test('startsWithExpertPrefix: 正文中提及不误触发', () => {
    assert.equal(startsWithExpertPrefix('please ping @llsExpert later'), false);
    assert.equal(startsWithExpertPrefix('run /expert in a comment'), false);
});

test('startsWithExpertPrefix: 必须是词边界，@llsExpertise 不触发', () => {
    assert.equal(startsWithExpertPrefix('@llsExpertise is good'), false);
});

test('startsWithExpertPrefix: 普通输入返回 false', () => {
    assert.equal(startsWithExpertPrefix('just a normal question'), false);
    assert.equal(startsWithExpertPrefix(''), false);
});

test('stripExpertPrefix: 剥除 @llsExpert 前缀并 trim', () => {
    assert.equal(stripExpertPrefix('@llsExpert refactor X'), 'refactor X');
    assert.equal(stripExpertPrefix('  @llsExpert   refactor X  '), 'refactor X');
});

test('stripExpertPrefix: 剥除 /expert 前缀并 trim', () => {
    assert.equal(stripExpertPrefix('/expert analyze this'), 'analyze this');
});

test('stripExpertPrefix: 仅剥除开头，正文中同名 token 保留', () => {
    assert.equal(stripExpertPrefix('@llsExpert ping @llsExpert again'), 'ping @llsExpert again');
});

test('stripExpertPrefix: 无前缀时返回 trim 后原文', () => {
    assert.equal(stripExpertPrefix('  hello world  '), 'hello world');
});
