/** @file 跨平台 CLI 版本入口与失败重试回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCliVersionCommand, clearCliVersionCache, probeCliVersion } from '../nativeCompactionProbe';

test('Windows cmd/bat 显式解释器与引用；PowerShell -File 不拼接命令', () => {
    for (const ext of ['cmd', 'bat']) {
        const file = `C:\\Program Files\\a & b!\\claude.${ext}`;
        const command = buildCliVersionCommand(file, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
        assert.equal(command.file, 'C:\\Windows\\System32\\cmd.exe');
        assert.deepEqual(command.args, ['/d', '/s', '/v:off', '/c', `""${file}" --version"`]);
        assert.equal(command.windowsVerbatimArguments, true);
    }
    const file = 'C:\\Program Files\\Claude\\cli.ps1';
    const ps = buildCliVersionCommand(file, 'win32', {});
    assert.equal(ps.file, 'powershell.exe');
    assert.deepEqual(ps.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file, '--version']);
    assert.throws(() => buildCliVersionCommand('C:\\%TEMP%\\cli.cmd', 'win32', {}));
    assert.deepEqual(buildCliVersionCommand('C:\\Claude\\claude.exe', 'win32', {}), { file: 'C:\\Claude\\claude.exe', args: ['--version'] });
});

test('探测继承 cwd/env；失败不缓存；成功缓存可显式清除', { skip: process.platform === 'win32' }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccai-version-'));
    const script = path.join(root, 'cli version');
    const marker = path.join(root, 'ready');
    await fs.writeFile(script, '#!/bin/sh\nif [ ! -f ready ]; then exit 1; fi\nprintf "%s\\n" "$PROBE_VERSION"\n', { mode: 0o755 });
    const options = { cwd: root, env: { ...process.env, PROBE_VERSION: 'warning: startup\nClaude Code v2.1.303' } };
    try {
        assert.equal(await probeCliVersion(script, options), undefined);
        await fs.writeFile(marker, 'ready');
        assert.equal(await probeCliVersion(script, options), '2.1.303');
        await fs.unlink(marker);
        assert.equal(await probeCliVersion(script, options), '2.1.303');
        clearCliVersionCache();
        assert.equal(await probeCliVersion(script, options), undefined);
        await fs.writeFile(marker, 'ready');
        assert.equal(await probeCliVersion(script, { ...options, env: { ...options.env, PROBE_VERSION: 'v2.1.279' } }), '2.1.279');
    } finally { clearCliVersionCache(); await fs.rm(root, { recursive: true, force: true }); }
});
