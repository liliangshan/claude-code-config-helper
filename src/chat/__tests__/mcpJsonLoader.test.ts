/**
 * @file mcpJsonLoader 单元测试。
 *
 * 覆盖以下能力：
 * 1. 同时识别顶层 `servers`（VS Code 风格）与 `mcpServers`（Claude CLI 风格）；
 * 2. `${workspaceFolder}` 与 `${env:NAME}` 变量替换；
 * 3. 未识别 `${...}` 占位符原样保留（避免误伤 CLI 占位符）；
 * 4. JSONC 行内注释 / 块注释 / BOM 容忍解析；
 * 5. `mergeMcpServers` 高优先级覆盖低优先级；
 * 6. 文件不存在 / 内容为空 / JSON 非法时不抛错。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// mcpJsonLoader 顶层 `import * as vscode from 'vscode'`，必须先装好 stub 再 require。
import { installVscodeStub } from './testUtils/vscodeStub';
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcpJsonLoaderModule = require('../cli/mcpJsonLoader') as typeof import('../cli/mcpJsonLoader');
const {
    loadMcpJsonFile,
    mergeMcpServers,
    resolveUserMcpJsonPath,
    resolveWorkspaceMcpJsonPath
} = mcpJsonLoaderModule;

/**
 * 在系统临时目录里创建一个用例隔离子目录。
 *
 * @param prefix 目录名前缀。
 * @returns 该子目录绝对路径。
 */
function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * 把内容写入指定路径，自动创建父目录。
 *
 * @param filePath 目标文件绝对路径。
 * @param content  文件内容文本。
 */
function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

test('resolveWorkspaceMcpJsonPath 在无工作区时返回 undefined', () => {
    assert.equal(resolveWorkspaceMcpJsonPath(undefined), undefined);
    assert.equal(resolveWorkspaceMcpJsonPath(''), undefined);
});

test('resolveWorkspaceMcpJsonPath 返回工作区 .vscode/mcp.json 路径', () => {
    const ws = '/some/workspace';
    const result = resolveWorkspaceMcpJsonPath(ws);
    assert.equal(result, path.join(ws, '.vscode', 'mcp.json'));
});

test('resolveUserMcpJsonPath 包含 Code/User/mcp.json 段', () => {
    const userPath = resolveUserMcpJsonPath();
    assert.ok(userPath.endsWith(path.join('Code', 'User', 'mcp.json')), `unexpected user mcp path: ${userPath}`);
});

test('loadMcpJsonFile：文件不存在时返回空 servers 且 loaded=false', () => {
    const result = loadMcpJsonFile('/non/existent/mcp.json', 'workspace', undefined);
    assert.equal(result.loaded, false);
    assert.deepEqual(result.servers, {});
    assert.equal(result.error, undefined);
});

test('loadMcpJsonFile：兼容顶层 servers 字段（VS Code 风格）', () => {
    const dir = makeTempDir('mcp-vscode');
    const file = path.join(dir, 'mcp.json');
    writeFile(file, JSON.stringify({
        servers: {
            'chrome-devtools': {
                type: 'stdio',
                command: 'npx',
                args: ['chrome-devtools-mcp@latest']
            }
        }
    }));
    const result = loadMcpJsonFile(file, 'user', undefined);
    assert.equal(result.loaded, true);
    assert.ok(result.servers['chrome-devtools']);
    assert.equal(result.servers['chrome-devtools'].command, 'npx');
    assert.deepEqual(result.servers['chrome-devtools'].args, ['chrome-devtools-mcp@latest']);
});

test('loadMcpJsonFile：兼容顶层 mcpServers 字段（Claude CLI 风格）', () => {
    const dir = makeTempDir('mcp-cli-style');
    const file = path.join(dir, 'mcp.json');
    writeFile(file, JSON.stringify({
        mcpServers: {
            foo: { type: 'stdio', command: 'foo-bin', args: ['-v'] }
        }
    }));
    const result = loadMcpJsonFile(file, 'workspace', undefined);
    assert.equal(result.loaded, true);
    assert.equal(result.servers.foo.command, 'foo-bin');
});

test('loadMcpJsonFile：${workspaceFolder} 与 ${env:NAME} 变量替换', () => {
    const dir = makeTempDir('mcp-vars');
    const file = path.join(dir, 'mcp.json');
    process.env.__MCP_TEST_VAR__ = 'secret-value';
    writeFile(file, JSON.stringify({
        servers: {
            demo: {
                command: '${workspaceFolder}/node_modules/.bin/demo',
                args: ['--cwd', '${workspaceFolder}'],
                env: { TOKEN: '${env:__MCP_TEST_VAR__}', KEEP: '${env:__NOT_DEFINED_XYZ__}' }
            }
        }
    }));
    const result = loadMcpJsonFile(file, 'workspace', '/my/ws');
    assert.equal(result.loaded, true);
    const demo = result.servers.demo;
    assert.equal(demo.command, '/my/ws/node_modules/.bin/demo');
    assert.deepEqual(demo.args, ['--cwd', '/my/ws']);
    assert.equal(demo.env?.TOKEN, 'secret-value');
    assert.equal(demo.env?.KEEP, '');
    delete process.env.__MCP_TEST_VAR__;
});

test('loadMcpJsonFile：未识别 ${...} 占位符原样保留', () => {
    const dir = makeTempDir('mcp-unknown-var');
    const file = path.join(dir, 'mcp.json');
    writeFile(file, JSON.stringify({
        servers: {
            x: { command: 'echo', args: ['${input:apiKey}', '${userHome}'] }
        }
    }));
    const result = loadMcpJsonFile(file, 'user', undefined);
    assert.deepEqual(result.servers.x.args, ['${input:apiKey}', '${userHome}']);
});

test('loadMcpJsonFile：JSONC 行内注释 / 块注释可被剔除', () => {
    const dir = makeTempDir('mcp-jsonc');
    const file = path.join(dir, 'mcp.json');
    writeFile(file, [
        '{',
        '  // 这是一个行注释',
        '  "servers": {',
        '    /* 块注释 */',
        '    "a": { "command": "a-cmd" } // 末尾注释',
        '  }',
        '}'
    ].join('\n'));
    const result = loadMcpJsonFile(file, 'workspace', undefined);
    assert.equal(result.loaded, true);
    assert.equal(result.servers.a.command, 'a-cmd');
});

test('loadMcpJsonFile：BOM + 空文件 + 非法 JSON 均不抛', () => {
    const dir = makeTempDir('mcp-bad');
    const empty = path.join(dir, 'empty.json');
    writeFile(empty, '');
    const emptyRes = loadMcpJsonFile(empty, 'user', undefined);
    assert.equal(emptyRes.loaded, true);
    assert.deepEqual(emptyRes.servers, {});

    const bom = path.join(dir, 'bom.json');
    writeFile(bom, '\uFEFF{"servers":{"b":{"command":"b-cmd"}}}');
    const bomRes = loadMcpJsonFile(bom, 'user', undefined);
    assert.equal(bomRes.loaded, true);
    assert.equal(bomRes.servers.b.command, 'b-cmd');

    const bad = path.join(dir, 'bad.json');
    writeFile(bad, '{ not valid json');
    const badRes = loadMcpJsonFile(bad, 'user', undefined);
    assert.equal(badRes.loaded, false);
    assert.ok(badRes.error);
});

test('mergeMcpServers：前者优先覆盖后者同名 key', () => {
    const high = { a: { command: 'high-a' }, c: { command: 'high-c' } };
    const mid = { a: { command: 'mid-a' }, b: { command: 'mid-b' } };
    const low = { a: { command: 'low-a' }, d: { command: 'low-d' } };
    const merged = mergeMcpServers(high, mid, low);
    assert.equal(merged.a.command, 'high-a');
    assert.equal(merged.b.command, 'mid-b');
    assert.equal(merged.c.command, 'high-c');
    assert.equal(merged.d.command, 'low-d');
});

test('mergeMcpServers：undefined / 空对象 / 非对象都安全', () => {
    const merged = mergeMcpServers(undefined, {}, { a: { command: 'a' } });
    assert.equal(Object.keys(merged).length, 1);
    assert.equal(merged.a.command, 'a');
});
