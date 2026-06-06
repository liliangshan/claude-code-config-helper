# 落地方案：Read/Write 自动打开文件 + llsccaiVscode get_errors 工具

> 代码级实施方案，已按以下决策定稿：
> 1. 只要模型**读或改**文件（Read / Write / Edit / MultiEdit / NotebookEdit）就在编辑器打开；
> 2. 打开用 `preview: false`（持久标签页）；
> 3. get_errors 走**新建独立 MCP server `llsccaiVscode`**；
> 4. 具体到文件与代码。

配置命名空间：`claudeCodeConfigHelper`（`src/constants.ts:69 CONFIG_NAMESPACE`）。

---

# 总览：两处改动互不耦合

| 功能 | 接入点 | 性质 |
| --- | --- | --- |
| Read/Write 自动打开 | relay 拦截器 `src/llsTask/{streamingInterceptor,interceptor}.ts` 被动观察 tool_use → 调宿主 `EditorAutoOpener` | 只读观察，**不改写** SSE/JSON |
| get_errors | 新 `src/vscodeTools/` MCP server（镜像 `browserTools/`）+ relay handler + cliConfig 注入 | 标准 MCP 工具 |

---

# 功能一：Read/Write 自动打开

## A1. 新文件 `src/editorAutoOpen.ts`

宿主侧执行真正的打开逻辑。**唯一**碰 `vscode` 的地方，拦截器只通过回调触发它，保证拦截器仍可单测。

```ts
/** @file 监听模型 Read/Write/Edit 类工具调用，自动在编辑器打开目标文件。 */

import * as path from 'path';
import * as vscode from 'vscode';

import { Logger } from './logger';
import { CONFIG_NAMESPACE } from './constants';

/** 触发自动打开的工具名集合（读或改文件）。 */
const FILE_OPEN_TOOL_NAMES = new Set<string>([
    'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'
]);

/** 配置键：自动打开总开关。 */
const AUTO_OPEN_ENABLED_KEY = 'editor.autoOpenReadWriteFiles';

/** 判断工具名是否属于会触发自动打开的文件工具。 */
export function isFileOpenToolName(name: unknown): boolean {
    return typeof name === 'string' && FILE_OPEN_TOOL_NAMES.has(name);
}

/** 从工具 input 中取出文件路径（Read/Write/Edit=file_path，NotebookEdit=notebook_path）。 */
export function extractFilePathFromToolInput(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as { file_path?: unknown; notebook_path?: unknown };
    const raw = typeof obj.file_path === 'string' ? obj.file_path
        : typeof obj.notebook_path === 'string' ? obj.notebook_path
        : undefined;
    const trimmed = raw?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** 自动打开器：去重 + workspace 校验 + 非存在文件延迟重试。 */
export class EditorAutoOpener {
    /** 最近已尝试打开的绝对路径，避免一轮内反复打开。 */
    private readonly recentlyOpened = new Set<string>();

    /** 观察一次工具调用；非文件工具或开关关闭时直接忽略。fire-and-forget。 */
    public observeToolUse(toolName: string, input: unknown): void {
        if (!isFileOpenToolName(toolName)) return;
        if (!this.isEnabled()) return;
        const filePath = extractFilePathFromToolInput(input);
        if (!filePath) return;
        void this.openFile(filePath).catch((err) => {
            Logger.debug?.(`[EditorAutoOpen] 打开失败：${err instanceof Error ? err.message : String(err)}`);
        });
    }

    /** 读取总开关，默认开。 */
    private isEnabled(): boolean {
        return vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>(AUTO_OPEN_ENABLED_KEY, true);
    }

    /** 解析 → workspace 校验 → 已打开则跳过 → 打开（preview:false, 不抢焦点）。 */
    private async openFile(filePath: string): Promise<void> {
        if (/^(?:javascript|command|data):/i.test(filePath)) return;
        const abs = path.isAbsolute(filePath)
            ? filePath
            : this.resolveInWorkspace(filePath);
        if (!abs || !this.isInsideWorkspace(abs)) return;

        if (this.recentlyOpened.has(abs)) return;
        this.recentlyOpened.add(abs);

        const uri = vscode.Uri.file(abs);
        if (this.isAlreadyOpen(uri)) return;

        try {
            await this.show(uri);
        } catch {
            // Write 新建文件：tool_use 时可能尚未落盘，延迟一次重试。
            setTimeout(() => { void this.show(uri).catch(() => undefined); }, 700);
        }
    }

    /** 打开并显示文档（持久标签、不抢焦点、第一列）。 */
    private async show(uri: vscode.Uri): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.One
        });
    }

    /** 是否已有同路径文档在打开状态（标签页存在）。 */
    private isAlreadyOpen(uri: vscode.Uri): boolean {
        return vscode.workspace.textDocuments.some((d) => d.uri.fsPath === uri.fsPath);
    }

    /** 相对路径回退到首个 workspace 根解析。 */
    private resolveInWorkspace(rel: string): string | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder ? path.join(folder.uri.fsPath, rel) : undefined;
    }

    /** 绝对路径是否位于任一 workspace 根之内。 */
    private isInsideWorkspace(abs: string): boolean {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.some((f) => {
            const rel = path.relative(f.uri.fsPath, abs);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
    }
}
```

> 说明：`recentlyOpened` 永久去重即可——「已打开判断」已覆盖用户手动关标签后想重看的场景由 `isAlreadyOpen` 决定；若希望关掉标签后再次 Read 能重开，可改成带 TTL 的 Map，但默认实现已满足「没打开才打开」。
> `Logger.debug?.` 用可选链，若 `Logger` 无 debug 方法改用 `Logger.info`。

## A2. 拦截器接回调（不改写，仅观察）

### `src/llsTask/interceptor.ts`

`LlsTaskInterceptorDeps` 增一个可选回调：

```ts
export interface LlsTaskInterceptorDeps {
    service: LlsTaskService;
    autoContinueScheduler: AutoContinueScheduler;
    /** 可选：观察到 Read/Write/Edit 类文件工具调用时触发（用于自动打开）。 */
    onFileTool?: (toolName: string, input: unknown) => void;
}
```

`interceptJsonResponse` 的 tool_use 分支里，命中文件工具时回调（**不改写，原样返回 block**）：

```ts
const rewritten = content.map((block) => {
    if (block?.type !== 'tool_use') return block;
    sawToolUse = true;
    const name = String(block.name ?? '');
    if (isWorkflowToolName(name)) {
        handledWorkflowTool = true;
        const message = executeWorkflowTool(block.input, deps, name);
        return { type: 'text', text: message };
    }
    sawNonLocalTool = true;
    if (isFileOpenToolName(name)) deps.onFileTool?.(name, block.input);   // ← 新增
    return block;
});
```

`interceptSseResponse`：非本地工具当前不进 `accumulators`。改为：文件工具也建累积器（但**不**改写、原样透传），在 stop 时回调。

```ts
// content_block_start 分支（payload.content_block.type==='tool_use'）末尾：
const localKind = classifyLocalToolKind(name);
accumulators.set(index, { index, name, inputJson: '', localKind });
if (localKind === 'workflow') handledWorkflowTool = true;
else sawNonLocalTool = true;
if (localKind) { /* …原有改写为 text 的逻辑，保持不变… */ continue; }
// 非本地：原样 push（保持现状），但累积器已建好以便累积 input

// content_block_delta 分支：非本地文件工具要累积 input，同时仍要透传
if (payload.type === 'content_block_delta') {
    const index = Number(payload.index ?? 0);
    const acc = accumulators.get(index);
    if (acc?.localKind) { /* 原有：累积且不透传 */ continue; }
    if (acc && isFileOpenToolName(acc.name) && typeof payload.delta?.partial_json === 'string') {
        acc.inputJson += payload.delta.partial_json;   // ← 累积，但不 continue，继续向下透传
    }
}

// content_block_stop 分支：非本地文件工具在 stop 时回调
if (payload.type === 'content_block_stop') {
    const index = Number(payload.index ?? 0);
    const acc = accumulators.get(index);
    if (acc?.localKind) { /* …原有改写逻辑… */ continue; }
    if (acc && isFileOpenToolName(acc.name)) deps.onFileTool?.(acc.name, parseToolInput(acc.inputJson));
    accumulators.delete(index);
}
```

并 `import { isFileOpenToolName } from '../editorAutoOpen';`。

### `src/llsTask/streamingInterceptor.ts`

`LlsTaskStreamingInterceptorDeps` 同样加 `onFileTool?`，并把它放进 `toInterceptorDeps()`：

```ts
export interface LlsTaskStreamingInterceptorDeps {
    service: LlsTaskService;
    autoContinueScheduler: AutoContinueScheduler;
    onFileTool?: (toolName: string, input: unknown) => void;   // ← 新增
}
```

新增并行累积 Map（文件工具，不改写）：

```ts
private readonly fileToolBlocks = new Map<number, { name: string; inputJson: string }>();
```

`handleContentBlockStart` 里，`kind` 为空（非本地）时若是文件工具则登记：

```ts
const kind = classifyLocalToolKind(name);
if (!kind) {
    this.sawNonLocalTool = true;
    if (this.deps.onFileTool && isFileOpenToolName(name)) {
        this.fileToolBlocks.set(index, { name, inputJson: '' });
    }
    return formatSseEvent(record);   // 原样透传
}
```

`handleContentBlockDelta`：非本地文件工具累积后**仍要透传**（注意现有代码对非 localBlocks 的 delta 是 `return formatSseEvent(...)`）：

```ts
private handleContentBlockDelta(payload: Record<string, unknown>): string {
    const index = Number(payload.index ?? 0);
    const block = this.localBlocks.get(index);
    if (!block) {
        const fileBlock = this.fileToolBlocks.get(index);
        const delta = isRecord(payload.delta) ? payload.delta : {};
        if (fileBlock && typeof delta.partial_json === 'string') {
            fileBlock.inputJson += delta.partial_json;
        }
        return formatSseEvent({ event: 'content_block_delta', data: JSON.stringify(payload) });
    }
    const delta = isRecord(payload.delta) ? payload.delta : {};
    if (typeof delta.partial_json === 'string') block.inputJson += delta.partial_json;
    return '';
}
```

`handleContentBlockStop`：开头处理文件工具（在 `localBlocks.get` 为空的分支里回调后透传）：

```ts
private handleContentBlockStop(record: SseEventRecord, payload: Record<string, unknown>): string {
    const index = Number(payload.index ?? 0);
    const block = this.localBlocks.get(index);
    if (!block) {
        const fileBlock = this.fileToolBlocks.get(index);
        if (fileBlock) {
            this.deps.onFileTool?.(fileBlock.name, parseToolInput(fileBlock.inputJson));
            this.fileToolBlocks.delete(index);
        }
        return formatSseEvent(record);
    }
    // …原有 localBlocks 改写逻辑不变…
}
```

并 `import { isFileOpenToolName } from '../editorAutoOpen';`。

## A3. 装配：把回调从 adapter 透传到拦截器

### `src/relay/anthropicProxy.ts`

构造函数加可选第 5 参 `fileOpenObserver`：

```ts
public constructor(
    private readonly recorder?: DebugRecorder,
    private readonly taskDeps?: AnthropicProxyTaskDeps,
    private readonly usageSink?: UsageSink,
    private readonly tokenBudget?: TokenBudgetService,
    private readonly fileOpenObserver?: (toolName: string, input: unknown) => void   // ← 新增
) {}
```

两处拦截器构造各加一行 `onFileTool`：

```ts
// 流式（~347）
new LlsTaskStreamingInterceptor({
    service: this.taskDeps.llsTaskService,
    autoContinueScheduler: this.taskDeps.autoContinueScheduler,
    onFileTool: this.fileOpenObserver
})
// 非流式（~404）
interceptAnthropicResponse(rawResponseBody, upstreamRes.headers['content-type'], {
    service: this.taskDeps.llsTaskService,
    autoContinueScheduler: this.taskDeps.autoContinueScheduler,
    onFileTool: this.fileOpenObserver
}).body
```

### `src/extension.ts`（adapter 装配处 ~4683）

```ts
const editorAutoOpener = new EditorAutoOpener();
// …
new AnthropicProxyAdapter(
    debugRecorder,
    { configManager, llsTaskService, autoContinueScheduler },
    (report) => usageSinkRef.sink(report),
    tokenBudgetService,
    (toolName, input) => editorAutoOpener.observeToolUse(toolName, input)   // ← 新增
),
```

顶部 `import { EditorAutoOpener } from './editorAutoOpen';`。

> OpenAI 兼容 adapter（`OpenAIChatProxyAdapter` / `OpenAIResponsesProxyAdapter`）默认不接此回调；Claude Code 主链路是 anthropic apiType，已覆盖。若将来要覆盖 OpenAI provider，同样加一参即可。

## A4. 配置项

`package.json` 的 `contributes.configuration.properties` 增：

```jsonc
"claudeCodeConfigHelper.editor.autoOpenReadWriteFiles": {
    "type": "boolean",
    "default": true,
    "description": "%configuration.editor.autoOpenReadWriteFiles.description%",
    "scope": "resource"
}
```

`package.nls.json` / `package.nls.zh-cn.json` 各加该 key 文案。

## A5. 测试

`src/llsTask/__tests__/interceptor.fileOpen.test.ts`：

- 喂入含 `Read`（`{file_path:"/ws/a.ts"}`）的 SSE / JSON 响应，注入 `onFileTool` spy，断言被调用且参数正确；
- 工具名为 `Bash` 时不调用；
- **关键回归**：断言文件工具的 SSE/JSON **原样透传未被改写**（对比 in==out 的 tool_use 块）；
- `editorAutoOpen.test.ts`：`extractFilePathFromToolInput`（file_path / notebook_path / 缺失）与 `isFileOpenToolName` 纯函数单测（这两个不依赖 vscode）。`EditorAutoOpener` 的 vscode 部分可在集成阶段手测。

---

# 功能二：llsccaiVscode get_errors 工具

镜像 `browserTools/` 三段式：claude 子进程跑 stdio MCP server → 经 HTTP bridge POST 回扩展宿主 → 宿主用 `vscode.languages.getDiagnostics()` 执行。新建目录 `src/vscodeTools/`。

## B1. `src/vscodeTools/tools.ts`

```ts
/** @file llsccaiVscode MCP 工具常量与 schema。 */

export const VSCODE_MCP_SERVER_NAME = 'llsccaiVscode' as const;
export const VSCODE_FULL_TOOL_PREFIX = `mcp__${VSCODE_MCP_SERVER_NAME}__` as const;

export type VscodeToolName = 'get_errors';

export interface VscodeToolSchema {
    name: VscodeToolName;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

export const VSCODE_TOOL_SCHEMAS: readonly VscodeToolSchema[] = [
    {
        name: 'get_errors',
        description:
            'Read diagnostics (errors/warnings) from the VS Code Problems panel via ' +
            'vscode.languages.getDiagnostics(). Returns at most 10 items, errors first.',
        inputSchema: {
            type: 'object',
            properties: {
                filePaths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional. Only return diagnostics for these file paths; omit for all.'
                }
            },
            required: []
        }
    }
] as const;

const VSCODE_TOOL_NAMES = new Set<VscodeToolName>(VSCODE_TOOL_SCHEMAS.map((t) => t.name));
export function isVscodeToolName(v: unknown): v is VscodeToolName {
    return typeof v === 'string' && VSCODE_TOOL_NAMES.has(v as VscodeToolName);
}
```

## B2. `src/vscodeTools/diagnostics.ts`（纯函数，移植参考方案，可单测）

把 `vscode.Diagnostic[]` 的归一化结果（不依赖 vscode 运行时）做收集/排序/截断。宿主侧先把
`vscode.languages.getDiagnostics()` 转成下面的 `RawDiag[]` 再喂进来。

```ts
/** @file get_errors 诊断收集/排序/截断（纯函数，无 vscode 依赖）。 */

export type DiagSeverity = 'error' | 'warning' | 'information' | 'hint' | 'unknown';

export interface RawDiag {
    uri: string;
    filePath: string;
    severity: DiagSeverity;
    message: string;
    source?: string;
    code?: string;
    range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
}

export interface GetErrorsResult {
    ok: boolean;
    source: 'vscode.languages.getDiagnostics';
    summary: { total: number; errors: number; warnings: number; information: number; hints: number };
    diagnostics: RawDiag[];
    message: string;
    truncated: boolean;
}

const MAX_ITEMS = 10;
const WEIGHT: Record<DiagSeverity, number> = { error: 1, warning: 2, information: 3, hint: 4, unknown: 5 };

export function buildGetErrorsResult(all: RawDiag[], filePaths?: string[]): GetErrorsResult {
    const items = all.filter((d) => matchesFilePaths(d, filePaths)).sort(compare);
    const summary = {
        total: items.length,
        errors: items.filter((i) => i.severity === 'error').length,
        warnings: items.filter((i) => i.severity === 'warning').length,
        information: items.filter((i) => i.severity === 'information').length,
        hints: items.filter((i) => i.severity === 'hint').length
    };
    const truncated = items.length > MAX_ITEMS;
    return {
        ok: true,
        source: 'vscode.languages.getDiagnostics',
        summary,
        diagnostics: items.slice(0, MAX_ITEMS),
        message: items.length === 0
            ? 'No matching diagnostics in the VS Code Problems panel.'
            : truncated
                ? `Found ${items.length} diagnostics; returning the first ${MAX_ITEMS}.`
                : `Found ${items.length} diagnostics.`,
        truncated
    };
}

export function emptyErrorResult(message: string): GetErrorsResult {
    return {
        ok: false,
        source: 'vscode.languages.getDiagnostics',
        summary: { total: 0, errors: 0, warnings: 0, information: 0, hints: 0 },
        diagnostics: [], message, truncated: false
    };
}

function compare(a: RawDiag, b: RawDiag): number {
    const s = WEIGHT[a.severity] - WEIGHT[b.severity];
    if (s !== 0) return s;
    const f = a.filePath.localeCompare(b.filePath);
    return f !== 0 ? f : a.range.startLine - b.range.startLine;
}

function matchesFilePaths(d: RawDiag, filePaths?: string[]): boolean {
    if (!filePaths || filePaths.length === 0) return true;
    const fs = norm(d.filePath);
    return filePaths.some((p) => {
        const t = norm(p.trim());
        return !!t && (fs === t || fs.endsWith('/' + t) || fs.startsWith(t.endsWith('/') ? t : t + '/'));
    });
}

function norm(v: string): string { return v.replace(/\\/g, '/'); }
```

## B3. `src/vscodeTools/diagnosticsHost.ts`（宿主侧，调 vscode）

```ts
/** @file get_errors 宿主侧执行器：读取 vscode.languages.getDiagnostics()。 */

import * as vscode from 'vscode';

import { buildGetErrorsResult, emptyErrorResult, type DiagSeverity, type RawDiag } from './diagnostics';
import type { VscodeToolName } from './tools';

export interface VscodeToolResult { isError?: boolean; content: { type: 'text'; text: string }[]; }

export interface VscodeToolExecutor {
    execute(name: VscodeToolName, args?: Record<string, unknown>): Promise<VscodeToolResult>;
}

export class DiagnosticsHost implements VscodeToolExecutor {
    public async execute(name: VscodeToolName, args: Record<string, unknown> = {}): Promise<VscodeToolResult> {
        if (name !== 'get_errors') {
            return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }] };
        }
        try {
            const filePaths = Array.isArray(args.filePaths)
                ? (args.filePaths as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
                : undefined;
            const raw = collect();
            const result = buildGetErrorsResult(raw, filePaths);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            const result = emptyErrorResult(err instanceof Error ? err.message : 'Failed to read diagnostics.');
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    }
}

function collect(): RawDiag[] {
    const out: RawDiag[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        for (const d of diags) {
            out.push({
                uri: uri.toString(),
                filePath: uri.fsPath || uri.toString(),
                severity: toSeverity(d.severity),
                message: d.message,
                source: d.source,
                code: normalizeCode(d.code),
                range: {
                    startLine: d.range.start.line + 1,
                    startCharacter: d.range.start.character + 1,
                    endLine: d.range.end.line + 1,
                    endCharacter: d.range.end.character + 1
                }
            });
        }
    }
    return out;
}

function toSeverity(s: vscode.DiagnosticSeverity): DiagSeverity {
    switch (s) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'information';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return 'unknown';
    }
}

function normalizeCode(code: vscode.Diagnostic['code']): string | undefined {
    if (code === undefined || code === null) return undefined;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
    return String((code as { value: unknown }).value);
}
```

## B4. `src/vscodeTools/httpBridge.ts`（抄 browser 版，换 path/类型）

```ts
/** @file llsccaiVscode MCP 子进程 ↔ 扩展宿主 HTTP bridge。 */

import * as http from 'http';
import { DiagnosticsHost, type VscodeToolExecutor, type VscodeToolResult } from './diagnosticsHost';
import { isVscodeToolName, type VscodeToolName } from './tools';

export const VSCODE_TOOL_HTTP_PATH = '/llsccai/vscode-tool';
export const VSCODE_TOOL_RELAY_PORT_ENV = 'LLS_VSCODE_TOOL_RELAY_PORT';

export class VscodeHttpForwardingHost implements VscodeToolExecutor {
    public constructor(private readonly port: number) {}
    public async execute(name: VscodeToolName, args: Record<string, unknown> = {}): Promise<VscodeToolResult> {
        return postJson<VscodeToolResult>(this.port, { name, arguments: args });
    }
}

export function createVscodeHttpHost(port: number): VscodeToolExecutor {
    return new VscodeHttpForwardingHost(port);
}

/** 扩展宿主侧 relay handler；路径不匹配返回 false 以便链式下一个 handler。 */
export function createVscodeToolRelayHandler(host: VscodeToolExecutor = new DiagnosticsHost()) {
    return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
        const p = (req.url ?? '').split('?', 1)[0];
        if (p !== VSCODE_TOOL_HTTP_PATH) return false;
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') { writeJson(res, 405, { error: 'method_not_allowed' }); return true; }
        try {
            const body = JSON.parse(await readBody(req)) as { name?: unknown; arguments?: unknown };
            if (!isVscodeToolName(body.name)) { writeJson(res, 400, { error: `unknown_tool: ${String(body.name)}` }); return true; }
            const args = (body.arguments && typeof body.arguments === 'object') ? body.arguments as Record<string, unknown> : {};
            writeJson(res, 200, await host.execute(body.name, args));
        } catch (err) {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
    };
}
// postJson / readBody / writeJson 与 browserTools/httpBridge.ts 完全一致，可抽公共模块或直接复制。
```

> 可选优化：把 browser 与 vscode 两个 bridge 的 `postJson`/`readBody`/`writeJson` 抽到 `src/relay/httpJson.ts` 共用，避免复制。非必须。

## B5. `src/vscodeTools/vscodeMcpServer.ts`（stdio JSON-RPC，抄 browserMcpServer）

与 `browserMcpServer.ts` 结构相同，差异点：

- `serverInfo.name = 'llsccai-vscode'`；
- `tools/list` 返回 `VSCODE_TOOL_SCHEMAS`；
- `tools/call` 校验 `isVscodeToolName` 后转 `host.execute`；
- `startVscodeMcpServer()` 读 `VSCODE_TOOL_RELAY_PORT_ENV`，`port>0` 时用 `createVscodeHttpHost(port)`；
- 文件末尾 `if (require.main === module) startVscodeMcpServer();`。

## B6. 注册到 CLI mcpServers — `src/chat/cli/cliConfig.ts`

仿 `injectBrowserMcpServer` 加一个：

```ts
import { VSCODE_MCP_SERVER_NAME } from '../../vscodeTools/tools';
import { VSCODE_TOOL_RELAY_PORT_ENV } from '../../vscodeTools/httpBridge';

function injectVscodeMcpServer(
    mcpServers: ChatCliConfig['mcpServers'],
    enabled: boolean,
    relayPort: number | undefined
): ChatCliConfig['mcpServers'] {
    if (!enabled) return mcpServers;
    const next: NonNullable<ChatCliConfig['mcpServers']> = { ...(mcpServers ?? {}) };
    if (!next[VSCODE_MCP_SERVER_NAME]) {
        next[VSCODE_MCP_SERVER_NAME] = {
            type: 'stdio',
            command: process.execPath,
            args: ['-e', buildVscodeMcpEntrypointScript()],
            env: relayPort ? { [VSCODE_TOOL_RELAY_PORT_ENV]: String(relayPort) } : undefined
        };
    } else if (relayPort) {
        next[VSCODE_MCP_SERVER_NAME] = {
            ...next[VSCODE_MCP_SERVER_NAME],
            env: { ...(next[VSCODE_MCP_SERVER_NAME].env ?? {}), [VSCODE_TOOL_RELAY_PORT_ENV]: String(relayPort) }
        };
    }
    return next;
}

function buildVscodeMcpEntrypointScript(): string {
    const entry = require.resolve('../../vscodeTools/vscodeMcpServer');
    return `require(${JSON.stringify(entry)}).startVscodeMcpServer();`;
}
```

在装配 `normal.mcpServers` 处（~376）串进链：

```ts
const vscodeToolsEnabled = vsCfg.get<boolean>('vscodeTools.getErrors.enabled', true);
// …
mcpServers: injectAskExpertMcpServer(
    injectVscodeMcpServer(
        injectBrowserMcpServer(baseConfig.mcpServers, browserToolsEnabled, relayPort),
        vscodeToolsEnabled,
        relayPort
    ),
    expertAvailable
),
```

> 与 browser 不同，get_errors 用独立 vscode 设置开关读取（默认开），不依赖 baseConfig 是否已含该 server。

## B7. 挂载 relay handler — `src/extension.ts`

```ts
// ~4677
const browserToolRelayHandler = createBrowserToolRelayHandler();
const vscodeToolRelayHandler = createVscodeToolRelayHandler();   // ← 新增
// ~4714
relayServer.setHandler(async (req, res) => {
    if (await browserToolRelayHandler(req, res)) return;
    if (await vscodeToolRelayHandler(req, res)) return;          // ← 新增
    await chatRelayHandler(req, res);
});
```

顶部 `import { createVscodeToolRelayHandler } from './vscodeTools/httpBridge';`。
（可选）仿 2082 行 browser 健康探针加一处启动日志。

## B8. `package.json` / nls

```jsonc
"claudeCodeConfigHelper.vscodeTools.getErrors.enabled": {
    "type": "boolean",
    "default": true,
    "description": "%configuration.vscodeTools.getErrors.enabled.description%",
    "scope": "resource"
}
```

nls 两份加文案。若有工具自动放行 allowlist（settings.json permissions），加入
`mcp__llsccaiVscode__get_errors` 以免每次 get_errors 都弹权限确认。

## B9. 测试

- `src/vscodeTools/__tests__/diagnostics.test.ts`：`buildGetErrorsResult` 排序（error 先）、截断 10 条、summary 计数、filePaths 过滤、空集合 message；`emptyErrorResult` 形态。
- `src/vscodeTools/__tests__/vscodeMcpServer.test.ts`：喂 `initialize` / `tools/list`（断言含 get_errors）/ `tools/call`（host stub 返回固定结果），仿 `browserTools/__tests__/browserTools.test.ts`。

---

# 与 REMOVE_VSCODE_DIAGNOSTICS_PLAN.md 的关系

旧的 `get_llsccai_vscode_diagnostics`（relay 注入 + `@llsccai-get-errors` 触发词）若仍在，应先按该计划删除，避免与新的 MCP 式 `get_errors` 双轨。新方案不复用任何旧触发词/注入逻辑。

# 改动文件清单

新增：
- `src/editorAutoOpen.ts`
- `src/vscodeTools/tools.ts`
- `src/vscodeTools/diagnostics.ts`
- `src/vscodeTools/diagnosticsHost.ts`
- `src/vscodeTools/httpBridge.ts`
- `src/vscodeTools/vscodeMcpServer.ts`
- 测试：`src/llsTask/__tests__/interceptor.fileOpen.test.ts`、`src/vscodeTools/__tests__/*.test.ts`、`editorAutoOpen` 纯函数测试

修改：
- `src/llsTask/interceptor.ts`（deps 加 `onFileTool`，JSON/SSE 文件工具回调，不改写）
- `src/llsTask/streamingInterceptor.ts`（deps 加 `onFileTool`，fileToolBlocks 累积+回调）
- `src/relay/anthropicProxy.ts`（构造加 `fileOpenObserver`，两处拦截器透传）
- `src/extension.ts`（建 `EditorAutoOpener` 并传入 adapter；挂 `vscodeToolRelayHandler`）
- `src/chat/cli/cliConfig.ts`（`injectVscodeMcpServer` + 串链 + 读 `vscodeTools.getErrors.enabled`）
- `package.json` + `package.nls.json` + `package.nls.zh-cn.json`（两个新设置项）

# 验证清单

- [ ] 终端 Claude Read 已存在文件 → 编辑器打开为持久标签，焦点不被抢。
- [ ] 文件已打开时再 Read → 不重复打开、不跳动。
- [ ] Write 新文件 → 写完后（延迟重试）被打开。
- [ ] workspace 外绝对路径 / `Bash` 等非文件工具 → 不打开。
- [ ] 关 `editor.autoOpenReadWriteFiles` → 不再自动打开。
- [ ] Chat 面板链路同样生效。
- [ ] 文件工具的响应未被改写（无回归：Read 结果照常往返、内容完整）。
- [ ] 模型调用 `mcp__llsccaiVscode__get_errors` → 返回当前 Problems 诊断，error 优先、≤10 条、truncated 正确。
- [ ] 带 `filePaths` 过滤生效；无诊断时 `ok:true, diagnostics:[]`。
- [ ] 关 `vscodeTools.getErrors.enabled` → CLI mcpServers 不再注入该 server。
- [ ] `npm test` 全绿 + TS 编译通过。
