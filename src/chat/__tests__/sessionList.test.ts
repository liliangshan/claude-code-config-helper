/** @file Execute the real history-drawer functions to verify localization, isolation, closing and resume behavior. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');

/** Minimal DOM tracks native history attributes, focus, rendering and row clicks without duplicating drawer logic. */
class HistoryElement {
    public innerHTML = ''; public inert = true; public focused = false;
    public readonly attributes = new Map<string, string>();
    public readonly handlers = new Map<string, () => void>();
    public rows: HistoryElement[] = [];
    public closeButton?: HistoryElement;
    /** Write observable ARIA state. */
    public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    /** Read the selected history identity. */
    public getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    /** Record native keyboard-focus movement. */
    public focus(): void { this.focused = true; }
    /** Return the close control requested by the actual open function. */
    public querySelector(): HistoryElement | undefined { return this.closeButton; }
    /** Return supplied rows after list HTML has been rendered. */
    public querySelectorAll(): HistoryElement[] { return this.rows; }
    /** Bind row clicks using the actual render function. */
    public addEventListener(event: string, action: () => void): void { this.handlers.set(event, action); }
}

/** Create two independent Webview contexts running the same real asset functions in the selected language. */
function drawer(language: string) {
    const panel = new HistoryElement(); const content = new HistoryElement(); const button = new HistoryElement();
    panel.closeButton = new HistoryElement();
    const sent: unknown[] = [];
    const chatTranslations: Record<string, Record<string, string>> = Object.fromEntries(['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'].map(key => [key, {}]));
    const translationsStart = source.indexOf('    const sessionListTranslations = {');
    const translationsEnd = source.indexOf('\n    /**', translationsStart);
    const functionsStart = source.indexOf('    function openSessions() {');
    const functionsEnd = source.indexOf('\n    /**', source.indexOf('    function escapeHtml(', functionsStart));
    assert.ok(functionsStart > 0 && functionsEnd > functionsStart);
    const context = { chatTranslations, currentLanguage: language, HTMLElement: HistoryElement,
        sessionListDialogEl: panel, sessionListContentEl: content, openSessionsEl: button,
        t: (key: string) => chatTranslations[language][key],
        post: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))) };
    const handlers = runInNewContext(source.slice(translationsStart, translationsEnd) + '\n' + source.slice(functionsStart, functionsEnd)
        + '\n({ openSessions, closeSessionList, renderSessionList, getSessionDateGroup, formatTimeAgo });', context) as {
            openSessions(): void; closeSessionList(): void; renderSessionList(sessions: unknown[]): void;
            getSessionDateGroup(ts: number, now: number): string; formatTimeAgo(ts: number, now: number): string;
        };
    return { panel, content, button, sent, handlers, labels: chatTranslations[language] };
}

/** Listing and dismissing histories must never clear/restart chat or touch the opposite Webview. */
test('left and right history drawers request only their own list and resume only the clicked session', () => {
    const left = drawer('zh-cn'); const right = drawer('en');
    left.handlers.openSessions();
    assert.deepEqual(left.sent, [{ type: 'sessions/list' }]); assert.deepEqual(right.sent, []);
    assert.equal(left.panel.inert, false); assert.equal(left.panel.attributes.get('aria-hidden'), 'false');
    assert.equal(left.button.attributes.get('aria-expanded'), 'true'); assert.equal(left.panel.closeButton?.focused, true);
    assert.ok(left.content.innerHTML.includes('加载中…'));
    assert.equal(right.content.innerHTML, '');
    const row = new HistoryElement(); row.setAttribute('data-session-id', 'saved-left'); left.content.rows = [row];
    left.handlers.renderSessionList([{ sessionId: 'saved-left', summary: '<img src=x onerror=bad()>', gitBranch: '<script>bad()</script>', lastModified: Date.now() }]);
    assert.ok(left.content.innerHTML.includes('&lt;img')); assert.equal(left.content.innerHTML.includes('<img'), false);
    assert.equal(left.content.innerHTML.includes('<script>'), false);
    row.handlers.get('click')!();
    assert.deepEqual(left.sent, [{ type: 'sessions/list' }, { type: 'session/resume', sessionId: 'saved-left' }]);
    assert.equal(left.panel.inert, true); assert.equal(left.panel.attributes.get('aria-hidden'), 'true');
    assert.equal(left.button.attributes.get('aria-expanded'), 'false'); assert.equal(left.button.focused, true);
    right.handlers.openSessions(); right.handlers.closeSessionList();
    assert.deepEqual(right.sent, [{ type: 'sessions/list' }]);
});

/** Dynamic loading/empty/date text uses the active locale, not only the statically translated button. */
test('history loading, empty state, close actions and dates stay localized in all seven languages', () => {
    const now = new Date(2026, 9, 28, 12).getTime();
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        const view = drawer(language); view.handlers.openSessions();
        assert.ok(view.content.innerHTML.includes(view.labels.sessionsLoading));
        view.handlers.renderSessionList([]); assert.ok(view.content.innerHTML.includes(view.labels.sessionsEmpty));
        assert.equal(view.handlers.getSessionDateGroup(now, now), view.labels.sessionsToday);
        assert.equal(view.handlers.getSessionDateGroup(now - 86400000, now), view.labels.sessionsYesterday);
        const relative = view.handlers.formatTimeAgo(now - 120000, now);
        assert.equal(relative, new Intl.RelativeTimeFormat(language, { numeric: 'always', style: 'short' }).format(-2, 'minute'));
    }
});

/** Real button, backdrop and Escape bindings must be present, not just callable drawer helper functions. */
test('history entry, close button, backdrop and Escape use the restored drawer actions', () => {
    const callbacks = new Map<string, (event?: { key: string }) => void>();
    const controls = ['button', 'backdrop'].map(name => {
        const element = new HistoryElement();
        element.addEventListener = (_event: string, action: () => void) => { callbacks.set(name, action); };
        return element;
    });
    let opened = 0; let closed = 0;
    const openBinding = source.split('\n').find(line => line.includes("openSessionsEl?.addEventListener('click', openSessions)"));
    const closeStart = source.indexOf('    sessionListCloseEls.forEach((el) => {');
    const closeEnd = source.indexOf('    contextClearEl', closeStart);
    assert.ok(openBinding); assert.ok(closeStart > 0 && closeEnd > closeStart);
    runInNewContext(openBinding + '\n' + source.slice(closeStart, closeEnd), {
        HTMLElement: HistoryElement, sessionListCloseEls: controls,
        sessionListDialogEl: Object.assign(new HistoryElement(), {
            addEventListener: (_event: string, action: (event: { key: string }) => void) => callbacks.set('keydown', event => { if (event) action(event); })
        }),
        openSessionsEl: { addEventListener: (_event: string, action: () => void) => callbacks.set('open', action) },
        openSessions: () => { opened++; }, closeSessionList: () => { closed++; }
    });
    callbacks.get('open')!(); assert.equal(opened, 1);
    callbacks.get('button')!(); callbacks.get('backdrop')!(); assert.equal(closed, 2);
    callbacks.get('keydown')!({ key: 'Enter' }); assert.equal(closed, 2);
    callbacks.get('keydown')!({ key: 'Escape' }); assert.equal(closed, 3);
});

/** Explicit history reloading bypasses message-ID deduplication, while ordinary ready/init remains incremental. */
test('explicit history initialization redraws matching message IDs and ordinary initialization remains deduplicated', () => {
    const start = source.indexOf("            case 'session/init':");
    const end = source.indexOf("            case 'request/usage':", start);
    assert.ok(start > 0 && end > start);
    const block = source.slice(start + "            case 'session/init':".length, end);
    let clears = 0; let appended = 0;
    const context = { lastSessionInitSignature: 'same', currentCliPath: '', currentCliStatus: '', currentCliDetail: '',
        renderedMessagesCache: [], historyReplayMode: false,
        message: { messages: [{ id: 'same', role: 'assistant', segments: [{ kind: 'markdown', text: 'Updated history' }] }], cliPath: '/cli', replace: true },
        updateRequestRecoveryStatus: () => {}, setChatRunning: () => {}, updateCliStatusText: () => {},
        buildSessionInitSignature: () => 'same', cloneMessagesForCache: (value: unknown) => value,
        messagesEl: { querySelector: () => ({}) }, findIncrementalInitStart: () => 1,
        chatClipboard: { reset: () => {} }, renderEmptyState: () => { clears++; }, syncClaudeTodoFromMessages: () => {},
        appendMessage: () => { appended++; }, finalizeHistoryReplayAskUser: () => {}, forceScrollToBottomSettled: () => {}, syncSessionInitSignatureFromDom: () => {}
    };
    runInNewContext('do { ' + block + ' } while (false);', context);
    assert.equal(clears, 1); assert.equal(appended, 1);
    context.message.replace = false;
    runInNewContext('do { ' + block + ' } while (false);', context);
    assert.equal(clears, 1); assert.equal(appended, 1, 'Ordinary duplicate ready/init still avoids flashing or resending anything');
});
