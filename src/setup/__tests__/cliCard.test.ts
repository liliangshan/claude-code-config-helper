/** @file Verify the settings CLI card exposes only version information and its existing update action. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(resolve(__dirname, '../../../media/configView.js'), 'utf8');
const labelsStart = source.indexOf('    const setupLabels = {');
const labelsEnd = source.indexOf('\n    /**', labelsStart);
const cardStart = source.indexOf('    function renderClaudeCard() {');
const cardEnd = source.indexOf('\n    /**', cardStart);

test('CLI card localizes current version and exposes just one update button', () => {
    assert.ok(labelsStart >= 0 && labelsEnd > labelsStart && cardStart >= 0 && cardEnd > cardStart);
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        const sandbox = { currentLanguage: language, state: { setup: { cli: { version: '2.1.311', source: 'managed' } }, chatCliPath: '/private/cli' }, text: (value: unknown) => String(value) };
        const html = runInNewContext(source.slice(labelsStart, labelsEnd) + '\n' + source.slice(cardStart, cardEnd) + '\nrenderClaudeCard();', sandbox) as string;
        assert.match(html, /<strong data-role="cli-version">2\.1\.311<\/strong>/);
        assert.deepEqual([...html.matchAll(/data-setup="([^"]+)"/g)].map(match => match[1]), ['update']);
        assert.equal((html.match(/<button\b/g) || []).length, 1);
        assert.equal(/<input|<details|managed|\/private\/cli|section-description|status-badge/.test(html), false);
        assert.equal(html.includes('undefined'), false);
    }
    const fallback = runInNewContext(source.slice(labelsStart, labelsEnd) + '\n' + source.slice(cardStart, cardEnd) + '\nrenderClaudeCard();', { currentLanguage: 'unknown', state: {}, text: (value: unknown) => String(value) }) as string;
    assert.match(fallback, /Current version/); assert.match(fallback, /Check for updates/); assert.match(fallback, /<strong data-role="cli-version">—<\/strong>/);
});

test('simplified card keeps the existing setupAction update message', () => {
    const start = source.indexOf("        document.querySelectorAll('[data-setup]')");
    const end = source.indexOf('\n', start);
    const sent: unknown[] = []; let click!: () => void;
    runInNewContext(source.slice(start, end), {
        document: { querySelectorAll: () => [{ dataset: { setup: 'update' }, addEventListener: (_event: string, action: () => void) => { click = action; } }] },
        vscode: { postMessage: (message: unknown) => sent.push(message) }
    });
    click(); assert.equal(JSON.stringify(sent), JSON.stringify([{ type: 'setupAction', action: 'update' }]));
});

test('update progress patches only the existing card and keeps its button and unrelated forms intact', () => {
    const start = source.indexOf('    function renderCliUpdate() {');
    const end = source.indexOf('\n    /**', start);
    const button = { disabled: false, textContent: '' };
    const version = { textContent: '2.1.311' };
    const status = { hidden: true, textContent: '', dataset: {} };
    const unrelated = { draft: 'Keep this provider edit' };
    const state = { busy: true, progress: { phase: 'checking' }, version: '2.1.311' } as any;
    const context = {
        currentLanguage: 'zh-tw', cliUpdateState: state, unrelated,
        document: { querySelector: (selector: string) => selector === '[data-setup="update"]' ? button : selector === '[data-role="cli-version"]' ? version : status }
    };
    const script = source.slice(labelsStart, labelsEnd) + '\n' + source.slice(start, end) + '\nrenderCliUpdate();';
    runInNewContext(script, context);
    assert.equal(button.disabled, true); assert.equal(button.textContent, '正在檢查…');
    state.busy = false; state.progress = { phase: 'current', version: '2.1.311' };
    runInNewContext('renderCliUpdate();', context);
    assert.equal(button.disabled, false); assert.equal(button.textContent, '檢查更新');
    assert.equal(status.textContent, '已是最新版本 · 2.1.311'); assert.equal(status.hidden, false);
    assert.equal(unrelated.draft, 'Keep this provider edit');
});

test('settings header removes JSON shortcut and shortens global prompt labels without changing its action', () => {
    const start = source.indexOf('    function renderHeader() {');
    const end = source.indexOf('\n    /**', start);
    const html = runInNewContext(source.slice(start, end) + '\nrenderHeader();', { BRAND_NAME: 'Claude Code Config Helper' }) as string;
    assert.equal(html.includes('btn-open-settings'), false);
    assert.equal(html.includes('openSettingsJson'), false);
    assert.ok(html.includes('btn-open-global-shared'));
    assert.ok(html.includes('btn-open-workspace-shared'));
    const labels = [...source.matchAll(/globalPromptTask: '([^']+)'/g)].map(match => match[1]);
    assert.equal(labels.length, 7);
    assert.ok(labels.every(label => !label.includes('/')));
    assert.ok(labels.includes('全域提示詞'));
    const actionStart = source.indexOf("        byId('btn-open-global-shared'");
    const sent: unknown[] = []; let click!: () => void;
    runInNewContext(source.slice(actionStart, source.indexOf('\n', actionStart)), {
        byId: (_id: string, bind: (element: unknown) => void) => bind({ addEventListener: (_event: string, action: () => void) => { click = action; } }),
        post: (type: string) => sent.push(type)
    });
    click(); assert.deepEqual(sent, ['openGlobalSharedSettings']);
});

test('provider heading contains the original add button in place of the removed description', () => {
    const start = source.indexOf('    function renderSectionHead(');
    const end = source.indexOf('\n    /**', start);
    const providersStart = source.indexOf('    function renderProvidersCard() {');
    const providersEnd = source.indexOf('\n    /**', providersStart);
    const html = runInNewContext(source.slice(start, end) + '\n' + source.slice(providersStart, providersEnd) + '\nrenderProvidersCard();', {
        state: { providers: [] }, SECTION_ICON_PROVIDERS: '', text: (value: unknown) => String(value), t: (key: string) => key
    }) as string;
    const heading = html.match(/<div class="section-head providers-heading">([\s\S]*?)<button id="btn-new-provider"[^>]*>[\s\S]*?<\/button>\s*<\/div>/);
    assert.ok(heading, 'The add button belongs to the heading, not a separate full-width row');
    assert.equal(html.includes('providerDescription'), false);
    assert.equal(html.includes('section-description'), false);
    assert.equal((html.match(/id="btn-new-provider"/g) || []).length, 1);
    assert.ok(html.includes('provider-count-value'));
});

test('provider key labels display only validated masked values or the existing localized status', () => {
    const start = source.indexOf('    function providerKeyLabel(');
    const end = source.indexOf('\n    /**', start);
    const script = source.slice(start, end) + '\nproviderKeyLabel(provider);';
    const label = (provider: unknown) => runInNewContext(script, { provider, t: (key: string) => key === 'savedApiKey' ? '已儲存金鑰' : '未儲存金鑰' });
    assert.equal(label({ hasApiKey: true, maskedApiKey: '*ABCD' }), '*ABCD');
    assert.equal(label({ hasApiKey: true }), '已儲存金鑰');
    assert.equal(label({ hasApiKey: false, maskedApiKey: '*ABCD' }), '未儲存金鑰');
    for (const maskedApiKey of ['complete-secret-value', '*too-long', '*<b/>', '* ab ']) assert.equal(label({ hasApiKey: true, maskedApiKey }), '已儲存金鑰');
});
