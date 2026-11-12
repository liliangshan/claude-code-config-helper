/** @file Shared model picker presentation and unchanged selection/save contract regressions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = resolve(__dirname, '../../..');
const html = readFileSync(resolve(root, 'media/chat/index.html'), 'utf8');
const source = readFileSync(resolve(root, 'media/chat/main.js'), 'utf8');
const style = readFileSync(resolve(root, 'media/chat/chatPolish.css'), 'utf8');

/** Extract real functions so tests verify the actual message contract instead of a copied implementation. */
function block(name: string): string {
    const start = source.indexOf('    function ' + name + '(');
    const end = source.indexOf('\n    /**', start);
    assert.ok(start > 0 && end > start, name);
    return source.slice(start, end);
}

/** New markup retains native controls and stable data-role keys, with associated accessible labels. */
test('model picker has labeled native selects and a scroll body between header and footer', () => {
    const start = html.indexOf('<dialog class="model-picker"');
    const end = html.indexOf('</dialog>', start);
    const dialog = html.slice(start, end);
    assert.match(dialog, /aria-labelledby="model-picker-title"/);
    assert.match(dialog, /aria-describedby="model-picker-description"/);
    assert.ok(dialog.indexOf('model-picker__header') < dialog.indexOf('model-picker__body'));
    assert.ok(dialog.indexOf('model-picker__body') < dialog.indexOf('model-picker__footer'));
    for (const [role, label] of [['normal', 'normal'], ['taskflow', 'taskflow'], ['compaction', 'compaction'], ['cache-ttl', 'cache']]) {
        const select = dialog.match(new RegExp('<select[^>]*data-role="model-picker-' + role + '-select"[^>]*>'))?.[0] ?? '';
        assert.ok(select); assert.ok(select.includes('aria-labelledby="picker-' + label + '-label"'));
    }
    assert.match(dialog, /type="submit"[^>]*data-role="model-picker-save"/);
    assert.match(style, /\.model-picker__body\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
    assert.match(style, /\.model-picker__footer\s*\{[^}]*flex:\s*0 0 auto/);
});

/** All supplemental captions and close actions follow the existing seven locale choices. */
test('model picker descriptions and compaction labels are complete in seven languages', () => {
    const start = source.indexOf('    const modelPickerDescriptions = {');
    const end = source.indexOf('\n    /** 补齐上下文窗口', start);
    assert.ok(start > 0 && end > start);
    const chatTranslations = Object.fromEntries(['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'].map(language => [language, {}]));
    runInNewContext(source.slice(start, end), { chatTranslations });
    for (const labels of Object.values(chatTranslations)) for (const key of ['pickerDescription', 'pickerNormalHint', 'pickerTaskFlowHint', 'pickerCompactionHint', 'pickerCacheHint', 'pickerRestartHint', 'pickerClose', 'pickerOnSave', 'pickerImmediate', 'pickerCacheImmediateHint']) {
        assert.ok(typeof (labels as Record<string, unknown>)[key] === 'string' && (labels as Record<string, string>)[key].length, key);
    }
});

/** Appearance changes do not send requests, change optional-model semantics or combine the independent cache update. */
test('model picker still submits the exact model tuple once and closes through the existing action', () => {
    class Select { /** Hold the same provider/model value as a native select. */ public constructor(public value: string) {} }
    const sent: any[] = []; let closed = 0, rendered = 0;
    const context = { HTMLSelectElement: Select, modelPickerNormalSelectEl: new Select('p/deepseek-v4'), modelPickerTaskFlowSelectEl: new Select(''),
        modelPickerCompactionSelectEl: new Select('summary/glm-5.3-flash'), composerState: {} as any,
        renderModelsBar: () => { rendered++; }, post: (message: unknown) => sent.push(message), closeModelPicker: () => { closed++; } };
    const submit = runInNewContext(block('readModelPickerSelection') + '\n' + block('submitModelPicker') + '\nsubmitModelPicker;', context);
    submit();
    assert.equal(sent.length, 1); assert.equal(sent[0].type, 'models/applyPair');
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { type: 'models/applyPair', normal: { providerId: 'p', modelId: 'deepseek-v4' }, taskFlow: null, compaction: { providerId: 'summary', modelId: 'glm-5.3-flash' } });
    assert.equal(closed, 1); assert.equal(rendered, 1); assert.equal(context.composerState.taskFlowEnabled, false);
    assert.equal(sent.some(value => value.type === 'cacheTtl/select'), false);
});

/** Full identifiers are plain text, optional fallbacks remain empty, and presentation never posts a message. */
test('model picker selected details safely display actual identifiers and clear empty or missing selections', () => {
    const detail = { textContent: '', hidden: true };
    /** Minimal native-select stand-in for side-effect-free presentation regression coverage. */
    class Select {
        public title = '';
        public parentElement = { querySelector: (selector: string) => selector === '.model-picker__detail' ? detail : null };
        /** Mirror only the native select members consumed by the production presentation helper. */
        public constructor(public value: string, public selectedOptions: { textContent: string; disabled: boolean }[]) {}
    }
    const update = runInNewContext(block('renderModelPickerSelectionDetail') + '\nrenderModelPickerSelectionDetail;', { HTMLSelectElement: Select });
    const key = 'provider/<img src=x onerror=alert(1)>/long-model-name';
    const select = new Select(key, [{ textContent: 'Provider: Long model', disabled: false }]);
    update(select);
    assert.equal(detail.textContent, key); assert.equal(detail.hidden, false);
    assert.equal(select.title, 'Provider: Long model — ' + key);
    select.value = ''; select.selectedOptions[0].textContent = 'Follow normal model';
    update(select);
    assert.equal(detail.textContent, ''); assert.equal(detail.hidden, true); assert.equal(select.title, 'Follow normal model');
    select.value = key; select.selectedOptions[0].disabled = true;
    update(select); assert.equal(detail.textContent, ''); assert.equal(detail.hidden, true);
    select.selectedOptions = []; update(select);
    assert.equal(select.title, ''); assert.equal(detail.hidden, true);
    update(null);
});

/** Responsive styling retains all four sections, timing descriptions and keyboard-visible actions. */
test('model picker adapts optional cards and exposes model and cache timing without replacing native selects', () => {
    assert.match(style, /@media\s*\(min-width:\s*560px\)[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(style, /\.model-picker__body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(style, /\.model-picker__detail\s*\{[^}]*overflow-wrap:\s*anywhere/);
    assert.match(style, /\.model-picker\s+:is\(button,\s*select\):focus-visible/);
    assert.match(html, /data-i18n="pickerOnSave"/);
    assert.match(html, /data-i18n="pickerImmediate"/);
    assert.match(html, /id="picker-cache-note"[\s\S]*data-i18n="pickerCacheImmediateHint"/);
    for (const role of ['normal', 'taskflow', 'compaction']) {
        assert.match(html, new RegExp('aria-describedby="picker-' + role + '-hint picker-' + role + '-detail"'));
        assert.match(html, new RegExp('data-role="model-picker-' + role + '-detail" hidden'));
    }
});

/** Sorting uses provider grouping then natural model IDs, not aliases, and never mutates snapshots. */
test('model picker sorts providers then model IDs consistently across supported languages', () => {
    const models = Object.freeze([
        Object.freeze({ providerId: 'z', providerName: 'Zulu', modelId: 'a-first', displayName: 'First alias' }),
        Object.freeze({ providerId: 'a', providerName: 'Alpha', modelId: 'model-10', displayName: 'A alias' }),
        Object.freeze({ providerId: 'b', providerName: 'Alpha', modelId: 'a-first', displayName: 'A alias' }),
        Object.freeze({ providerId: 'a', providerName: 'Alpha', modelId: 'model-2', displayName: 'Z alias' }),
        Object.freeze({ providerId: 'a', providerName: 'Alpha', modelId: 'vendor/model-1', displayName: 'B alias' })
    ]);
    for (const currentLanguage of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        const sort = runInNewContext(block('sortModelPickerOptions') + '\nsortModelPickerOptions;', { currentLanguage });
        const sorted = Array.from(sort(models)) as typeof models[number][];
        assert.deepEqual(sorted.map(model => model.providerId + '/' + model.modelId), [
            'a/model-2', 'a/model-10', 'a/vendor/model-1', 'b/a-first', 'z/a-first'
        ], currentLanguage);
        assert.notEqual(sorted, models);
        assert.ok(sorted.every(model => models.includes(model)), 'Option objects and their selected metadata are unchanged');
        assert.deepEqual(Array.from(sort(undefined)), []);
        assert.deepEqual(Array.from(sort([])), []);
    }
    assert.equal(models[0].providerId, 'z');
    assert.equal(models[1].modelId, 'model-10');
});

/** Exact spelling resolves collation ties, while missing provider names fall back to their IDs. */
test('model picker sorting has stable tie breaks independent of input order', () => {
    const sort = runInNewContext(block('sortModelPickerOptions') + '\nsortModelPickerOptions;', { currentLanguage: 'en' });
    const models = [
        { providerId: 'p', providerName: 'Same', modelId: 'model-2' },
        { providerId: 'p', providerName: 'Same', modelId: 'Model-2' },
        { providerId: 'q', providerName: 'Same', modelId: 'model-1' },
        { providerId: 'Alpha', providerName: '', modelId: 'model-9' }
    ];
    const keys = (values: typeof models) => values.map(model => model.providerId + '/' + model.modelId);
    const expected = ['Alpha/model-9', 'p/Model-2', 'p/model-2', 'q/model-1'];
    assert.deepEqual(Array.from(keys(sort(models))), expected);
    assert.deepEqual(Array.from(keys(sort([...models].reverse()))), expected);
});

/** All three production renderers sort only option display, retaining saved values and optional empty rows. */
test('normal task-flow and compaction dropdowns preserve selection and fallback after sorting', () => {
    /** Minimal option state matching the fields read and written by production renderers. */
    class Option {
        public value = '';
        public textContent = '';
        public title = '';
        public disabled = false;
        public selected = false;
    }
    /** Minimal single-select behavior for rebuilding and preserving the native selected option. */
    class Select {
        public options: Option[] = [];
        public title = '';
        public detail = { textContent: '', hidden: true };
        public parentElement = { querySelector: () => this.detail };
        /** Setting innerHTML to empty removes previous options like a native select. */
        public set innerHTML(_value: string) { this.options = []; }
        /** Append a single-select option without losing an explicitly selected later option. */
        public appendChild(option: Option): void {
            if (option.selected) this.options.forEach(item => { item.selected = false; });
            if (this.options.length === 0) option.selected = true;
            this.options.push(option);
        }
        /** Return the actual selected option used by detail rendering. */
        public get selectedOptions(): Option[] { return this.options.filter(option => option.selected); }
        /** Preserve the provider/model identity rather than selecting by its sorted position. */
        public get value(): string { return this.selectedOptions[0]?.value ?? ''; }
    }
    const models = Object.freeze([
        Object.freeze({ providerId: 'z', providerName: 'Zulu', modelId: 'first', displayName: 'A alias' }),
        Object.freeze({ providerId: 'a', providerName: 'Alpha', modelId: 'model-10', displayName: 'A alias' }),
        Object.freeze({ providerId: 'a', providerName: 'Alpha', modelId: 'model-2', displayName: 'Z alias' })
    ]);
    const normal = new Select(), taskflow = new Select(), compaction = new Select();
    const composerState = { modelOptions: models, taskFlowModelOptions: models, compactionModelOptions: models,
        currentModelKey: 'z/first', taskFlowEnabled: true, taskFlowModelId: 'a/model-10', compactionEnabled: false, compactionModelId: '' };
    const stateBefore = JSON.stringify(composerState);
    const api = runInNewContext(['sortModelPickerOptions', 'renderModelPickerSelectionDetail', 'renderModelPickerNormalList',
        'renderModelPickerTaskFlowList', 'renderModelPickerCompactionList', 'readModelPickerSelection'].map(block).join('\n')
        + '\n({renderModelPickerNormalList,renderModelPickerTaskFlowList,renderModelPickerCompactionList,readModelPickerSelection});', {
        currentLanguage: 'zh-cn', composerState, HTMLSelectElement: Select, document: { createElement: () => new Option() },
        modelPickerNormalSelectEl: normal, modelPickerTaskFlowSelectEl: taskflow, modelPickerCompactionSelectEl: compaction, t: (key: string) => key
    });
    api.renderModelPickerNormalList(); api.renderModelPickerTaskFlowList(); api.renderModelPickerCompactionList();
    const expected = ['a/model-2', 'a/model-10', 'z/first'];
    assert.deepEqual(normal.options.map(option => option.value), expected);
    for (const select of [taskflow, compaction]) assert.deepEqual(select.options.map(option => option.value), ['', ...expected]);
    assert.equal(normal.value, 'z/first'); assert.equal(taskflow.value, 'a/model-10'); assert.equal(compaction.value, '');
    assert.equal(normal.detail.textContent, 'z/first'); assert.equal(compaction.detail.hidden, true);
    assert.equal(normal.options[0].textContent, 'Alpha: Z alias', 'Aliases are displayed but never used as sort keys');
    assert.equal(JSON.stringify(composerState), stateBefore);
    assert.deepEqual(JSON.parse(JSON.stringify(api.readModelPickerSelection())), {
        normal: { providerId: 'z', modelId: 'first' }, taskFlow: { providerId: 'a', modelId: 'model-10' }, compaction: null
    });
    composerState.compactionEnabled = true; composerState.compactionModelId = 'z/first';
    api.renderModelPickerCompactionList(); assert.equal(compaction.value, 'z/first');
});
