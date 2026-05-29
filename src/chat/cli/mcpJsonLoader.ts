/**
 * @file 读取 VS Code 风格的 `mcp.json` 配置（工作区 `.vscode/mcp.json` 与用户全局区）。
 *
 * VS Code 1.99+ 引入了标准化的 MCP 配置文件位置：
 * - 工作区级：`<workspaceFolder>/.vscode/mcp.json`
 * - 用户级：
 *   - macOS:   `~/Library/Application Support/Code/User/mcp.json`
 *   - Windows: `%APPDATA%/Code/User/mcp.json`
 *   - Linux:   `~/.config/Code/User/mcp.json`
 *
 * 文件结构示例（与 Claude CLI 的 `.mcp.json` 字段完全兼容，只是顶层 key 不同）：
 * ```json
 * {
 *   "servers": {
 *     "my-server": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["my-mcp"],
 *       "env": { "API_KEY": "${env:MY_API_KEY}" }
 *     }
 *   },
 *   "inputs": []
 * }
 * ```
 *
 * 本模块负责：
 * 1. 安全读取并 JSON 解析（容忍 BOM、注释、空文件）；
 * 2. 把 `servers` 字段映射为我们扩展内部的 `McpServerConfig`；
 * 3. 做最小的变量替换：`${env:VAR}` / `${workspaceFolder}`，其它 `${...}` 原样保留；
 * 4. 提供多源合并（高优先级覆盖低优先级同名 server）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

import { Logger } from '../../logger';
import type { McpServerConfig } from './types';

/**
 * 表示某个 mcp.json 文件加载结果。
 */
export interface McpJsonLoadResult {
    /** 文件绝对路径。 */
    filePath: string;
    /** 该文件来源类型。 */
    source: 'workspace' | 'user';
    /** 成功解析出的 server 字典；解析失败/文件不存在时为空对象。 */
    servers: Record<string, McpServerConfig>;
    /** 是否成功读取并解析（文件不存在视为 false 但不算 error）。 */
    loaded: boolean;
    /** 加载错误信息，文件不存在时为空。 */
    error?: string;
}

/**
 * 计算工作区 `.vscode/mcp.json` 文件路径。
 *
 * @param workspaceFolder 当前工作区根目录绝对路径。为空时返回 `undefined`。
 * @returns 工作区 mcp.json 绝对路径；无工作区时返回 `undefined`。
 */
export function resolveWorkspaceMcpJsonPath(workspaceFolder: string | undefined): string | undefined {
    if (!workspaceFolder) return undefined;
    return path.join(workspaceFolder, '.vscode', 'mcp.json');
}

/**
 * 计算用户级 `mcp.json` 文件路径，按 VS Code 在不同平台的约定。
 *
 * 仅基于平台默认路径推断；如果用户使用了便携模式或自定义 user-data-dir，
 * 该路径可能不准——这是 VS Code 内部状态，扩展无法稳定获取。
 *
 * @returns 用户级 mcp.json 绝对路径。
 */
export function resolveUserMcpJsonPath(): string {
    const home = os.homedir();
    switch (process.platform) {
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
        case 'win32': {
            const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
            return path.join(appData, 'Code', 'User', 'mcp.json');
        }
        default:
            return path.join(home, '.config', 'Code', 'User', 'mcp.json');
    }
}

/**
 * 从给定 mcp.json 文件路径加载并解析 server 配置。
 *
 * - 文件不存在：返回 `{ loaded: false, servers: {} }`（不算错误）；
 * - 文件存在但无法读/解析：返回 `loaded: false, error`，并写一条 warn 日志；
 * - 成功：返回 `loaded: true, servers`。
 *
 * @param filePath mcp.json 文件绝对路径。
 * @param source 来源类型，仅用于结果元信息与日志。
 * @param workspaceFolder 用于 `${workspaceFolder}` 变量替换；无值时占位符原样保留。
 * @returns 加载结果。
 */
export function loadMcpJsonFile(
    filePath: string,
    source: 'workspace' | 'user',
    workspaceFolder: string | undefined
): McpJsonLoadResult {
    if (!fs.existsSync(filePath)) {
        return { filePath, source, servers: {}, loaded: false };
    }
    let raw = '';
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.warn(`读取 mcp.json 失败：${filePath} -> ${message}`);
        return { filePath, source, servers: {}, loaded: false, error: message };
    }
    if (!raw.trim()) {
        return { filePath, source, servers: {}, loaded: true };
    }
    let parsed: unknown;
    try {
        // 兼容 BOM 与 JSONC 行内注释（VS Code 用户经常手写注释）。
        parsed = JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, '')));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.warn(`解析 mcp.json 失败：${filePath} -> ${message}`);
        return { filePath, source, servers: {}, loaded: false, error: message };
    }
    const servers = normalizeServersField(parsed, workspaceFolder);
    return { filePath, source, servers, loaded: true };
}

/**
 * 加载工作区 + 用户区两份 mcp.json 并返回结果列表。
 *
 * @param workspaceFolder 当前工作区根目录绝对路径。
 * @returns 两个加载结果，按调用方需要的优先级（工作区在前、用户区在后）排列。
 */
export function loadAllVscodeMcpJsons(workspaceFolder: string | undefined): McpJsonLoadResult[] {
    const results: McpJsonLoadResult[] = [];
    const wsPath = resolveWorkspaceMcpJsonPath(workspaceFolder);
    if (wsPath) results.push(loadMcpJsonFile(wsPath, 'workspace', workspaceFolder));
    results.push(loadMcpJsonFile(resolveUserMcpJsonPath(), 'user', workspaceFolder));
    return results;
}

/**
 * 按优先级合并多份 server 字典，前者覆盖后者同名项。
 *
 * @param sources 按优先级从高到低排列的 server 字典数组。
 * @returns 合并后的 server 字典。
 */
export function mergeMcpServers(
    ...sources: Array<Record<string, McpServerConfig> | undefined>
): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};
    // 从低优先级到高优先级覆盖，所以反向遍历。
    for (let i = sources.length - 1; i >= 0; i--) {
        const dict = sources[i];
        if (!dict) continue;
        for (const [key, value] of Object.entries(dict)) {
            if (!key || !value || typeof value !== 'object') continue;
            merged[key] = value;
        }
    }
    return merged;
}

/**
 * 把 VS Code mcp.json 解析后的对象的 `servers` 字段映射为我们的 `McpServerConfig` 字典。
 *
 * 同时执行变量替换：
 * - `${workspaceFolder}` → 当前工作区根；
 * - `${env:NAME}`         → `process.env.NAME`，找不到时替换为空串；
 * - 其它 `${...}`         → 保留原样（避免误伤 Claude CLI 自身的占位符）。
 *
 * `inputs` 字段会被忽略，因为 Claude CLI 不支持 VS Code 风格的输入弹窗。
 *
 * @param raw 已经 JSON.parse 出来的根对象。
 * @param workspaceFolder 当前工作区根；空时跳过 `${workspaceFolder}` 替换。
 * @returns 规范化后的 server 字典。
 */
function normalizeServersField(
    raw: unknown,
    workspaceFolder: string | undefined
): Record<string, McpServerConfig> {
    if (!raw || typeof raw !== 'object') return {};
    const root = raw as Record<string, unknown>;
    // VS Code 官方字段名是 "servers"；同时兼容 Claude CLI 风格的 "mcpServers" 顶层 key。
    const rawServers = (root.servers ?? root.mcpServers) as Record<string, unknown> | undefined;
    if (!rawServers || typeof rawServers !== 'object') return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, value] of Object.entries(rawServers)) {
        if (!name || !value || typeof value !== 'object') continue;
        const src = value as Record<string, unknown>;
        const server: McpServerConfig = {};
        for (const [field, fieldValue] of Object.entries(src)) {
            if (fieldValue === undefined || fieldValue === null) continue;
            switch (field) {
                case 'args': {
                    if (Array.isArray(fieldValue)) {
                        server.args = fieldValue
                            .filter((item): item is string => typeof item === 'string')
                            .map((item) => substituteVariables(item, workspaceFolder));
                    }
                    break;
                }
                case 'env':
                case 'headers': {
                    if (fieldValue && typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
                        const dict: Record<string, string> = {};
                        for (const [k, v] of Object.entries(fieldValue as Record<string, unknown>)) {
                            if (!k || typeof v !== 'string') continue;
                            dict[k] = substituteVariables(v, workspaceFolder);
                        }
                        if (Object.keys(dict).length > 0) (server as Record<string, unknown>)[field] = dict;
                    }
                    break;
                }
                case 'type':
                case 'command':
                case 'url':
                case 'cwd': {
                    if (typeof fieldValue === 'string' && fieldValue.length > 0) {
                        (server as Record<string, unknown>)[field] = substituteVariables(fieldValue, workspaceFolder);
                    }
                    break;
                }
                case 'gallery':
                case 'version':
                    // VS Code 自有字段：用于市场升级追踪，CLI 用不到，但保留透传不会出错。
                    (server as Record<string, unknown>)[field] = fieldValue;
                    break;
                default:
                    // 其它字段原样透传，便于未来 Claude CLI 增加新字段时无须改代码。
                    (server as Record<string, unknown>)[field] = fieldValue;
            }
        }
        out[name] = server;
    }
    return out;
}

/**
 * 对字符串中的 `${...}` 占位符做有限的变量替换。
 *
 * 仅展开 `${workspaceFolder}` 和 `${env:NAME}` 两种，其它占位符原样保留。
 *
 * @param input 原始字符串。
 * @param workspaceFolder 工作区根目录；空时 `${workspaceFolder}` 保留原样。
 * @returns 替换后的字符串。
 */
function substituteVariables(input: string, workspaceFolder: string | undefined): string {
    return input.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
        const trimmed = expr.trim();
        if (trimmed === 'workspaceFolder') {
            return workspaceFolder ?? match;
        }
        if (trimmed.startsWith('env:')) {
            const envName = trimmed.substring('env:'.length).trim();
            if (!envName) return match;
            return process.env[envName] ?? '';
        }
        return match;
    });
}

/**
 * 去掉 JSON 内容中的 `// 单行注释` 和 `/* 块注释 *\/`，保留字符串字面量中的相同字符。
 *
 * VS Code 用户经常把 mcp.json 当 JSONC 写注释。这里做最小化的剔除，便于
 * `JSON.parse` 直接使用。
 *
 * @param raw 原始文件内容。
 * @returns 剔除注释后的字符串。
 */
function stripJsonComments(raw: string): string {
    let out = '';
    let i = 0;
    let inString = false;
    let stringQuote = '"';
    let escape = false;
    while (i < raw.length) {
        const ch = raw[i];
        const next = raw[i + 1];
        if (inString) {
            out += ch;
            if (escape) {
                escape = false;
            } else if (ch === '\\') {
                escape = true;
            } else if (ch === stringQuote) {
                inString = false;
            }
            i++;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            inString = true;
            stringQuote = ch;
            out += ch;
            i++;
            continue;
        }
        if (ch === '/' && next === '/') {
            // 单行注释，吃到行末。
            while (i < raw.length && raw[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            // 块注释，吃到 */。
            i += 2;
            while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/**
 * 用于在测试中重写 VS Code 工作区根目录解析逻辑的钩子。
 *
 * 默认实现读取 `vscode.workspace.workspaceFolders[0].uri.fsPath`；测试可以替换
 * 该钩子来注入自定义路径，避免依赖真实 VS Code 运行时。
 */
export const workspaceFolderResolver = {
    /**
     * 返回当前工作区根目录绝对路径；无工作区时返回 `undefined`。
     */
    resolve(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }
};
