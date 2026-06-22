/**
 * @file 自動開檔與 VS Code get_errors MCP 工具測試。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';

import { installVscodeStub } from './testUtils/vscodeStub';

installVscodeStub({
    values: {
        claudeCodeConfigHelper: {
            'editor.autoOpenReadWriteFiles': true,
            'vscodeTools.getErrors.enabled': true
        }
    },
    workspaceFolderFsPath: '/workspace'
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractFilePathFromToolInput, isFileOpenToolName } = require('../../editorAutoOpen') as typeof import('../../editorAutoOpen');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildGetErrorsResult, emptyErrorResult } = require('../../vscodeTools/diagnostics') as typeof import('../../vscodeTools/diagnostics');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VscodeMcpServer } = require('../../vscodeTools/vscodeMcpServer') as typeof import('../../vscodeTools/vscodeMcpServer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VSCODE_TOOL_SCHEMAS } = require('../../vscodeTools/tools') as typeof import('../../vscodeTools/tools');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { interceptAnthropicResponse } = require('../../llsTask/interceptor') as typeof import('../../llsTask/interceptor');

type RawDiag = import('../../vscodeTools/diagnostics').RawDiag;
type VscodeToolName = import('../../vscodeTools/tools').VscodeToolName;
type VscodeToolResult = import('../../vscodeTools/diagnosticsHost').VscodeToolResult;

/** 建立不會觸發任務流續推副作用的攔截器依賴。 */
function buildInterceptorDeps(onFileTool?: (toolName: string, input: unknown) => void): Parameters<typeof interceptAnthropicResponse>[2] {
    return {
        service: {
            hasActiveWorkflow: () => false,
            isWorkflowCompleted: () => false,
            clearWorkflowUpdateMissing() {},
            markWorkflowUpdateMissing() {}
        } as Parameters<typeof interceptAnthropicResponse>[2]['service'],
        autoContinueScheduler: {
            schedule() {},
            scheduleAfterWorkflowTool() {},
            resetMissingToolCounter() {},
            armIdleWatchdog() {},
            notifyRequestStarted() {},
            cancel() {}
        } as unknown as Parameters<typeof interceptAnthropicResponse>[2]['autoContinueScheduler'],
        onFileTool
    };
}

/** 建立非流式 Anthropic tool_use 回應。 */
function buildJsonToolUse(name: string, input: Record<string, unknown>): string {
    return JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name, input }]
    });
}

/** 建立 SSE event 文字。 */
function sse(event: string, data: Record<string, unknown> | string): string {
    return `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

/** 驅動 VscodeMcpServer 處理 NDJSON JSON-RPC 訊息。 */
async function driveVscodeServer(lines: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new VscodeMcpServer({
        stdin,
        stdout,
        host: {
            async execute(name: VscodeToolName, args: Record<string, unknown> = {}): Promise<VscodeToolResult> {
                return { content: [{ type: 'text', text: JSON.stringify({ name, args }) }] };
            }
        }
    });
    const responses: Array<Record<string, unknown>> = [];
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) responses.push(JSON.parse(line) as Record<string, unknown>);
            idx = buffer.indexOf('\n');
        }
    });
    server.start();
    for (const line of lines) stdin.write(`${JSON.stringify(line)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.dispose();
    return responses;
}

test('editorAutoOpen: 識別檔案工具並萃取正確路徑欄位', () => {
    assert.equal(isFileOpenToolName('Read'), true);
    assert.equal(isFileOpenToolName('Write'), true);
    assert.equal(isFileOpenToolName('Edit'), true);
    assert.equal(isFileOpenToolName('MultiEdit'), true);
    assert.equal(isFileOpenToolName('NotebookEdit'), true);
    assert.equal(isFileOpenToolName('Bash'), false);
    assert.equal(extractFilePathFromToolInput('Read', { file_path: ' src/a.ts ' }), 'src/a.ts');
    assert.equal(extractFilePathFromToolInput('NotebookEdit', { notebook_path: ' nb.ipynb ' }), 'nb.ipynb');
    assert.equal(extractFilePathFromToolInput('Bash', { file_path: 'src/a.ts' }), undefined);
    assert.equal(extractFilePathFromToolInput('Read', { file_path: '   ' }), undefined);
});

test('interceptor: JSON 檔案工具呼叫 onFileTool 且原樣保留回應', () => {
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const body = buildJsonToolUse('Read', { file_path: '/workspace/src/a.ts' });
    const result = interceptAnthropicResponse(body, 'application/json', buildInterceptorDeps((toolName, input) => {
        calls.push({ toolName, input });
    }));

    assert.equal(result.body, body);
    assert.equal(result.sawToolUse, true);
    assert.equal(result.handledWorkflowTool, false);
    assert.equal(result.sawNonLocalTool, true);
    assert.deepEqual(calls, [{ toolName: 'Read', input: { file_path: '/workspace/src/a.ts' } }]);
});

test('interceptor: Bash 工具不觸發檔案開啟回呼', () => {
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const body = buildJsonToolUse('Bash', { command: 'pwd' });
    const result = interceptAnthropicResponse(body, 'application/json', buildInterceptorDeps((toolName, input) => {
        calls.push({ toolName, input });
    }));

    assert.equal(result.body, body);
    assert.equal(result.sawNonLocalTool, true);
    assert.deepEqual(calls, []);
});

test('interceptor: SSE 檔案工具累積 input 後呼叫 onFileTool 且不改寫回應', () => {
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const body = [
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path"' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"src/a.ts"}' } }),
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    ].join('');
    const result = interceptAnthropicResponse(body, 'text/event-stream', buildInterceptorDeps((toolName, input) => {
        calls.push({ toolName, input });
    }));

    assert.equal(result.body, body);
    assert.equal(result.sawToolUse, true);
    assert.equal(result.handledWorkflowTool, false);
    assert.equal(result.sawNonLocalTool, true);
    assert.deepEqual(calls, [{ toolName: 'Edit', input: { file_path: 'src/a.ts' } }]);
});

test('diagnostics: 空集合回傳固定摘要', () => {
    assert.deepEqual(emptyErrorResult(), {
        summary: 'No VS Code diagnostics found.',
        truncated: false,
        total: 0,
        errors: 0,
        warnings: 0,
        diagnostics: []
    });
    assert.deepEqual(buildGetErrorsResult([]), emptyErrorResult());
});

test('diagnostics: 依嚴重性、路徑與位置排序並建立 summary', () => {
    const raw: RawDiag[] = [
        { filePath: '/workspace/b.ts', severity: 'warning', message: 'warn', line: 3, character: 1 },
        { filePath: '/workspace/a.ts', severity: 'error', message: 'err late', line: 2, character: 1 },
        { filePath: '/workspace/a.ts', severity: 'error', message: 'err early', line: 1, character: 2 },
        { filePath: '/workspace/c.ts', severity: 'information', message: 'info', line: 1, character: 1 }
    ];
    const result = buildGetErrorsResult(raw, { workspaceRoot: '/workspace' });

    assert.equal(result.summary, 'Found 4 VS Code diagnostics (2 errors, 1 warning).');
    assert.equal(result.total, 4);
    assert.equal(result.errors, 2);
    assert.equal(result.warnings, 1);
    assert.deepEqual(result.diagnostics.map((diag) => diag.message), ['err early', 'err late', 'warn', 'info']);
});

test('diagnostics: 支援工作區相對路徑過濾並截斷 10 條', () => {
    const raw: RawDiag[] = Array.from({ length: 12 }, (_, index) => ({
        filePath: `/workspace/src/a.ts`,
        severity: index % 2 === 0 ? 'error' : 'warning',
        message: `diag ${index}`,
        line: index + 1,
        character: 1
    }));
    raw.push({ filePath: '/workspace/src/b.ts', severity: 'error', message: 'other', line: 1, character: 1 });
    const result = buildGetErrorsResult(raw, { filePaths: ['src/a.ts'], workspaceRoot: '/workspace' });

    assert.equal(result.total, 12);
    assert.equal(result.diagnostics.length, 10);
    assert.equal(result.truncated, true);
    assert.equal(result.summary, 'Found 12 VS Code diagnostics (6 errors, 6 warnings). Showing first 10.');
    assert.equal(result.diagnostics.some((diag) => diag.filePath.endsWith('b.ts')), false);
});

test('vscodeMcpServer: tools/list 暴露 get_errors schema', async () => {
    const responses = await driveVscodeServer([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);

    assert.equal(responses.length, 1);
    assert.deepEqual((responses[0].result as { tools: unknown[] }).tools, VSCODE_TOOL_SCHEMAS);
});

test('vscodeMcpServer: tools/call 轉發 get_errors 參數', async () => {
    const responses = await driveVscodeServer([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_errors', arguments: { filePaths: ['src/a.ts'] } } }
    ]);

    assert.equal(responses.length, 1);
    const result = responses[0].result as VscodeToolResult;
    assert.equal(result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(result.content[0].text), { name: 'get_errors', args: { filePaths: ['src/a.ts'] } });
});

test('vscodeMcpServer: 未知工具回傳 isError 結果', async () => {
    const responses = await driveVscodeServer([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unknown', arguments: {} } }
    ]);

    assert.equal(responses.length, 1);
    const result = responses[0].result as VscodeToolResult;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
});
