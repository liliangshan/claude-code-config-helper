/** @file Verify the main chat's parallel-session entry stays visible, localized and wired to the existing session manager. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('parallel-session entry has labels and tooltips in all seven chat languages', () => {
    const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');
    const start = source.indexOf('    const editorButtonTranslations = {');
    const end = source.indexOf('\n    /**', start);
    assert.ok(start >= 0 && end > start);
    const labels: Record<string, string> = {
        en: '＋ Parallel session', 'zh-cn': '＋ 并行会话', 'zh-tw': '＋ 並行會話',
        ja: '＋ 並行セッション', ko: '＋ 병렬 대화', fr: '＋ Session parallèle', de: '＋ Parallele Sitzung'
    };
    const translations: Record<string, Record<string, string>> = Object.fromEntries(Object.keys(labels).map(language => [language, {}]));
    runInNewContext(source.slice(start, end), { chatTranslations: translations });
    for (const [language, label] of Object.entries(labels)) {
        assert.equal(translations[language].editorNew, label);
        for (const key of ['editorList', 'editorNewTitle', 'editorListTitle']) assert.ok(translations[language][key]);
        assert.doesNotMatch(translations[language].editorNewTitle, /3/);
    }
    assert.equal(translations['zh-cn'].editorList, '任务会话');
    assert.match(translations['zh-cn'].editorNewTitle, /直接打开左侧独立会话/);
    const html = readFileSync(resolve(__dirname, '../../../media/chat/index.html'), 'utf8');
    assert.match(html, /data-role="editor-session-new"[^>]*data-i18n="editorNew"[^>]*data-i18n-title="editorNewTitle"[^>]*>＋ Parallel session<\/button>/);
    assert.equal(html.includes('data-role="editor-session-list"'), false);
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'));
    for (const suffix of ['openParallelSessions', 'newEditorSession', 'openEditorHistory']) {
        const command = manifest.contributes.commands.find((entry: { command: string }) => entry.command === `claudeRouter.chat.${suffix}`);
        assert.equal(command.title, `%command.chat.${suffix}.title%`);
        for (const file of ['package.nls.json', 'package.nls.zh-cn.json']) {
            const nls = JSON.parse(readFileSync(resolve(__dirname, '../../../', file), 'utf8'));
            assert.ok(nls[`command.chat.${suffix}.title`]);
        }
    }
});

/** Guard against hiding the main-chat entry inside the native-toolbar-only group or changing its existing action. */
test('main chat exposes one parallel-session button and clicking it uses the existing session manager action', () => {
    const html = readFileSync(resolve(__dirname, '../../../media/chat/index.html'), 'utf8');
    const css = readFileSync(resolve(__dirname, '../../../media/chat/style.css'), 'utf8');
    const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');
    const actions = html.match(/<div class="chat-actions chat-actions--sessions">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.equal((html.match(/data-role="editor-session-new"/g) || []).length, 1);
    assert.match(actions, /<button[^>]*class="sidebar-only"[^>]*data-role="editor-session-new"/);
    assert.match(css, /\.sidebar-chat \.sidebar-only\s*\{[^}]*display: inline-flex;/);
    for (const selector of ['.chat-actions--sessions', '.chat-actions-row', '.chat-header']) {
        const rules = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
        for (const [, selectors, declarations] of rules) {
            if (selectors.includes(selector)) assert.doesNotMatch(declarations, /display:\s*none\s*;/);
        }
    }
    const handler = source.split('\n').find(line => line.includes('[data-role="editor-session-new"]') && line.includes('addEventListener'));
    assert.ok(handler);
    const sent: unknown[] = [];
    let click: (() => void) | undefined;
    runInNewContext(handler, {
        document: { querySelector: () => ({ addEventListener: (_name: string, listener: () => void) => { click = listener; } }) },
        post: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message)))
    });
    assert.ok(click);
    click();
    assert.deepEqual(sent, [{ type: 'leftSessions/show' }]);
});

/** Full settings expose a localized, keyboard-accessible switch without adding navigation to embedded onboarding. */
test('settings header shows one parallel-session switch in every language and providers-only mode omits it', () => {
    const source = readFileSync(resolve(__dirname, '../../../media/configView.js'), 'utf8');
    const labelsStart = source.indexOf('    const parallelSessionLabels = {');
    const labelsEnd = source.indexOf('\n    /**', labelsStart);
    const headerStart = source.indexOf('    function renderHeader() {');
    const headerEnd = source.indexOf('\n    /**', headerStart);
    assert.ok(labelsStart > 0 && labelsEnd > labelsStart && headerEnd > headerStart);
    const languages = ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'];
    const translations: Record<string, Record<string, string>> = Object.fromEntries(languages.map(language => [language, {}]));
    const script = source.slice(labelsStart, labelsEnd) + '\n' + source.slice(headerStart, headerEnd) + '\nrenderHeader();';
    const html = runInNewContext(script, { translations, BRAND_NAME: 'Claude Code Config Helper' }) as string;
    for (const language of languages) {
        assert.ok(translations[language].switchParallelSession);
        assert.ok(translations[language].switchParallelSessionTitle);
    }
    assert.equal(translations['zh-cn'].switchParallelSession, '切到并行会话');
    assert.equal((html.match(/id="btn-editor-chat"/g) || []).length, 1);
    assert.match(html, /id="btn-editor-chat"[^>]*type="button"[^>]*data-i18n-title="switchParallelSessionTitle"[^>]*data-i18n-aria-label="switchParallelSession"/);
    assert.ok(html.indexOf('id="btn-editor-chat"') < html.indexOf('id="btn-import"'));
    assert.match(source, /\$\{providersOnly \? '' : renderHeader\(\)\}/);
    const css = readFileSync(resolve(__dirname, '../../../media/configView.css'), 'utf8');
    assert.match(css, /#btn-editor-chat \.toolbar-btn-label\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
});

/** Clicking settings navigation sends only the existing open action, not a restart, save or history-list request. */
test('settings parallel-session switch posts the existing openEditorSession action once', () => {
    const source = readFileSync(resolve(__dirname, '../../../media/configView.js'), 'utf8');
    const handler = source.split('\n').find(line => line.includes("byId('btn-editor-chat'") && line.includes('addEventListener'));
    assert.ok(handler);
    let click: (() => void) | undefined;
    const sent: string[] = [];
    runInNewContext(handler, {
        byId: (id: string, bind: (element: unknown) => void) => {
            assert.equal(id, 'btn-editor-chat');
            bind({ addEventListener: (event: string, listener: () => void) => { assert.equal(event, 'click'); click = listener; } });
        },
        post: (type: string) => sent.push(type)
    });
    assert.ok(click); click();
    assert.deepEqual(sent, ['openEditorSession']);
});
