/** @file Left-side MCP discovery inherits workspace settings without overriding explicit strict mode. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import type { ChatCliConfig } from '../../chat/cli/types';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const vscode = require('vscode');
const { LeftChatSession } = require('../leftSession') as typeof import('../leftSession');
const { CliProcess } = require('../../chat/cli/cliProcess') as typeof import('../../chat/cli/cliProcess');
const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');
const loaders = require('../../chat/cli/mcpJsonLoader') as typeof import('../../chat/cli/mcpJsonLoader');

/** Use actual left runtime and argument generation, but do not execute configured MCP commands or contact services. */
test('left CLI keeps native project MCP discovery and private bridges while respecting strict mode on restart', { timeout: 15000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'left-mcp-'));
    const cwd = await fs.realpath(directory); stub.workspaceFolderFsPath = cwd;
    Object.assign(vscode.workspace, { isTrusted: true });
    const executable = path.join(cwd, 'cli');
    await fs.copyFile(path.resolve(__dirname, '../../../fixtures/editor-chat-cli.cjs'), executable); await fs.chmod(executable, 0o700);
    await fs.writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { projectOnly: { type: 'stdio', command: 'project-server' } } }));
    await fs.mkdir(path.join(cwd, '.vscode'));
    await fs.writeFile(path.join(cwd, '.vscode', 'mcp.json'), JSON.stringify({ servers: { vscodeOnly: { type: 'stdio', command: '${workspaceFolder}/local-mcp' } } }));
    stub.values.claudeCodeConfigHelper = { 'chat.cliPath': executable, 'chat.includeVscodeMcpJson': true,
        'chat.cliEnv': { CLAUDE_CONFIG_DIR: path.join(cwd, 'config') }, 'chat.mcpServers': { extensionOnly: { type: 'stdio', command: 'extension-server' } } };
    const configuredRoots: Array<string | undefined> = [];
    t.mock.method(loaders, 'loadAllVscodeMcpJsons', (root?: string) => {
        configuredRoots.push(root);
        return root ? [loaders.loadMcpJsonFile(path.join(root, '.vscode', 'mcp.json'), 'workspace', root)] : [];
    });
    const launches: Array<{ config: ChatCliConfig; args: string[] }> = [];
    const start = CliProcess.prototype.start;
    t.mock.method(CliProcess.prototype, 'start', async function (this: InstanceType<typeof CliProcess>, config: ChatCliConfig) {
        await start.call(this, config);
        launches.push({ config, args: (this as any).buildStreamJsonArgs(config.cliArgs, config.resumeSessionId) });
    });
    const values = new Map<string, unknown>();
    const context = { workspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } } as any;
    const manager = { getCurrentModel: () => ({ providerId: 'p', modelId: 'm' }), getChatReasoningEffort: () => 'auto',
        getChatSubagentsEnabled: () => false, getChatCacheTtl: () => 'default', getProvider: () => ({ enabled: true }),
        getProviderModel: () => ({ modelId: 'm', contextLength: 200000 }), isModelEnabled: () => true,
        getGlobalSystemPrompt: () => '', getWorkspaceSystemPrompt: () => '', getResolvedUiLanguage: () => 'en', listProviders: () => [] } as any;
    const left = new LeftChatSession(context, manager, async () => {});
    const nativeConfig = await fs.readFile(path.join(cwd, '.mcp.json'), 'utf8');
    try {
        await left.openFirst();
        const first = launches[0]; assert.ok(first);
        assert.equal(first.config.cwd, cwd);
        assert.equal(first.args.includes('--strict-mcp-config'), false, 'Default discovery must not suppress workspace .mcp.json');
        assert.equal(first.args.includes('--bare'), false);
        assert.ok(first.config.mcpServers?.extensionOnly);
        assert.equal(first.config.mcpServers?.vscodeOnly.command, path.join(cwd, 'local-mcp'));
        for (const name of ['llsccaiBrowser', 'llsccaiVscode', 'llsccaiWakeup']) {
            const bridge: import('../../chat/cli/types').McpServerConfig | undefined = first.config.mcpServers?.[name]; assert.ok(bridge);
            assert.equal(bridge.env?.LLS_EDITOR_BRIDGE, name);
            assert.ok(bridge.env?.LLS_EDITOR_TOOL_URL?.endsWith('/tools'));
            assert.equal(bridge.env?.LLS_BROWSER_TOOL_RELAY_PORT, undefined, 'Built-in bridges remain session-private');
        }
        stub.values.claudeCodeConfigHelper['chat.strictMcpConfig'] = true;
        await left.receive({ type: 'cli/restart' });
        assert.equal(launches.at(-1)!.args.includes('--strict-mcp-config'), true, 'An explicitly enabled strict policy must remain enabled');
        stub.values.claudeCodeConfigHelper['chat.strictMcpConfig'] = false;
        await left.receive({ type: 'cli/restart' });
        assert.equal(launches.at(-1)!.args.includes('--strict-mcp-config'), false);
        assert.ok(configuredRoots.every(root => root === cwd), 'MCP paths always resolve against the conversation workspace');
        assert.equal(await fs.readFile(path.join(cwd, '.mcp.json'), 'utf8'), nativeConfig, 'Native MCP configuration is never rewritten or copied');
        const id = left.activeId!;
        await left.shutdown();
        const metadata = await fs.readFile(path.join(cwd, '.LLSOAI', 'editor-sessions', id, 'meta.json'), 'utf8');
        assert.equal(metadata.includes('project-server'), false, 'MCP commands and credentials are not persisted in conversation metadata');
    } finally { await left.shutdown(); await fs.rm(cwd, { recursive: true, force: true }); }
});

/** A restored conversation cannot adopt another root's MCP servers or folder-scoped strict policy. */
test('CLI configuration resolves independent conversation MCP files and settings against its fixed workspace root', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-mcp-'));
    const first = path.join(directory, 'first'); const second = path.join(directory, 'second');
    await fs.mkdir(path.join(first, '.vscode'), { recursive: true }); await fs.mkdir(path.join(second, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(first, '.vscode', 'mcp.json'), JSON.stringify({ servers: { firstOnly: { command: 'first-mcp' } } }));
    await fs.writeFile(path.join(second, '.vscode', 'mcp.json'), JSON.stringify({ servers: { secondOnly: { command: '${workspaceFolder}/second-mcp' } } }));
    stub.workspaceFolderFsPath = first;
    stub.values.claudeCodeConfigHelper = { 'chat.includeVscodeMcpJson': true };
    const getConfiguration = vscode.workspace.getConfiguration;
    const resources: Array<string | undefined> = [];
    t.mock.method(vscode.workspace, 'getConfiguration', (namespace: string, resource?: { fsPath: string }) => {
        resources.push(resource?.fsPath);
        const config = getConfiguration(namespace);
        return { ...config, get: (key: string, fallback?: unknown) => key === 'chat.strictMcpConfig' ? resource?.fsPath === second : config.get(key, fallback) };
    });
    t.mock.method(loaders, 'loadAllVscodeMcpJsons', (root?: string) => root ? [loaders.loadMcpJsonFile(path.join(root, '.vscode', 'mcp.json'), 'workspace', root)] : []);
    try {
        const service = new ChatCliConfigService();
        const scoped = service.getConfig(second);
        assert.equal(scoped.cwd, second); assert.equal(scoped.strictMcpConfig, true);
        assert.equal(scoped.mcpServers?.secondOnly.command, path.join(second, 'second-mcp'));
        assert.equal(scoped.mcpServers?.firstOnly, undefined);
        assert.ok(resources.includes(second));
        const main = service.getConfig();
        assert.equal(main.cwd, first); assert.equal(main.strictMcpConfig, undefined);
        assert.ok(main.mcpServers?.firstOnly); assert.equal(main.mcpServers?.secondOnly, undefined);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
