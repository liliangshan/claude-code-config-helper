/** @file 从实际前端脚本提取纯格式化方法进行回归验证。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

/** 提取源码函数，避免测试复制实现。 */
function formatter(language: string): (summary?: unknown) => string {
    const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');
    const translations = source.slice(source.indexOf('    var usageTranslations ='), source.indexOf('    const vscode ='));
    const start = source.indexOf('    function formatRequestUsage(');
    const end = source.indexOf('\n    /**', start);
    const sandbox: any = { currentLanguage: language, chatTranslations: Object.fromEntries(['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'].map(key => [key, {}])) };
    sandbox.t = (key: string) => sandbox.chatTranslations[language][key];
    return runInNewContext(translations + source.slice(start, end) + '\nformatRequestUsage;', sandbox);
}

test('all seven languages render exactly five fields, unknowns and interruption', () => {
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        const format = formatter(language);
        const empty = format();
        assert.equal(empty.split(' · ').length, 5);
        assert.equal((empty.match(/—/g) || []).length, 5);
        const complete = format({ inputTokens: 3000, cacheReadInputTokens: 22000, cacheCreationInputTokens: 1000, outputTokens: 842, cacheHitRate: 84.62, totalInputTokens: 26000 });
        assert.equal(complete.split(' · ').length, 5);
        assert.ok(complete.includes('84.62%'));
        assert.ok(!complete.includes((26000).toLocaleString(language)));
        assert.equal(format({ status: 'timeout' }).split(' · ').length, 6);
        assert.ok(format({ inputTokens: 0 }).includes('0'));
    }
});

/** 直接执行实际片段渲染方法，保证实时及历史 usage 都不再追加整轮页脚。 */
test('round usage segments do not render a footer', () => {
    const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');
    const start = source.indexOf('    function appendSegment(');
    const end = source.indexOf('\n    /**', start);
    const render = runInNewContext(source.slice(start, end) + '\nappendSegment;', {
        isHiddenChatToolSegment: () => false,
        appendUsageFooter: () => assert.fail('不应再渲染整轮用量'),
        appendText: () => assert.fail('usage 不应退化为正文')
    });
    render({}, { kind: 'usage', id: 'usage:round', usage: { model: 'gpt-6-astra', inputTokens: 373 } });
    render({}, { kind: 'usage', text: '历史整轮用量' });
});
