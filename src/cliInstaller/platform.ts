/** @file Detect Linux libc in Node and Electron hosts without treating an unavailable report as musl. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { platformPackage } from './archive';

/** Injectable host probes keep Linux glibc/musl coverage deterministic and offline. */
export interface LibcProbes {
    report(): unknown;
    command(file: string, args: string[]): string;
    read(file: string): string;
    list(directory: string): string[];
}
/** Bound local probes; no shell, downloads, installation or execution of untrusted code. */
const hostProbes: LibcProbes = {
    report: () => process.report?.getReport(),
    command: (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 65536, windowsHide: true }),
    read: file => readFileSync(file, 'utf8'), list: directory => readdirSync(directory)
};
/** Classify explicit libc evidence instead of guessing from a missing report field. */
export function libcFromText(text: string): 'glibc' | 'musl' | undefined {
    if (/\bmusl\b|ld-musl-/i.test(text)) return 'musl';
    if (/\bglibc\b|GNU C Library|GNU libc|ld-linux[^\s/]*\.so|libc[-.]\d[^\s/]*\.so|libc\.so\.6/i.test(text)) return 'glibc';
    return undefined;
}
/** Resolve the actual Linux libc using runtime evidence, getconf/ldd, and known loader files. */
export function detectLinuxLibc(probes: LibcProbes = hostProbes): 'glibc' | 'musl' {
    try {
        let report = probes.report() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] } | string | undefined;
        if (typeof report === 'string') report = JSON.parse(report);
        if (report && typeof report === 'object') {
            if (report.header?.glibcVersionRuntime) return 'glibc';
            const detected = libcFromText(Array.isArray(report.sharedObjects) ? report.sharedObjects.filter(item => typeof item === 'string' && /^\/(?:usr\/)?lib(?:64|32)?\//.test(item)).join('\n') : '');
            if (detected) return detected;
        }
    } catch { /* Some Electron hosts disable process.report; continue with the real system probes. */ }
    for (const [file, args] of [['getconf', ['GNU_LIBC_VERSION']], ['ldd', ['--version']]] as const) {
        try {
            const detected = libcFromText(probes.command(file, [...args])); if (detected) return detected;
        } catch (error) {
            const output = error as { stdout?: string | Buffer; stderr?: string | Buffer };
            const detected = libcFromText(String(output.stdout ?? '') + '\n' + String(output.stderr ?? '')); if (detected) return detected;
        }
    }
    try { const detected = libcFromText(probes.read('/usr/bin/ldd')); if (detected) return detected; } catch { /* Minimal containers may not ship ldd. */ }
    const loaders = new Set<'glibc' | 'musl'>();
    for (const directory of ['/lib', '/lib64', '/usr/lib', '/lib/x86_64-linux-gnu', '/lib/aarch64-linux-gnu']) {
        try { for (const name of probes.list(directory)) { const detected = libcFromText(name); if (detected) loaders.add(detected); } }
        catch { /* Only directories present in this host contribute evidence. */ }
    }
    if (loaders.size === 1) return [...loaders][0];
    throw new Error('Unable to determine Linux libc: runtime report, getconf, ldd and loader probes returned no unambiguous result. Select an existing Claude CLI executable.');
}
/** Choose the native package only after validating the platform/architecture and Linux libc. */
export function resolveHostPlatformPackage(platform: string, arch: string, probes: LibcProbes = hostProbes): string {
    platformPackage(platform, arch);
    return platformPackage(platform, arch, platform === 'linux' && detectLinuxLibc(probes) === 'musl');
}
