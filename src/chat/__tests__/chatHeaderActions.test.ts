/** @file Verify compact text actions and shared title-dialog behavior from actual chat assets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');

test('editor and main chat share the existing restart action with progress, not a separate CLI-only button', () => {
    const html = readFileSync(resolve(__dirname, '../../../media/chat/index.html'), 'utf8');
    const primary = html.match(/<div class="chat-actions chat-actions--primary">([\s\S]*?)<\/div>/)?.[1] || '';
    const secondary = html.match(/<div class="chat-actions chat-actions--sessions">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.ok(secondary.includes('data-role="session-title-edit"'));
    assert.equal(primary.includes('data-role="session-title-edit"'), false);
    assert.equal(html.includes('data-role="restart-cli-only"'), false);
    for (const role of ['restart-cli', 'editor-session-new', 'new-session', 'help-open']) assert.ok(secondary.includes(`data-role="${role}"`));
    assert.equal(primary.includes('data-role="editor-session-new"'), false);
    for (const role of ['editor-session-new', 'extension-settings']) {
        assert.match(html, new RegExp(`<button[^>]*class="sidebar-only"[^>]*data-role="${role}"`));
    }
    assert.equal(html.includes('data-role="editor-session-list"'), false);
    assert.equal(html.includes('data-role="editor-session-reset"'), false);
    const header = html.match(/<header class="chat-header">([\s\S]*?)<\/header>/)?.[1] || '';
    assert.ok(header.indexOf('data-role="session-title"') < header.indexOf('class="chat-actions-row"'));
    for (const role of ['cli-status', 'models-bar', 'normal-model-name', 'taskflow-model-name', 'open-model-picker']) assert.equal(header.includes(`data-role="${role}"`), false);
    assert.ok(html.includes('data-role="composer-normal-chip"'));
    assert.ok(html.includes('data-role="composer-taskflow-chip"'));
    const css = readFileSync(resolve(__dirname, '../../../media/chat/style.css'), 'utf8');
    assert.match(css, /\.chat-header\s*\{[^}]*flex-wrap: nowrap;/);
    assert.match(css, /\.chat-header__main\s*\{[^}]*flex: 0 1 auto;/);
    assert.match(css, /\.sidebar-chat \.chat-actions-row\s*\{[^}]*margin-left: auto;[^}]*justify-content: safe flex-end;/);
    assert.match(css, /\.sidebar-only\s*\{\s*display: none;/);
    assert.match(css, /\.chat-actions-row\s*\{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/);
    assert.match(source, /\[data-role="session-title-edit"\].*addEventListener\('click', beginSessionTitleEdit\)/);
    assert.match(source, /\[data-role="editor-session-new"\].*leftSessions\/show/);
    assert.equal(source.includes('data-role="restart-cli-only"'), false);
    assert.match(source, /restartCliEl\?\.addEventListener\('click', \(\) => post\(\{ type: 'cli\/restart' \}\)\)/);
});

test('chat no longer exposes conversation-list controls while preserved history translations remain localized', () => {
    const start = source.indexOf('    const sessionListTranslations = {');
    const end = source.indexOf('\n    /**', start);
    assert.ok(start >= 0 && end > start);
    const translations: Record<string, Record<string, string>> = Object.fromEntries(['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'].map(language => [language, {}]));
    runInNewContext(source.slice(start, end), { chatTranslations: translations });
    assert.equal(translations['zh-cn'].sessions, '会话列表');
    assert.equal(translations['zh-tw'].sessions, '會話列表');
    for (const values of Object.values(translations)) {
        assert.ok(values.sessions); assert.equal(values.sessionsTitle, values.sessions);
        assert.ok(values.sessionsLoading); assert.ok(values.sessionsEmpty);
    }
    const html = readFileSync(resolve(__dirname, '../../../media/chat/index.html'), 'utf8');
    for (const role of ['open-sessions', 'session-list', 'editor-session-list', 'left-session-list']) {
        assert.equal(html.includes(`data-role="${role}"`), false);
    }
    assert.equal(source.includes('openSessionsEl?.addEventListener'), false);
});

/** Minimal dialog DOM drives the actual title editor rather than a copied implementation. */
class DialogElement {
    public className = ''; public textContent = ''; public value = ''; public title = ''; public open = false;
    public children: DialogElement[] = []; public handlers: Record<string, (event?: any) => void> = {};
    /** Append an element while keeping dialog structure observable. */
    public appendChild(child: DialogElement): void { this.children.push(child); }
    /** Register click and key handlers for deterministic interaction. */
    public addEventListener(name: string, handler: (event?: any) => void): void { this.handlers[name] = handler; }
    /** Open the dialog, matching the Webview's native modal API. */
    public showModal(): void { this.open = true; }
    /** Close also emits close to test duplicate-submission protection. */
    public close(): void { this.open = false; this.handlers.close?.(); }
    /** Removal has no external side effects in this unit test. */
    public remove(): void {}
    /** Focus is intentionally inert in the DOM stub. */
    public focus(): void {}
    /** Text selection is intentionally inert in the DOM stub. */
    public select(): void {}
    /** Return the configured fallback heading. */
    public getAttribute(): string { return 'LLS CLAUDE CHAT'; }
}

test('shared title dialog saves once, updates display and never renames a session switched while open', () => {
    const start = source.indexOf('    function applySessionTitle(');
    const end = source.indexOf('\n    /**', source.indexOf('    function beginSessionTitleEdit(', start));
    assert.ok(start >= 0 && end > start);
    const dialogs: DialogElement[] = []; const sent: any[] = []; const heading = new DialogElement();
    const context = {
        document: { createElement: () => new DialogElement(), body: { appendChild: (dialog: DialogElement) => dialogs.push(dialog) } },
        sessionTitleEl: heading, sessionTitleEditing: false, currentSessionTitleId: 'one', currentSessionTitleFull: 'Old title',
        HTMLDialogElement: DialogElement, t: (key: string) => key, post: (message: unknown) => sent.push(message)
    };
    runInNewContext(source.slice(start, end) + '\nbeginSessionTitleEdit();', context);
    const dialog = dialogs[0]; dialog.children[1].value = 'Changed title';
    dialog.children[2].children[1].handlers.click();
    assert.equal(sent.length, 1); assert.equal(sent[0].sessionId, 'one'); assert.equal(sent[0].title, 'Changed title');
    assert.equal(heading.textContent, 'Changed title');
    runInNewContext('beginSessionTitleEdit(); applySessionTitle("Other task", "two");', context);
    dialogs[1].children[1].value = 'Must not rename the new session';
    dialogs[1].children[2].children[1].handlers.click();
    assert.equal(sent.length, 1); assert.equal(heading.textContent, 'Other task');
});
