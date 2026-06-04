# VS Code 在编辑区打开网页：接口与版本演进笔记

> 整理自 VS Code 官方 release notes（1.109 ~ 1.122），数据来源见文末。
> 检索脚本：`scripts/fetch_vscode_release_notes.py`。

## 一句话结论

VS Code 里「在编辑区打开网页」有两套东西：

- **Simple Browser**（老）——基于 `<iframe>`，跨平台、最稳，但不能登录认证、Google/GitHub 等站点打不开。
- **Integrated Browser**（新，1.109 引入）——真正的内嵌浏览器（仅 desktop），可登录、带 DevTools、可调试、可被 agent 操作。

## 实测结论（本扩展宿主探测，2026-06-04，VS Code 含 Copilot agent）

> 在扩展宿主里枚举 `vscode.lm.tools`（87 个）与 `vscode.commands.getCommands(true)`（2887 个）实测，下列为硬结论：

**A. agent 浏览器工具是 `vscode.lm` 的 Language Model Tool，不是命令。** 真实工具名是 **snake_case**：

| 能力 | LM tool 名（实测） | 描述（节选） |
| --- | --- | --- |
| 打开页面 | `open_browser_page` | Open a new browser page in the integrated browser at the given URL. |
| 导航 | `navigate_page` | Navigate a browser page by URL, history, or reload. |
| 读页面 | `read_page` | Get a snapshot of the current browser page state. **比 screenshot 更好用**。 |
| 截图 | `screenshot_page` | Capture a screenshot；不能基于截图做操作，要读状态用 `read_page`。 |
| 点击 | `click_element` | Click on an element. |
| 输入 | `type_in_page` | Type text or press keys. |
| 悬停 | `hover_element` | — |
| 拖拽 | `drag_element` | — |
| 对话框 | `handle_dialog` | — |
| Playwright | `run_playwright_code` | Run a Playwright snippet；**仅当其它工具不够时才用**。 |
| 抓网页正文 | `copilot_fetchWebPage` | Fetch main content of a web page（非内嵌浏览器，纯抓取）。 |

调用入口是 **`vscode.lm.invokeTool(name, { input, toolInvocationToken }, token)`**，不是 `vscode.commands.executeCommand`。

**B. 这些 camelCase 名字作为命令全部不存在**（旧代码里 `executeCommand('openBrowserPage'/'runPlaywrightCode'/…)` 这条路是死的）：
`openBrowserPage`、`navigatePage`、`readPage`、`screenshotPage`、`runPlaywrightCode`、`browser.openIntegratedBrowser`、`workbench.action.openIntegratedBrowser`、`simpleBrowser.show` —— 实测 **全部 `=> false`**（连 `simpleBrowser.show` 在该构建里也没有）。

**C. 真实存在的是一组 `workbench.action.browser.*` UI 命令**（可 `executeCommand`）：
`workbench.action.browser.open` / `.openOrList` / `.newTab` / `.goBack` / `.goForward` / `.reload` / `.hardReload` / `.addScreenshotToChat` / `.addFullPageScreenshotToChat` / `.addConsoleLogsToChat` / `.addElementToChat` / `.toggleDevTools` / `.pickDevicePreset` / `.showEmulationToolbar` / `.setUserAgent` / `.zoomIn` / `.zoomOut` …
这些是**打开/导航/把截图或 console 加到 chat** 的 UI 动作；**读 DOM、跑 Playwright 没有对应命令，只能走 LM tool**。

**D. 已验证（决定性）：方案 A 成立——外部无 chat token 也能 `vscode.lm.invokeTool` 内置浏览器工具。**
实测（`toolInvocationToken: undefined`，扩展激活上下文，非 chat 请求）：

- `invokeTool('open_browser_page', { input: { url } })` → **成功**。返回文本以 `Page ID: <uuid>` 开头，后跟 `Summary: / Page Title / URL / Snapshot:`（无障碍树，节点带 `[ref=eN]`、`[cursor=pointer]`，比裸 DOM 更适合点击定位）。
- `invokeTool('read_page', { input: { pageId } })` → **成功**。返回 `Page Title / URL / Recent events（含 console 报错、requestFailed 等）/ Snapshot`。**`browser_console` 也应复用它**。
- `invokeTool('screenshot_page', { input: { pageId } })` → **成功**。返回值是 VS Code 序列化的二进制部件，形如 `{"$mid":24,"mimeType":"image/jpeg","data":<bytes>}`——**MIME 是 `image/jpeg`，且数据不能 `JSON.stringify`**，要从结果内容块里取 `data`（Uint8Array/VSBuffer）再 base64。

**关键入参名：`pageId`**（实测四种候选 `pageId`/`page_id`/`id`/`page` 中，仅 `pageId` 成功；其余 `read_page` 抛 `Cannot read properties of undefined (reading 'toString')`、`screenshot_page` 回 `No page ID provided. Use 'open_browser_page' first.`）。

**调用约定（已坐实）：**
1. `open_browser_page { url }` → 拿到 `pageId`（宿主侧需缓存为「当前页」）。
2. 之后所有针对页面的工具都要带 `{ pageId }`：`read_page` / `screenshot_page` / `navigate_page` / `click_element` / `type_in_page` / `run_playwright_code` …
3. 结果是 `LanguageModelToolResult`，`.content[]` 里是 `LanguageModelTextPart`（取 `.value`）或二进制图片部件（取 `.data` + `.mimeType`）。

**改造结论：** 重写 `src/browserTools/browserToolHost.ts`——把 `commands.executeCommand(camelCase)` 全部换成 `vscode.lm.invokeTool(snake_case, { input })`，宿主维护 `currentPageId`，正确解析文本/图片内容块；删除失效的命令 wrapper 兜底与错误的 `VSCODE_BROWSER_COMMANDS` camelCase 映射。

**待补 inputSchema（不阻塞核心）：** `navigate_page`（按 URL/历史/reload 导航的字段）与 `run_playwright_code`（代码字段名）的精确入参，从 `vscode.lm.tools[].inputSchema` 读取确认。

## 可用接口（实操，从简单到强）

| 方式 | 调用 | 说明 |
| --- | --- | --- |
| Simple Browser | `vscode.commands.executeCommand('simpleBrowser.show', url)` | 老的、跨平台、最稳的「编辑区打开网页」（webview + iframe）。兜底首选。 |
| Integrated Browser | `vscode.commands.executeCommand('browser.openIntegratedBrowser', url)` | 命令标题 `Browser: Open Integrated Browser`（1.109+）。能登录 / DevTools，仅 desktop。命令 ID 在不同版本有 `browser.*` / `workbench.action.*` 变体，调用前建议做能力探测。 |
| 自建 Webview | `window.createWebviewPanel(...)` + `<iframe src>` | 需要自己完全控制渲染时用。Simple Browser 本质就是这么实现的。 |
| 外部浏览器 | `vscode.env.openExternal(uri)` | 走系统默认浏览器，不在编辑区内。 |

> 集成建议：优先 `simpleBrowser.show` 作兜底；检测到 1.109+ 且为 desktop 时再用 integrated browser 命令。

### 相关设置（1.109 引入）

- `workbench.browser.openLocalhostLinks` —— 让 localhost 链接直接在新内嵌浏览器里打开。
- `simpleBrowser.useIntegratedBrowser` —— 用 Integrated Browser 替换 Simple Browser。
- `workbench.browser.enableChatTools`（1.110）—— 允许 agent 使用浏览器操作工具。

## 版本演进时间线

### 1.109 —— Integrated Browser 首发（Preview）

- 引入全新 **Integrated browser**（VS Code desktop），替代基于 `<iframe>` 的老 Simple Browser。
- 老 Simple Browser 的限制：iframe 无法做网站登录认证，Google / GitHub / Stack Overflow 等站点打不开。
- 新内嵌浏览器绕开 iframe 限制：可登录、可浏览任意页面、自带 DevTools、支持认证。
- **命令**：`Browser: Open Integrated Browser`。
- **设置**：`workbench.browser.openLocalhostLinks`、`simpleBrowser.useIntegratedBrowser`。

### 1.110 —— Agent 浏览器操作工具

- 新设置 `workbench.browser.enableChatTools:true`，给 agent 一组操作内嵌浏览器的工具：
  - 页面导航：`openBrowserPage`、`navigatePage`
  - 自定义自动化：`runPlaywrightCode`
- agent 操作页面时能读取页面内容、console 错误与警告，开箱即用，无需额外依赖。
- 默认 agent 打开的页面跑在私有、内存态会话里；可显式把某个页面「共享」给 agent 以授予临时访问。
- 扩展作者向：Webview Panels / 自定义编辑器的 tab 图标现在可用 `ThemeIcon`（`webviewPanel.iconPath = new vscode.ThemeIcon('octoface')`）。

### 1.112 —— Integrated Browser 调试

- 内嵌浏览器现在支持**调试**：可设断点、单步、查看变量，全程不离开 VS Code。
- 新增 `editor-browser` 调试类型，支持 Launch 与 Attach 配置，兼容大部分 `msedge` / `chrome` 调试配置（迁移常常只需改 `launch.json` 里的 `type`）。
- UX 改进：右键上下文菜单；浏览器独立缩放级别（与 VS Code 窗口缩放解耦，按站点记忆）。
- agent / 工具生成的图片（如内嵌浏览器截图）可在 chat 中选中并在专用 image carousel 视图打开。

### 1.113 —— 自签名证书

- 内嵌浏览器支持使用自签名证书，便于本地 HTTPS 开发调试。

### 1.122 —— 设备模拟 & 截图进 Chat

- **设备模拟（Emulate devices）**：内置屏幕尺寸、移动端 / 触摸模拟、自定义 User-Agent 等；命令 **Show Emulation Toolbar**（从浏览器标签溢出菜单触发）。agent 也可通过 Playwright 代码触发设备模拟。
- **Add Screenshot to Chat**：把内嵌浏览器当前视口截图作为上下文附加到 chat，适合 UI / 布局调试。

## 检索脚本用法

```bash
# 默认扫 1.95~1.105，用内置关键字（browser/webview/chat/open in editor…）
python3 scripts/fetch_vscode_release_notes.py

# 指定版本 + 自定义关键字 + 上下文行数
python3 scripts/fetch_vscode_release_notes.py --minors 109,110,112,122 \
  --keywords "integrated browser,simple browser,open in editor" --context 3
```

数据源优先用 GitHub 上 `vscode-docs` 的 markdown 原文，超时则回退官网 `code.visualstudio.com/updates/v1_<minor>`。

## 来源

- VS Code v1.109 Release Notes — <https://code.visualstudio.com/updates/v1_109>
- VS Code v1.110 Release Notes — <https://code.visualstudio.com/updates/v1_110>
- VS Code v1.112 Release Notes — <https://code.visualstudio.com/updates/v1_112>
- VS Code v1.113 Release Notes — <https://code.visualstudio.com/updates/v1_113>
- VS Code v1.122 Release Notes — <https://code.visualstudio.com/updates/v1_122>
