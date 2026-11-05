/** @file Opt-in real CLI resume regression: old persisted image schemas must reach the model with current GIF fields. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
import { refreshImageRequestSchemas } from '../requestSchemas';

/** Keep the native conversation on disk between launches; never call a paid image/model endpoint or edit a real history. */
for (const deferred of [false, true]) test(`real CLI resume refreshes old image schemas and executes GIF fields (deferred=${deferred})`, { skip: !process.env.CCAI_NATIVE_TEST_CLI, timeout: 40000 }, async t => {
    installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
    const entry = await import('../entry');
    const { createRelayRouter } = await import('../../relay/router');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-schema-resume-'));
    const sessionId = randomUUID(), capability = randomUUID(); let gif = false, repair = false;
    const inbound: any[] = [], upstream: any[] = [], toolCalls: any[] = [];
    t.mock.method(entry, 'refreshImageToolsForRequest', async (body: unknown) => { inbound.push(body); return repair ? refreshImageRequestSchemas(body, gif) : body; });
    const adapter = { apiType: 'anthropic' as const, handle: async (ctx: any) => {
        upstream.push(ctx.parsedBody); const id = randomUUID();
        ctx.res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (type: string, fields: object) => ctx.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message: { id, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
        const hasImageTool = ctx.parsedBody.tools?.some((tool: any) => tool.name === 'mcp__llsccaiImage__openapi_generate_image');
        const search = deferred && !hasImageTool;
        const alreadyCalled = JSON.stringify(ctx.parsedBody.messages).includes('GIF_SUBMISSION_FIXTURE_ACCEPTED');
        const call = !search && repair && gif && !alreadyCalled;
        const input = search ? { query: 'select:mcp__llsccaiImage__openapi_generate_image', max_results: 1 }
            : { prompt: 'local fixture only', size: '512x512', output_format: 'gif', frame_count: 9, frame_duration_ms: 200 };
        const toolUse = search || call;
        send('content_block_start', { index: 0, content_block: toolUse ? { type: 'tool_use', id: search ? 'load-gif-tool-fixture' : 'gif-call-fixture', name: search ? 'ToolSearch' : 'mcp__llsccaiImage__openapi_generate_image', input: {} } : { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: toolUse ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'GIF_SCHEMA_FIXTURE_OK' } });
        send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 8 } }); send('message_stop', {}); ctx.res.end();
    } };
    const router = createRelayRouter({ configManager: { getProviderWithSecret: async () => ({ id: 'p', apiType: 'anthropic', enabled: true, baseUrl: 'http://127.0.0.1', models: [] }) } as any, adapters: [adapter] });
    const server = http.createServer((req, res) => {
        if (req.url === `/llsccai/image-tool/${capability}`) {
            let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
                toolCalls.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ content: [{ type: 'text', text: 'GIF_SUBMISSION_FIXTURE_ACCEPTED' }] }));
            }); return;
        }
        void router(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    /** Launch the real CLI with the same native identity, changing only the MCP's non-sensitive GIF capability. */
    async function turn(resume: boolean): Promise<void> {
        const mcp = { mcpServers: { llsccaiImage: { type: 'stdio', command: process.execPath, args: ['-e', `require(${JSON.stringify(require.resolve('../imageMcpServer'))}).startImageMcpServer()`], env: { LLS_IMAGE_SUPPORTS_GIF: gif ? '1' : '0', LLS_IMAGE_TOOL_RELAY_PORT: String(port), LLS_IMAGE_TOOL_CAPABILITY: capability } } } };
        const child = spawn(process.env.CCAI_NATIVE_TEST_CLI!, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', 'p/fixture', '--allowedTools', 'mcp__llsccaiImage__openapi_generate_image', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--setting-sources', '', '--system-prompt-snapshot', 'on', resume ? '--resume' : '--session-id', sessionId], {
            cwd, stdio: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(cwd, 'config'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_AUTH_TOKEN: 'local-fixture-only', CLAUDE_CODE_SKIP_AUTH_LOGIN: '1', CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTO_COMPACT: '1', ENABLE_TOOL_SEARCH: deferred ? 'true' : 'false' }
        });
        let output = '', stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('"type":"result"')) child.stdin.end(); });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        try {
            const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
            child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Reply with the fixture marker. Do not call image tools.' } }) + '\n');
            assert.equal(await exited, 0, stderr); assert.ok(output.includes('GIF_SCHEMA_FIXTURE_OK'), stderr);
        } finally { clearTimeout(timer); child.kill('SIGKILL'); }
    }
    /** Select the exact image generation schema from the captured model request. */
    const image = (body: any) => body.tools.find((tool: any) => tool.name === 'mcp__llsccaiImage__openapi_generate_image');
    try {
        await turn(false); assert.ok(image(inbound.at(-1))); assert.equal('output_format' in image(upstream.at(-1)).input_schema.properties, false);
        gif = true; await turn(true);
        assert.equal('output_format' in image(inbound.at(-1)).input_schema.properties, false, 'Native resume reproduces the old schema despite a GIF-enabled MCP process');
        repair = true; await turn(true);
        assert.deepEqual(image(upstream.at(-1)).input_schema.properties.output_format.enum, ['gif']);
        assert.equal(image(upstream.at(-1)).input_schema.properties.frame_count.default, 9);
        assert.match(image(upstream.at(-1)).description, /animated GIF/);
        assert.equal(toolCalls.length, 1, 'The real CLI accepts the new fields when executing the current MCP tool');
        assert.deepEqual(toolCalls[0].arguments, { prompt: 'local fixture only', size: '512x512', output_format: 'gif', frame_count: 9, frame_duration_ms: 200 });
        gif = false; await turn(true);
        assert.equal('output_format' in image(upstream.at(-1)).input_schema.properties, false);
        assert.equal(upstream.at(-1).messages, inbound.at(-1).messages, 'Schema repair preserves all resumed messages');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(cwd, { recursive: true, force: true }); }
});
