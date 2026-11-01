/** @file Opt-in real CLI acceptance for HTTP MCP discovery, native WebFetch exclusion and a complete local request. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { HttpToolHost } from '../httpHost';
import { createHttpToolRelayHandler } from '../httpBridge';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { CliProcess } = require('../../chat/cli/cliProcess') as typeof import('../../chat/cli/cliProcess');

/** Bind a disposable loopback HTTP server. */
async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as import('node:net').AddressInfo).port;
}

/** Complete real CLI JSON, filtered-HTML and redirect tool turns without any third-party model request. */
for (const format of ['json', 'html', 'redirect'] as const) test(`real CLI exposes HTTP MCP, excludes WebFetch and receives ${format} results`, { skip: !process.env.CCAI_NATIVE_TEST_CLI, timeout: 40000 }, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ccai-http-cli-'));
    let apiHits = 0, modelHits = 0, verifiedTools = false, verifiedResult = false;
    const destination = http.createServer((req, res) => {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            apiHits++; assert.equal(req.headers['x-fixture'], 'owned');
            if (format === 'redirect' && req.url === '/final') { assert.equal(req.method, 'GET'); assert.equal(body, ''); }
            else { assert.equal(req.method, 'POST'); assert.equal(body, '{"hello":"world"}'); }
            if (format === 'redirect' && req.url === '/api') { res.writeHead(302, { location: '/final' }); res.end(); return; }
            if (format === 'html' || format === 'redirect') {
                res.writeHead(422, { 'content-type': 'text/html' });
                res.end('<html><head><title>Fixture</title></head><body><p>HTTP_RESULT_OK</p><script>SCRIPT_MUST_NOT_REACH_MODEL</script></body></html>');
            } else { res.writeHead(422, { 'content-type': 'application/json' }); res.end('{"fixture":"HTTP_RESULT_OK"}'); }
        });
    });
    const target = `http://127.0.0.1:${await listen(destination)}/api`;
    const host = new HttpToolHost(), handler = createHttpToolRelayHandler(host, 'local-cli-capability');
    const bridge = http.createServer((req, res) => { void handler(req, res); });
    const port = await listen(bridge);
    const model = http.createServer((req, res) => {
        let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
            const body = JSON.parse(raw); modelHits++;
            const tools = body.tools?.map((tool: any) => tool.name) ?? [];
            if (modelHits === 1) {
                assert.ok(tools.includes('mcp__llsccaiHttp__http_fetch'), JSON.stringify(tools));
                assert.equal(tools.includes('WebFetch'), false); verifiedTools = true;
            } else {
                const messages = JSON.stringify(body.messages);
                verifiedResult = messages.includes('HTTP_RESULT_OK'); assert.equal(verifiedResult, true);
                if (format === 'redirect') { assert.ok(messages.includes('redirectCount')); assert.ok(messages.includes('/final')); }
                if (format === 'html' || format === 'redirect') {
                    assert.equal(messages.includes('SCRIPT_MUST_NOT_REACH_MODEL'), false);
                    assert.equal(messages.includes('<p>HTTP_RESULT_OK</p>'), false);
                    assert.ok(messages.includes('html-text'));
                }
            }
            const block = modelHits === 1 ? { type: 'tool_use', id: 'http_call', name: 'mcp__llsccaiHttp__http_fetch', input: { url: target, options: { method: 'POST', headers: { 'x-fixture': 'owned', 'content-type': 'application/json' }, body: '{"hello":"world"}' } } }
                : { type: 'text', text: 'HTTP_CLI_OK' };
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
            send('message_start', { message: { id: `m_${modelHits}`, type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
            send('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
            send('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
            send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: modelHits === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }); send('message_stop', {}); res.end();
        });
    });
    const modelPort = await listen(model), processWrapper = new CliProcess() as any;
    processWrapper.currentConfig = { model: 'm', permissionMode: 'acceptEdits', strictMcpConfig: true, mcpServers: { llsccaiHttp: { type: 'stdio', command: process.execPath, args: ['-e', `require(${JSON.stringify(require.resolve('../httpMcpServer'))}).startHttpMcpServer()`], env: { LLS_HTTP_TOOL_RELAY_PORT: String(port), LLS_HTTP_TOOL_CAPABILITY: 'local-cli-capability' } } } };
    const args = processWrapper.buildStreamJsonArgs(['--allowedTools', 'mcp__llsccaiHttp__http_fetch', '--setting-sources', '']);
    const child = spawn(process.env.CCAI_NATIVE_TEST_CLI!, args, { cwd, stdio: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: cwd, ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`, ANTHROPIC_API_KEY: 'local-only', ANTHROPIC_AUTH_TOKEN: 'local-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTO_COMPACT: '1' } });
    let output = '', errorOutput = '', result = false;
    child.stderr.on('data', chunk => errorOutput += chunk);
    child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('"type":"result"')) { result = true; child.stdin.end(); }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
        const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use the HTTP tool to run the single authorized local API test.' } }) + '\n');
        await exited;
        assert.equal(result, true, errorOutput); assert.equal(verifiedTools, true); assert.equal(verifiedResult, true); assert.equal(apiHits, format === 'redirect' ? 2 : 1); assert.ok(output.includes('HTTP_CLI_OK'));
    } finally {
        clearTimeout(timer); child.kill('SIGKILL'); host.dispose(); processWrapper.dispose();
        for (const server of [model, bridge, destination]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        await fs.rm(cwd, { recursive: true, force: true });
    }
});
