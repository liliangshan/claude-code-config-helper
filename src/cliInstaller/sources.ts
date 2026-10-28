/** @file Explicit CLI package sources and strict HTTPS allowlists. */
export type CliInstallSource = 'official' | 'china';
export const CLI_REGISTRIES = { official: 'https://registry.npmjs.org', china: 'https://registry.npmmirror.com' } as const;

/** Accept only named sources, never arbitrary registry URLs from Webviews or saved state. */
export function isCliInstallSource(value: unknown): value is CliInstallSource {
    return value === 'official' || value === 'china';
}

/** Validate both initial URLs and every redirect against the explicitly selected source. */
export function validateRegistryUrl(url: string, source: CliInstallSource = 'official'): URL {
    const target = new URL(url);
    const hosts = source === 'china' ? ['registry.npmmirror.com', 'cdn.npmmirror.com'] : ['registry.npmjs.org'];
    if (!isCliInstallSource(source) || target.protocol !== 'https:' || !hosts.includes(target.hostname) || target.username || target.password || (target.port && target.port !== '443')) {
        throw new Error('URL is outside the selected HTTPS CLI registry');
    }
    return target;
}
