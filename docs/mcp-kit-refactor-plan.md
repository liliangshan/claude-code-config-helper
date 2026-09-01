# MCP 桥重复结构收敛方案（评审 3.3）

> 对应评审条目：`docs/project-review-2026-08-30.md` §3.3「四套 MCP 桥结构高度重复」
> 目标：提炼 `src/mcpKit/`，让新增一套工具只需声明 schema + executor。
> 约束：**不改变任何对外行为**（工具名、协议报文、HTTP 路径、env 变量名全部保持不变）。

---

## 一、现状盘点

### 1.1 四套桥的文件对应关系

| 能力 | 工具常量/schema | 宿主执行器 | HTTP bridge | stdio server |
|------|----------------|-----------|-------------|--------------|
| 浏览器 | `src/browserTools/tools.ts` | `src/browserTools/browserToolHost.ts` | `src/browserTools/httpBridge.ts` | `src/browserTools/browserMcpServer.ts` |
| VS Code 诊断 | `src/vscodeTools/tools.ts` | `src/vscodeTools/diagnosticsHost.ts` | `src/vscodeTools/httpBridge.ts` | `src/vscodeTools/vscodeMcpServer.ts` |
| 定时唤醒 | `src/wakeupTools/tools.ts` | `src/wakeupTools/wakeupHost.ts` | `src/wakeupTools/httpBridge.ts` | `src/wakeupTools/wakeupMcpServer.ts` |
| ask_expert | `src/expertMode/expertConstants.ts` | `src/expertMode/expertSubturnService.ts` | 无（同进程） | `src/expertMode/askExpertMcpServer.ts` |

### 1.2 逐字重复的代码块

**A. HTTP bridge 三份几乎完全相同**（`browserTools/httpBridge.ts` 132 行、
`vscodeTools/httpBridge.ts` 133 行、`wakeupTools/httpBridge.ts` 174 行）：

| 重复单元 | browser | vscode | wakeup | 差异 |
|---------|---------|--------|--------|------|
| `MAX_BODY_BYTES = 4 * 1024 * 1024` | :15 | :15 | :21 | 无 |
| `postJson<T>()` | :76-107 | :75-106 | :105-136 | 仅 `path` 常量不同 |
| `readRequestBody()` | :109-126 | :109-126 | :144-161 | 仅报错文案不同 |
| `writeJson()` | :128-132 | :129-133 | :170-174 | 无 |
| `XxxHttpForwardingHost` 类 | :26-35 | :26-35 | :32-49 | 仅泛型与 path |
| `createXxxToolRelayHandler` 主体 | :43-74 | :43-72 | :71-96 | 见下 |

`createXxxToolRelayHandler` 的三份实现，除以下两点外逐行相同：
- **host 解析方式**：browser/vscode 允许 `host` 缺省并惰性 `require` 默认宿主
  （`browserTools/httpBridge.ts:47`、`vscodeTools/httpBridge.ts:46-47`）；
  wakeup 的 `host` 为必填（`wakeupTools/httpBridge.ts:71`），因为 timer 必须
  活在扩展宿主的同一个 `WakeupScheduler` 实例上。
- **工具名守卫**：`isBrowserToolName` / `isVscodeToolName` / `isWakeupToolName`。

**B. stdio server 三份骨架相同**（`browserMcpServer.ts` 193 行、
`vscodeMcpServer.ts` 185 行、`wakeupMcpServer.ts` 221 行）：

| 重复单元 | browser | vscode | wakeup | askExpert |
|---------|---------|--------|--------|-----------|
| `JsonRpcRequest` / `JsonRpcResponse` 接口 | :8-29 | :7-29 | :10-32 | 有 |
| `start()` stdin 订阅 | :69-78 | :69-78 | :95-104 | :122-132 |
| `flushLines()` 行缓冲 | :86-96 | :86-96 | :110-120 | :150-162 |
| `handleLine()` + `-32700` / `-32603` | :98-127 | :99-127 | :122-144 | :164-207 |
| `dispatch()` initialize/tools/list/tools\_call | :139-151 | :130-145 | :148-170 | :215-236 |
| `handleToolCall()` params 解构 + Unknown tool | :148-172 | :148-164 | :175-190 | :244-262 |
| `write()` NDJSON 输出 | :166-169 | :167-169 | :195-197 | :300+ |
| `startXxxMcpServer()` + `require.main` 守卫 | :180-192 | :173-185 | :204-220 | 有 |

**C. 缺 relay 时的兜底策略三份不一致**（真正的隐患）：

| 实现 | 缺 relay port 时的行为 | 位置 |
|------|----------------------|------|
| vscode | 惰性 `require('./diagnosticsHost')` 起进程内 fallback（子进程内无 `vscode`，实际会抛） | `vscodeMcpServer.ts:63` |
| browser | 同上，`require('./browserToolHost')` | `browserMcpServer.ts` 构造函数 |
| wakeup | 用 `UNAVAILABLE_HOST` 返回 `isError` 文本，工具仍在 `tools/list` 中 | `wakeupMcpServer.ts:52-57` |

wakeup 的做法是三者中唯一正确的（见其 :203-205 注释：「好过整组工具静默消失」），
但没有回灌给另外两套。

**D. `serverInfo.version` 三处硬编码 `'1.0.0'`**：
`browserMcpServer.ts:144`、`vscodeMcpServer.ts:136`、`wakeupMcpServer.ts:155`、
`askExpertMcpServer.ts:223`。与 `package.json` 的 `3.2.29` 脱节（评审 §3.2 已列）。

**E. `tools.ts` 的 schema 类型与守卫三份同构**：
`BrowserToolSchema` / `VscodeToolSchema` / `WakeupToolSchema` 三个接口字段完全一致；
`isBrowserToolName` / `isVscodeToolName` / `isWakeupToolName` 三个函数实现逐字相同
（`browserTools/tools.ts` 尾部、`vscodeTools/tools.ts` 尾部、`wakeupTools/tools.ts:104-107`）。

**F. 注入与日志侧的三连重复**：
- `src/chat/cli/cliConfig.ts` 的 `injectBrowserMcpServer`(:970)、
  `injectVscodeMcpServer`(:1011)、`injectWakeupMcpServer`(:1053) 三个函数体
  除常量名外完全一致；配套的 `buildXxxMcpEntrypointScript`(:997/:1038/:1078) 亦然。
- `src/activation/mcpInjectionLog.ts` 的 `logBrowserMcpInjection`(:26)、
  `logVscodeMcpInjection`(:48)、`logWakeupMcpInjection`(:70) 三份日志逻辑同构。

---

## 二、目标结构

新增 `src/mcpKit/`，共 5 个文件：

```
src/mcpKit/
  types.ts          工具 schema / 结果 / 执行器的公共类型 + 守卫工厂
  jsonRpc.ts        JSON-RPC 报文类型与错误码常量
  stdioServer.ts    McpStdioServer：行缓冲 + dispatch + NDJSON 输出
  httpBridge.ts     createToolRelayHandler / createHttpForwardingHost
  registry.ts       McpBridgeDescriptor：一处声明 server 名/路径/env/schema
```

### 2.1 `src/mcpKit/types.ts`

```ts
/** MCP tools/list 返回的单个工具 schema。 */
export interface McpToolSchema<TName extends string = string> {
    name: TName;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

/** 工具执行结果（MCP tools/call 的 content 形态）。 */
export interface McpToolResult {
    isError?: boolean;
    content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
}

/** 工具执行器：宿主侧真实实现与子进程侧 HTTP 转发共用此接口。 */
export interface McpToolExecutor<TName extends string = string> {
    execute(name: TName, args: Record<string, unknown>): Promise<McpToolResult>;
}

/** 由 schema 列表生成工具名守卫，替代三份手写的 isXxxToolName。 */
export function createToolNameGuard<TName extends string>(
    schemas: readonly McpToolSchema<TName>[]
): (value: unknown) => value is TName;
```

**替代**：`browserTools/tools.ts` 的 `BrowserToolSchema` + `isBrowserToolName`、
`vscodeTools/tools.ts` 的 `VscodeToolSchema` + `isVscodeToolName`、
`wakeupTools/tools.ts` 的 `WakeupToolSchema` + `isWakeupToolName`。
三个 `tools.ts` 只保留 `XXX_MCP_SERVER_NAME`、`XXX_TOOL_SCHEMAS` 与
`export const isXxxToolName = createToolNameGuard(XXX_TOOL_SCHEMAS)` 一行。

### 2.2 `src/mcpKit/registry.ts`

```ts
/** 一套 MCP 桥的全部静态声明，三处（注入/日志/bridge）共用同一份。 */
export interface McpBridgeDescriptor<TName extends string = string> {
    /** mcpServers 字典中的 server 名，如 'llsccaiVscode'。 */
    serverName: string;
    /** relay HTTP 路径，如 '/llsccai/vscode-tool'。 */
    httpPath: string;
    /** relay 端口环境变量名，如 'LLS_VSCODE_TOOL_RELAY_PORT'。 */
    relayPortEnv: string;
    /** 子进程入口模块路径（require.resolve 的入参）。 */
    entryModule: string;
    /** 子进程入口导出的启动函数名，如 'startVscodeMcpServer'。 */
    entryStarter: string;
    /** tools/list 返回的工具全集。 */
    schemas: readonly McpToolSchema<TName>[];
    /** 缺 relay 时对模型的说明文案（统一走 UNAVAILABLE 兜底）。 */
    unavailableMessage: string;
}
```

三份 descriptor 分别置于 `browserTools/bridge.ts`、`vscodeTools/bridge.ts`、
`wakeupTools/bridge.ts`，各约 20 行常量。

### 2.3 `src/mcpKit/httpBridge.ts`

```ts
/** 子进程侧执行器：把 execute 转成 HTTP POST 给扩展宿主 relay。 */
export function createHttpForwardingHost(
    descriptor: McpBridgeDescriptor,
    port: number
): McpToolExecutor;

/** 扩展宿主侧 relay handler；路径不匹配返回 false 交给下一个 handler。 */
export function createToolRelayHandler(
    descriptor: McpBridgeDescriptor,
    resolveHost: () => McpToolExecutor
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
```

`resolveHost` 用惰性回调统一 browser/vscode 的「缺省时 require 默认宿主」与
wakeup 的「必须注入」两种形态——wakeup 直接传 `() => host`，另两者传
`() => host ?? require(...)`，重复的 `postJson` / `readRequestBody` / `writeJson`
三个私有函数只留 mcpKit 一份。

**删除**：`browserTools/httpBridge.ts:76-132`、`vscodeTools/httpBridge.ts:75-133`、
`wakeupTools/httpBridge.ts:105-174`（三份 postJson/readRequestBody/writeJson）。

### 2.4 `src/mcpKit/stdioServer.ts`

```ts
/** 最小 MCP stdio JSON-RPC server：行缓冲 + 标准方法分派 + NDJSON 输出。 */
export class McpStdioServer {
    constructor(options: {
        descriptor: McpBridgeDescriptor;
        host: McpToolExecutor;
        stdin?: NodeJS.ReadableStream;
        stdout?: NodeJS.WritableStream;
    });
    start(): void;
    dispose(): void;
}

/** 按 descriptor + env 端口装配并启动一个 stdio server。 */
export function startStdioServerFromEnv(
    descriptor: McpBridgeDescriptor,
    options?: { host?: McpToolExecutor; stdin?: ...; stdout?: ... }
): McpStdioServer;
```

`serverInfo.version` 由 `startStdioServerFromEnv` 从
`require('../../package.json').version` 读取，一次性修掉四处 `'1.0.0'` 硬编码。

缺 relay 时统一采用 wakeup 的策略：构造一个返回
`{ isError: true, content: [{ type:'text', text: descriptor.unavailableMessage }] }`
的兜底执行器，工具仍出现在 `tools/list`，调用时明确报错。

**替代后各 server 文件收缩为约 15 行**，例如 `vscodeMcpServer.ts`：

```ts
import { VSCODE_BRIDGE } from './bridge';
import { startStdioServerFromEnv, type McpStdioServer } from '../mcpKit/stdioServer';

/** 启动 VS Code 工具 MCP server。 */
export function startVscodeMcpServer(options = {}): McpStdioServer {
    return startStdioServerFromEnv(VSCODE_BRIDGE, options);
}

if (require.main === module) {
    startVscodeMcpServer();
}
```

### 2.5 注入侧收敛

`src/chat/cli/cliConfig.ts` 的三个 `injectXxxMcpServer` + 三个
`buildXxxMcpEntrypointScript` 合并为一个：

```ts
/** 按 descriptor 向 mcpServers 字典注入一个内置 MCP server。 */
function injectBuiltinMcpServer(
    mcpServers: ChatCliConfig['mcpServers'],
    descriptor: McpBridgeDescriptor,
    enabled: boolean,
    relayPort: number | undefined
): ChatCliConfig['mcpServers'];
```

调用点 `cliConfig.ts:308-313` 与 `:392-396` 的三层嵌套改为对
`[BROWSER_BRIDGE, VSCODE_BRIDGE, WAKEUP_BRIDGE]` 的 `reduce`。

`src/activation/mcpInjectionLog.ts` 的三个 `logXxxMcpInjection` 合并为
`logMcpInjection(config, descriptor)`，`wiring.ts:140-145` 的
`logMcpInjection` 回调改为遍历三个 descriptor。

---

## 三、约束与风险

### 3.1 必须保持的既有约束

**子进程禁止静态 import 宿主模块。** `wakeupTools/httpBridge.ts:1-7` 的文件头注释
记录了 3.2.23 的事故：静态 import 链一旦拉进 `vscode`，MCP 子进程直接崩溃，
整组工具在模型侧静默消失。因此 `src/mcpKit/**` 的所有文件：

- 只允许 `import * as http from 'http'` 等 Node 内置模块；
- 引用宿主侧类型一律 `import type`；
- 需要真实宿主实例时必须走惰性 `require` 或调用方注入的回调。

落地后建议加一条测试守住这条线（见 §4）。

### 3.2 不可合并的差异点

| 差异 | 处理方式 |
|------|---------|
| wakeup 的 host 必填 | `createToolRelayHandler` 收 `resolveHost` 回调，由调用方决定 |
| askExpert 有 in-flight `AbortController` 管理（`askExpertMcpServer.ts:141` / `:270-295`） | **本次不并入 mcpKit**，仅复用 `jsonRpc.ts` 类型与 `stdioServer` 的行缓冲；tools/call 分支保留自有实现 |
| askExpert 无 HTTP bridge（同进程运行） | 不涉及 `mcpKit/httpBridge` |
| browser 的 `sessionStore` 注入（`httpBridge.ts:44-47`） | 由 `resolveHost` 闭包捕获，descriptor 不感知 |

### 3.3 行为兼容性检查清单

改造后必须逐项确认与改造前**字节级一致**：

- `mcpServers` 字典的三个 key：`llsccaiBrowser` / `llsccaiVscode` / `llsccaiWakeup`
- 三个 env 变量名：`LLS_BROWSER_TOOL_RELAY_PORT` / `LLS_VSCODE_TOOL_RELAY_PORT` /
  `LLS_WAKEUP_TOOL_RELAY_PORT`
- 三个 HTTP 路径：`/llsccai/browser-tool` / `/llsccai/vscode-tool` / `/llsccai/wakeup-tool`
- `args: ['-e', "require(...).startXxxMcpServer();"]` 的入口脚本形态
- `initialize` 响应的 `protocolVersion: '2024-11-05'` 与 `capabilities: { tools: {} }`
- 全部工具裸名与 `inputSchema`（模型侧看到的 `mcp__<server>__<tool>` 不能变）

唯一**有意变更**的对外行为：`serverInfo.version` 从 `'1.0.0'` 变为真实扩展版本
（评审 §3.2 要求），以及 browser/vscode 缺 relay 时从「崩溃」改为「返回 isError 文本」。

---

## 四、实施顺序

每一步独立可编译、可测、可回滚；建议逐步提交。

| # | 步骤 | 涉及文件 | 验收 |
|---|------|---------|------|
| 1 | 建 `mcpKit/types.ts` + `jsonRpc.ts`，三个 `tools.ts` 改用 `createToolNameGuard` | `mcpKit/types.ts`、`mcpKit/jsonRpc.ts`、`browserTools/tools.ts`、`vscodeTools/tools.ts`、`wakeupTools/tools.ts` | 编译 + 现有 192 测试全绿 |
| 2 | 建 `mcpKit/registry.ts` 与三份 `bridge.ts` descriptor（先只声明，不接线） | `mcpKit/registry.ts`、`{browser,vscode,wakeup}Tools/bridge.ts` | 编译通过 |
| 3 | 建 `mcpKit/httpBridge.ts`，三份 `httpBridge.ts` 改为薄封装（保留原导出名与签名） | `mcpKit/httpBridge.ts` + 三份 `httpBridge.ts` | `browserTools/__tests__/httpBridge.test.ts` 全绿 |
| 4 | 建 `mcpKit/stdioServer.ts`，三份 `xxxMcpServer.ts` 收缩为 15 行 | `mcpKit/stdioServer.ts` + 三份 server | `wakeupMcpServer.test.ts`、`mcpServerBoot.test.ts` 全绿 |
| 5 | 合并 `cliConfig.ts` 的三个 inject 与三个 buildEntrypoint | `src/chat/cli/cliConfig.ts:963-1082` | `cliConfigDual.test.ts`、`cliProcess.mcpSkills.test.ts` 全绿 |
| 6 | 合并 `mcpInjectionLog.ts` 三个 log 函数，更新 `wiring.ts` 回调 | `src/activation/mcpInjectionLog.ts`、`src/activation/wiring.ts:140-145` | 编译 + 全量测试 |
| 7 | `serverInfo.version` 读 package.json，统一 UNAVAILABLE 兜底 | `mcpKit/stdioServer.ts` | 手工验证 `initialize` 响应 |

### 4.1 需要补的测试

- `src/mcpKit/__tests__/stdioServer.test.ts`：行缓冲跨 chunk 分帧、
  `-32700` parse error、`-32603` 内部错误、未知方法、未知工具名。
- `src/mcpKit/__tests__/httpBridge.test.ts`：路径不匹配返回 false、
  非 POST 返回 405、超过 `MAX_BODY_BYTES` 拒绝、未知工具名返回 400。
- `src/mcpKit/__tests__/noHostImports.test.ts`：**守住 §3.1 约束**——
  读取 `src/mcpKit/**/*.ts` 源码，断言不存在指向 `vscode` 或宿主模块的静态
  `import`（只允许 `import type` 与 Node 内置模块）。

### 4.2 预期收益

| 指标 | 改造前 | 改造后（估） |
|------|-------|------------|
| 三份 `httpBridge.ts` | 132 + 133 + 174 = 439 行 | 约 60 行（薄封装）+ mcpKit 130 行 |
| 三份 `xxxMcpServer.ts` | 193 + 185 + 221 = 599 行 | 约 45 行 + mcpKit 170 行 |
| `cliConfig.ts` 注入段 | :963-1082 约 120 行 | 约 35 行 |
| `mcpInjectionLog.ts` | 115 行 | 约 45 行 |
| **合计** | **约 1273 行** | **约 485 行** |

新增第五套工具的成本：从「复制 4 个文件、约 550 行」降为
「写一份 descriptor（约 20 行）+ 一个 executor」。
