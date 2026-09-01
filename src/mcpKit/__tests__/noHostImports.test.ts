/**
 * @file mcpKit 目录的「禁止静态 import 宿主模块」约束测试。
 *
 * 3.2.23 事故：MCP server 侧文件静态 import 了链式 require('vscode') 的宿主模块，
 * 子进程一启动就崩溃，整组工具在模型侧静默消失且无可见报错。
 * mcpKit 下的文件全部会被子进程加载，这里逐文件扫源码守住这条边界。
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/** 允许静态 import 的 Node 内置模块。 */
const ALLOWED_BUILTINS = new Set(['http', 'https', 'fs', 'path', 'os', 'url', 'events', 'buffer', 'crypto', 'child_process', 'net', 'zlib', 'stream', 'util']);

/** mcpKit 源码目录（本测试文件的上一级）。 */
const KIT_DIR = path.resolve(__dirname, '../../../src/mcpKit');

/**
 * 收集目录下所有 .ts 源文件（跳过 __tests__）。
 *
 * @param dir 起始目录。
 * @returns 绝对路径列表。
 */
function collectSources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__') continue;
            found.push(...collectSources(full));
        } else if (entry.name.endsWith('.ts')) {
            found.push(full);
        }
    }
    return found;
}

/**
 * 判断一个 import 说明符是否被允许出现在静态 import 中。
 *
 * @param spec import 的模块说明符。
 * @returns 允许则为 true。
 */
function isAllowedSpecifier(spec: string): boolean {
    const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
    if (ALLOWED_BUILTINS.has(bare)) return true;
    // 同目录内的相对引用同样只含类型与纯逻辑，允许。
    return spec.startsWith('./');
}

test('mcpKit 源码目录存在且能被扫描到', () => {
    const sources = collectSources(KIT_DIR);
    assert.ok(sources.length >= 4, `应扫描到 mcpKit 源文件：${sources.length}`);
});

test('mcpKit 下不存在指向 vscode 或宿主模块的值 import', () => {
    const offenders: string[] = [];
    for (const file of collectSources(KIT_DIR)) {
        const source = fs.readFileSync(file, 'utf-8');
        // 只匹配值 import：`import type ...` 与 `import { type X }` 不产生运行期 require。
        const pattern = /^\s*import\s+(?!type\s)([\s\S]*?)from\s+['"]([^'"]+)['"]/gm;
        for (const match of source.matchAll(pattern)) {
            const clause = match[1];
            const spec = match[2];
            // `import type * as http from 'http'` 已被上面的 (?!type ) 排除；
            // 这里再排掉整段花括号里全是 type 的写法。
            const onlyTypeBindings = /^\s*\{[^}]*\}\s*$/.test(clause)
                && clause.replace(/[{}]/g, '').split(',').every((part) => part.trim().length === 0 || part.trim().startsWith('type '));
            if (onlyTypeBindings) continue;
            if (!isAllowedSpecifier(spec)) {
                offenders.push(`${path.relative(KIT_DIR, file)} → ${spec}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `mcpKit 只允许 import Node 内置模块与同目录模块：\n${offenders.join('\n')}`);
});

test('mcpKit 下不存在裸写的 vscode 字面量 import', () => {
    const offenders: string[] = [];
    for (const file of collectSources(KIT_DIR)) {
        const source = fs.readFileSync(file, 'utf-8');
        if (/from\s+['"]vscode['"]/.test(source)) offenders.push(path.relative(KIT_DIR, file));
    }
    assert.deepEqual(offenders, [], `mcpKit 文件禁止引用 vscode：${offenders.join(', ')}`);
});
