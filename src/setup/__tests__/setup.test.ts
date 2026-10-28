/** @file Offline tests for explicit onboarding and script-free CLI installation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { isSetupComplete, compareVersions } from '../state';
import { platformPackage, extractPlatformArchive, verifyIntegrity } from '../../cliInstaller/archive';
import { CliInstaller } from '../../cliInstaller/install';
import { validateRegistryUrl, isCliInstallSource } from '../../cliInstaller/sources';
import { downloadOfficial } from '../../cliInstaller/download';

/** Build an inert npm tar fixture; test verifier never executes it. */
function archive(name = 'package/claude', type = 48): Buffer {
    const content = Buffer.from('synthetic binary'); const header = Buffer.alloc(512);
    header.write(name); header.write('0000700\0', 100); header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header[156] = type;
    const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return gzipSync(Buffer.concat([header, content, Buffer.alloc(512 - content.length), Buffer.alloc(1024)]));
}

test('existing CLI/model do not bypass missing explicit setup completion', () => {
    const state = { schemaVersion: 1, completed: true, environmentId: 'local:darwin:arm64', cli: { path: '/existing/claude' } };
    assert.equal(isSetupComplete(undefined, state, state.environmentId), false);
    assert.equal(isSetupComplete(true, undefined, state.environmentId), false);
    assert.equal(isSetupComplete(true, state, 'ssh:linux:x64'), false);
    assert.equal(isSetupComplete(true, state, state.environmentId), true);
    assert.equal(compareVersions('2.1.311', '2.1.302'), 1);
    assert.throws(() => compareVersions('latest', '2.1.1'));
});

test('platform mapping handles musl and rejects unknown architectures', () => {
    assert.equal(platformPackage('darwin', 'arm64'), '@anthropic-ai/claude-code-darwin-arm64');
    assert.equal(platformPackage('linux', 'x64', true), '@anthropic-ai/claude-code-linux-x64-musl');
    assert.throws(() => platformPackage('linux', 'ia32'));
});

test('archive rejects traversal, symlinks and integrity mismatch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-archive-'));
    try {
        await assert.rejects(extractPlatformArchive(archive('package/../../escape'), root, 'unix'));
        await assert.rejects(extractPlatformArchive(archive('package/claude', 50), root, 'unix'));
        assert.throws(() => verifyIntegrity(archive(), 'sha512-' + Buffer.alloc(64).toString('base64')));
        const binary = await extractPlatformArchive(archive(), root, 'unix'); assert.equal(await fs.readFile(binary, 'utf8'), 'synthetic binary');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('installer promotes only verified payload and preserves external files on failure or cancellation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-install-'));
    const bytes = archive(); const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    const release = { version: '2.1.311', packageName: '@anthropic-ai/claude-code-darwin-arm64', url: 'https://registry.npmjs.org/test.tgz', integrity };
    const external = path.join(root, 'existing-cli'); await fs.writeFile(external, 'keep');
    try {
        const bad = new CliInstaller({ download: async () => bytes, verify: async () => '0.0.1' });
        await assert.rejects(bad.install(release, root, new AbortController().signal, () => {}), /verification/);
        assert.equal(await fs.readFile(external, 'utf8'), 'keep');
        const cancelled = new AbortController(); cancelled.abort();
        const good = new CliInstaller({ download: async () => bytes, verify: async () => release.version });
        await assert.rejects(good.install(release, root, cancelled.signal, () => {}), /cancelled/);
        const installed = await good.install(release, root, new AbortController().signal, () => {});
        assert.equal(installed, path.join(await fs.realpath(root), 'claude-2.1.311'));
        assert.equal(await fs.readFile(installed, 'utf8'), 'synthetic binary');
        await assert.rejects(good.install(release, root, new AbortController().signal, () => {}), /already exists/);
        assert.equal(await fs.readFile(installed, 'utf8'), 'synthetic binary', 'Existing executable is never overwritten');
        const nextInstaller = new CliInstaller({ download: async () => bytes, verify: async () => '2.1.312' });
        const newer = await nextInstaller.install({ ...release, version: '2.1.312' }, root, new AbortController().signal, () => {});
        assert.equal(path.basename(newer), 'claude-2.1.312');
        assert.equal(await fs.readFile(installed, 'utf8'), 'synthetic binary', 'A new version preserves the old executable');
        assert.deepEqual((await fs.readdir(root)).sort(), ['claude-2.1.311', 'claude-2.1.312', 'existing-cli']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows installation publishes only the version-named executable in the selected directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-windows-'));
    const bytes = archive('package/claude.exe');
    const release = { version: '2.1.311', packageName: '@anthropic-ai/claude-code-win32-x64', url: 'https://registry.npmjs.org/test.tgz', integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
    try {
        const installer = new CliInstaller({ download: async () => bytes, verify: async () => release.version });
        const executable = await installer.install(release, root, new AbortController().signal, () => {});
        assert.equal(executable, path.join(await fs.realpath(root), 'claude-2.1.311.exe'));
        assert.deepEqual(await fs.readdir(root), ['claude-2.1.311.exe']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('registry URLs and redirects cannot escape the explicitly selected source', async () => {
    assert.equal(isCliInstallSource('official'), true); assert.equal(isCliInstallSource('china'), true);
    assert.equal(isCliInstallSource('https://untrusted.example'), false);
    assert.equal(validateRegistryUrl('https://registry.npmjs.org/package').hostname, 'registry.npmjs.org');
    assert.equal(validateRegistryUrl('https://cdn.npmmirror.com/packages/test.tgz', 'china').hostname, 'cdn.npmmirror.com');
    for (const url of ['http://registry.npmmirror.com/pkg', 'https://registry.npmmirror.com.evil.example/pkg', 'https://user:secret@registry.npmmirror.com/pkg', 'https://127.0.0.1/pkg', 'https://registry.npmmirror.com:444/pkg']) {
        assert.throws(() => validateRegistryUrl(url, 'china'));
        await assert.rejects(downloadOfficial(url, new AbortController().signal, undefined, undefined, 0, 'china'));
    }
    assert.throws(() => validateRegistryUrl('https://cdn.npmmirror.com/pkg'));
    assert.throws(() => validateRegistryUrl('https://registry.npmjs.org/pkg', 'china'));
});

test('selected mirror supplies metadata and payload with integrity verification and phase reporting', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-mirror-'));
    const bytes = archive(); const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    const packageName = '@anthropic-ai/claude-code-darwin-arm64', version = '2.1.311';
    const requests: string[] = []; let verified = false; const phases: string[] = [];
    const installer = new CliInstaller({
        download: async (url, _signal, progress, _limit, _redirects, source) => {
            assert.equal(source, 'china'); requests.push(url);
            if (url.endsWith('/latest')) return Buffer.from(JSON.stringify({ version, optionalDependencies: { [packageName]: version } }));
            if (url.endsWith(`/${version}`)) return Buffer.from(JSON.stringify({ name: packageName, version, dist: { tarball: 'https://registry.npmmirror.com/package.tgz', integrity } }));
            progress?.(bytes.length, bytes.length); phases.push('download'); return bytes;
        },
        verify: async () => { verified = true; return version; }
    });
    try {
        const release = await installer.latest(new AbortController().signal, packageName, 'china');
        assert.equal(release.source, 'china');
        const executable = await installer.install(release, root, new AbortController().signal, () => {}, () => phases.push('verify'));
        assert.equal(verified, true); assert.deepEqual(phases, ['download', 'verify']);
        assert.equal(requests.length, 3); assert.ok(requests.every(url => url.startsWith('https://registry.npmmirror.com/')));
        assert.equal(await fs.readFile(executable, 'utf8'), 'synthetic binary');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
