/** @file Four-format capability, request, storage and safe SVG acceptance with local fixtures only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { defaultImageConfig } from '../types';
import { parseImageConfig } from '../config';
import { defaultImageFormat, enabledImageFormats, imageFormatsFromEnvironment, imageOutputOptions, restoredImageOutputOptions } from '../formats';
import { imageToolSchemas } from '../tools';
import { decodeImage, generateImages, imageType, loadGeneratedImage } from '../imageClient';
import { ImageTaskStore } from '../taskStore';
import { ImageTaskManager } from '../taskManager';
import { imageResultMessageFromPrompt, imageResultPrompt } from '../results';
import { refreshImageRequestSchemas } from '../requestSchemas';
import { convertAnthropicToOpenAIResponses } from '../../relay/converters/anthropicToOpenAIResponses';
import { convertAnthropicToOpenAIChat } from '../../relay/converters/anthropicToOpenAIChat';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const svg = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="100" height="80" fill="url(#g)"/><text x="2" y="20">文字 &amp; text</text></svg>');
const all = { supportsPng: true, supportsJpg: true, supportsGif: true, supportsSvg: true };

/** Every nonempty switch combination advertises only enabled formats and never defaults to GIF. */
test('four format switches migrate old settings and generate exact enums and static-first instructions', () => {
    const { supportsPng: _png, supportsJpg: _jpg, supportsSvg: _svg, ...legacy } = defaultImageConfig();
    const restored = parseImageConfig({ ...legacy, supportsGif: true }, 4);
    assert.equal(restored.supportsPng, true); assert.equal(restored.supportsJpg, false); assert.equal(restored.supportsSvg, false); assert.equal(restored.supportsGif, true);
    for (let mask = 1; mask < 16; mask++) {
        const flags = { supportsPng: !!(mask & 1), supportsJpg: !!(mask & 2), supportsGif: !!(mask & 4), supportsSvg: !!(mask & 8) };
        const config = parseImageConfig({ ...defaultImageConfig(), ...flags }, 1);
        assert.deepEqual(enabledImageFormats(config), (['png', 'jpg', 'gif', 'svg'] as const).filter((_, index) => mask & (1 << index)));
        for (const schema of imageToolSchemas(config).slice(0, 2)) {
            const format = schema.inputSchema.properties.output_format as any;
            assert.deepEqual(format.enum, enabledImageFormats(config));
            assert.equal(format.default, defaultImageFormat(config));
            assert.equal('frame_count' in schema.inputSchema.properties, flags.supportsGif);
            assert.match(schema.description, /does NOT select that format/);
            if (flags.supportsGif) assert.match(schema.description, /Never use a two-frame GIF/);
        }
        const environment = imageFormatsFromEnvironment({ LLS_IMAGE_OUTPUT_FORMATS: enabledImageFormats(config).join(',') });
        assert.deepEqual(environment, flags);
        const tool = imageToolSchemas(config)[0];
        const body = { model: 'fixture', messages: [{ role: 'user', content: 'local fixture' }], tools: [{ name: 'mcp__llsccaiImage__openapi_generate_image', description: tool.description, input_schema: tool.inputSchema }] };
        const chat = convertAnthropicToOpenAIChat(body as any).body;
        const responses = convertAnthropicToOpenAIResponses(body as any).body;
        for (const converted of [chat.tools?.[0]?.function, responses.tools?.[0]]) {
            assert.ok(converted && 'parameters' in converted);
            assert.deepEqual((converted.parameters as any).properties.output_format.enum, enabledImageFormats(config));
        }
    }
    assert.throws(() => parseImageConfig({ ...defaultImageConfig(), supportsPng: false }, 1), /IMAGE_CONFIG_INVALID/);
    for (const key of ['supportsPng', 'supportsJpg', 'supportsGif', 'supportsSvg']) assert.throws(() => parseImageConfig({ ...defaultImageConfig(), [key]: 'true' }, 1), /IMAGE_CONFIG_INVALID/);
    assert.deepEqual(enabledImageFormats(imageFormatsFromEnvironment({ LLS_IMAGE_OUTPUT_FORMATS: 'png,evil' })), ['png']);
    assert.deepEqual(enabledImageFormats(imageFormatsFromEnvironment({ LLS_IMAGE_SUPPORTS_GIF: '1' })), ['png', 'gif']);
});

/** Static requests remain static with all switches on, and disabled formats fail before admission or billing. */
test('output validation defaults to PNG, rejects disabled formats and limits frame arguments to explicit GIF', () => {
    assert.deepEqual(imageOutputOptions({}, '513x513', all), { output_format: 'png' });
    for (const output_format of ['png', 'jpg', 'svg'] as const) {
        assert.deepEqual(imageOutputOptions({ output_format }, '513x513', all), { output_format });
        assert.throws(() => imageOutputOptions({ output_format, frame_count: 2 }, '512x512', all), /IMAGE_ARGUMENT_INVALID/);
    }
    assert.deepEqual(imageOutputOptions({ output_format: 'gif' }, '512x512', all), { output_format: 'gif', frame_count: 9, frame_duration_ms: 200 });
    for (const output_format of ['jpg', 'svg']) assert.throws(() => imageOutputOptions({ output_format }, '512x512', defaultImageConfig()), /IMAGE_FORMAT_DISABLED/);
    for (const output_format of [null, 1, '', 'webp', 'jpeg']) assert.throws(() => imageOutputOptions({ output_format }, '512x512', all), /IMAGE_ARGUMENT_INVALID/);
    assert.throws(() => imageOutputOptions({}, '512x512', { ...all, supportsPng: false, supportsJpg: false, supportsSvg: false }), /IMAGE_ARGUMENT_INVALID/);
    assert.deepEqual(restoredImageOutputOptions({}, '1x1'), {});
    assert.deepEqual(restoredImageOutputOptions({ output_format: 'svg' }, '1x1'), { output_format: 'svg' });
});

/** Complete SVG data is validated as inert local content, never accepted by extension or Content-Type alone. */
test('SVG validates UTF-8, nesting and inert local references while rejecting active or external content', () => {
    assert.deepEqual(imageType(svg), { mimeType: 'image/svg+xml', extension: 'svg' });
    assert.deepEqual(decodeImage('data:image/svg+xml;base64,' + svg.toString('base64'), 4096), svg);
    const unsafe = ['<svg><script>alert(1)</script></svg>', '<svg onload="bad()"/>', '<svg width=1/>', '<svg width="1" width="2"/>', '<svg><foreignObject/></svg>', '<!DOCTYPE svg><svg/>', '<svg><image href="https://example.com/x"/></svg>', '<svg><use href="//example.com/x"/></svg>', '<svg style="fill:url(https://example.com/x)"/>', '<svg><rect></svg>', '<svg></bad></svg>', '<svg><rect>', '<svg/><svg/>', '<svg>&unknown;</svg>', '<svg><animate/></svg>', '<svg><rect fill="url(&#104;ttps://example.com/x)"/></svg>', '<svg style="fill:u\\rl(#x)"/>'];
    for (const text of unsafe) assert.throws(() => imageType(Buffer.from(text)), /IMAGE_(SVG_UNSAFE|FORMAT_UNSUPPORTED)/, text);
    assert.throws(() => imageType(Buffer.from('<html><svg/></html>')), /IMAGE_FORMAT_UNSUPPORTED/);
    assert.throws(() => imageType(Buffer.concat([Buffer.from('<svg>'), Buffer.from([255]), Buffer.from('</svg>')])), /IMAGE_FORMAT_UNSUPPORTED/);
});

/** The actual API client sends static output explicitly and never attaches frame defaults to JPG/PNG/SVG. */
test('local image API receives explicit default PNG, JPEG mapping and opt-in GIF/SVG payloads', async () => {
    const requests: any[] = [];
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET') { assert.equal(req.headers.authorization, undefined); res.end(svg); return; }
        let body = ''; for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body)); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const snapshot = { config: { ...defaultImageConfig(), ...all, modelId: 'fixture' }, generationUrl: base, editUrl: base, headers: {}, providerName: 'fixture' };
    try {
        for (const output_format of [undefined, 'png', 'jpg', 'svg', 'gif'] as const) await generateImages(snapshot, { prompt: 'local fixture', size: '512x512', operation: 'generate', ...(output_format ? { output_format } : {}) }, new AbortController().signal);
        assert.deepEqual(requests.map(request => request.output_format), ['png', 'png', 'jpeg', 'svg', 'gif']);
        for (const request of requests.slice(0, 4)) { assert.equal('frame_count' in request, false); assert.equal('frame_duration_ms' in request, false); }
        assert.equal(requests[4].frame_count, 9);
        await assert.rejects(generateImages({ ...snapshot, config: { ...snapshot.config, supportsSvg: false } }, { prompt: 'no submit', size: '512x512', operation: 'generate', output_format: 'svg' }, new AbortController().signal), /IMAGE_FORMAT_DISABLED/);
        assert.equal(requests.length, 5);
        assert.deepEqual(await loadGeneratedImage({ url: base + '/output.svg' }, 4096, new AbortController().signal), svg);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

/** Format identity survives task checkpoints/results, while wrong-format provider output is not silently relabeled. */
test('SVG output persists and restores without executable previews and mismatched formats fail without replay', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-formats-'));
    const store = new ImageTaskStore(cwd), scope = 'a'.repeat(64);
    const snapshot = { config: { ...defaultImageConfig(), ...all, modelId: 'fixture' }, generationUrl: 'https://unused.example', editUrl: 'https://unused.example', headers: {}, providerName: 'fixture' };
    let calls = 0;
    const queue = new ImageTaskManager(store, { generate: async () => { calls++; return [{}]; }, load: async () => svg });
    try {
        const first = await queue.submit(scope, snapshot, { prompt: 'vector fixture', size: '512x512', operation: 'generate', output_format: 'svg' });
        await queue.idle();
        const completed = await store.get(scope, first.taskId);
        assert.equal(completed.status, 'succeeded'); assert.equal(completed.output_format, 'svg');
        assert.equal(completed.images[0].mimeType, 'image/svg+xml'); assert.match(completed.images[0].relativePath, /\.svg$/);
        assert.deepEqual(await fs.readFile(await store.imagePath(scope, completed.taskId, completed.images[0].id)), svg);
        const result = imageResultMessageFromPrompt(imageResultPrompt(completed, cwd), 'zh-cn', Date.now());
        assert.ok(result); assert.ok(result.text?.includes('"output_format":"svg"')); assert.match(result.text!, /provide the existing file link only/);
        const second = await queue.submit(scope, snapshot, { prompt: 'raster fixture', size: '512x512', operation: 'generate', output_format: 'png' });
        await queue.idle();
        const mismatch = await store.get(scope, second.taskId);
        assert.equal(mismatch.status, 'partially_failed'); assert.equal(mismatch.error, 'IMAGE_FORMAT_MISMATCH'); assert.equal(calls, 2);
        assert.equal(mismatch.images[0].mimeType, 'image/svg+xml'); assert.match(mismatch.images[0].relativePath, /\.svg$/);
        const body = { tools: [{ name: 'mcp__llsccaiImage__openapi_generate_image', input_schema: {}, description: 'old' }] };
        const updated = refreshImageRequestSchemas(body, all) as any;
        assert.deepEqual(updated.tools[0].input_schema.properties.output_format.enum, ['png', 'jpg', 'gif', 'svg']);
        const disabled = refreshImageRequestSchemas(updated, defaultImageConfig()) as any;
        assert.deepEqual(disabled.tools[0].input_schema.properties.output_format.enum, ['png']); assert.equal('frame_count' in disabled.tools[0].input_schema.properties, false);
    } finally { await queue.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});

/** Both real MCP child entry points publish the exact four-format capability set without vscode or secrets. */
test('main and independent MCP bridges publish explicit PNG/JPG/GIF/SVG capability enums', { timeout: 10000 }, async () => {
    for (const editor of [false, true]) for (const formats of ['png', 'jpg,svg', 'png,jpg,gif,svg']) {
        const module = path.resolve(__dirname, editor ? '../../editorChat/mcp' : '../imageMcpServer');
        const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(module)}).${editor ? 'startEditorBridge' : 'startImageMcpServer'}()`], {
            env: { ...process.env, LLS_IMAGE_OUTPUT_FORMATS: formats, LLS_IMAGE_TOOL_RELAY_PORT: '', LLS_IMAGE_TOOL_CAPABILITY: '', LLS_EDITOR_BRIDGE: 'llsccaiImage', LLS_EDITOR_TOOL_URL: 'http://127.0.0.1:1/test/tools' }, stdio: ['pipe', 'pipe', 'pipe']
        });
        let output = '', errors = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
        child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 0, errors);
        for (const tool of JSON.parse(output).result.tools.slice(0, 2)) {
            assert.deepEqual(tool.inputSchema.properties.output_format.enum, formats.split(','));
            assert.equal('frame_count' in tool.inputSchema.properties, formats.includes('gif'));
        }
    }
});
