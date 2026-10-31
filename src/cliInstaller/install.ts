/** @file Managed CLI installer: exact platform version, integrity, staging, verification and atomic promotion. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyIntegrity, extractPlatformArchive } from './archive';
import { resolveHostPlatformPackage } from './platform';
import { downloadOfficial } from './download';
import { CLI_REGISTRIES, validateRegistryUrl, type CliInstallSource } from './sources';
import { probeCliVersion, clearCliVersionCache } from '../chat/cli/nativeCompactionProbe';

/** Validated immutable release selection shown before user approves installation. */
export interface CliRelease { version: string; packageName: string; url: string; integrity: string; source?: CliInstallSource }
/** Dependency injection keeps tests offline and never executes synthetic/untrusted downloads. */
export interface InstallerDependencies {
    download: typeof downloadOfficial;
    verify: (executable: string) => Promise<string | undefined>;
}
/** Detect the actual extension host package, including Electron-safe Linux libc fallbacks. */
export function hostPlatformPackage(): string {
    return resolveHostPlatformPackage(process.platform, process.arch);
}
/** Side-by-side managed installation never edits an external/global npm installation. */
export class CliInstaller {
    /** @param dependencies Official transport by default, local substitutes only in tests. */
    public constructor(private readonly dependencies: InstallerDependencies = { download: downloadOfficial, verify: executable => { clearCliVersionCache(); return probeCliVersion(executable); } }) {}
    /** Resolve the selected registry's main release and its exact matching platform package. */
    public async latest(signal: AbortSignal, packageName = hostPlatformPackage(), source: CliInstallSource = 'official'): Promise<CliRelease> {
        const registry = CLI_REGISTRIES[source];
        validateRegistryUrl(`${registry}/`, source);
        const main = JSON.parse((await this.dependencies.download(`${registry}/@anthropic-ai%2fclaude-code/latest`, signal, undefined, 4 * 1024 * 1024, 0, source)).toString());
        if (!/^\d+\.\d+\.\d+$/.test(main.version) || main.optionalDependencies?.[packageName] !== main.version) throw new Error('No matching platform release in selected registry');
        const meta = JSON.parse((await this.dependencies.download(`${registry}/${encodeURIComponent(packageName)}/${main.version}`, signal, undefined, 4 * 1024 * 1024, 0, source)).toString());
        if (meta.name !== packageName || meta.version !== main.version || typeof meta.dist?.tarball !== 'string' || typeof meta.dist?.integrity !== 'string') throw new Error('Invalid platform package metadata');
        const url = validateRegistryUrl(meta.dist.tarball, source);
        return { version: main.version, packageName, url: url.href, integrity: meta.dist.integrity, source };
    }
    /** Publish a verified version-named executable directly in the chosen root without replacing existing files. */
    public async install(release: CliRelease, root: string, signal: AbortSignal, progress: (bytes: number, total?: number) => void, onVerify: () => void = () => {}): Promise<string> {
        validateRegistryUrl(release.url, release.source ?? 'official');
        if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^@anthropic-ai\/claude-code-(darwin|linux|win32)-(arm64|x64)(-musl)?$/.test(release.packageName)) throw new Error('Invalid installation identity');
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const canonical = await fs.realpath(root);
        const lockPath = path.join(canonical, '.install.lock');
        const lock = await fs.open(lockPath, 'wx', 0o600);
        const staging = path.join(canonical, `.staging-${randomUUID()}`);
        try {
            await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
            const folder = release.packageName.slice('@anthropic-ai/claude-code-'.length);
            const destination = path.join(canonical, `claude-${release.version}${folder.startsWith('win32') ? '.exe' : ''}`);
            try { await fs.lstat(destination); throw new Error('Version file already exists; select its verified executable or a different root'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await fs.mkdir(staging, { mode: 0o700 });
            const bytes = await this.dependencies.download(release.url, signal, progress, undefined, 0, release.source ?? 'official');
            onVerify();
            verifyIntegrity(bytes, release.integrity); if (signal.aborted) throw new Error('Installation cancelled');
            const executable = await extractPlatformArchive(bytes, staging, folder.startsWith('win32') ? 'win32' : 'unix');
            if (signal.aborted) throw new Error('Installation cancelled');
            if (await this.dependencies.verify(executable) !== release.version) throw new Error('Downloaded CLI version verification failed');
            if (signal.aborted) throw new Error('Installation cancelled');
            // An exclusive hard-link publication is atomic on the same volume and never replaces an occupied target.
            await fs.link(executable, destination);
            return destination;
        } finally {
            await fs.rm(staging, { recursive: true, force: true }); await lock.close(); await fs.unlink(lockPath);
        }
    }
}
