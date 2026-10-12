/** @file 直接执行聊天前端粘贴处理，验证图文分流、图片去重及输入焦点边界。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

/** 无 DOM 依赖的 textarea 替身，检查处理器不会覆盖文本或抢焦点。 */
class TestTextarea {
    public disabled = false;
    public readOnly = false;
    public value = '原有内容';
    public selectionStart = 1;
    public selectionEnd = 3;
    /** 粘贴上传不应异步抢回用户已切走的焦点。 */
    public focus(): void { assert.fail('不应重新聚焦输入框'); }
}

/** 创建固定元信息的假图片，可测试相同元信息但不同文件不能被误删。 */
function image(): File {
    return { name: 'image.png', type: 'image/png', size: 123 } as File;
}

/** 构造剪贴板图片条目。 */
function imageItem(file: File | null): DataTransferItem {
    return { kind: 'file', type: 'image/png', getAsFile: () => file } as DataTransferItem;
}

/** 提取实际前端函数，注入可观察的附件上传与日志接口。 */
function harness(options: { text?: string; html?: string; htmlImages?: string[]; items?: DataTransferItem[]; files?: File[]; upload?: () => Promise<void> } = {}) {
    const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');
    const start = source.indexOf('    async function handlePaste(');
    const end = source.indexOf('\n    /**', start);
    assert.ok(start >= 0 && end > start);
    const composer = new TestTextarea();
    const uploads: Array<{ files: File[]; source: string }> = [];
    const logs: Array<{ message: string }> = [];
    const imported: string[] = [];
    const handle = runInNewContext(source.slice(start, end) + '\nhandlePaste;', {
        composerEl: composer,
        HTMLTextAreaElement: TestTextarea,
        post: (message: { message: string }) => logs.push(message),
        collectPastedHtmlImages: () => ({ sources: options.htmlImages ?? [], skipped: false, limited: false }),
        importPastedHtmlImages: (sources: string[]) => imported.push(...sources),
        showToast: () => {}, t: (key: string) => key,
        uploadBlobFiles: async (files: File[], origin: string) => {
            if (files.length === 0) return;
            uploads.push({ files: Array.from(files), source: origin });
            await options.upload?.();
        }
    }) as (event: unknown) => Promise<void>;
    const event = {
        target: composer as unknown,
        defaultPrevented: false,
        propagationStopped: false,
        clipboardData: {
            items: options.items ?? [], files: options.files ?? [],
            /** 按 MIME 返回网页 HTML 和纯文本两种剪贴板格式。 */
            getData: (type: string) => type === 'text/html' ? options.html ?? '' : options.text ?? ''
        } as unknown,
        /** 模拟浏览器原生事件取消标记。 */
        preventDefault(): void { this.defaultPrevented = true; },
        /** 模拟捕获阶段拦截，避免同图重复处理。 */
        stopPropagation(): void { this.propagationStopped = true; }
    };
    return { composer, uploads, logs, imported, event, paste: () => handle(event) };
}

test('网页 HTML 图文无 File 时交宿主下载，文本仍原生粘贴', async () => {
    const h = harness({ text: '网页文字', html: '<p>网页文字<img src="https://img.example/a.png"></p>', htmlImages: ['https://img.example/a.png'] });
    await h.paste();
    assert.equal(h.event.defaultPrevented, false);
    assert.deepEqual(h.imported, ['https://img.example/a.png']);
    assert.equal(h.uploads.length, 0);
});

test('剪贴板原生图片优先，HTML 中同图不重复下载', async () => {
    const h = harness({ text: '文字', html: '<img src="https://img.example/a.png">', htmlImages: ['https://img.example/a.png'], files: [image()] });
    await h.paste();
    assert.deepEqual(h.imported, []);
    assert.equal(h.uploads.length, 1);
});

test('纯文本不拦截、不上传，不修改现有文本和选区', async () => {
    const h = harness({ text: '文本\n第二行' });
    await h.paste();
    assert.equal(h.event.defaultPrevented, false);
    assert.equal(h.event.propagationStopped, false);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.composer.value, '原有内容');
    assert.equal(h.composer.selectionStart, 1);
    assert.equal(h.composer.selectionEnd, 3);
});

test('混合图文保留原生文本粘贴，多张图片独立上传且不记录正文', async () => {
    const first = image();
    const second = image();
    const h = harness({ text: '私密正文\n🙂', items: [imageItem(first), imageItem(second)], files: [image(), image()] });
    await h.paste();
    assert.equal(h.event.defaultPrevented, false);
    assert.equal(h.event.propagationStopped, true);
    assert.deepEqual(h.uploads, [{ files: [first, second], source: 'paste' }]);
    assert.equal(h.composer.value, '原有内容');
    assert.equal(JSON.stringify(h.logs).includes('私密正文'), false);
});

test('只有图片时阻止默认插入，不重复上传 items 和 files 中的同一图片', async () => {
    const file = image();
    const h = harness({ items: [imageItem(file), imageItem(file)], files: [image()] });
    await h.paste();
    assert.equal(h.event.defaultPrevented, true);
    assert.deepEqual(h.uploads, [{ files: [file], source: 'paste' }]);
});

test('items 无可用图片时回退 files，并忽略非图片文件', async () => {
    const file = image();
    const h = harness({ items: [imageItem(null)], files: [{ name: 'note.txt', type: 'text/plain' } as File, file] });
    await h.paste();
    assert.deepEqual(h.uploads, [{ files: [file], source: 'paste' }]);
});

test('空白文本仍应允许原生粘贴，不把换行和缩进丢掉', async () => {
    const h = harness({ text: ' \n\t', files: [image()] });
    await h.paste();
    assert.equal(h.event.defaultPrevented, false);
    assert.equal(h.uploads.length, 1);
});

test('其他输入框、禁用态、只读态和已处理事件不截获图片', async () => {
    for (const mode of ['other', 'disabled', 'readonly', 'handled', 'missing']) {
        const h = harness({ files: [image()] });
        if (mode === 'other') h.event.target = new TestTextarea();
        if (mode === 'disabled') h.composer.disabled = true;
        if (mode === 'readonly') h.composer.readOnly = true;
        if (mode === 'handled') h.event.defaultPrevented = true;
        if (mode === 'missing') h.event.clipboardData = null;
        await h.paste();
        assert.equal(h.uploads.length, 0);
        assert.equal(h.event.propagationStopped, false);
    }
});

test('图片异步读取期间就决定原生文本粘贴，不等上传完成才处理事件', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ text: '文字', files: [image()], upload: () => wait });
    const pending = h.paste();
    assert.equal(h.event.defaultPrevented, false);
    assert.equal(h.uploads.length, 1);
    release();
    await pending;
});
