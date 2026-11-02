/** @file Seven-language setup enablement guidance stays passive and uses the extension's actual display name. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const root = resolve(__dirname, '../../..');
const source = readFileSync(resolve(root, 'media/setup.js'), 'utf8');
const displayName = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8'))['extension.displayName'];
const locales = ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'];

/** Minimal DOM captures literal text, accessibility attributes and notice children without running a browser. */
class Element {
    public className = ''; public textContent = ''; public id = '';
    public attributes: Record<string, string> = {}; public children: Element[] = [];
    /** Bind the native tag requested by the real setup renderer. */
    public constructor(public readonly tag: string) {}
    /** Preserve literal attribute values for accessibility assertions. */
    public setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    /** Append only explicit nodes; no HTML parsing or command dispatch is implemented. */
    public append(...children: Element[]): void { this.children.push(...children); }
}

/** Extract a named declaration through the next standard comment, matching existing setup UI tests. */
function declaration(marker: string): string {
    const start = source.indexOf(marker), end = source.indexOf('\n    /**', start);
    assert.ok(start >= 0 && end > start, marker);
    return source.slice(start, end);
}

/** Run the production notice builder with no VS Code API, proving it requires no enablement action. */
function render(language: string): Element {
    return runInNewContext([
        declaration('    const extensionEnablementLabels = {'),
        declaration('    function node('),
        declaration('    function extensionEnablementNotice()'),
        'extensionEnablementNotice();'
    ].join('\n'), { state: { language }, document: { createElement: (tag: string) => new Element(tag) } }) as Element;
}

test('setup enablement reminder covers all seven languages and the real Marketplace display name', () => {
    const rows = runInNewContext(declaration('    const extensionEnablementLabels = {') + '\nextensionEnablementLabels;') as Record<string, string[]>;
    assert.deepEqual(Object.keys(rows).sort(), [...locales].sort());
    assert.equal(new Set(Object.values(rows).map(row => row[0])).size, 7);
    for (const locale of locales) {
        assert.equal(rows[locale].length, 2); assert.ok(rows[locale].every(value => value.trim()));
        const notice = render(locale);
        assert.equal(notice.tag, 'aside'); assert.equal(notice.attributes.role, 'note');
        assert.equal(notice.attributes['aria-labelledby'], notice.children[0].id);
        assert.equal(notice.children[0].tag, 'strong'); assert.equal(notice.children[1].tag, 'p');
        assert.ok(notice.children[1].textContent.includes(displayName));
        assert.ok(notice.children[1].textContent.includes('VS Code'));
        assert.equal(notice.children[1].textContent.includes('undefined'), false);
    }
    assert.match(rows['zh-cn'][1], /左侧.*扩展.*商店/);
    assert.match(rows['zh-cn'][1], /启用（工作区）/);
    assert.match(rows['zh-cn'][1], /齿轮.*全局启用/);
    assert.match(rows.en[1], /Enable \(Workspace\).*gear.*Enable Globally/);
    assert.equal(render('unknown').children[1].textContent, render('en').children[1].textContent);
});

test('setup reminder appears on every step without changing Next or extension enablement', () => {
    assert.ok(source.includes('page.append(section, extensionEnablementNotice());'));
    const notice = declaration('    function extensionEnablementNotice()');
    assert.equal(/postMessage|executeCommand|onclick|innerHTML/.test(notice), false);
    assert.equal(/enableAll|enableGlobally|enableExtension/.test(source), false);
    assert.ok(source.includes("button('下一步', 'Next', 'next', 'primary')"));
    assert.ok(source.includes("button('下一步', 'Next', 'review', 'primary')"));
    const css = readFileSync(resolve(root, 'media/setup.css'), 'utf8');
    assert.match(css, /\.extension-enablement-notice\s*\{[^}]*overflow-wrap:\s*anywhere/);
});
