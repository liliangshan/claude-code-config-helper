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

/** Responsive chat content must use panel width and keep model/usage inline until wrapping is necessary. */
test('chat polish uses fluid width and does not force model and usage onto separate rows', () => {
    const source = readFileSync(resolve(__dirname, '../../../media/chat/chatPolish.css'), 'utf8');
    const message = source.match(/\.message_07S1Yg\s*\{([^}]+)\}/)?.[1] ?? '';
    const fields = source.match(/\.requestUsageFields\s*\{([^}]+)\}/)?.[1] ?? '';
    const header = source.match(/\.requestUsageHeader\s*\{([^}]+)\}/)?.[1] ?? '';
    assert.match(message, /width:\s*100%/);
    assert.match(message, /max-width:\s*100%/);
    assert.match(fields, /flex:\s*0 1 auto/);
    assert.doesNotMatch(fields, /flex-basis:\s*100%/);
    assert.match(header, /gap:\s*4px 12px/);
    assert.doesNotMatch(source, /780px/);
});

/** Smaller model text stays beside usage on the left without hiding fields or forcing wide separation. */
test('model route and name remain one size smaller and left aligned beside usage', () => {
    const style = readFileSync(resolve(__dirname, '../../../media/chat/chatPolish.css'), 'utf8');
    const source = style.match(/\.assistantSourcePrefix_07S1Yg\s*\{([^}]+)\}/)?.[1] ?? '';
    const header = style.match(/\.requestUsageHeader\s*\{([^}]+)\}/)?.[1] ?? '';
    const model = style.match(/\.requestUsageHeader > span:first-child\s*\{([^}]+)\}/)?.[1] ?? '';
    const fields = style.match(/\.requestUsageFields\s*\{([^}]+)\}/)?.[1] ?? '';
    for (const rule of [source, model]) {
        assert.match(rule, /font-size:\s*max\(10px,\s*calc\(var\(--lls-font-xs\) - 1px\)\)/);
        assert.match(rule, /margin-inline-start:\s*0/);
        assert.match(rule, /text-align:\s*left/);
        assert.match(rule, /overflow-wrap:\s*anywhere/);
    }
    assert.match(header, /width:\s*100%/);
    assert.match(header, /font-size:\s*var\(--lls-font-xs\)/);
    assert.match(header, /text-align:\s*left/);
    assert.doesNotMatch(model, /order:|margin-inline-start:\s*auto/);
    assert.match(model, /flex:\s*0 1 auto/);
    assert.match(fields, /font-size:\s*max\(10px,\s*\.85em\)/);
    assert.doesNotMatch(model + fields, /display:\s*none|text-overflow:\s*ellipsis|white-space:\s*nowrap/);
});

/** Tool-card metadata receives left padding only; existing bottom padding and margin stay unchanged. */
test('tool card usage has a left inset without extra spacing below', () => {
    const style = readFileSync(resolve(__dirname, '../../../media/chat/chatPolish.css'), 'utf8');
    const inset = style.match(/\.root_ZUQaOA > \.requestUsageHeader\s*\{([^}]+)\}/)?.[1] ?? '';
    const header = style.match(/\.requestUsageHeader\s*\{([^}]+)\}/)?.[1] ?? '';
    assert.match(inset, /padding-inline-start:\s*10px/);
    assert.doesNotMatch(inset, /margin|padding-bottom|padding-block|padding:\s/);
    assert.match(header, /padding:\s*7px 0 9px/);
    assert.match(header, /margin-bottom:\s*9px/);
});
