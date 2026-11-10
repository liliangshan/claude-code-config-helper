/** @file Visible-thinking disclosure tests execute the real Webview controller without model calls. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(resolve(__dirname, '../../../media/chat/thinking.js'), 'utf8');

/** Small DOM records exact text and disclosure state without duplicating the production renderer. */
class Element {
    public className = ''; public textContent = ''; public open = false;
    public dataset: Record<string, string> = {};
    public children: Element[] = [];
    public handlers = new Map<string, () => void>();
    /** Record literal child nodes. */
    public append(...children: Element[]): void { this.children.push(...children); }
    /** Record a single native child append. */
    public appendChild(child: Element): Element { this.children.push(child); return child; }
    /** Record ARIA attributes without executing markup. */
    public setAttribute(): void {}
    /** Observe real user-activation callbacks. */
    public addEventListener(name: string, handler: () => void): void { this.handlers.set(name, handler); }
    /** Match the small class/tag selectors used by the controller. */
    public matches(selector: string): boolean { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tag === selector; }
    /** Bind the simulated tag name. */
    public constructor(public readonly tag = 'div') {}
    /** Return descendants matching real controller selectors. */
    public querySelectorAll(selector: string): Element[] {
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    /** Return one matching descendant. */
    public querySelector(selector: string): Element { const value = this.querySelectorAll(selector)[0]; assert.ok(value, selector); return value; }
}

/** Start isolated per-Webview state with actual localized controller code. */
function fixture() {
    const window: any = {};
    runInNewContext(source, { window, document: { createElement: (tag: string) => new Element(tag) } });
    const ui = window.createThinkingUi('zh-cn');
    const container = new Element();
    const segment = { id: 'thinking:1:0', kind: 'markdown', text: '> 💭 原始内容', thinking: { text: '原始内容', complete: false } };
    const anchor: Element = ui.render(container, segment, 'message-one');
    const root = anchor.querySelector('.thinking-disclosure');
    return { ui, container, segment, anchor, root, panel: root.querySelector('details'), body: root.querySelector('.thinking-disclosure__block') };
}

/** Running/default state collapses only on actual completion; manual open/close always wins. */
test('thinking expands while streaming, settles on completion and respects manual preferences', () => {
    const f = fixture();
    f.ui.settle(f.container, true); assert.equal(f.panel.open, true);
    f.ui.update(f.anchor, { ...f.segment, thinking: { text: '原始内容\n新增内容', complete: false } }, true);
    assert.equal(f.body.textContent, '原始内容\n新增内容'); assert.equal(f.panel.open, true);
    f.ui.update(f.anchor, { ...f.segment, thinking: { text: '结束', complete: true } }, true); assert.equal(f.panel.open, false);
    f.panel.querySelector('summary').handlers.get('click')!(); f.panel.open = true;
    f.ui.settle(f.container, false); assert.equal(f.panel.open, true, 'User expansion stays open after completion');
    f.panel.querySelector('summary').handlers.get('click')!(); f.panel.open = false;
    f.ui.update(f.anchor, f.segment, true); assert.equal(f.panel.open, false, 'User collapse is not reversed by streaming');
    f.ui.reset(); f.ui.settle(f.container, true); assert.equal(f.panel.open, true);
    f.ui.settle(f.container, false); assert.equal(f.panel.open, false);
});

/** Remount/locale updates keep manual choice, and identical segment ordinals in another message remain independent. */
test('thinking choices survive rerender and localization without leaking into other messages', () => {
    const f = fixture(); f.ui.settle(f.container, true);
    f.panel.querySelector('summary').handlers.get('click')!(); f.panel.open = false;
    const remountContainer = new Element();
    const remounted: Element = f.ui.render(remountContainer, f.segment, 'message-one');
    const other: Element = f.ui.render(remountContainer, f.segment, 'message-two'); f.ui.settle(remountContainer, true);
    assert.equal(remounted.querySelector('details').open, false); assert.equal(other.querySelector('details').open, true);
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        f.ui.language(language); f.ui.settle(remountContainer, false);
        assert.ok(remounted.querySelector('.thinking-disclosure__title').textContent.length > 0);
        assert.equal(remounted.querySelector('details').open, false);
    }
});

/** Only explicitly returned thinking or exact historic formatting is wrapped; provider HTML is never interpreted. */
test('thinking contains literal visible text only and does not capture ordinary quotes or tool output', () => {
    const f = fixture(); const raw = '<img src=x onerror=bad()>\n# visible text';
    f.ui.update(f.anchor, { ...f.segment, thinking: { text: raw, complete: true } }, false);
    assert.equal(f.body.textContent, raw); assert.equal(f.body.children.length, 0);
    assert.equal(f.ui.visible({ kind: 'markdown', text: '> Regular quote' }), null);
    assert.equal(f.ui.visible({ kind: 'tool', text: '> 💭 tool output' }), null);
    assert.equal(f.ui.visible({ kind: 'markdown', text: '> 💭 quote\n\nActual answer' }), null);
    assert.equal(f.ui.visible({ kind: 'markdown', text: '> 💭 first\n> next' }).text, 'first\nnext');
    assert.equal(f.ui.visible({ kind: 'markdown', thinking: { text: ' ', complete: true } }), null);
});

/** Thinking across requests shares one reply disclosure without moving intervening tool nodes or losing member text. */
test('multiple thinking blocks share one disclosure with isolated request members and stable in-place updates', () => {
    const f = fixture();
    const tool = new Element(); tool.className = 'tool'; f.container.appendChild(tool);
    const second = { ...f.segment, id: 'thinking:2:0', requestId: 'request-two', thinking: { text: '第二段思考', complete: false } };
    const anchor: Element = f.ui.render(f.container, second, 'message-one');
    assert.equal(f.container.querySelectorAll('.thinking-disclosure').length, 1);
    assert.equal(f.container.querySelectorAll('details').length, 1);
    assert.equal(f.container.children[1], tool);
    assert.equal(f.container.children[2], anchor);
    assert.equal(anchor.dataset.segmentId, 'thinking:2:0');
    const blocks = f.root.querySelectorAll('.thinking-disclosure__block');
    assert.deepEqual(blocks.map(block => block.textContent), ['原始内容', '第二段思考']);
    f.ui.update(f.anchor, { ...f.segment, thinking: { text: '第一段已完成', complete: true } }, true);
    assert.equal(f.panel.open, true, 'A second incomplete block keeps the one disclosure active');
    f.panel.querySelector('summary').handlers.get('click')!(); f.panel.open = false;
    f.ui.update(anchor, { ...second, thinking: { text: '第二段新增内容', complete: false } }, true);
    assert.equal(f.panel.open, false, 'New member content respects the reply-level manual collapse');
    assert.equal(f.root.querySelectorAll('.thinking-disclosure__block')[0], blocks[0]);
    assert.equal(f.root.querySelectorAll('.thinking-disclosure__block')[1], blocks[1]);
    assert.equal(blocks[0].textContent, '第一段已完成'); assert.equal(blocks[1].textContent, '第二段新增内容');
    const same: Element = f.ui.render(f.container, second, 'message-one');
    assert.equal(same, anchor); assert.equal(f.root.querySelectorAll('.thinking-disclosure__block').length, 2);
    f.ui.update(anchor, { ...second, thinking: { text: '第二段已完成', complete: true } }, true);
    assert.equal(f.root.dataset.complete, 'true'); assert.equal(f.root.dataset.pending, 'false');
    const repeatedId = f.ui.render(f.container, { ...second, requestId: 'request-three' }, 'message-one');
    assert.notEqual(repeatedId, anchor); assert.equal(f.root.querySelectorAll('.thinking-disclosure__block').length, 3);
    const other = new Element(); f.ui.render(other, second, 'another-reply');
    assert.equal(other.querySelectorAll('.thinking-disclosure').length, 1);
    const otherUi = fixture(); assert.equal(otherUi.container.querySelectorAll('.thinking-disclosure__block').length, 1);
});

/** Legacy and structured thinking can share one reply without deduplicating distinct id-less historical blocks. */
test('grouped thinking settles only when all members complete and keeps ordered legacy text', () => {
    const f = fixture();
    const legacy = f.ui.render(f.container, { kind: 'markdown', text: '> 💭 历史第一段\n> 下一行' }, 'message-one');
    const another = f.ui.render(f.container, { kind: 'markdown', text: '> 💭 历史第二段' }, 'message-one');
    assert.notEqual(legacy, another);
    assert.deepEqual(f.root.querySelectorAll('.thinking-disclosure__block').map(block => block.textContent), ['原始内容', '历史第一段\n下一行', '历史第二段']);
    f.ui.settle(f.container, true); assert.equal(f.panel.open, true);
    f.ui.update(f.anchor, { ...f.segment, thinking: { text: '已完成', complete: true } }, true);
    assert.equal(f.panel.open, true, 'Other incomplete blocks still keep the group open');
    f.ui.update(legacy, { kind: 'markdown', thinking: { text: '历史第一段\n下一行', complete: true } }, true);
    f.ui.update(another, { kind: 'markdown', thinking: { text: '历史第二段', complete: true } }, true);
    assert.equal(f.panel.open, false); assert.equal(f.root.dataset.complete, 'true');
    f.ui.settle(f.container, false); assert.equal(f.panel.open, false);
});

/** Every runtime loads the same local resources under nonce CSP; approved polish never adds fake content. */
test('all chat hosts load shared polish and thinking resources without relaxing CSP', () => {
    const root = resolve(__dirname, '../../..');
    const html = readFileSync(resolve(root, 'media/chat/index.html'), 'utf8');
    assert.ok(html.includes('{{chatPolishStyleUri}}')); assert.ok(html.indexOf('{{thinkingScriptUri}}') < html.indexOf('{{scriptUri}}'));
    assert.equal(html.includes("'unsafe-inline'"), false);
    for (const file of ['src/chat/chatViewHost.ts', 'src/editorChat/leftView.ts', 'src/editorChat/manager.ts']) {
        const host = readFileSync(resolve(root, file), 'utf8'); assert.ok(host.includes('chatPolish.css'), file); assert.ok(host.includes('thinking.js'), file);
    }
    const main = readFileSync(resolve(root, 'media/chat/main.js'), 'utf8');
    assert.ok(main.includes("existing.classList.contains('thinking-disclosure__anchor')"));
    assert.ok(main.includes("thinkingUi.update(existing, segment"), 'Streaming updates reuse the thinking node instead of rebuilding it');
    assert.ok(main.includes("chatClipboard.defer('thinking-settle'"), 'Completion cannot hide selected thinking before copying finishes');
    const style = readFileSync(resolve(root, 'media/chat/chatPolish.css'), 'utf8');
    assert.ok(style.includes('--vscode-')); assert.ok(style.includes('prefers-reduced-motion')); assert.ok(style.includes('vscode-high-contrast-light'));
    assert.equal(style.replace(/\.thinking-disclosure__panel > summary::-webkit-details-marker\s*\{[^}]*\}/g, '').includes('display: none'), false, 'Only the native decorative marker may be hidden, never message controls');
});

/** The original composer comet runs only with real running state and remains static for reduced-motion users. */
test('chat polish preserves the existing running composer animation and reduced-motion fallback', () => {
    const root = resolve(__dirname, '../../..');
    const base = readFileSync(resolve(root, 'media/chat/style.css'), 'utf8');
    const polish = readFileSync(resolve(root, 'media/chat/chatPolish.css'), 'utf8');
    for (const pseudo of ['before', 'after']) {
        assert.match(base, new RegExp('\\.composer-box--running::' + pseudo + '\\s*\\{[^}]*animation:\\s*lls-input-working-border-spin'));
    }
    assert.doesNotMatch(polish, /\.composer-box--running::(?:before|after)[^{]*\{[^}]*content:\s*none/);
    assert.match(polish, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.chat-root \*::before[\s\S]*animation:\s*none !important/);
});

/** The removed three-dot row has no DOM, styles or running-state references; border and stop feedback remain. */
test('composer has no global pending dots or placeholder while preserving running feedback', () => {
    const root = resolve(__dirname, '../../..');
    const html = readFileSync(resolve(root, 'media/chat/index.html'), 'utf8');
    const main = readFileSync(resolve(root, 'media/chat/main.js'), 'utf8');
    const base = readFileSync(resolve(root, 'media/chat/style.css'), 'utf8');
    const polish = readFileSync(resolve(root, 'media/chat/chatPolish.css'), 'utf8');
    for (const content of [html, main, base, polish]) {
        assert.doesNotMatch(content, /chat-global-pending|globalPendingEl|data-role="global-pending"/);
    }
    assert.match(html, /data-role="context-panel"/);
    assert.ok(main.includes("classList.toggle('composer-box--running', composerState.chatRunning)"));
    assert.ok(main.includes("sendEl.dataset.mode = composerState.chatRunning ? 'stop' : 'send'"));
    assert.match(base, /animation:\s*lls-input-working-border-spin/);
});
