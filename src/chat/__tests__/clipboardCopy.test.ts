/** @file Tests execute the actual clipboard controller without loading the full chat renderer. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

/** Minimal editable element used to verify native composer copy remains untouched. */
class Editable {
    /** Report an editable ancestor to the controller. */
    public closest(): this { return this; }
}

/** Install the real controller against observable DOM, clipboard messages and timers. */
function harness() {
    const listeners: Record<string, (event: any) => void> = {};
    const sent: any[] = [];
    const timers = new Map<number, () => void>();
    let timer = 0;
    const selection = { isCollapsed: false, anchorNode: {}, focusNode: {}, rangeCount: 1, toString: () => 'selected text', getRangeAt: () => ({ intersectsNode: () => true }) };
    const root = { contains: () => true };
    const elements: any[] = [];
    const listen = (type: string, fn: (event: any) => void): void => {
        const previous = listeners[type];
        listeners[type] = event => { previous?.(event); fn(event); };
    };
    const document = {
        addEventListener: listen,
        body: { appendChild: () => {} },
        createElement: () => {
            const node = { className: '', textContent: '', style: {}, offsetWidth: 100, offsetHeight: 30,
                events: {} as Record<string, () => void>, setAttribute: () => {}, appendChild: () => {}, remove: () => {}, contains: () => false,
                addEventListener(type: string, fn: () => void): void { this.events[type] = fn; } };
            elements.push(node); return node;
        }
    };
    const window: any = { getSelection: () => selection, addEventListener: document.addEventListener };
    runInNewContext(readFileSync(resolve(__dirname, '../../../media/chat/clipboard.js'), 'utf8'), {
        window, document, Element: Editable, Map, Promise,
        setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id)
    });
    const controller = window.installChatClipboard({ postMessage: (message: unknown) => sent.push(message) }, root, (key: string) => key);
    return { controller, selection, listeners, sent, timers, root, elements };
}

test('copy resolves only after host success; failure never reports copied', async () => {
    const h = harness();
    const success = h.controller.write('code');
    assert.equal(h.sent[0].type, 'clipboard/write');
    h.listeners.message({ data: { type: 'from-extension', message: { type: 'clipboard/result', requestId: h.sent[0].requestId, ok: true } } });
    await success; assert.equal(h.timers.size, 0);
    const failure = h.controller.write('more');
    h.listeners.message({ data: { type: 'clipboard/result', requestId: h.sent[1].requestId, ok: false } });
    await assert.rejects(failure, /failed/);
});

test('Ctrl/Cmd+C copy a selected message but preserve textarea and empty-selection shortcuts', () => {
    const h = harness(); let prevented = 0;
    const event = { key: 'c', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target: {}, preventDefault: () => prevented++, stopPropagation: () => {} };
    h.listeners.keydown(event); assert.equal(prevented, 1); assert.equal(h.sent[0].text, 'selected text');
    h.listeners.keydown({ ...event, target: new Editable() }); assert.equal(prevented, 1);
    h.selection.isCollapsed = true; h.listeners.keydown(event); assert.equal(prevented, 1);
    h.selection.isCollapsed = false; h.listeners.keydown({ ...event, ctrlKey: false, metaKey: true }); assert.equal(prevented, 2);
});

test('copy acknowledgement timeout rejects rather than falsely showing success', async () => {
    const h = harness(); const pending = h.controller.write('code');
    const rejection = assert.rejects(pending, /timed out/);
    [...h.timers.values()][0](); await rejection;
});

test('native copy uses current selection, not a stale cached selection', () => {
    const h = harness(); const output: string[] = [];
    h.listeners.copy({ target: {}, clipboardData: { setData: (_mime: string, text: string) => output.push(text) }, preventDefault: () => {} });
    assert.deepEqual(output, ['selected text']);
    assert.equal(h.sent[0].type, 'clipboard/write');
    assert.equal(h.sent[0].text, 'selected text');
    h.selection.isCollapsed = true;
    h.listeners.copy({ target: {}, preventDefault: () => assert.fail('empty copy must not be intercepted') });
});

test('message context menu retains selected text even when native selection collapses before opening', () => {
    const h = harness();
    const event = { button: 2, target: {}, clientX: 20, clientY: 20, preventDefault: () => {}, stopPropagation: () => {} };
    h.listeners.mousedown(event);
    h.selection.isCollapsed = true;
    h.listeners.contextmenu(event);
    const button = h.elements[1];
    assert.ok(button);
    h.listeners.blur({});
    button.events.click();
    assert.equal(h.sent[0].text, 'selected text');
});

test('selected streaming nodes defer redraw, coalesce and release when deselected', () => {
    const h = harness(); let rendered = 0;
    assert.equal(h.controller.defer('message', {}, () => rendered = 1), true);
    h.controller.defer('message', {}, () => rendered = 2);
    h.listeners.selectionchange({}); assert.equal(rendered, 0);
    h.selection.isCollapsed = true; h.listeners.selectionchange({}); assert.equal(rendered, 2);
    h.listeners.selectionchange({}); assert.equal(rendered, 2);
});

test('conversation reset discards deferred callbacks instead of repainting old content', () => {
    const h = harness(); h.controller.defer('message', {}, () => assert.fail('old conversation'));
    h.controller.reset(); h.selection.isCollapsed = true; h.listeners.selectionchange({});
});
