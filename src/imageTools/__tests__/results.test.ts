/** @file Result-message regression tests: localization, persistent identity, safe links and streaming isolation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { imageResultMessage, imageResultPrompt, imageResultMessageFromPrompt, isImageTaskTerminal } from '../results';
import { ImageResultReceipts } from '../delivery';
import type { ImageTask } from '../types';

/** Build a durable task without provider URLs, credentials or source bytes. */
function task(status: ImageTask['status']): ImageTask {
    const id = randomUUID();
    return { version: 1, taskId: `20261002T081530123Z_${randomUUID()}`, scopeId: 'a'.repeat(64), operation: 'generate',
        prompt: 'draw', model: 'test-image', size: '1536x1024', configRevision: 1, status, createdAt: 10, finishedAt: 20,
        images: [{ id, relativePath: `images/${id}.png`, mimeType: 'image/png', bytes: 8 }] };
}

test('terminal image messages are localized user continuations with stable IDs and checked local references', () => {
    const result = task('succeeded');
    const titles = new Set<string>();
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        const message = imageResultMessage(result, language); titles.add(message.segments[0].text!);
        assert.equal(message.id, `image-result-${result.taskId}`); assert.equal(message.role, 'user'); assert.equal(message.pending, false);
        assert.equal(message.createdAt, 20); assert.ok(message.segments[0].text?.includes('1536x1024'));
        assert.deepEqual(message.segments[1].generatedImage, { taskId: result.taskId, imageId: result.images[0].id, scopeId: result.scopeId });
        assert.equal(message.segments[1].filePath, `.LLSOAI/openapi-image-generation/${result.images[0].relativePath}`);
        assert.ok(!JSON.stringify(message).includes('imageUrl')); assert.ok(!JSON.stringify(message).includes('apiKey'));
    }
    assert.equal(titles.size, 7);
    for (const status of ['queued', 'running', 'succeeded', 'partially_failed', 'failed', 'interrupted'] as const) {
        const value = task(status); assert.equal(isImageTaskTerminal(value), !['queued', 'running'].includes(status));
        if (isImageTaskTerminal(value)) assert.ok(imageResultMessage(value, 'en').segments[0].text);
    }
    assert.match(imageResultMessage(task('failed'), 'en').segments[0].text!, /Do not automatically regenerate/);
    assert.match(imageResultMessage(task('interrupted'), 'zh-cn').segments[0].text!, /可能已经计费/);
    assert.equal(imageResultMessage(result, 'en').text, imageResultPrompt(result));
    assert.match(imageResultPrompt(result), /Do not poll this task or generate it again/);
    assert.ok(imageResultPrompt(result).includes(result.images[0].relativePath));
    const restored = imageResultMessageFromPrompt(imageResultPrompt(result), 'zh-cn', 99);
    assert.equal(restored?.id, imageResultMessage(result, 'en').id); assert.equal(restored?.role, 'user');
    assert.equal(restored?.segments[1].generatedImage?.imageId, result.images[0].id);
    assert.match(restored?.segments[0].text ?? '', /图片生成完成/);
    assert.equal(imageResultMessageFromPrompt('[image-generation-result]\n{"taskId":"../bad"}', 'en', 1), undefined);
});

test('completion sends workspace, relative path, absolute path and file URI without preview conversion', () => {
    const result = task('succeeded'), workspacePath = path.resolve('workspace with spaces', '项目#test');
    const payload = JSON.parse(imageResultPrompt(result, workspacePath).slice('[image-generation-result]\n'.length));
    const relativePath = `.LLSOAI/openapi-image-generation/${result.images[0].relativePath}`;
    const absolutePath = path.resolve(workspacePath, relativePath);
    assert.equal(payload.workspacePath, workspacePath); assert.equal(payload.images[0].path, relativePath);
    assert.equal(payload.images[0].absolutePath, absolutePath);
    assert.equal(payload.images[0].fileUri, pathToFileURL(absolutePath).toString());
    assert.equal(fileURLToPath(payload.images[0].fileUri), absolutePath);
    assert.ok(payload.images[0].fileUri.includes('%20')); assert.ok(payload.images[0].fileUri.includes('%23'));
    for (const key of ['webviewUrl', 'imageUrl']) assert.equal(key in payload.images[0], false);
    assert.ok(!payload.instruction.includes('Webview'));
    const restored = imageResultMessageFromPrompt(imageResultPrompt(result, workspacePath), 'en', 99);
    assert.equal(restored?.role, 'user'); assert.equal(restored?.id, imageResultMessage(result, 'en').id);
    assert.deepEqual(JSON.parse(restored!.text!.slice('[image-generation-result]\n'.length)).images, payload.images);
});

test('completion instructs the model to use the exact file URI for image and original-file output', () => {
    const value = task('succeeded');
    const payload = JSON.parse(imageResultPrompt(value, path.resolve('workspace with spaces', '项目#test')).slice('[image-generation-result]\n'.length));
    assert.match(payload.instruction, /use that image's fileUri verbatim/);
    assert.ok(payload.instruction.includes('![image description](FILE_URI)'));
    assert.ok(payload.instruction.includes('[Open original image](FILE_URI)'));
    assert.match(payload.instruction, /Do not substitute path or absolutePath/);
    assert.match(payload.instruction, /strip the file:\/\/\/ prefix/);
    assert.match(payload.instruction, /decode or re-encode the URI/);
    assert.match(payload.instruction, /does not guarantee inline preview support/);
    assert.match(payload.instruction, /If no fileUri is supplied/);
    assert.equal(payload.images[0].fileUri, pathToFileURL(payload.images[0].absolutePath).toString());
    assert.match(payload.instruction, /Do not poll this task or generate it again/);
});

test('result receipts survive host recreation and never claim a result twice or across scopes', async () => {
    const records = new Map<string, boolean>();
    const state = { get: (_key: string, fallback: boolean) => records.get(_key) ?? fallback, update: async (key: string, value: boolean) => { records.set(key, value); } } as any;
    const receipts = new ImageResultReceipts(state), value = task('succeeded');
    const scope = { cwd: '/workspace', id: value.scopeId, title: 'Chat' };
    assert.equal(receipts.has(scope, value), false);
    assert.deepEqual(await Promise.all([receipts.claim(scope, value), receipts.claim(scope, value)]), [true, false]);
    assert.equal(new ImageResultReceipts(state).has(scope, value), true);
    assert.equal(receipts.has({ ...scope, id: 'b'.repeat(64) }, value), false);
    const unavailable = new ImageResultReceipts({ get: () => false, update: async () => { throw new Error('storage unavailable'); } } as any);
    await assert.rejects(unavailable.claim(scope, value), /storage unavailable/); assert.equal(unavailable.has(scope, value), false);
});
