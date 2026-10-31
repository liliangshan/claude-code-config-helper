/** @file Global image settings with cross-window revision checks and SecretStorage-only credentials. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ConfigManager } from '../configManager';
import { buildOpenAIForwardHeaders } from '../relay/openAIHeaders';
import { imageApiUrl, imageEndpoints, parseImageConfig } from './config';
import { ImageFileLock, readJson, safeDirectory, writeJson } from './storage';
import { defaultImageConfig, ImageError, imageErrorCode, type ImageConfigInput, type ImageGenerationConfig, type ImageGenerationExecutionSnapshot, type ImageGenerationPublicState } from './types';

/** Minimal secret interface makes failure/rollback tests independent of VS Code. */
export interface ImageSecrets { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; delete(key: string): Thenable<void> }
/** Mask malformed/credential-bearing endpoints before they reach a configuration Webview. */
function publicEndpoint(value: string): string {
    if (!value) return '';
    try { imageApiUrl(value, true); return value; } catch { return ''; }
}

/** One global store, not one store per chat; reads always consult the committed disk revision. */
export class ImageConfigStore extends EventEmitter {
    private directory = '';
    private watcher?: fs.FSWatcher;
    private readonly missingMarker = 'llsccai.imageGeneration.config.initialized';
    private initialized?: Promise<void>;
    private queue: Promise<unknown> = Promise.resolve();
    private seen = false;
    private disposed = false;
    /** Bind extension-owned global storage and the existing provider resolver. */
    public constructor(private readonly root: string, private readonly secrets: ImageSecrets, private readonly manager: ConfigManager) { super(); }
    /** Create only the extension-owned settings directory, then watch atomic replacements across windows. */
    public initialize(): Promise<void> {
        if (this.disposed) return Promise.reject(new ImageError('IMAGE_STORAGE_FAILED'));
        if (!this.initialized) {
            this.initialized = this.initializeStorage().catch(error => { this.initialized = undefined; throw error; });
        }
        return this.initialized;
    }
    /** Initialize directory/watch resources once; failed attempts can be retried after storage unlocks. */
    private async initializeStorage(): Promise<void> {
        await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
        this.directory = await safeDirectory(this.root, ['image-generation'], true);
        let configPresent = false;
        try { await fsp.lstat(path.join(this.directory, 'config.json')); configPresent = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!configPresent && await this.secrets.get(this.missingMarker)) this.seen = true;
        this.watcher = fs.watch(this.directory, () => { if (!this.disposed) this.emit('change'); });
        this.watcher.on('error', () => { if (!this.disposed) this.emit('change'); });
    }
    /** Read a validated revision. Missing configuration is allowed only before any record was observed. */
    public async read(): Promise<ImageGenerationConfig> {
        await this.initialize(); await safeDirectory(this.root, ['image-generation'], false);
        try {
            const raw = await readJson(path.join(this.directory, 'config.json')) as Record<string, unknown>;
            if (raw.version !== 1) throw new ImageError('IMAGE_CONFIG_INVALID');
            const config = parseImageConfig(raw, raw.revision as number);
            if (raw.secretRef !== undefined) {
                if (typeof raw.secretRef !== 'string' || !/^llsccai\.imageGeneration\.secret\.[0-9a-f-]{36}$/.test(raw.secretRef)) throw new ImageError('IMAGE_CONFIG_INVALID');
                config.secretRef = raw.secretRef;
            }
            this.seen = true; return config;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.seen && !await this.secrets.get(this.missingMarker)) return defaultImageConfig();
            throw new ImageError('IMAGE_CONFIG_INVALID');
        }
    }
    /** Resolve authentication only inside the host. Disabled settings may still be checked explicitly. */
    public async resolve(config: ImageGenerationConfig, keyOverride?: string): Promise<ImageGenerationExecutionSnapshot> {
        if (!config.modelId) throw new ImageError('IMAGE_CONFIG_REQUIRED');
        let base = config.baseUrl; let providerName = 'Custom'; let headers: Record<string, string> = {};
        if (config.source === 'provider') {
            let provider;
            try { provider = await this.manager.getProviderWithSecret(config.providerId); }
            catch { throw new ImageError('IMAGE_KEY_REQUIRED'); }
            if (!provider || provider.enabled === false || !['openai-compatible', 'v1-response'].includes(provider.apiType)
                || !this.manager.isModelEnabled(this.manager.getProviderModel(config.providerId, config.modelId))) throw new ImageError('IMAGE_CONFIG_INVALID');
            base = provider.baseUrl; providerName = provider.name;
            headers = buildOpenAIForwardHeaders(provider, {});
            if (provider.authMode !== 'none' && !headers.authorization && !headers['x-api-key']) throw new ImageError('IMAGE_KEY_REQUIRED');
        } else {
            const key = keyOverride ?? (config.secretRef ? await this.secrets.get(config.secretRef) : undefined);
            if (config.authMode === 'bearer') {
                if (!key?.trim() || /[\r\n]/.test(key)) throw new ImageError('IMAGE_KEY_REQUIRED');
                headers.authorization = `Bearer ${key.trim()}`;
            }
        }
        headers['content-type'] = 'application/json';
        return { config: { ...config }, ...imageEndpoints(config, base), headers, providerName };
    }
    /** Build a new validated revision while retaining/removing credentials only by explicit action. */
    private draft(input: ImageConfigInput, old: ImageGenerationConfig): ImageGenerationConfig {
        if (!input || input.expectedRevision !== old.revision) throw new ImageError('IMAGE_CONFIG_CONFLICT');
        if (input.config?.secretRef !== undefined) throw new ImageError('IMAGE_CONFIG_INVALID');
        if (!['keep', 'replace', 'delete'].includes(input.keyAction)) throw new ImageError('IMAGE_CONFIG_INVALID');
        if (input.keyAction === 'replace' && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 16384 || /[\r\n]/.test(input.apiKey))) throw new ImageError('IMAGE_KEY_REQUIRED');
        const next = parseImageConfig(input.config, old.revision + 1);
        if (input.keyAction === 'keep') next.secretRef = old.secretRef;
        return next;
    }
    /** Check a draft locally; no network requests and no credential writes. */
    public async check(input: ImageConfigInput): Promise<ImageGenerationExecutionSnapshot> {
        const checked = input?.keyAction === 'replace' ? { ...input, apiKey: 'pending-user-key' } : input;
        const next = this.draft(checked, await this.read());
        return this.resolve(next, checked.keyAction === 'replace' ? checked.apiKey : undefined);
    }
    /** Serialize local saves, hold a cross-host lock, then publish the secret reference atomically. */
    public save(input: ImageConfigInput): Promise<ImageGenerationConfig> {
        const action = this.queue.then(async () => {
            await this.initialize(); await safeDirectory(this.root, ['image-generation'], false);
            const lock = new ImageFileLock(path.join(this.directory, 'config.lock')); await lock.acquire();
            let newRef: string | undefined; let published = false;
            try {
                const current = await this.read(); const next = this.draft(input, current);
                if (next.enabled) await this.resolve(next, input.keyAction === 'replace' ? input.apiKey?.trim() : undefined);
                else if (next.source === 'custom' && next.baseUrl) imageEndpoints(next);
                if (input.keyAction === 'replace') {
                    newRef = `llsccai.imageGeneration.secret.${randomUUID()}`;
                    await this.secrets.store(newRef, input.apiKey!.trim()); next.secretRef = newRef;
                }
                await lock.check(); await writeJson(path.join(this.directory, 'config.json'), next);
                published = true; this.seen = true;
                await this.secrets.store(this.missingMarker, '1').then(undefined, () => {});
                this.emit('change'); return next;
            } finally {
                if (newRef && !published) await this.secrets.delete(newRef).then(undefined, () => {});
                await lock.release();
            }
        });
        this.queue = action.catch(() => {}); return action;
    }
    /** Produce a minimal safe state; provider headers and secret references never enter Webview messages. */
    public async publicState(): Promise<ImageGenerationPublicState> {
        let config = defaultImageConfig(); let error: string | undefined; let snapshot: ImageGenerationExecutionSnapshot | undefined;
        try { config = await this.read(); if (config.enabled || config.modelId) snapshot = await this.resolve(config); }
        catch (failure) { error = imageErrorCode(failure); }
        const { secretRef, ...safe } = config;
        safe.baseUrl = publicEndpoint(safe.baseUrl); safe.generationEndpointOverride = publicEndpoint(safe.generationEndpointOverride); safe.editEndpointOverride = publicEndpoint(safe.editEndpointOverride);
        const hasApiKey = config.source === 'provider' ? !!(snapshot?.headers.authorization || snapshot?.headers['x-api-key']) : !!(secretRef && await this.secrets.get(secretRef).then(value => !!value, () => false));
        const providers = this.manager.listProviders().filter(p => p.enabled !== false && ['openai-compatible', 'v1-response'].includes(p.apiType)).map(p => ({
            id: p.id, name: p.name, baseUrl: publicEndpoint(p.baseUrl),
            models: p.models.filter(m => this.manager.isModelEnabled(m)).map(m => ({ modelId: m.modelId, displayName: m.displayName })) }));
        return { config: safe, hasApiKey, providers, error, generationUrl: snapshot?.generationUrl, editUrl: snapshot?.editUrl };
    }
    /** Notify views when a referenced provider changes without modifying the global selection. */
    public refresh(): void { this.emit('change'); }
    /** Stop watching while leaving committed settings and safe credential revisions intact. */
    public dispose(): void { this.disposed = true; this.watcher?.close(); this.removeAllListeners(); }
}
