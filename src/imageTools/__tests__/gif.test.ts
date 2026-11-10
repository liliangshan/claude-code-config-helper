/** @file GIF capability, MCP schema and end-to-end image acceptance using local fixtures only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { imageAnimationOptions, IMAGE_GIF_ENV } from '../animation';
import { parseImageConfig } from '../config';
import { defaultImageConfig } from '../types';
import { imageToolSchemas } from '../tools';
import { decodeImage, imageType, generateImages, loadGeneratedImage } from '../imageClient';
import { ImageTaskStore } from '../taskStore';
import { imageResultPrompt, imageResultMessageFromPrompt } from '../results';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

const singleFrameGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Preserve a real two-frame GIF stream, including both graphics-control/image blocks and its trailer.
const gif = Buffer.concat([singleFrameGif.subarray(0, 19), singleFrameGif.subarray(19, -1), singleFrameGif.subarray(19)]);

/** Old records remain static-only; the capability flag must be an explicit boolean for either source. */
test('GIF config is opt-in and both sources preserve the capability', () => {
    const { supportsGif: _flag, ...legacy } = defaultImageConfig();
    assert.equal(parseImageConfig(legacy, 1).supportsGif, false);
    for (const source of ['custom', 'provider']) assert.equal(parseImageConfig({ ...legacy, source, supportsGif: true }, 2).supportsGif, true);
    for (const supportsGif of [1, 'true', null, []]) assert.throws(() => parseImageConfig({ ...legacy, supportsGif }, 2), /IMAGE_CONFIG_INVALID/);
});

/** Validate the entire documented range before any provider submission while preserving static payloads. */
test('GIF arguments require explicit format, aligned size and bounded integer frames', () => {
    const defaults = { output_format: 'gif', frame_count: 9, frame_duration_ms: 200 };
    assert.deepEqual(imageAnimationOptions({}, '1025x1025', true), {});
    assert.deepEqual(imageAnimationOptions({}, '1025x1025', false), {});
    assert.deepEqual(imageAnimationOptions({ output_format: 'gif' }, '512x512', true), defaults);
    for (const [frame_count, frame_duration_ms] of [[2, 20], [64, 2000]]) assert.deepEqual(
        imageAnimationOptions({ output_format: 'gif', frame_count, frame_duration_ms }, '768x432', true), { output_format: 'gif', frame_count, frame_duration_ms });
    for (const size of ['513x512', '512x513', '0x16', '16x0', '16.0x16', '16X16']) assert.throws(() => imageAnimationOptions({ output_format: 'gif' }, size, true), /IMAGE_ARGUMENT_INVALID/);
    for (const bad of [{ frame_count: 9 }, { frame_duration_ms: 200 }, { output_format: 'png' },
        ...[1, 65, 2.5, '9', null].map(frame_count => ({ output_format: 'gif', frame_count })),
        ...[19, 2001, 20.5, '200', null].map(frame_duration_ms => ({ output_format: 'gif', frame_duration_ms }))]) {
        assert.throws(() => imageAnimationOptions(bad, '512x512', true), /IMAGE_ARGUMENT_INVALID/);
    }
    assert.throws(() => imageAnimationOptions({ output_format: 'gif' }, '512x512', false), /IMAGE_GIF_UNSUPPORTED/);
});

/** Both public generation/edit schemas disclose animation fields only for enabled capabilities. */
test('GIF schemas expose exact public fields and leave default static schemas unchanged', () => {
    for (const name of ['openapi_generate_image', 'openapi_edit_image']) {
        const off = imageToolSchemas(false).find(tool => tool.name === name)!;
        const on = imageToolSchemas(true).find(tool => tool.name === name)!;
        assert.deepEqual((off.inputSchema.properties.output_format as any).enum, ['png']);
        assert.deepEqual((on.inputSchema.properties.output_format as any).enum, ['png', 'gif']);
        assert.equal((on.inputSchema.properties.frame_count as any).default, 9);
        assert.equal((on.inputSchema.properties.frame_duration_ms as any).default, 200);
        assert.ok(on.inputSchema.required.includes('size'));
        assert.match(on.description, /ONLY when the user explicitly asks for GIF or animation/);
        assert.equal(on.inputSchema.additionalProperties, false);
    }
    assert.equal(imageToolSchemas(false)[0].inputSchema.properties.frame_count, undefined);
});

/** Run each real MCP entry without vscode, with capabilities frozen by the CLI startup environment. */
test('main and independent MCP subprocesses publish capability-specific GIF schemas', { timeout: 10000 }, async () => {
    for (const editor of [false, true]) for (const enabled of [false, true]) {
        const entry = path.resolve(__dirname, editor ? '../../editorChat/mcp' : '../imageMcpServer');
        const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(entry)}).${editor ? 'startEditorBridge' : 'startImageMcpServer'}()`], {
            env: { ...process.env, LLS_IMAGE_OUTPUT_FORMATS: enabled ? 'png,gif' : 'png', [IMAGE_GIF_ENV]: enabled ? '1' : '0', LLS_IMAGE_TOOL_RELAY_PORT: '', LLS_IMAGE_TOOL_CAPABILITY: '', LLS_EDITOR_BRIDGE: 'llsccaiImage', LLS_EDITOR_TOOL_URL: 'http://127.0.0.1:1/test/tools' }, stdio: ['pipe', 'pipe', 'pipe']
        });
        let output = '', error = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
        child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
        const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
        assert.equal(code, 0, error);
        const tools = JSON.parse(output).result.tools;
        assert.equal(tools.length, 6);
        assert.equal('frame_count' in tools[0].inputSchema.properties, enabled);
    }
});

/** GIF bytes stay unchanged through both Base64 forms and unauthenticated HTTP downloads. */
test('GIF client supports signatures and sends normalized fields without changing static requests', async () => {
    assert.deepEqual(imageType(gif), { mimeType: 'image/gif', extension: 'gif' });
    assert.equal(imageType(Buffer.from('GIF87a')).mimeType, 'image/gif');
    assert.deepEqual(decodeImage(gif.toString('base64'), 1024), gif);
    assert.deepEqual(decodeImage('data:image/gif;base64,' + gif.toString('base64'), 1024), gif);
    assert.throws(() => imageType(Buffer.from('GIF90a')), /IMAGE_FORMAT_UNSUPPORTED/);
    const requests: any[] = [];
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET') { assert.equal(req.headers.authorization, undefined); res.end(gif); return; }
        let body = ''; for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: gif.toString('base64') }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const snapshot = { config: { ...defaultImageConfig(), modelId: 'gif-model', supportsGif: true }, generationUrl: base + '/generations', editUrl: base + '/edits', providerName: 'fixture', headers: { authorization: 'Bearer synthetic' } };
    try {
        await generateImages(snapshot, { prompt: 'animate', size: '512x512', operation: 'generate', output_format: 'gif' }, new AbortController().signal);
        assert.deepEqual(requests[0], { model: 'gif-model', prompt: 'animate', size: '512x512', output_format: 'gif', frame_count: 9, frame_duration_ms: 200 });
        await generateImages(snapshot, { prompt: 'edit', size: '512x512', operation: 'edit', image: 'data:image/gif;base64,' + gif.toString('base64'), output_format: 'gif', frame_count: 64, frame_duration_ms: 20 }, new AbortController().signal);
        assert.equal(requests[1].frame_count, 64); assert.equal(requests[1].frame_duration_ms, 20);
        assert.equal(requests[1].images.length, 1); assert.equal(requests[1].n, 1); assert.equal('image' in requests[1], false);
        await generateImages(snapshot, { prompt: 'static', size: '513x513', operation: 'generate' }, new AbortController().signal);
        assert.deepEqual(requests[2], { model: 'gif-model', prompt: 'static', size: '513x513', output_format: 'png' });
        await assert.rejects(generateImages({ ...snapshot, config: { ...snapshot.config, supportsGif: false } }, { prompt: 'no', size: '512x512', operation: 'generate', output_format: 'gif' }, new AbortController().signal), /IMAGE_GIF_UNSUPPORTED/);
        assert.equal(requests.length, 3);
        assert.deepEqual(await loadGeneratedImage({ url: base + '/result.gif' }, 1024, new AbortController().signal), gif);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

/** Admit, execute, save, open and restore a GIF using the real host and a local mock image provider. */
test('GIF task admission, output persistence, completion and image opening retain animation metadata', async t => {
    installVscodeStub({ values: {} }); const vscode = require('vscode');
    vscode.commands = { executeCommand: async () => {} };
    const { ImageToolHost } = require('../imageToolHost') as typeof import('../imageToolHost');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'image-gif-')));
    const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd);
    vscode.workspace.isTrusted = true;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, get: () => [{ uri: { fsPath: cwd, scheme: 'file' } }] });
    const secrets = new Map<string, string>(); const opened: string[] = [], requests: any[] = [];
    t.mock.method(vscode.commands, 'executeCommand', async (_name: string, uri: any) => { opened.push(uri.fsPath); });
    const context = { globalStorageUri: { fsPath: root }, secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } } } as any;
    const manager = { listProviders: () => [], onDidChange: () => ({ dispose() {} }), getResolvedUiLanguage: () => 'en' } as any;
    const host = new ImageToolHost(context, manager), scope = { cwd, id: 'a'.repeat(64), title: 'GIF' };
    const opening: Promise<void>[] = [], autoOpen = (host as any).autoOpenImages.bind(host);
    t.mock.method(host as any, 'autoOpenImages', (root: string, task: any) => { const result = autoOpen(root, task); opening.push(result); return result; });
    const server = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body)); res.end(JSON.stringify({ data: [{ b64_json: gif.toString('base64') }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    try {
        await host.initialize();
        await host.config.save({ expectedRevision: 0, keyAction: 'keep', config: { ...defaultImageConfig(), enabled: true, modelId: 'gif-model', baseUrl: 'https://example.com', authMode: 'none' } });
        t.mock.method(host.config, 'resolve', async (config: ReturnType<typeof defaultImageConfig>) => ({ config, generationUrl: base, editUrl: base, headers: {}, providerName: 'local fixture' }));
        const args = { prompt: 'loop', size: '512x512', output_format: 'gif' };
        assert.match(JSON.stringify(await host.execute(scope, 'openapi_generate_image', args, randomUUID(), () => true)), /IMAGE_GIF_UNSUPPORTED/);
        const config = await host.config.read(); await host.config.save({ expectedRevision: config.revision, keyAction: 'keep', config: { ...config, supportsGif: true } });
        for (const invalid of [{ ...args, size: '513x512' }, { ...args, frame_count: 65 }, { ...args, frame_duration_ms: 19 }]) {
            assert.equal((await host.execute(scope, 'openapi_generate_image', invalid, randomUUID(), () => true)).isError, true);
        }
        assert.equal(requests.length, 0);
        const accepted = await host.execute(scope, 'openapi_generate_image', args, randomUUID(), () => true);
        assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
        await (await (host as any).queue(cwd)).idle(); await Promise.all(opening);
        const taskId = JSON.parse(String(accepted.content[0].text)).taskId;
        const store = new ImageTaskStore(cwd), task = await store.get(scope.id, taskId);
        assert.equal(task.status, 'succeeded'); assert.equal(task.output_format, 'gif'); assert.equal(task.frame_count, 9); assert.equal(task.frame_duration_ms, 200);
        assert.match(task.images[0].relativePath, /\.gif$/); assert.equal(task.images[0].mimeType, 'image/gif');
        const file = await store.imagePath(scope.id, taskId, task.images[0].id); assert.deepEqual(await fs.readFile(file), gif);
        assert.deepEqual(opened, [file], 'New GIF output opens automatically without waiting for a chat view');
        const prompt = imageResultPrompt(task, cwd); const restored = imageResultMessageFromPrompt(prompt, 'en', Date.now());
        assert.ok(restored); assert.equal(JSON.parse(restored.text!.slice('[image-generation-result]\n'.length)).frame_count, 9);
        await host.receive({ type: 'imageGeneration/imageOpen', requestId: 'open-gif', taskId, imageId: task.images[0].id }, { scope: async () => scope, post() {} });
        assert.ok(opened.includes(file)); assert.equal(requests.length, 1);
        const info = await host.execute(scope, 'openapi_image_generation_info', {}, randomUUID(), () => true);
        assert.equal(JSON.parse(String(info.content[0].text)).supportsGif, true);
    } finally { await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
});
