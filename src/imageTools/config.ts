/** @file Pure image configuration validation and deterministic Images endpoint construction. */
import { defaultImageConfig, ImageError, type ImageGenerationConfig } from './types';

/** Validate connection fields and normalize removed options to internal safety defaults, including old records. */
export function parseImageConfig(raw: Record<string, unknown>, revision: number): ImageGenerationConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ImageError('IMAGE_CONFIG_INVALID');
    const config = defaultImageConfig();
    for (const key of ['providerId', 'modelId', 'baseUrl'] as const) {
        const value = raw[key] ?? '';
        if (typeof value !== 'string' || value.length > 2048) throw new ImageError('IMAGE_CONFIG_INVALID');
        config[key] = value.trim();
    }
    if (typeof raw.enabled !== 'boolean') throw new ImageError('IMAGE_CONFIG_INVALID');
    if (raw.source !== 'provider' && raw.source !== 'custom') throw new ImageError('IMAGE_CONFIG_INVALID');
    if (raw.authMode !== 'bearer' && raw.authMode !== 'none') throw new ImageError('IMAGE_CONFIG_INVALID');
    config.enabled = raw.enabled; config.source = raw.source; config.authMode = raw.authMode;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ImageError('IMAGE_CONFIG_INVALID');
    config.revision = revision;
    return config;
}
/** Parse an explicit API URL, forbidding embedded credentials, query strings and insecure remote HTTP. */
export function imageApiUrl(value: string, allowLocalHttp: boolean): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new ImageError('IMAGE_CONFIG_INVALID'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && allowLocalHttp))) throw new ImageError('IMAGE_CONFIG_INVALID');
    return url;
}
/** Resolve one prefix exactly once; overrides in provider mode cannot send inherited credentials across origins. */
export function imageEndpoints(config: ImageGenerationConfig, baseUrl = config.baseUrl): { generationUrl: string; editUrl: string } {
    const base = imageApiUrl(baseUrl, config.allowLocalHttp);
    if (/\/(images\/(generations|edits)|chat\/completions|responses|messages)\/?$/.test(base.pathname)) throw new ImageError('IMAGE_CONFIG_INVALID');
    const prefix = base.pathname.replace(/\/+$/, '') || '/v1';
    const resolve = (override: string, suffix: string): string => {
        const target = override ? imageApiUrl(override, config.allowLocalHttp) : new URL(`${prefix}/images/${suffix}`, base.origin);
        if (config.source === 'provider' && target.origin !== base.origin) throw new ImageError('IMAGE_CONFIG_INVALID');
        return target.toString();
    };
    return { generationUrl: resolve(config.generationEndpointOverride, 'generations'), editUrl: resolve(config.editEndpointOverride, 'edits') };
}
