/**
 * @file CliProcess MCP / skills 启动参数注入单元测试。
 *
 * 参考 Claude Code 官方扩展 (`anthropic.claude-code` 2.1.x) 的 SDK 实现，
 * 验证我们在 `CliProcess.buildStreamJsonArgs()` / `appendMcpArgs()` /
 * `appendSkillArgs()` 中对 MCP servers、strict-mcp-config、skills 的注入逻辑：
 * 1. mcpServers 非空时追加 `--mcp-config '{"mcpServers":...}'`；
 * 2. strictMcpConfig=true 时追加 `--strict-mcp-config`；
 * 3. skills='all' 注入 `--allowedTools Skill`；
 * 4. skills=['a','b'] 注入 `--allowedTools Skill(a),Skill(b)`；
 * 5. 用户已自定义 `--mcp-config` / `--allowedTools` 时不重复追加而是合并去重。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// CliProcess 顶层 `import * as vscode from 'vscode'`，必须先装好 stub 再 require。
import { installVscodeStub } from './testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CliProcess } = require('../cli/cliProcess') as typeof import('../cli/cliProcess');
type ChatCliConfig = import('../cli/types').ChatCliConfig;

/**
 * 构造一份可注入到 CliProcess 内部状态的最小化 ChatCliConfig。
 *
 * 这里手工构造一个对象覆盖 CliProcess 的 `currentConfig` 私有字段，让我们能在
 * 不真正 spawn 子进程的情况下调用 `buildStreamJsonArgs` 验证注入结果。
 *
 * @param overrides 需要覆盖的字段。
 * @returns 最小化 ChatCliConfig。
 */
function makeConfig(overrides: Partial<ChatCliConfig>): ChatCliConfig {
    return {
        enabled: true,
        cliPath: '/usr/bin/false',
        cliArgs: [],
        cwd: '/tmp',
        transport: 'streamJsonStdio',
        cliEnv: {},
        ...overrides
    };
}

/**
 * 调用 CliProcess 内部的 buildStreamJsonArgs（私有方法）。
 *
 * @param config 待注入的配置。
 * @param resumeSessionId 可选恢复 session id。
 * @returns 启动参数数组。
 */
function buildArgs(config: ChatCliConfig, resumeSessionId?: string): string[] {
    const proc = new CliProcess();
    // 通过 cast 写入私有字段，避免修改 CliProcess 的公开 API。
    (proc as unknown as { currentConfig: ChatCliConfig }).currentConfig = config;
    const args = (proc as unknown as {
        buildStreamJsonArgs(cliArgs: string[], resumeSessionId?: string): string[];
    }).buildStreamJsonArgs(config.cliArgs, resumeSessionId);
    proc.dispose();
    return args;
}

test('mcpServers 非空时启动参数应包含 --mcp-config JSON', () => {
    const args = buildArgs(makeConfig({
        mcpServers: {
            'fs': { type: 'stdio', command: 'node', args: ['fs-mcp.js'] }
        }
    }));
    const idx = args.indexOf('--mcp-config');
    assert.notEqual(idx, -1, '--mcp-config 应被注入');
    const payload = JSON.parse(args[idx + 1]);
    assert.deepEqual(payload, {
        mcpServers: {
            fs: { type: 'stdio', command: 'node', args: ['fs-mcp.js'] }
        }
    });
});

test('strictMcpConfig=true 时启动参数应包含 --strict-mcp-config', () => {
    const args = buildArgs(makeConfig({
        mcpServers: { srv: { type: 'http', url: 'https://x' } },
        strictMcpConfig: true
    }));
    assert.ok(args.includes('--strict-mcp-config'), '应注入 --strict-mcp-config');
});

test('skills="all" 时注入 --allowedTools Skill', () => {
    const args = buildArgs(makeConfig({ skills: 'all' }));
    const idx = args.indexOf('--allowedTools');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], 'Skill');
});

test('skills=["a","b"] 时注入 Skill(a),Skill(b)', () => {
    const args = buildArgs(makeConfig({ skills: ['a', 'b'] }));
    const idx = args.indexOf('--allowedTools');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], 'Skill(a),Skill(b)');
});

test('用户 cliArgs 已含 --allowedTools 时应与 skills 合并去重', () => {
    const args = buildArgs(makeConfig({
        cliArgs: ['--allowedTools', 'Read,Write,Skill(a)'],
        skills: ['a', 'b']
    }));
    const idx = args.indexOf('--allowedTools');
    assert.notEqual(idx, -1);
    const tools = args[idx + 1].split(',');
    assert.deepEqual(tools.sort(), ['Read', 'Skill(a)', 'Skill(b)', 'Write']);
});

test('用户 cliArgs 已含 --mcp-config 时不重复注入', () => {
    const userPayload = '{"mcpServers":{"user":{"type":"stdio","command":"u"}}}';
    const args = buildArgs(makeConfig({
        cliArgs: ['--mcp-config', userPayload],
        mcpServers: { ext: { type: 'stdio', command: 'e' } }
    }));
    const occurrences = args.filter((arg) => arg === '--mcp-config' || arg.startsWith('--mcp-config='));
    assert.equal(occurrences.length, 1, '只应保留用户自定义的 --mcp-config');
    const idx = args.indexOf('--mcp-config');
    assert.equal(args[idx + 1], userPayload);
});

test('mcpServers/skills 缺省时不应注入任何相关参数', () => {
    const args = buildArgs(makeConfig({}));
    assert.equal(args.includes('--mcp-config'), false);
    assert.equal(args.includes('--strict-mcp-config'), false);
    assert.equal(args.includes('--allowedTools'), false);
});

test('skills 与 mcpServers 同时存在并保留 resume sessionId', () => {
    const args = buildArgs(
        makeConfig({
            mcpServers: { fs: { type: 'stdio', command: 'node' } },
            skills: ['code']
        }),
        'sess-1'
    );
    assert.ok(args.includes('--mcp-config'));
    const tIdx = args.indexOf('--allowedTools');
    assert.equal(args[tIdx + 1], 'Skill(code)');
    const rIdx = args.indexOf('--resume');
    assert.equal(args[rIdx + 1], 'sess-1');
});
test('appendSystemPrompt 非空时启动参数应包含 --append-system-prompt', () => {
    const args = buildArgs(makeConfig({ appendSystemPrompt: 'dispatcher prompt' }));
    const idx = args.indexOf('--append-system-prompt');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], 'dispatcher prompt');
});

test('route-specific ANTHROPIC_BASE_URL 不一致时配置比较应判定为不同', () => {
    const proc = new CliProcess();
    const left = makeConfig({
        cliEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345/normal' }
    });
    const right = makeConfig({
        cliEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345/expert' }
    });
    const same = (proc as unknown as {
        isSameConfig(leftConfig: ChatCliConfig, rightConfig: ChatCliConfig): boolean;
    }).isSameConfig(left, right);
    proc.dispose();
    assert.equal(same, false);
});

test('route-specific ANTHROPIC_BASE_URL 相同时配置比较应保持一致', () => {
    const proc = new CliProcess();
    const left = makeConfig({
        cliEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345/plan' }
    });
    const right = makeConfig({
        cliEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345/plan' }
    });
    const same = (proc as unknown as {
        isSameConfig(leftConfig: ChatCliConfig, rightConfig: ChatCliConfig): boolean;
    }).isSameConfig(left, right);
    proc.dispose();
    assert.equal(same, true);
});

// ---------------------------------------------------------------------------
// 按需专家：ask_expert 经 MCP 注入时的权限流回归
// ---------------------------------------------------------------------------

const ASK_EXPERT_MCP = {
    askExpert: { type: 'stdio' as const, command: 'node', args: ['ask-expert-mcp.js'] }
};

test('plan 权限模式下注入 ask_expert MCP，仍走 stdio 权限流（仅 bypass 才跳过）', () => {
    // 回归：plan/default/acceptEdits 等非 bypass 模式下，ask_expert MCP server 被
    // 注入到 --mcp-config，同时 --permission-prompt-tool stdio 仍然存在——这是
    // 非交互模式下让需要确认的工具能弹授权的通道，不应因 ask_expert 而被关闭。
    const args = buildArgs(makeConfig({
        permissionMode: 'plan',
        mcpServers: ASK_EXPERT_MCP,
        strictMcpConfig: true
    }));
    // ask_expert MCP 已注入。
    const mcpIdx = args.indexOf('--mcp-config');
    assert.notEqual(mcpIdx, -1);
    assert.match(args[mcpIdx + 1], /askExpert/);
    assert.ok(args.includes('--strict-mcp-config'));
    // plan 模式仍保留 stdio 权限流。
    const permIdx = args.indexOf('--permission-prompt-tool');
    assert.notEqual(permIdx, -1, 'plan 模式应保留 --permission-prompt-tool');
    assert.equal(args[permIdx + 1], 'stdio');
    assert.equal(args.indexOf('--permission-mode') !== -1 && args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('bypassPermissions 模式下注入 ask_expert MCP，仍保留 stdio 通道以拦截 AskUserQuestion', () => {
    // bypass 模式保留 --dangerously-skip-permissions 的同时追加 stdio 权限流：
    // AskUserQuestion 需经授权通道回传答案（否则空答案导致模型立即继续）；
    // 其余工具由扩展宿主 handleToolPermissionRequest 自动放行，保持 bypass 体验。
    const args = buildArgs(makeConfig({
        permissionMode: 'bypassPermissions',
        mcpServers: ASK_EXPERT_MCP,
        strictMcpConfig: true
    }));
    const mcpIdx = args.indexOf('--mcp-config');
    assert.notEqual(mcpIdx, -1);
    assert.match(args[mcpIdx + 1], /askExpert/);
    assert.ok(args.includes('--dangerously-skip-permissions'), 'bypass 模式应保留 --dangerously-skip-permissions');
    const permIdx = args.indexOf('--permission-prompt-tool');
    assert.notEqual(permIdx, -1, 'bypass 模式应保留 stdio 权限流以拦截 AskUserQuestion');
    assert.equal(args[permIdx + 1], 'stdio');
});

test('用户已在 cliArgs 指定 --permission-prompt-tool 时不因 ask_expert 注入重复', () => {
    const args = buildArgs(makeConfig({
        permissionMode: 'plan',
        mcpServers: ASK_EXPERT_MCP,
        cliArgs: ['--permission-prompt-tool', 'mcp__custom__ask']
    }));
    const occurrences = args.filter((arg) => arg === '--permission-prompt-tool' || arg.startsWith('--permission-prompt-tool='));
    assert.equal(occurrences.length, 1, '应尊重用户自定义的 --permission-prompt-tool，不重复追加');
    const idx = args.indexOf('--permission-prompt-tool');
    assert.equal(args[idx + 1], 'mcp__custom__ask');
});
