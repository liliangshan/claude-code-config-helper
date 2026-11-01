/** @file HTTP bridge injection, transport authentication and CLI deny-list regression tests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { HttpToolHost } from '../httpHost';
import { createHttpToolRelayHandler } from '../httpBridge';
import { forwardHttpTool } from '../transport';
import { HTTP_BRIDGE, HTTP_CAPABILITY_ENV } from '../bridge';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: { 'chat.includeVscodeMcpJson': false } } });
const vscode = require('vscode');
const { ChatCliConfigService } = require('../../chat/cli/cliConfig') as typeof import('../../chat/cli/cliConfig');
const { CliProcess } = require('../../chat/cli/cliProcess') as typeof import('../../chat/cli/cliProcess');

/** Bind one isolated fixture server. */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** Capability validation rejects browser/foreign requests before issuing any outbound fetch. */
test('HTTP relay requires its capability and forwards exactly once', async () => {
    let calls = 0;
    const host = new HttpToolHost({ fetch: async () => { calls++; return new Response('fixture', { status: 418 }); } });
    const handler = createHttpToolRelayHandler(host, 'fixture-capability');
    const server = http.createServer((req, res) => { void handler(req, res); });
    const port = await listen(server), endpoint = new URL(`http://127.0.0.1:${port}${HTTP_BRIDGE.httpPath}`);
    try {
        const rejected = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ name: 'http_fetch', arguments: { url: 'https://example.com' } }) });
        assert.equal(rejected.status, 403); await rejected.text(); assert.equal(calls, 0);
        const result = await forwardHttpTool(endpoint, 'http_fetch', { url: 'https://example.com' }, 'fixture-capability');
        assert.equal(JSON.parse(String(result.content[0].text)).status, 418); assert.equal(calls, 1);
    } finally { host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

/** HTTP replacement is injected only into trusted workspaces and preserves explicit user deny rules. */
test('HTTP injection disables only WebFetch and preserves custom MCP and deny-list behavior', async () => {
    Object.assign(vscode.workspace, { isTrusted: true });
    const { normal } = await new ChatCliConfigService().getRoutedConfigsWithRelayEnv(21009);
    assert.ok(normal.mcpServers?.llsccaiHttp);
    assert.equal(normal.mcpServers?.llsccaiHttp.env?.LLS_HTTP_TOOL_RELAY_PORT, '21009');
    assert.ok(normal.mcpServers?.llsccaiHttp.env?.[HTTP_CAPABILITY_ENV]);
    const proc = new CliProcess() as any;
    proc.currentConfig = normal;
    for (const input of [[], ['--disallowedTools', 'Bash', 'Write'], ['--disallowed-tools=Read,Edit'], ['--disallowedTools', 'WebFetch']]) {
        const args: string[] = proc.buildStreamJsonArgs(input);
        const names = args.filter(value => !value.startsWith('{')).join(' ');
        assert.ok(names.includes('WebFetch'));
        assert.equal(names.includes('WebSearch'), false);
        for (const item of input.filter(value => !value.startsWith('--'))) assert.ok(args.includes(item));
    }
    const scopedRule = proc.buildStreamJsonArgs(['--disallowedTools=Bash(git push:*),Edit', '--disallowed-tools=Read']);
    assert.ok(scopedRule.includes('--disallowedTools=Bash(git push:*),Edit,WebFetch'));
    assert.ok(scopedRule.includes('--disallowed-tools=Read,WebFetch'));
    const custom = proc.buildStreamJsonArgs(['--mcp-config', '{"mcpServers":{}}']);
    assert.equal(custom.includes('WebFetch'), false, 'Do not disable the original when replacement injection is overridden');
    Object.assign(vscode.workspace, { isTrusted: false });
    stub.values.claudeCodeConfigHelper['chat.mcpServers'] = { llsccaiHttp: { type: 'stdio', command: 'foreign-http-server' } };
    try {
        const config = new ChatCliConfigService().getConfig(); assert.equal(config.mcpServers?.llsccaiHttp, undefined);
        proc.currentConfig = config; assert.equal(proc.buildStreamJsonArgs([]).includes('WebFetch'), false);
    } finally { Object.assign(vscode.workspace, { isTrusted: true }); proc.dispose(); }
    stub.values.claudeCodeConfigHelper = { 'chat.includeVscodeMcpJson': false };
});

/** A genuine MCP subprocess lists the schema without loading VS Code, even when the relay is unavailable. */
test('HTTP MCP entry lists fetch schema and reports unavailable relay without disappearing', { timeout: 10000 }, async () => {
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../httpMcpServer'))}).startHttpMcpServer()`], { env: { ...process.env, LLS_HTTP_TOOL_RELAY_PORT: '' }, stdio: 'pipe' });
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
    const exit = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
    child.stdin.end([
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'http_fetch', arguments: { url: 'https://example.com' } } }
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    await exit;
    const replies = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(child.exitCode, 0, errors);
    assert.equal(replies.find(item => item.id === 2).result.tools[0].name, 'http_fetch');
    assert.equal(replies.find(item => item.id === 2).result.tools[0].annotations.readOnlyHint, false);
    assert.equal(replies.find(item => item.id === 3).result.isError, true);
});

/** Independent bridges use a session capability URL and cannot send HTTP requests through another tool endpoint. */
test('independent HTTP MCP forwards through its own relay and rejects the generic tools endpoint', { timeout: 10000 }, async () => {
    const { EditorRelay } = require('../../editorChat/relay') as typeof import('../../editorChat/relay');
    const { EditorContinuation } = require('../../editorChat/continuation') as typeof import('../../editorChat/continuation');
    const { LlsTaskService } = require('../../llsTask/service') as typeof import('../../llsTask/service');
    const manager = {} as any, service = new LlsTaskService(manager), host = new HttpToolHost({ fetch: async () => new Response('editor-owned') });
    const relay = new EditorRelay(manager, service, new EditorContinuation(service), () => {});
    relay.toolHandler = (bridge, name, args, _id, signal) => { assert.equal(bridge, 'llsccaiHttp'); return host.execute(name, args, signal); };
    await relay.start(); relay.configure({ normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' }); relay.active = true;
    try {
        const result = await forwardHttpTool(new URL(relay.url + '/tools/http'), 'http_fetch', { url: 'https://example.com' }, undefined, 'llsccaiHttp');
        assert.equal(JSON.parse(String(result.content[0].text)).body, 'editor-owned');
        await assert.rejects(forwardHttpTool(new URL(relay.url + '/tools'), 'http_fetch', { url: 'https://example.com' }, undefined, 'llsccaiHttp'), /HTTP_RELAY_REJECTED/);
        const previous = relay.url;
        relay.configure({ normalModel: 'p/m', taskFlowModel: '', compactionModel: '', reasoningEffort: 'auto', permissionMode: 'acceptEdits', subagentsEnabled: false, autoCompactEnabled: false, codePreviewEnabled: false, cacheTtl: 'default' });
        await assert.rejects(forwardHttpTool(new URL(previous + '/tools/http'), 'http_fetch', { url: 'https://example.com' }, undefined, 'llsccaiHttp'), /HTTP_RELAY_REJECTED/);
    } finally { relay.dispose(); host.dispose(); service.dispose(); }
});
