# 浏览器工具落地实施方案（改用 vscode.lm.invokeTool）

> 目标：把 `src/browserTools/` 的浏览器工具从「调 `vscode.commands.executeCommand` 走 camelCase 命令」（已实测全部不存在，等于空跑）改为「调官方 `vscode.lm.invokeTool` 走 snake_case 内置工具」，让 `browser_open / get_content / screenshot / navigate / eval / console` 真正可用。
>
> 背景与实测依据见 [VSCODE_INTEGRATED_BROWSER_NOTES.md](./VSCODE_INTEGRATED_BROWSER_NOTES.md) 的「实测结论」一节。本文件只讲怎么改。

## 0. 已坐实的事实（实测，不再假设）

- agent 浏览器工具是 **`vscode.lm` 的 Language Model Tool**，不是命令。`vscode.commands` 里 `openBrowserPage`/`navigatePage`/`readPage`/`screenshotPage`/`runPlaywrightCode`/`simpleBrowser.show` **全部不存在**。
- 外部（扩展激活上下文，`toolInvocationToken: undefined`，非 chat 请求）**可以** `vscode.lm.invokeTool` 调用内置浏览器工具——已成功调通 `open_browser_page` / `read_page` / `screenshot_page`。
- 真实工具名（snake_case）：`open_browser_page` / `navigate_page` / `read_page` / `screenshot_page` / `click_element` / `type_in_page` / `hover_element` / `drag_element` / `handle_dialog` / `run_playwright_code`；另有纯抓取 `copilot_fetchWebPage`。
- **关键入参名 `pageId`**：`open_browser_page { url }` 返回文本含 `Page ID: <uuid>`；之后所有针对页面的工具都要带 `{ pageId }`。四种候选键实测只有 `pageId` 成功。
- `read_page { pageId }` 返回 `Page Title / URL / Recent events（含 console 报错、requestFailed）/ Snapshot（无障碍树，节点带 [ref=eN]）`。
- `screenshot_page { pageId }` 返回 VS Code 序列化二进制部件，`mimeType = image/jpeg`；**不能 `JSON.stringify`**，要取内容块的 `data`（Uint8Array/VSBuffer）再 base64。
- 需要 `workbench.browser.enableChatTools = true`（已有 `promptEnableBrowserChatToolsIfNeeded` 处理）；仅 desktop（`uiKind === 1`）。

### 0.1 全部 inputSchema 已确认（实测 `vscode.lm.tools[].inputSchema`）

| 工具 | 必填 | 可选 | 备注 |
| --- | --- | --- | --- |
| `open_browser_page` | （无） | `url`(string, 绝对 URI), `forceNew`(bool) | 省略 `url` → 提示用户分享已有页。返回文本含 `Page ID: <uuid>` |
| `read_page` | `pageId` | — | 返回 Title/URL/Recent events/Snapshot |
| `screenshot_page` | `pageId` | `ref`, `selector`, `element`, `scrollIntoViewIfNeeded`(bool) | 省略元素定位 → 截整个视口 |
| `navigate_page` | `pageId` | `type`(`url`\|`back`\|`forward`\|`reload`，默认 url), `url`(type=url 时必填) | |
| `click_element` | `pageId`, `element` | `ref`\|`selector`(二选一), `dblClick`, `button` | |
| `type_in_page` | `pageId` | `text`\|`key`(二选一), `ref`, `selector`, `element` | |
| `hover_element` | `pageId`, `element` | `ref`\|`selector`(二选一) | |
| `drag_element` | `pageId`, `fromElement`, `toElement` | `fromRef`\|`fromSelector`, `toRef`\|`toSelector` | |
| `run_playwright_code` | `pageId` | `code`\|`deferredResultId`(二选一), `timeoutMs`(默认 5000) | **不能直接用 `document`/`window`，必须经 `page` 对象**，如 `return page.evaluate(() => document.title)`；>5s 返回 `deferredResultId` 供轮询 |
| `handle_dialog` | `pageId` | `acceptModal`(bool), `promptText`, `selectFiles`(string[]) | |

→ **不再有未确认项**，可直接照此实现。`navigate_page` 用 `{ pageId, type:'url', url }`；`run_playwright_code` 用 `{ pageId, code }`（>5s 需处理 `deferredResultId` 轮询，首版可只透传错误，二期再做轮询）。

## 1. 现状与问题（为什么现在是空跑）

数据流（4 跳，绕）：

```
Claude CLI ──tools/call(browser_*)──► browserMcpServer.ts（子进程 Code Helper Plugin）
  └─ host.execute(browser_*) ─► BrowserHttpCommandExecutor ──HTTP {command:camelCase,args}──► 扩展宿主 relay
       └─ createBrowserToolRelayHandler ─► mapCommandToToolCall(camelCase→browser_*) ─► BrowserToolHost.execute(browser_*)
            └─ this.commands.executeCommand('openBrowserPage', url)  ◄── 这里 vscode.commands 没有这个命令 → 抛错/兜底 simpleBrowser.show（也不存在）
```

问题点：

1. **最后一跳用 `vscode.commands.executeCommand(camelCase)`，命令根本不存在**——`browser_screenshot/eval/get_content` 实际全是空的，`browser_open` 只能落到 `openBrowserPageFallback`（自注册 wrapper）。
2. **中间 camelCase 命令名是无意义的内部协议**：子进程把 `browser_*` 翻成 camelCase 命令发 HTTP，宿主又把 camelCase 翻回 `browser_*`，来回翻译纯属冗余。
3. **没有 `pageId` 概念**：当前协议不传/不存页面 id，导致 `read_page`/`screenshot_page` 即便改对也没法定位页面。
4. `tools.ts` 的 `VSCODE_BROWSER_COMMANDS` 是错的 camelCase 映射；`browser_get_content`/`browser_console` 用 `run_playwright_code` 跑 JS 取 DOM，偏离官方「快照」模型。

## 2. 目标架构（最小改动，去掉冗余翻译）

保留子进程 MCP server + HTTP bridge 这条传输链（它没问题），只做两件事：

- **传输协议从「命令式」改成「工具式」**：子进程直接把 `{ name: browser_*, arguments }` POST 给宿主，不再翻 camelCase 命令。
- **宿主侧执行从 `commands.executeCommand` 改成 `vscode.lm.invokeTool`**，并在宿主内维护 `currentPageId`、解析 `LanguageModelToolResult`。

```
Claude CLI ──tools/call(browser_*)──► browserMcpServer.ts（子进程）
  └─ HTTP {name:browser_*, arguments} ──► 扩展宿主 relay
       └─ BrowserLmToolHost.execute(browser_*, args)
            ├─ open    → lm.invokeTool('open_browser_page', { input:{ url } })       → 存 currentPageId、回快照文本
            ├─ navigate→ lm.invokeTool('navigate_page',     { input:{ pageId,url } })
            ├─ content → lm.invokeTool('read_page',         { input:{ pageId } })    → 回快照+events 文本
            ├─ console → lm.invokeTool('read_page',         { input:{ pageId } })    → 抽 Recent events
            ├─ shot    → lm.invokeTool('screenshot_page',   { input:{ pageId } })    → 回 image(jpeg base64)
            └─ eval    → lm.invokeTool('run_playwright_code',{ input:{ pageId,code } })
```

## 3. 逐文件改造清单

### 3.1 `src/browserTools/tools.ts`

- 删除错误的 `VSCODE_BROWSER_COMMANDS`（camelCase），改为 **LM 工具名常量**：

  ```ts
  export const LM_BROWSER_TOOLS = {
      open: 'open_browser_page',
      navigate: 'navigate_page',
      read: 'read_page',
      screenshot: 'screenshot_page',
      eval: 'run_playwright_code',
  } as const;
  ```
- `BROWSER_TOOL_SCHEMAS` 基本保留（对模型暴露的仍是我们自己的 `browser_*` 名）。`browser_navigate` 的 `url` 仍必填；`browser_eval` 的 `script` 仍必填。`browser_open/navigate/get_content/screenshot/console` 这些**对模型不暴露 pageId**——pageId 由宿主内部维护，模型无需感知。

### 3.2 新建 `src/browserTools/browserLmToolHost.ts`（核心，替代旧 host 的执行逻辑）

职责：在扩展宿主里用 `vscode.lm.invokeTool` 执行，维护 `currentPageId`，解析结果。要点：

- **依赖注入**：构造参数接收一个最小 `lm` 接口（`invokeTool` + 可选 `tools`）和 `env`（`uiKind`），便于单测打桩（沿用旧 host 的注入风格）。
- **状态**：`private currentPageId?: string`。
- **execute(name, args)**：
  - 非 desktop（`uiKind !== 1`）→ 返回 isError 文本。
  - `browser_open`：`invokeTool('open_browser_page', { input:{ url } })`；从返回文本正则 `Page ID:\s*([0-9a-f-]{36})` 抽 pageId 存起来；返回快照文本。
  - `browser_navigate`：确保有 pageId（无则报「先 open」）；`invokeTool('navigate_page', { input:{ pageId, url } })`。
  - `browser_get_content`：`invokeTool('read_page', { input:{ pageId } })`，返回文本。
  - `browser_console`：复用 `read_page`，从文本里截取 `Recent events:` 段；无则返回「无 console 事件」。
  - `browser_screenshot`：`invokeTool('screenshot_page', { input:{ pageId } })`，从结果内容块取图片（见 3.4），返回 `{type:'image', data, mimeType}`。
  - `browser_eval`：`invokeTool('run_playwright_code', { input:{ pageId, code: script } })`。
- **错误**：`invokeTool` 抛错时包成 `{ isError:true, content:[{type:'text', text }] }`。
- **token**：每次调用用 `new vscode.CancellationTokenSource().token`，调用后 `dispose()`。

### 3.3 `src/browserTools/httpBridge.ts`

- 传输协议改为工具式：请求体 `{ name: BrowserToolName, arguments }`，删除 `mapCommandToToolCall` 与 `BrowserHttpCommandExecutor` 的命令封装。
- 子进程侧：保留一个轻量「把 `host.execute` 转成 HTTP POST」的执行器，但发送 `{name, arguments}` 而非 `{command, args}`。
- 宿主侧 `createBrowserToolRelayHandler`：读 `{name, arguments}`，直接 `browserLmToolHost.execute(name, arguments)`，把结果（文本或图片块）序列化回 JSON。
  - 图片块：JSON 里回 `{type:'image', data:<base64>, mimeType}`，子进程原样作为 MCP image content 返回。

### 3.4 截图结果解析（关键细节）

`screenshot_page` 的结果是 `LanguageModelToolResult`，`.content[]` 里图片部件实测形如 `{"$mid":24,"mimeType":"image/jpeg","data":<bytes>}`。实现时：

- 遍历 `result.content`，找带 `data` 的部件；`data` 可能是 `Uint8Array` / `Buffer` / `{ type:'Buffer', data:number[] }`。
- 统一转成 `Buffer` → `.toString('base64')`；`mimeType` 取部件的 `mimeType`（缺省 `image/jpeg`）。
- **禁止** `JSON.stringify` 整个部件（会丢二进制 / 体积爆炸）。

### 3.5 `src/extension.ts`

- 删除失效的 `registerBrowserCommandWrappers` / `openBrowserPageFallback` / `VSCODE_BROWSER_COMMANDS.open` 命令注册（不再需要命令兜底）。
- 保留 `promptEnableBrowserChatToolsIfNeeded`（仍需 `enableChatTools`）与 `logBrowserMcpInjection`。
- relay handler 注册处改为持有一个 `BrowserLmToolHost` 单例（宿主内唯一，保证 `currentPageId` 跨调用一致）。
- **删除本次新增的一次性探测代码**：`probeBrowserCapabilities` / `probeInvokeBrowserTool` 及 `activate` 里的 `void probeBrowserCapabilities()`。

## 4. pageId 生命周期

- 宿主维护单一 `currentPageId`：`browser_open` 成功后写入；其余工具读它。
- `browser_navigate`/`get_content`/`screenshot`/`console`/`eval` 在 `currentPageId` 为空时，返回明确错误：`No browser page is open. Call browser_open first.`（与官方 `screenshot_page` 的提示一致）。
- 暂不支持多页面/多 tab：一次只跟踪最近打开的页面，够当前 agent 用；将来要多页再把 pageId 暴露给模型。

## 5. 边界与失败处理

- **仅 desktop**：`uiKind !== 1` 直接返回 isError 文本，不注册/不调用（沿用现状）。
- **`enableChatTools` 未开**：`invokeTool` 可能找不到工具或抛错；错误文本透传给模型，同时已有弹窗引导用户开启。
- **`lm` / `invokeTool` 不存在**（老 VS Code）：`execute` 返回 isError 文本，提示升级 VS Code 到 1.110+。
- **不做版本探测降级**：按 NOTES 既定原则，能力缺失时让调用自然失败、由模型/用户感知，不写「>=1.110 才暴露」这类分支。

## 6. 测试方案

- **单测**（`src/browserTools/__tests__/`）：用打桩 `lm.invokeTool` 注入 BrowserLmToolHost，断言：
  - `browser_open` 解析 `Page ID:` 并存 pageId；
  - 后续工具带上正确 `{ pageId }`；
  - 未 open 先 `read_page` → isError；
  - 截图部件（Uint8Array / Buffer / `{type:'Buffer'}` 三种形态）都能正确 base64；
  - 非 desktop / `invokeTool` 不存在 → isError。
- **HTTP bridge 单测**：`{name,arguments}` 往返，图片块 JSON 序列化/反序列化保真。
- **手动联调**：在 Chat 里让模型 `browser_open https://www.baidu.com` → `browser_get_content` → `browser_screenshot`，确认快照文本与 jpeg 截图都进 Chat。

## 7. 落地步骤（建议顺序）

1. 用探测补齐 `navigate_page` / `run_playwright_code` 的 `inputSchema`（贴日志即可），确认字段名。
2. 删除一次性探测代码。
3. 改 `tools.ts`（LM 工具名常量）。
4. 新建 `browserLmToolHost.ts` + 单测。
5. 改 `httpBridge.ts` 协议为 `{name,arguments}`、宿主持有 host 单例、图片块序列化。
6. 改 `extension.ts`：删命令 wrapper 兜底、relay 接 BrowserLmToolHost。
7. `npm run compile` + 跑单测 + 手动联调。
8. 删除本文与 NOTES 里标注为「一次性探测」的内容（或归档），更新 `BROWSER_TOOLS_DESIGN.md` 的「集成方式」一节为「LM tool」结论。
9. 版本号 +patch，更新 CHANGELOG/README，打包。

## 8. 风险与回退

- **风险**：未来 VS Code 改 LM 工具名/入参（snake_case → 其它），或对第三方扩展收紧 `invokeTool` 内置工具的权限。
  - 缓解：工具名集中在 `LM_BROWSER_TOOLS` 常量；`invokeTool` 失败统一回 isError 文本，不崩溃。
- **回退**：保留 `copilot_fetchWebPage`（纯抓取）或 `workbench.action.browser.open`（仅显示）作为最低限度兜底——仅在确实需要时再加，不提前写降级分支。
