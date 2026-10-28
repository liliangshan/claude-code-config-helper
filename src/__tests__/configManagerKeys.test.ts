/** @file Verify saved key hints never copy full credentials into provider configuration or Webview state. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: {} });
const { ConfigManager } = require('../configManager') as typeof import('../configManager');
const { PROVIDERS_STATE_KEY, PROVIDER_API_KEY_SECRET_PREFIX } = require('../constants') as typeof import('../constants');

/** Create isolated non-secret and secret stores with explicit tracking of secret reads. */
function fixture() {
    const values = new Map<string, unknown>(); const secrets = new Map<string, string>(); let reads = 0;
    const context = { subscriptions: [], globalState: {
        get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { values.set(key, value); }
    }, secrets: {
        store: async (key: string, value: string) => { secrets.set(key, value); },
        get: async (key: string) => { reads++; return secrets.get(key); },
        delete: async (key: string) => { secrets.delete(key); }
    } } as unknown as import('vscode').ExtensionContext;
    const manager = new ConfigManager(context);
    const provider = { id: 'p', name: 'Test', baseUrl: 'https://example.com', apiType: 'anthropic', authMode: 'api_key', models: [], enabled: true, autoFetchModels: false, createdAt: 1, updatedAt: 1, hasApiKey: false, customHeaders: [] } as import('../types').ProviderConfigWithoutSecrets;
    return { values, secrets, manager, provider, reads: () => reads };
}

test('saving and rotating a key persists only the masked suffix outside SecretStorage', async () => {
    const f = fixture();
    try {
        await f.manager.saveProvider(f.provider, '  synthetic-token-ABCD  ');
        assert.equal(f.manager.getProvider('p')?.maskedApiKey, '*ABCD');
        assert.equal(f.secrets.get(`${PROVIDER_API_KEY_SECRET_PREFIX}p`), 'synthetic-token-ABCD');
        const config = JSON.stringify(f.values.get(PROVIDERS_STATE_KEY));
        assert.equal(config.includes('synthetic-token'), false); assert.ok(config.includes('*ABCD'));
        assert.equal(JSON.stringify(f.manager.getState()).includes('synthetic-token'), false);
        await f.manager.saveProvider({ ...f.manager.getProvider('p')!, maskedApiKey: '*FAKE' });
        assert.equal(f.manager.getProvider('p')?.maskedApiKey, '*ABCD', 'Editing provider fields keeps the host-generated hint');
        await f.manager.replaceProviders([f.manager.getProvider('p')!], { p: 'replacement-token-WXYZ' });
        assert.equal(f.manager.getProvider('p')?.maskedApiKey, '*WXYZ');
        assert.equal(f.reads(), 0, 'Displaying or saving a hint never retrieves the full secret');
        assert.equal((await f.manager.getProviderWithSecret('p'))?.apiKey, 'replacement-token-WXYZ');
        await f.manager.replaceProviders([f.manager.getProvider('p')!], { p: '' });
        assert.equal(f.manager.getProvider('p')?.hasApiKey, false); assert.equal(f.manager.getProvider('p')?.maskedApiKey, undefined);
        assert.equal(f.secrets.size, 0);
    } finally { f.manager.dispose(); }
});

test('legacy providers keep the saved-key fallback and short keys never reveal their complete value', async () => {
    const f = fixture();
    try {
        f.values.set(PROVIDERS_STATE_KEY, [{ ...f.provider, hasApiKey: true }]);
        assert.equal(f.manager.getProvider('p')?.maskedApiKey, undefined);
        await f.manager.replaceProviders([{ ...f.manager.getProvider('p')!, maskedApiKey: '*FAKE' }]);
        assert.equal(f.manager.getProvider('p')?.maskedApiKey, undefined, 'A Webview cannot fabricate a key hint');
        await f.manager.saveProvider(f.provider, '1234');
        assert.equal(f.manager.getProvider('p')?.hasApiKey, true); assert.equal(f.manager.getProvider('p')?.maskedApiKey, undefined);
        assert.equal(f.reads(), 0);
        await f.manager.saveProvider(f.provider, 'long-test-5678');
        await f.manager.saveProvider(f.manager.getProvider('p')!, '');
        assert.equal(f.manager.getProvider('p')?.maskedApiKey, undefined);
    } finally { f.manager.dispose(); }
});
