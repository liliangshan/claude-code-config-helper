/** @file Offline Linux package selection regressions for Node, Electron and minimal container hosts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLinuxLibc, resolveHostPlatformPackage, type LibcProbes } from '../../cliInstaller/platform';

/** Start with unavailable probes so each test declares the evidence it relies on explicitly. */
function probes(overrides: Partial<LibcProbes>): LibcProbes {
    return { report: () => undefined, command: () => { throw new Error('missing command'); }, read: () => { throw new Error('missing file'); }, list: () => [], ...overrides };
}

test('Linux detects glibc from reports without requiring a process report in Electron', () => {
    assert.equal(detectLinuxLibc(probes({ report: () => ({ header: { glibcVersionRuntime: '2.35' } }) })), 'glibc');
    assert.equal(resolveHostPlatformPackage('linux', 'x64', probes({ report: () => undefined, command: () => 'glibc 2.35' })), '@anthropic-ai/claude-code-linux-x64');
    assert.equal(resolveHostPlatformPackage('linux', 'arm64', probes({ report: () => { throw new Error('report disabled'); }, command: () => 'ldd (GNU libc) 2.36' })), '@anthropic-ai/claude-code-linux-arm64');
});

test('musl requires positive evidence, including ldd output on stderr or loader names', () => {
    assert.equal(detectLinuxLibc(probes({ report: () => ({ header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] }) })), 'musl');
    assert.equal(resolveHostPlatformPackage('linux', 'x64', probes({ command: () => { throw { stderr: 'musl libc (x86_64)\nVersion 1.2.4' }; } })), '@anthropic-ai/claude-code-linux-x64-musl');
    assert.equal(resolveHostPlatformPackage('linux', 'arm64', probes({ list: directory => directory === '/lib' ? ['ld-musl-aarch64.so.1'] : [] })), '@anthropic-ai/claude-code-linux-arm64-musl');
    assert.throws(() => detectLinuxLibc(probes({ report: () => ({ header: {} }) })), /no unambiguous result/);
});

test('minimal systems use ldd scripts or known loaders and never guess from conflicting evidence', () => {
    assert.equal(detectLinuxLibc(probes({ read: () => '#!/bin/sh\n# GNU C Library ldd' })), 'glibc');
    assert.equal(detectLinuxLibc(probes({ list: directory => directory === '/lib64' ? ['ld-linux-x86-64.so.2'] : [] })), 'glibc');
    assert.throws(() => detectLinuxLibc(probes({ list: () => ['ld-musl-x86_64.so.1', 'ld-linux-x86-64.so.2'] })), /Select an existing Claude CLI/);
    assert.equal(resolveHostPlatformPackage('darwin', 'arm64', probes({ report: () => assert.fail('Non-Linux never probes libc') })), '@anthropic-ai/claude-code-darwin-arm64');
    assert.throws(() => resolveHostPlatformPackage('linux', 'ia32', probes({})), /Unsupported/);
});
