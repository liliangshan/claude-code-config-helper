/** @file 从真实前端源码验证代码预览开关顺序、七语言和状态回填。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');

/** 提供动态工具栏构建所需的最小 DOM，不复制产品实现。 */
class TestElement {
    public dataset: Record<string, string> = {};
    public children: TestElement[] = [];
    public checked = false;
    public disabled = false;
    public textContent = '';
    public handlers: Record<string, () => void> = {};
    /** 添加 DOM 子节点。 */
    public append(...children: TestElement[]): void { this.children.push(...children); }
    /** 添加单个 DOM 子节点。 */
    public appendChild(child: TestElement): void { this.children.push(child); }
    /** 属性值不影响本测试的状态逻辑。 */
    public setAttribute(): void {}
    /** 保存点击/变更监听器供测试驱动。 */
    public addEventListener(name: string, handler: () => void): void { this.handlers[name] = handler; }
    /** 保存插入的工具栏。 */
    public insertAdjacentElement(_position: string, child: TestElement): void { this.children.push(child); }
}

/** 从源码提取指定函数。 */
function extract(name: string): string {
    const start = source.indexOf(`    function ${name}(`);
    const end = source.indexOf('\n    /**', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
}

test('七种语言均有名称与提示，代码预览位于自动压缩后且默认关闭', () => {
    const languages = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja', 'fr', 'de'];
    const start = source.indexOf('    /** 代码预览开关标签');
    const end = source.indexOf('    /** 缓存低命中', start);
    const translations: Record<string, Record<string, string>> = Object.fromEntries(languages.map(language => [language, {}]));
    runInNewContext(source.slice(start, end), { chatTranslations: translations });
    for (const language of languages) {
        assert.ok(translations[language].codePreviewLabel);
        assert.ok(translations[language].codePreviewTitle);
        const composer = new TestElement();
        const sent: unknown[] = [];
        const sandbox = {
            document: { querySelector: (selector: string) => selector === '.composer-box' ? composer : null, createElement: () => new TestElement() },
            HTMLElement: TestElement,
            tokenMeterWrapEl: null,
            composerState: { subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, chatRunning: true },
            createComposerShortcutButton: () => new TestElement(),
            t: (key: string) => translations[language][key] ?? key,
            post: (message: unknown) => sent.push(message),
            renderBrowserAutoApproveHint: () => {}, applyI18n: () => {}, applyRunningDisabledControls: () => {}
        };
        runInNewContext(extract('ensureComposerShortcutBar') + '\nensureComposerShortcutBar();', sandbox);
        const bar = composer.children[0];
        const roles = bar.children.map(label => label.children[0]?.dataset.role).filter(Boolean);
        assert.deepEqual(roles, ['subagents-toggle', 'auto-compact-toggle', 'code-preview-toggle']);
        const label = bar.children[bar.children.length - 1];
        const input = label.children[0];
        assert.equal(label.children[1].textContent, translations[language].codePreviewLabel);
        assert.equal(input.checked, false);
        input.checked = true;
        input.handlers.change();
        assert.equal(input.disabled, true);
        assert.equal(JSON.stringify(sent), JSON.stringify([{ type: 'codePreview/select', enabled: true }]));
    }
});

test('宿主回填更新开关并解除等待状态，运行中也允许切换', () => {
    const input = new TestElement();
    input.disabled = true;
    const state = { codePreviewEnabled: false };
    const start = source.indexOf("            case 'codePreview/current':");
    const end = source.indexOf("            case 'autoCompact/current':", start);
    const sandbox = {
        composerState: state, message: { type: 'codePreview/current', enabled: true },
        document: { querySelector: () => input }, HTMLInputElement: TestElement
    };
    runInNewContext('switch (message.type) {\n' + source.slice(start, end) + '\n}', sandbox);
    assert.equal(state.codePreviewEnabled, true);
    assert.equal(input.checked, true);
    assert.equal(input.disabled, false);
    assert.equal(extract('applyRunningDisabledControls').includes('code-preview-toggle'), false);
});
