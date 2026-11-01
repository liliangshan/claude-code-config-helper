/** @file Local image sources accept arbitrary readable host paths but never inline image encodings or downloads. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLocalImageSources, resolveImageSourcePath } from '../localImages';
import { IMAGE_BODY_LIMIT, ImageError } from '../types';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const pngDataUrl = `data:image/png;base64,${png.toString('base64')}`;

/** Arbitrary host paths include sibling files and symlink targets outside the working directory. */
test('local images accept absolute, relative, parent, file URI and symlink paths outside the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-local-'));
    const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd);
    const external = path.join(root, '参考 # image.png'); await fs.writeFile(external, png);
    const link = path.join(cwd, 'reference-link.png'); await fs.symlink(external, link);
    try {
        const sources = [external, '../参考 # image.png', pathToFileURL(external).toString(), link];
        assert.deepEqual(await loadLocalImageSources(sources, cwd, 1024), sources.map(() => pngDataUrl));
        assert.equal(await loadLocalImageSources(external, cwd, 1024), pngDataUrl);
        assert.equal(resolveImageSourcePath('~/image.png', cwd), path.join(os.homedir(), 'image.png'));
        // Existence/readability are the source checks; unusual extensions/content are left to the provider.
        const other = path.join(cwd, 'source.custom'); await fs.writeFile(other, 'provider-specific-source');
        assert.equal(await loadLocalImageSources(other, cwd, 1024), `data:application/octet-stream;base64,${Buffer.from('provider-specific-source').toString('base64')}`);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

/** Data URL MIME headers reflect file bytes first and preserve mixed-format array order without double encoding. */
test('local images produce complete Data URLs for PNG, JPEG, WebP and provider-specific sources', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-data-url-'));
    const cases = [
        { name: 'png-renamed.jpg', bytes: png, mime: 'image/png' },
        { name: 'jpeg-renamed.png', bytes: Buffer.from('ffd8ffe000104a464946', 'hex'), mime: 'image/jpeg' },
        { name: 'webp-without-extension', bytes: Buffer.from('524946460400000057454250', 'hex'), mime: 'image/webp' },
        { name: 'reference.GIF', bytes: Buffer.from('GIF89a'), mime: 'image/gif' },
        { name: 'reference.custom', bytes: Buffer.from('provider-specific-source'), mime: 'application/octet-stream' }
    ];
    try {
        for (const item of cases) await fs.writeFile(path.join(cwd, item.name), item.bytes);
        const encoded = await loadLocalImageSources(cases.map(item => item.name), cwd, 1024) as string[];
        assert.equal(encoded.length, cases.length);
        for (const [index, item] of cases.entries()) {
            const expected = `data:${item.mime};base64,${item.bytes.toString('base64')}`;
            assert.equal(encoded[index], expected);
            assert.equal(await loadLocalImageSources(item.name, cwd, 1024), expected);
            assert.equal(new URL(encoded[index]).protocol, 'data:');
            assert.equal(encoded[index].split(';base64,').length, 2);
            assert.deepEqual(Buffer.from(encoded[index].split(',')[1], 'base64'), item.bytes);
        }
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

/** File input must fail before task admission for missing paths, directories and formerly supported inline encodings. */
test('local images reject nonexistent paths, directories, URLs, Base64 and Data URIs', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-invalid-source-'));
    try {
        await assert.rejects(loadLocalImageSources('missing.png', cwd, 1024), /IMAGE_SOURCE_NOT_FOUND/);
        await assert.rejects(loadLocalImageSources(cwd, cwd, 1024), /IMAGE_SOURCE_NOT_FILE/);
        for (const source of ['https://example.com/source.png', 'http://example.com/a.png', 'data:image/png;base64,' + png.toString('base64'), 'ftp://example.com/a']) {
            await assert.rejects(loadLocalImageSources(source, cwd, 1024), /IMAGE_SOURCE_PATH_INVALID/);
        }
        await assert.rejects(loadLocalImageSources(png.toString('base64'), cwd, 1024), /IMAGE_SOURCE_NOT_FOUND/);
        for (const source of ['', null, {}, [], Array(17).fill('file.png')]) await assert.rejects(loadLocalImageSources(source, cwd, 1024), /IMAGE_(?:SOURCE_PATH_INVALID|ARGUMENT_INVALID)/);
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

/** Only path strings cross MCP, so original image bytes are not constrained by its 4 MiB envelope. */
test('local image encoding preserves large files, size limits and frozen bytes without writing another file', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-large-source-'));
    const source = path.join(cwd, 'large.png'); const original = Buffer.concat([png, Buffer.alloc(IMAGE_BODY_LIMIT, 1)]);
    try {
        await fs.writeFile(source, original);
        assert.ok(Buffer.byteLength(JSON.stringify({ image: source })) < 1024);
        const encoded = await loadLocalImageSources(source, cwd, original.length) as string;
        assert.ok(encoded.startsWith('data:image/png;base64,'));
        assert.deepEqual(Buffer.from(encoded.split(',')[1], 'base64'), original);
        await assert.rejects(loadLocalImageSources(source, cwd, original.length - 1), /IMAGE_SOURCE_TOO_LARGE/);
        await fs.writeFile(source, 'changed'); assert.deepEqual(Buffer.from(encoded.split(',')[1], 'base64'), original);
        assert.deepEqual(await fs.readdir(cwd), ['large.png']);
        await assert.rejects(loadLocalImageSources(source, cwd, 1024, () => { throw new ImageError('IMAGE_PERMISSION_DENIED'); }), /IMAGE_PERMISSION_DENIED/);
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
