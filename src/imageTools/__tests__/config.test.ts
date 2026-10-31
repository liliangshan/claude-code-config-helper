/** @file Global image settings tests with in-memory secrets and no billable network requests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageConfigStore, type ImageSecrets } from '../configStore';
import { imageEndpoints, parseImageConfig } from '../config';
import { defaultImageConfig, type ImageConfigInput } from '../types';
import type { ConfigManager } from '../../configManager';

/** Minimal host-free provider manager avoids VS Code access during pure configuration tests. */
function manager(): ConfigManager {
    return { listProviders: () => [], getProviderWithSecret: async () => undefined, isModelEnabled: (model: unknown) => !!model } as unknown as ConfigManager;
}
/** Separate stores share one key vault, just as windows in one extension environment do. */
function vault(): ImageSecrets & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return { values, get: async key => values.get(key), store: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } };
}
/** Form defaults never contain a real endpoint or secret. */
function input(revision: number, changes = {}): ImageConfigInput {
    return { expectedRevision: revision, config: { ...defaultImageConfig(), enabled: true, baseUrl: 'https://images.example.com/v1', modelId: 'test-image', ...changes }, keyAction: 'replace', apiKey: 'test-image-key-not-real' };
}

test('image endpoints preserve prefixes, reject embedded credentials and restrict provider overrides', () => {
    for (const [base, expected] of [['https://example.com', '/v1'], ['https://example.com/v1/', '/v1'], ['https://example.com/proxy/v1', '/proxy/v1'], ['https://example.com/custom', '/custom']]) {
        assert.equal(imageEndpoints({ ...defaultImageConfig(), baseUrl: base }).generationUrl, `https://example.com${expected}/images/generations`);
    }
    for (const baseUrl of ['https://key@example.com/v1', 'https://example.com/v1?key=x', 'https://example.com/v1#x', 'http://example.com', 'https://example.com/v1/chat/completions', 'https://example.com/v1/images/generations']) {
        assert.throws(() => imageEndpoints({ ...defaultImageConfig(), baseUrl }), /IMAGE_CONFIG_INVALID/);
    }
    assert.throws(() => imageEndpoints({ ...defaultImageConfig(), baseUrl: 'https://example.com', source: 'provider', generationEndpointOverride: 'https://other.example.com/images' }), /IMAGE_CONFIG_INVALID/);
    assert.equal(imageEndpoints({ ...defaultImageConfig(), baseUrl: 'http://127.0.0.1:1234', allowLocalHttp: true }).generationUrl, 'http://127.0.0.1:1234/v1/images/generations');
});

test('two windows share global settings, detect stale drafts, preserve snapshots and never serialize keys', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-config-')); const secrets = vault();
    const left = new ImageConfigStore(root, secrets, manager()); const right = new ImageConfigStore(root, secrets, manager());
    try {
        assert.equal((await left.read()).enabled, false);
        const first = await left.save(input(0)); const snapshot = await left.resolve(first);
        assert.equal((await right.read()).modelId, 'test-image');
        assert.ok(first.secretRef); assert.equal([...secrets.values.keys()].filter(key => key.startsWith('llsccai.imageGeneration.secret.')).length, 1);
        assert.ok(!(await fs.readFile(path.join(root, 'image-generation/config.json'), 'utf8')).includes('test-image-key-not-real'));
        assert.ok(!JSON.stringify(await right.publicState()).includes('secretRef'));
        assert.ok(!JSON.stringify(await right.publicState()).includes('test-image-key-not-real'));
        await assert.rejects(right.save(input(0)), /IMAGE_CONFIG_CONFLICT/);
        await right.save({ ...input(1, { modelId: 'new-image' }), apiKey: 'rotated-test-key' });
        assert.equal((await left.read()).modelId, 'new-image'); assert.equal(snapshot.config.modelId, 'test-image');
        assert.equal(snapshot.headers.authorization, 'Bearer test-image-key-not-real');
        await left.save({ ...input(2, { enabled: false }), keyAction: 'delete', apiKey: undefined });
        assert.equal((await right.publicState()).hasApiKey, false); assert.equal((await right.read()).secretRef, undefined);
    } finally { left.dispose(); right.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('image config rejects secret injection, rolls back vault failures and reports missing/corrupt storage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-config-errors-')); const secrets = vault();
    const store = new ImageConfigStore(root, secrets, manager());
    try {
        const first = await store.save(input(0));
        secrets.store = async () => { throw new Error('vault unavailable'); };
        await assert.rejects(store.save(input(1)), /vault unavailable/); assert.equal((await store.read()).revision, first.revision);
        await assert.rejects(store.save({ ...input(1, { secretRef: 'attacker-controlled' }), keyAction: 'keep', apiKey: undefined }), /IMAGE_CONFIG_INVALID/);
        const keep = { ...input(1), keyAction: 'keep' as const, apiKey: undefined };
        const second = await store.save(keep); assert.equal(second.secretRef, first.secretRef);
        const file = path.join(root, 'image-generation/config.json');
        await fs.unlink(file); await assert.rejects(store.read(), /IMAGE_CONFIG_INVALID/);
        await fs.writeFile(file, '{bad'); await assert.rejects(store.read(), /IMAGE_CONFIG_INVALID/);
    } finally { store.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('old image settings retain their connection but no longer configure dimensions or advanced options', () => {
    const config = parseImageConfig({ ...defaultImageConfig(), enabled: true, baseUrl: 'https://example.com/v1', modelId: 'image-model',
        defaultSize: '512x512', editEnabled: false, editModelId: 'old-edit-model', timeoutMs: 12, maxConcurrent: 8,
        generationEndpointOverride: 'https://obsolete.example.com/generate' }, 7);
    assert.equal(config.modelId, 'image-model'); assert.equal(config.baseUrl, 'https://example.com/v1'); assert.equal(config.revision, 7);
    assert.equal('defaultSize' in config, false); assert.equal(config.editEnabled, true); assert.equal(config.editModelId, '');
    assert.equal(config.timeoutMs, 180000); assert.equal(config.maxConcurrent, 1); assert.equal(config.generationEndpointOverride, '');
});

test('local draft checks do not write new secrets or contact an API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-config-check-')); const secrets = vault();
    const store = new ImageConfigStore(root, secrets, manager());
    try {
        const check = await store.check({ ...input(0), apiKey: undefined });
        assert.equal(check.config.modelId, 'test-image'); assert.equal(secrets.values.size, 0);
        assert.equal((await store.read()).revision, 0);
        await assert.rejects(fs.stat(path.join(root, 'image-generation/config.json')), { code: 'ENOENT' });
    } finally { store.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
