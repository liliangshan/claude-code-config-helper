# VS Code 在编辑区打开网页：接口与版本演进笔记

> 整理自 VS Code 官方 release notes（1.109 ~ 1.122），数据来源见文末。
> 检索脚本：`scripts/fetch_vscode_release_notes.py`。

## 一句话结论

VS Code 里「在编辑区打开网页」有两套东西：

- **Simple Browser**（老）——基于 `<iframe>`，跨平台、最稳，但不能登录认证、Google/GitHub 等站点打不开。
- **Integrated Browser**（新，1.109 引入）——真正的内嵌浏览器（仅 desktop），可登录、带 DevTools、可调试、可被 agent 操作。

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
