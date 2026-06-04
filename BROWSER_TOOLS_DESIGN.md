# 浏览器工具设计：自建工具，底层调 VS Code 开放能力

> 目标：给我们的扩展（内置 Chat / 主 CLI）增加一组**自建的「浏览器工具」**——打开网页、获取页面内容、
> 截图等——底层调用 VS Code 开放的 agent 浏览器能力。**仅面向 desktop**，**不做版本探测与降级**：
> VS Code 没开放对应能力时该工具调用自然失败，由模型/用户感知，我们不为低版本兜底。
>
> 关联背景见 [VSCODE_INTEGRATED_BROWSER_NOTES.md](./VSCODE_INTEGRATED_BROWSER_NOTES.md)。

## 0. 已定决策（本次）

- **集成方式**：**我们自建工具**（`browser_open` / `browser_screenshot` / …），底层调用 VS Code 开放的
  agent 浏览器命令；不直接暴露 VS Code 原生工具名给模型。
- **环境**：**仅 desktop**。`vscode.env.uiKind !== Desktop`（web）时不注册浏览器工具。
- **不做版本探测与降级**：不写「>= 1.110 才暴露」「老版本 iframe 兜底」这类分支。直接按 VS Code 当前
  开放的能力调用；底层命令不存在时，工具调用返回错误结果（而非崩溃），交由模型/用户处理。
- **通道**：MCP server 模式，仿 `AskExpertMcpServer` 新建 in-process `browser` MCP server，经 `mcpServers` 注册。
- **截图语义**：agent 自动截图（底层 `screenshotPage` / `runPlaywrightCode`），**非** 1.122 的用户手动「Add Screenshot to Chat」。

## 1. 现状与可复用资产

- 已有成熟的 **in-process MCP server 范式**：`src/expertMode/askExpertMcpServer.ts`（`AskExpertMcpServer`）
  —— 自实现最小 MCP（stdio JSON-RPC）server，只暴露工具，通过 Claude CLI 的 `mcpServers` 注册给主模型。
  浏览器工具**仿照这个范式**新增一个 `browser` MCP server。
- VS Code（1.110 起，`workbench.browser.enableChatTools:true`）开放的 agent 浏览器命令——我们底层调用：
  - **页面导航**：`openBrowserPage`、`navigatePage`
  - **页面内容与外观**：`readPage`、`screenshotPage`
  - **用户交互**：`clickElement`、`hoverElement`、`dragElement`、`typeInPage`、`handleDialog`
  - **自定义自动化**：`runPlaywrightCode`
- 工具的**实际执行必须发生在扩展宿主进程**（只有它能调 `vscode.commands` / `vscode.window`），
  因此 MCP 工具调用需要一条回扩展宿主的桥（参考 ask_expert 的 sub-turn 回调机制）。

## 2. 我们自建的工具（对模型暴露）

我们定义自己的工具名与 schema，内部调用 VS Code 开放的 agent 浏览器命令。不暴露 VS Code 原生工具名。

| 我们的工具名 | 底层调用的 VS Code 能力 | 输入 | 输出 |
| --- | --- | --- | --- |
| `browser_open` | `openBrowserPage` | `url` | 打开结果/页面 id |
| `browser_navigate` | `navigatePage` | `url` | 导航结果 |
| `browser_get_content` | `readPage` | （当前页） | 页面 DOM/文本 |
| `browser_screenshot` | `screenshotPage` | （当前页，可选区域） | 截图（image content, base64） |
| `browser_console` | 页面 console 错误/警告 | （当前页） | 控制台日志文本 |
| `browser_eval` | `runPlaywrightCode` | `script`（任意 Playwright/页面 JS） | 脚本返回值（JSON 序列化）/ console / 错误 |

> 这些底层命令需用户在 VS Code 侧开启 `workbench.browser.enableChatTools:true` 并在 chat tools picker 启用。
> 我们**不代设、不探测版本**；命令不可用时工具调用返回错误结果，由模型/用户处理。

### `browser_eval`——执行任意页面 JS（完全放开）

- **能力**：底层调 `runPlaywrightCode`，模型传入一段 Playwright JS 代码在内嵌浏览器中执行。
  典型用法 `await page.evaluate(() => { /* 任意页面上下文 JS */ })`，可读写 DOM、发请求、读 cookie/storage、
  点击/填表/等待等，等同任意脚本执行。
- **本次决策：完全放开**——不做受限子集、不加独立开关、不默认关，与其它浏览器工具同等可用。
- **返回**：把脚本返回值 JSON 序列化回模型；执行抛错时以 `isError` 结果回传错误栈。

## 3. 落地架构（MCP server 模式，仿 ask_expert）

仿 `src/expertMode/askExpertMcpServer.ts` 新建一个 in-process `browser` MCP server，通过 Claude CLI
的 `mcpServers` 注册；工具真正执行经回调桥回扩展宿主进程（只有宿主能调 `vscode.commands`）：

```
扩展宿主 (extension.ts)
  └─ BrowserToolHost                       // 宿主侧执行 vscode 命令，序列化结果（含截图 base64）
        ▲ (回调桥，仿 ask_expert sub-turn)
        │
  BrowserMcpServer (in-process)            // 仿 AskExpertMcpServer，tools/list 固定我们这几个工具
        └─ tools/call → 经桥回 BrowserToolHost 执行
        ▼
  Claude CLI (mcpServers 注册 mcp__llsccai-browser__browser_open / _screenshot …)
```

要点：
- `tools/list` 固定暴露我们定义的几个工具（不按版本裁剪——不做版本探测）。
- `tools/call` 不在 MCP 进程直接干活，经桥回宿主调 `vscode.commands.executeCommand(<底层命令>, …)`。
- 底层命令不存在/执行失败时，`tools/call` 返回 `isError` 结果（带说明），不崩溃、不阻塞。
- 截图返回：MCP tool result 用 image content（base64），把截图直接喂回模型，供其分析 UI。
- 复用 ask_expert 已有的 server 生命周期 / `mcpServers` 注册 / sub-turn 回调范式，改动集中、风险低。

## 4. 环境限制（仅 desktop）

- 注册前判断 `vscode.env.uiKind === vscode.UIKind.Desktop`；非 desktop（web）时不注册 `browser` MCP server。
- 不针对 remote 做特殊处理；能调通就用，调不通由 `tools/call` 返回错误结果。
- 这是唯一的环境门槛，**不引入版本号判断**。

## 5. 配置项（建议）

- `chat.browserTools.enabled`（project/global）—— 总开关，默认关，灰度上线；复用 project>global>off 解析范式。
  开启后 `browser_eval` 与其它工具同等暴露（不单独设开关）。
- 关闭总开关或非 desktop 时不注册 `browser` MCP server。
- 底层 `workbench.browser.enableChatTools` 需用户自行在 VS Code 开启；我们只在 README 提示，不代设。

## 6. 风险与边界

- **隐私**：内嵌浏览器带登录态，截图/读内容/`browser_eval` 可访问页面全部数据。由总开关 `chat.browserTools.enabled`
  统一控制（默认关）；开启即视为用户授权全部能力，含 `browser_eval` 任意 JS 执行。
- **执行进程边界**：只有宿主能调 vscode API，MCP 进程必须经桥回宿主，不能假设其能直接操作 UI。
- **底层命令不可用**：用户未开 `enableChatTools`、命令名变动或环境不支持时，`tools/call` 返回错误结果，
  不崩溃；不做自动降级/兜底（按本次决策）。

## 7. 建议分阶段实施

1. **P0**：`BrowserMcpServer` 骨架（仿 AskExpertMcpServer）+ `BrowserToolHost` 回调桥 + desktop 门槛 +
   `browser_open`（调 `openBrowserPage`）。验证 MCP 注册与宿主执行链路。
2. **P1（本次重点）**：`browser_screenshot`（调 `screenshotPage`），tool_result 以 image content 回模型。
3. **P2**：`browser_get_content`（`readPage`）/ `browser_navigate`（`navigatePage`）/ `browser_console`。
4. **P3**：`browser_eval`（调 `runPlaywrightCode`，完全放开，与其它工具同等暴露）。

## 8. 已确定决策（汇总）

- **集成方式**：我们自建工具，底层调 VS Code 开放命令；不暴露原生工具名。
- **环境**：仅 desktop（`uiKind === Desktop`）；非 desktop 不注册。
- **不做版本探测/降级**：不写版本门槛、不写 iframe 兜底；底层命令不可用时返回错误结果。
- **通道**：MCP server 模式，仿 `AskExpertMcpServer`，经 `mcpServers` 注册。
- **截图**：agent 自动截图（底层 `screenshotPage` / `runPlaywrightCode`），非 1.122 用户手动截图。
- **执行 JS**：`browser_eval` 底层 `runPlaywrightCode`，**能力完全放开**，与其它浏览器工具同等暴露（不单独设开关）。

## 9. 实现代码骨架

> 以下为设计参考骨架（非最终代码），仿 `src/expertMode/askExpertMcpServer.ts` 的 NDJSON JSON-RPC 范式。
> 文件落点建议：`src/browserTools/browserMcpServer.ts`、`src/browserTools/browserToolHost.ts`、`src/browserTools/types.ts`。

### 9.1 工具常量与 Schema（`browserTools/tools.ts`）

```ts
/** MCP server 在 Claude CLI mcpServers 注册时使用的 server 名。 */
export const BROWSER_MCP_SERVER_NAME = 'llsccaiBrowser' as const;

/** 底层调用的 VS Code agent 浏览器命令名（按本仓库实测填入实际命令 id）。 */
export const VSCODE_BROWSER_COMMANDS = {
    open: 'openBrowserPage',
    navigate: 'navigatePage',
    read: 'readPage',
    screenshot: 'screenshotPage',
    eval: 'runPlaywrightCode'
} as const;

/** 工具裸名（未加 mcp__<server>__ 前缀）。 */
export type BrowserToolName =
    | 'browser_open'
    | 'browser_navigate'
    | 'browser_get_content'
    | 'browser_screenshot'
    | 'browser_console'
    | 'browser_eval';

/** tools/list 返回的工具定义（固定全集，不按版本裁剪）。 */
export const BROWSER_TOOL_SCHEMAS = [
    {
        name: 'browser_open',
        description: 'Open a URL in the VS Code integrated browser (desktop only).',
        inputSchema: {
            type: 'object' as const,
            properties: { url: { type: 'string' as const, description: 'The URL to open.' } },
            required: ['url']
        }
    },
    {
        name: 'browser_navigate',
        description: 'Navigate the current integrated browser page to a URL.',
        inputSchema: {
            type: 'object' as const,
            properties: { url: { type: 'string' as const, description: 'The URL to navigate to.' } },
            required: ['url']
        }
    },
    {
        name: 'browser_get_content',
        description: 'Read the DOM / text content of the current integrated browser page.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] }
    },
    {
        name: 'browser_screenshot',
        description: 'Capture a screenshot of the current integrated browser page. Returns an image.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] }
    },
    {
        name: 'browser_console',
        description: 'Read console errors/warnings from the current integrated browser page.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] }
    },
    {
        name: 'browser_eval',
        description:
            'Run arbitrary Playwright/JS code in the integrated browser. ' +
            'Full Playwright API is available, e.g. await page.evaluate(() => document.title). ' +
            'Returns the JSON-serialized result.',
        inputSchema: {
            type: 'object' as const,
            properties: { script: { type: 'string' as const, description: 'Playwright/page JS to execute.' } },
            required: ['script']
        }
    }
] as const;
```

### 9.2 宿主侧执行器（`browserTools/browserToolHost.ts`）

工具真正执行处——只有扩展宿主进程能调 `vscode.commands`。截图统一转为 MCP image content。

```ts
import * as vscode from 'vscode';
import { VSCODE_BROWSER_COMMANDS, type BrowserToolName } from './tools';

/** MCP tool result 内容块（文本或图片）。 */
type ToolContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string };

/** 工具执行结果。 */
export interface BrowserToolResult {
    isError?: boolean;
    content: ToolContent[];
}

/**
 * 在扩展宿主进程执行浏览器工具：分派到对应 VS Code 命令并序列化结果。
 *
 * 底层命令不存在 / 抛错时返回 isError 结果（不抛出、不崩溃）——不做降级兜底。
 */
export class BrowserToolHost {
    /**
     * 仅 desktop 才允许执行；非 desktop 直接返回错误结果。
     */
    public async execute(name: BrowserToolName, args: Record<string, unknown>): Promise<BrowserToolResult> {
        if (vscode.env.uiKind !== vscode.UIKind.Desktop) {
            return this.error('Browser tools are only available in VS Code desktop.');
        }
        try {
            switch (name) {
                case 'browser_open':
                    return await this.runText(VSCODE_BROWSER_COMMANDS.open, [String(args.url ?? '')]);
                case 'browser_navigate':
                    return await this.runText(VSCODE_BROWSER_COMMANDS.navigate, [String(args.url ?? '')]);
                case 'browser_get_content':
                    return await this.runText(VSCODE_BROWSER_COMMANDS.read, []);
                case 'browser_console':
                    return await this.runText(VSCODE_BROWSER_COMMANDS.read, []); // console 随 readPage 一并返回
                case 'browser_screenshot':
                    return await this.runScreenshot();
                case 'browser_eval':
                    return await this.runText(VSCODE_BROWSER_COMMANDS.eval, [String(args.script ?? '')]);
                default:
                    return this.error(`Unknown tool: ${String(name)}`);
            }
        } catch (err) {
            return this.error(err instanceof Error ? err.message : String(err));
        }
    }

    /** 执行命令并把返回值序列化为文本结果。 */
    private async runText(command: string, cmdArgs: unknown[]): Promise<BrowserToolResult> {
        const raw = await vscode.commands.executeCommand<unknown>(command, ...cmdArgs);
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
        return { content: [{ type: 'text', text }] };
    }

    /** 截图：命令应返回 base64 PNG（按实测调整解析）。 */
    private async runScreenshot(): Promise<BrowserToolResult> {
        const raw = await vscode.commands.executeCommand<unknown>(VSCODE_BROWSER_COMMANDS.screenshot);
        const data = typeof raw === 'string' ? raw : (raw as { data?: string })?.data;
        if (!data) return this.error('Screenshot command returned no image data.');
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
    }

    /** 统一错误结果。 */
    private error(text: string): BrowserToolResult {
        return { isError: true, content: [{ type: 'text', text }] };
    }
}
```

### 9.3 MCP server（`browserTools/browserMcpServer.ts`，仿 AskExpertMcpServer）

复用 ask_expert 的 NDJSON JSON-RPC 主循环；差异只在 `tools/list` 返回全集、`tools/call` 转发给
`BrowserToolHost`。这里只列与 ask_expert **不同**的 dispatch 部分（其余 `start` / `flushLines` /
`handleLine` / `write` 逐字照搬）。

```ts
import { BROWSER_TOOL_SCHEMAS, type BrowserToolName } from './tools';
import type { BrowserToolHost } from './browserToolHost';

// constructor 注入 host：private readonly host: BrowserToolHost

/** 按 method 分派；仅 tools/list 与 tools/call 与 ask_expert 不同。 */
private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
        case 'initialize':
            return {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'llsccai-browser', version: '1.0.0' }
            };
        case 'tools/list':
            return { tools: BROWSER_TOOL_SCHEMAS };       // 固定全集，不按版本裁剪
        case 'tools/call':
            return this.handleToolCall(request);
        default:
            throw new Error(`Method not found: ${request.method}`);
    }
}

/** tools/call → 转发宿主执行器。 */
private async handleToolCall(request: JsonRpcRequest): Promise<unknown> {
    const params = (request.params && typeof request.params === 'object')
        ? request.params as Record<string, unknown> : {};
    const name = String(params.name) as BrowserToolName;
    const args = (params.arguments && typeof params.arguments === 'object')
        ? params.arguments as Record<string, unknown> : {};
    return this.host.execute(name, args);   // BrowserToolResult 即 MCP tool result 形状
}
```

### 9.4 注册接线（`extension.ts`）

仿 ask_expert 把 `browser` server 加入 Claude CLI 的 `mcpServers`，仅 desktop + 总开关开启时注册：

```ts
import { BROWSER_MCP_SERVER_NAME } from './browserTools/tools';

// 组装 mcpServers 时：
if (vscode.env.uiKind === vscode.UIKind.Desktop && config.browserTools.enabled) {
    mcpServers[BROWSER_MCP_SERVER_NAME] = {
        type: 'stdio',
        command: process.execPath,                       // Node
        args: [browserMcpServerEntryPath],               // 子进程入口，内部 startBrowserMcpServer()
        env: { /* 如需端口/token，仿 ask_expert 经 env 传入 */ }
    };
}
```

> 进程边界注意：若 MCP server 跑在**独立子进程**，它无法直接调 `vscode.commands`，需经 IPC/Relay 回桥到
> 宿主的 `BrowserToolHost`（与 ask_expert 经 Relay 端口回调同理）。若改为**进程内** server（在宿主进程内起），
> 则可直接持有 `BrowserToolHost` 实例，省去回桥——P0 建议先走进程内以简化链路。
