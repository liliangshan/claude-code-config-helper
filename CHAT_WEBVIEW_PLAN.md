# 聊天 Webview 与解析器方案

> 目标：将本扩展从「Claude Code 配置助手」转型为 **「Claude Code 的替代/增强前端」**。
>
> 核心策略：不再依赖官方 Claude Code 扩展作为中介，而是由用户选择本机 CLI 路径，扩展直接启动 CLI，并默认通过 **stdio 长连接 + 双向 `stream-json`** 与之通信；Webview 自行渲染消息内容，包含文件引用点击跳转、代码块、diff、工具调用等能力。不复用 Anthropic 官方 Claude Code 源码与界面资源。
>
> 这意味着本扩展将从一个「配置管理工具」演进为一个**独立的聊天交互前端**，用户安装本扩展 + 本机 CLI 即可获得完整的 Claude Code 聊天体验，而不需要安装官方 VS Code 扩展。

---

## 1. 合规边界

参考目录：`/Users/lls/Downloads/claude-code-main`

- 该仓库 `LICENSE.md` 为 `© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service.`
- 非 OSI 许可证，不允许直接复制源码、UI 资源、文案、图标。
- 该目录主要是 docs / plugins / scripts，未发现 Webview/解析器实现代码；官方扩展实现位于另一个未开源的包。

允许做什么：

- 参考它的**产品行为清单**（哪些信息需要展示、哪些可点击、哪些需要权限确认）。
- 自行设计**自有的消息协议、解析规则、UI 组件**。
- 用户本机的 CLI 由用户自行安装与授权，由扩展通过用户提供的路径启动。

不允许做什么：

- 复制官方源码、样式、图标、动画、文案。
- 即使“改改”也属派生作品，存在版权风险。
- 在扩展元数据中使用让用户误以为是官方扩展的名称/图标。

---

## 1b. 方向决策：为什么从 HTTP Relay 转向 CLI + Webview

### 1b.1 现状：当前 V3 架构的局限性

当前项目（DEV_PLAN_V3）的架构是 **HTTP Relay 模式**：

```
用户 → 本扩展配置 UI → 写入 settings.json → 官方 Claude Code 扩展读取 env vars →
     → 官方扩展发 POST /v1/messages → 本扩展 HTTP 中转服务 → 上游 Provider API
```

这套架构在实践中暴露了以下问题：

| 问题 | 影响 |
|------|------|
| **强依赖官方扩展** | 官方扩展的视图 ID、API 端点、env var 名称都可能随版本变化而失效 |
| **settings.json 写入竞态** | 多个 VS Code 窗口同时写入 env vars 可能冲突 |
| **端口管理复杂** | leader/follower 竞选、端口冲突、心跳检测增加了维护成本 |
| **协议转换的脆弱性** | Anthropic ↔ OpenAI 的流式转换、错误映射等存在边缘 case |
| **用户无独立体验** | 无论如何配置，用户最终仍在官方扩展的 UI 中操作 |
| **命令行用户无法受益** | 只用 `claude` CLI 的用户与本扩展完全无关 |

### 1b.2 新方向：CLI + Webview 直连模式

```
用户 → 本扩展 Webview（右侧聊天面板）↔ ChatController ↔ CliProcess (stdio long-lived stream-json) ↔ 本机 CLI
```

这套新架构的核心优势：

| 优势 | 说明 |
|------|------|
| **零扩展依赖** | 不需要官方 Claude Code 扩展即可独立工作 |
| **零端口/零 HTTP** | 所有通信走进程 stdin/stdout，无端口冲突、无 HTTP 服务 |
| **完整 UI 控制权** | 从输入框到消息渲染全部自研，可自由定制 |
| **CLI 用户兼容** | 与 `claude` CLI 命令行的用户群完全重叠 |
| **替换粘贴链路的自然方案** | 不再需要 osascript / SendKeys 等脆弱方案 |

### 1b.3 两条路线的工作量对比

| 模块 | Relay 路线（V3 已实现） | Chat 路线（待实现） |
|------|------------------------|---------------------|
| HTTP 服务器 | 已完成（~500 行） | 不需要 |
| 协议转换器 | 已完成（~1500 行） | 不需要（CLI 自己处理） |
| Provider 管理 UI | 已完成（~800 行） | **可能需要保留**（如果 Chat 也要多 Provider）或删除 |
| settings.json 写入 | 已完成（~300 行） | 不需要 |
| CLI 进程管理 | 不需要 | ~400 行（新写） |
| Webview 聊天 UI | 不需要 | ~600 行（新写） |
| 流式解析器 | 不需要 | ~500 行（新写） |
| 替换粘贴链路 | 部分完成（脆弱的 osascript） | ~200 行（新写，但干净） |

**决策结论**：Chat 路线的初期开发成本较高，但长期维护成本和用户体验都优于 Relay 路线。本计划采用**渐进式迁移**策略——先在 Chat 路线中实现 MVP，与现有 Relay 路线双模式并存，待 Chat 成熟后再逐步废弃 Relay。

### 1b.4 风险评估与缓解措施

| 风险 | 等级 | 说明 | 缓解措施 |
|------|------|------|----------|
| **CLI 长连接探针失败** | 🔴 高 | 若 CLI 无法稳定使用 `--output-format stream-json --verbose --input-format stream-json`，则需要退回单次 `-p` 或重新评估架构 | 探针先行（第 4 节）；探针完成前不投入正式编码 |
| **node-pty native 依赖** | 🟡 中 | 若最终发现必须模拟真实终端，引入 native 模块会增加打包和跨平台兼容性风险 | 默认不走 PTY；PTY 仅作为实验兜底；使用 `@vscode/node-pty` 而非原版 |
| **流式渲染性能** | 🟡 中 | postMessage 高频更新时 Webview 可能卡顿 | 实现节流合并；长消息截断；后续引入虚拟列表 |
| **会话状态丢失** | 🟡 中 | Webview 关闭或 VS Code reload 后聊天历史丢失 | MVP 先明确告知用户；后续增加 sessionStorage 或磁盘持久化 |
| **对现有 Relay 资产的冲击** | 🔴 高 | 删除 relay/ 模块影响正在运行的 Provider 管理、LLS Task 注入功能 | 渐进式迁移：先双模式并存，确认 Chat 稳定后再删除 |
| **文件引用误报** | 🟡 中 | 正则匹配可能将版本号、URL 段误识别为文件路径 | MVP 只匹配 Markdown 链接形式；宁缺毋滥 |
| **用户学习成本** | 🟢 低 | 从官方扩展切换到本扩展需要适应新 UI | 保持交互风格与主流聊天工具一致；提供使用引导 |
| **多窗口 / 多 workspace** | 🟡 中 | 每个 VS Code 窗口启动独立 CLI 进程，资源消耗增加 | 每个窗口独立进程是合理行为；文档说明 |

### 1b.5 对现有 Relay 资产的处置原则

1. **先建后拆**：先实现 Chat 链路端到端可用，再考虑删除 Relay 代码
2. **双模式并存期**：配置项 `relay.enabled`（默认 true）保留；同时新增 `chat.enabled`（默认 false）；用户通过功能开关选择模式
3. **Provider 配置复用**：如果 Chat 模式仍需要多 Provider 路由能力，保留 Provider 管理 UI 作为可选基础设施；如果完全交给 CLI 自身处理，则 Provider UI 可以整体裁剪
4. **LLS Task 迁移**：任务流注入从 `relay/taskRequestInjection.ts` 迁移到 `chat/integration/taskFlowBridge.ts`，迁移期间两套同时维护
5. **清理时机**：当 Chat 用户占比 > 80% 或 Relay 代码超过 3 个月无实质性修改时，启动 Relay 代码删除流程

---

## 2. 总体架构

在正式编码前先做“CLI 通信探针”，确认目标 CLI 的真实交互方式。当前主方案已从旧的泛化通道设计调整为 **stdio 长连接 + 双向 `stream-json`**：默认启动参数为 `--output-format stream-json --verbose --input-format stream-json`。`-p/--print` 只作为单次探针/降级适配器，PTY 只作为最后的实验兜底。整体架构按“控制器 / 视图 / 会话 / CLI 适配 / 解析器”分层，避免 Webview 宿主承担过多业务逻辑。

```text
┌──────────────────────────────────────────────────────────────────┐
│ VS Code Extension Host (Node)                                    │
│                                                                  │
│  ┌────────────────┐  stdio long-lived        ┌────────────────┐   │
│  │ CliProcess     │ ◄──────────────────────►│ User-selected  │   │
│  │ (spawn)        │  stream-json JSON Lines  │ Claude CLI     │   │
│  └──────┬─────────┘                         └────────────────┘   │
│         │ raw chunks (text / JSON events)                        │
│         ▼                                                        │
│  ┌────────────────┐                                              │
│  │ CliStreamMux   │  把 stdout/stderr/JSON 事件分流              │
│  └──────┬─────────┘                                              │
│         ▼                                                        │
│  ┌────────────────┐  自研解析器：文本→结构化 ChatSegment[]       │
│  │ ChatParser     │                                              │
│  └──────┬─────────┘                                              │
│         ▼                                                        │
│  ┌────────────────┐                                              │
│  │ ChatController │  编排会话、CLI、解析器、任务流桥接            │
│  └──────┬─────────┘                                              │
│         ▼                                                        │
│  ┌────────────────┐  postMessage(ExtensionToWebview)             │
│  │ ChatViewHost   │ ◄──── onDidReceiveMessage (WebviewToExt) ─── │
│  └──────┬─────────┘                                              │
└─────────┼────────────────────────────────────────────────────────┘
          │
          ▼ Webview (HTML + 自有 JS)
┌──────────────────────────────────────────────────────────────────┐
│  Right-side Chat Panel                                           │
│   - 消息列表（流式追加）                                         │
│   - 自有 Markdown / 代码块 / diff / 文件引用渲染                 │
│   - 输入框（Enter 发送 / Shift+Enter 换行）                      │
│   - 工具调用 / 权限确认卡片（在 CLI 协议确认后实现）             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. 模块拆分

放在 `src/chat/` 下，与现有 `src/relay/`、`src/llsTask/` 同级。

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `chat/index.ts` | 注册命令 / ChatPanel |
| 控制器 | `chat/chatController.ts` | 统一编排视图、会话、CLI 生命周期、解析器、任务流桥接 |
| 会话 | `chat/chatSession.ts` | 维护消息列表、pending 状态、当前请求、内存历史 |
| 视图宿主 | `chat/chatViewHost.ts` | 创建 WebviewPanel（右侧），处理 postMessage，不直接承载任务流逻辑 |
| CLI 配置 | `chat/cli/cliConfig.ts` | 读取 `chat.*` 配置、解析 cwd/env、处理默认值 |
| CLI 管理 | `chat/cli/cliProcess.ts` | 用用户配置的 `cliPath` 启动长生命周期子进程，封装 stdin/stdout |
| CLI 选择 | `chat/cli/cliResolver.ts` | 首次启动弹文件选择器；校验可执行；持久化 |
| CLI 适配 | `chat/cli/cliAdapter.ts` | 屏蔽不同 CLI 的输入输出协议、权限响应、取消/重启语义 |
| ANSI 清理 | `chat/cli/ansiStripper.ts` | 清理 ANSI 控制序列、进度动画、光标移动等终端噪声 |
| 流分流 | `chat/cli/streamMux.ts` | 拆分 stdout/stderr/可能的 JSON-events |
| Markdown 切块 | `chat/parser/markdownChunker.ts` | 处理跨 chunk 的 fenced code block / markdown 片段 |
| 解析器 | `chat/parser/chatParser.ts` | 文本 → `ChatSegment[]` |
| 文件引用 | `chat/parser/fileRefScanner.ts` | 识别 `path:line:col` / `[file](path#L10)` |
| diff 识别 | `chat/parser/diffScanner.ts` | 识别 unified diff、hunk、增删行 |
| 工具事件 | `chat/parser/toolEvent.ts` | 工具调用 / 权限确认 / 进度状态 |
| 任务流桥接 | `chat/integration/taskFlowBridge.ts` | 在发送给 CLI 前注入诊断/任务流上下文，避免放入 View 层 |
| Webview 资源 | `media/chat/index.html` `media/chat/main.js` `media/chat/style.css` | 自有 UI |
| 协议 | `chat/protocol.ts` | 扩展侧与 Webview 共享的消息协议类型 |
| 类型 | `chat/types.ts` | ChatMessage / ChatSegment / CLI 状态等领域类型 |

建议职责边界：

- `ChatViewHost` 只负责 WebviewPanel 生命周期、HTML 加载、`postMessage` / `onDidReceiveMessage`。
- `ChatController` 负责接收 Webview 事件、调用 `ChatSession`、`CliAdapter`、`ChatParser`。
- `CliProcess` 只负责原始进程 IO，不理解 Claude 协议。
- `CliAdapter` 负责把通用“发送消息 / 取消 / 权限确认”映射成具体 CLI 输入。
- `taskFlowBridge` 在消息发送前处理任务流注入，不侵入视图层。

---

## 4. 阶段 0：CLI 通信探针

在实现正式 Chat MVP 之前，必须先验证目标 CLI 的真实通信方式，避免把 Webview 与解析器建立在错误假设上。

> 长连接通道不再额外执行本机 schema 探针；本计划直接参考官方 VS Code 扩展包 `/Users/lls/wwwroot/liliangshan/vcode/anthropic.claude-code-2.1.144-darwin-arm64` 的启动方式和 SDK-style stdio 流设计。后续实现以该包中原生 UI 启动 CLI 的方式为准。

### 4.1 探针目标

- 长连接主路径直接按官方 VS Code 扩展包 `2.1.144` 对齐：`--output-format stream-json --verbose --input-format stream-json`。
- 确认 `-p/--print` 是否可作为单次请求探针/降级路径，而不是主聊天路径。
- 确认 CLI 是否必须运行在真实 TTY / PTY 中；若非必要，不把 PTY 纳入默认实现。
- 采集 stdout/stderr 的真实输出：纯文本、Markdown、ANSI、JSON Lines、terminal UI、进度动画等。
- 多轮输入按官方扩展的 SDK-style stdio JSON Lines 设计实现；纯文本 stdin 只保留为 `-p` 降级路径验证。
- 确认取消方式：`SIGINT`、stdin 控制命令、CLI 专用取消协议，或只能重启进程。
- 确认权限提示是否有结构化事件；如果只是 TTY 文本提示，先不要抽象成权限卡片。
- 确认会话恢复、重启、退出码、stderr 输出的真实表现。

### 4.1a CLI 版本兼容性

- 探针阶段必须运行 `cliPath --version` 获取版本号，并与内置的最低版本要求比对。
- 定义 `MIN_CLI_VERSION` 常量（如 `"0.1.0"`），使用 semver 比较。
- 版本不满足时弹提示“当前 CLI 版本过低，请升级到 X.Y.Z 以上”，并禁用 Chat 功能（`chat.enabled` 视为 false）。
- 探针结果缓存到 `globalState`，避免每次启动都执行完整探针；但可提供命令 `claudeRouter.chat.reprobe` 手动重新探测。

### 4.2 探针产物

- 记录首个支持的 CLI 名称、版本、启动参数。
- 记录是否采用 `stdio` 长连接 `stream-json` 主路径；仅当该路径失败时，再记录是否需要 `pty`。
- 保存若干输出样例到测试 fixture，例如：
  - `fixtures/cli-output/plain-text.txt`
  - `fixtures/cli-output/markdown-stream.txt`
  - `fixtures/cli-output/ansi-progress.txt`
  - `fixtures/cli-output/permission-prompt.txt`
  - `fixtures/cli-output/error-exit.txt`
- 如果 stdio 长连接不可用，再评估单次 `-p` 降级或 `node-pty` 的 native 依赖、打包体积、跨平台兼容性。

### 4.3 MVP 约束

- 探针未证明存在结构化 tool/permission 事件前，MVP 只承诺文本输入、文本输出、错误提示、文件引用跳转。
- 默认使用 `stdio` 长连接 + 双向 `stream-json`；`-p/--print` 只用于探针和降级，PTY 只在长连接路径被证明不可用时考虑。
- 需要 PTY 时，先把 `pty` 标为实验能力，并增加 macOS / Windows / Linux 打包验证。

### 4.4 已验证探针快照（2026-05-23）

- Homebrew cask `claude-code 2.1.141` 已安装成功，实际命令为 `/opt/homebrew/bin/claude`。
- `claude --help` 已确认支持 `-p/--print`、`--output-format text|json|stream-json`、`--input-format text|stream-json`、`--replay-user-messages` 和 `--include-partial-messages`。
- 用户完成本机 Claude CLI 认证后，`text`、`json`、`stream-json` 和 stdin 文本输入探针已返回真实模型输出。
- 官方 Claude Code VS Code 扩展 2.1.144 的原生 UI 路径使用内置 binary，并以 `--output-format stream-json --verbose --input-format stream-json` 通过 stdio pipe 通信；因此本计划的主路径明确改为 **stdio 长连接双向 JSON 事件流**，不再把旧的泛化通道设计或单次 `-p` 作为主架构。
- 官方扩展启动长连接时还设置 `MCP_CONNECTION_NONBLOCKING=true`、`CLAUDE_CODE_ENABLE_TASKS=0`、`CLAUDE_CODE_ENTRYPOINT=claude-vscode`；本扩展实现时可作为兼容性参考，但不得复制官方源码或 UI 资源。
- 长连接 stdin `stream-json` 方向不再作为阻塞探针项；实现时直接参考官方扩展包的 SDK-style stdio 流约定，并通过 fake CLI / 后续集成测试验证本扩展封装是否正确。
- 仍需继续确认：`SIGINT`/取消行为、结构化 permission/tool 事件，以及更复杂 Markdown / code block / file reference fixture。

---

## 5. CLI 进程层

### 5.1 配置项（新增）

写入 `package.json` 的 `contributes.configuration`：

```jsonc
"claudeCodeConfigHelper.chat.cliPath": {
  "type": "string",
  "default": "",
  "scope": "machine-overridable",
  "description": "用户自选的 Claude 兼容 CLI 可执行文件绝对路径。"
},
"claudeCodeConfigHelper.chat.cliArgs": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "scope": "machine-overridable",
  "description": "启动 CLI 时附加的参数。"
},
"claudeCodeConfigHelper.chat.cliCwd": {
  "type": "string",
  "default": "",
  "scope": "resource",
  "description": "CLI 工作目录，默认为当前工作区根目录。"
},
"claudeCodeConfigHelper.chat.transport": {
  "type": "string",
  "enum": ["streamJsonStdio", "printStdio", "pty"],
  "default": "streamJsonStdio",
  "description": "与 CLI 的通信通道。默认使用 stdio 长连接双向 stream-json；printStdio 仅作为单次请求降级；pty 为实验兜底。"
},
"claudeCodeConfigHelper.chat.enabled": {
  "type": "boolean",
  "default": false,
  "description": "是否启用内置 Chat Webview。默认关闭，与双模式共存迁移策略保持一致，避免 CLI 路径未配置时启动报错。"
},
"claudeCodeConfigHelper.chat.cliEnv": {
  "type": "object",
  "default": {},
  "scope": "machine-overridable",
  "description": "启动 CLI 时附加的环境变量。注意不要在此保存敏感令牌。"
}
```

配置策略：

- `cliPath` 是本机路径，使用 `machine-overridable`，避免 Settings Sync 把 A 机器路径同步到 B 机器。
- `cliArgs` 可能包含本机路径或敏感参数，同样使用 `machine-overridable`。
- `cliCwd` 与工作区相关，使用 `resource`。
- `transport` 默认 `streamJsonStdio`，启动长生命周期 CLI 进程并保持 stdin 打开；`printStdio` 只用于单次 `-p` 探针/降级；只有探针确认必须 PTY 时才建议用户切到 `pty`。
- `cliEnv` 不默认持久化任何密钥；如果用户需要密钥，优先建议通过系统环境或 CLI 自身登录态解决。

### 5.2 CliResolver

- 读取 `cliPath`；若空：`vscode.window.showOpenDialog({ canSelectFiles: true })`。
- 校验：
  - 文件存在。
  - macOS/Linux 可尝试 `fs.access(path, X_OK)`。
  - Windows 不完全依赖 `X_OK`，结合扩展名、`PATHEXT`、试运行 `--version` 或探针命令判断。
  - 支持 shell shim / npm global binary / macOS app shim 的解析说明。
- 写入配置；下一次直接使用。
- 提供命令 `claudeRouter.chat.selectCli` 让用户随时更换。
- **`cliPath` 空值行为**：若 `cliPath` 为空（默认值），`ChatController` 在 `chat.open` 命令触发时自动调用 `CliResolver` 弹出文件选择对话框，引导用户选择 CLI 路径。用户取消选择则 Chat 面板不打开，不静默失败。
- 多工作区时，默认以当前活动编辑器所属 workspace folder 作为 cwd；无活动编辑器则使用第一个 workspace folder；无 workspace 时使用用户主目录或 CLI 所在目录。

### 5.3 CliProcess

- `transport=streamJsonStdio`：`child_process.spawn(cliPath, ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', ...cliArgs], { cwd, env })`，保持 stdin 打开，按 JSON Lines 监听 `stdout/stderr/exit`。
- `transport=printStdio`：仅用于探针或降级，按需启动 `claude -p --verbose --output-format stream-json` 单次进程，不作为主聊天会话。
- `transport=pty`：用 `node-pty`（若不引入新依赖，先以 `streamJsonStdio` 为准，后续按需切换）。
- 暴露：
  - `send(jsonLine: string)`：向长连接 stdin 写入一行 `stream-json` 消息；降级适配器可在内部把文本包装为单次 `-p` 请求。
  - `onChunk(cb)`：原始 chunk。
  - `onExit(cb)`：进程退出。
  - `cancel()`：优先按 `CliAdapter` 的取消策略执行，必要时发送 `SIGINT`。
  - `restart()`：释放旧进程并重新启动。
  - `dispose()`：终止进程。
- 不做端口监听，所有通信都走进程通道。

### 5.4 CliAdapter

`CliAdapter` 负责把扩展内部语义映射成具体 CLI 的输入输出协议：

```ts
export interface CliAdapter {
  start(): Promise<void>;
  sendUserMessage(text: string): Promise<void>;
  cancelCurrentRequest(): Promise<void>;
  restart(): Promise<void>;
  resolvePermission?(id: string, choiceId: string): Promise<void>;
  parseOutput(chunk: CliChunk): ParsedCliEvent[];
}
```

设计原则：

- `CliProcess` 不猜测权限、工具调用、JSON 协议。
- `CliAdapter` 默认实现 `StreamJsonCliAdapter`，围绕官方扩展包采用的长连接 `stream-json` 事件做输入包装、输出解析、会话状态维护。
- `PlainTextCliAdapter` / `PrintModeCliAdapter` 只作为探针或降级路径，不作为正式 Chat Webview 的主适配器。
- 只有探针证明 CLI 有结构化事件时，才实现对应的 `ToolEvent` / `PermissionEvent`。
- 如果 CLI 输出 terminal UI，先通过 `ansiStripper` 清理控制序列；无法可靠清理时才切换到 PTY 专用适配器。

---

## 6. 解析器（自研）

### 6.1 输出结构

```ts
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatSegment {
  kind:
    | 'text'
    | 'markdown'
    | 'code'
    | 'fileRef'
    | 'diff'
    | 'tool'
    | 'permission'
    | 'error';
  text?: string;
  language?: string;
  filePath?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  sourceText?: string;
  confidence?: 'low' | 'medium' | 'high';
  tool?: {
    name: string;
    status: 'pending' | 'running' | 'success' | 'failed';
    summary?: string;
    detail?: string;
  };
  permission?: {
    id: string;
    title: string;
    detail?: string;
    options: Array<{ id: string; label: string }>;
  };
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  segments: ChatSegment[];
  pending?: boolean;
  createdAt: number;
}
```

### 6.2 解析顺序

1. **按事件分流**：若 CLI 输出有 JSON-line 事件（如 `{"type":"tool_use",...}`），先按行 JSON 解析；否则按文本流处理。
2. **ANSI 清理**：对普通文本输出清理控制序列、光标移动、进度动画。
3. **Markdown 切片**：
   - fenced code block → `code`
   - 其他段落 → `markdown`
4. **行内扫描**：
   - 文件引用正则第一版候选：
     ```regex
     ((?:[A-Za-z]:)?(?:\.{0,2}/)?[\w./-]+\.[A-Za-z0-9]+)(?::(\d+)(?:[:-](\d+))?)?
     ```
   - 该正则只是候选扫描，不直接等价于可信文件路径。
   - `path:line:col` 中第三段优先解释为 column；只有明确范围语法（如 `#L10-L20`）才解释为 endLine。
   - 支持 `~/path`、Windows 反斜杠、中文路径、空格路径需要后续增强。
   - Markdown 链接形式 `[file.ts:42](src/file.ts#L42-L51)` 直接识别 `path` + `#Lx[-Ly]`。
   - ⚠️ **已知局限性**：
     - 只匹配带扩展名的文件（`*.ts`, `*.py`, `*.json` 等），**不含扩展名的路径**（如 `Dockerfile`、`Makefile`、`my_module/__init__`）全部漏匹配
     - `[\w./\-]` 字符集不支持中文路径和空格路径
     - 会产生误报：如 `npm install 1.2.3` 中的 `1.2.3`、`see doc v2.0` 中的 `v2.0` 会被误识别为文件
     - **MVP 策略**：宁缺毋滥——先只匹配 Markdown 链接形式 `[text](path#Lx)` 和明确的 `path/to/file.ts:42` 格式，降低误报率；不含扩展名的路径和中文路径在后续迭代中逐步增强
5. **diff 检测**：出现连续 `--- a/...` / `+++ b/...` / `@@ ... @@` → 整段标记为 `diff`。
6. **错误段**：来自 stderr 或包含 `Error:` / `Traceback` / 退出码非 0 → `error`。
7. **工具/权限事件**：仅在拿到结构化事件时生成；不靠纯字符串猜测。

### 6.3 解析器形态

- 纯函数：`parseChunk(state, chunk) => { state, segments }`
- 流式状态机：保留“未闭合的 code block / diff”等中间态。
- 不依赖任何第三方专用库；Markdown 渲染交给 Webview 用 `markdown-it` 或先用轻量自研渲染。

### 6.3b 流式增量渲染设计（关键复杂点）

流式渲染是本方案的核心复杂点。CLI 输出是源源不断的 chunk，解析器需要逐块处理并增量更新 Webview。

**chunk 生命周期**：

```
CLI stdout chunk → StreamMux → ChatParser.parseChunk(state, chunk)
                                        ↓
                              { newState, segments[] }
                                        ↓
                              ChatController 合并到 ChatSession
                                        ↓
                              postMessage({ type: 'message/patch', append: true })
                                        ↓
                              Webview 增量追加/更新 DOM
```

**关键挑战与方案**：

| 挑战 | 方案 |
|------|------|
| **跨 chunk 的 code block** | 状态机保留 `inFencedCodeBlock` 标记和 language 信息；新 chunk 到达时自动续接 |
| **跨 chunk 的 diff** | 状态机保留 `inDiffBlock` 标记和当前 hunk 缓冲区 |
| **高频 chunk 导致 postMessage 过载** | 实现 **消息合并队列**：50ms 窗口内多个 segments 合并为一次 `message/patch` 发送 |
| **Webview 侧 DOM 更新效率** | 使用 **insertAdjacentHTML** 追加而非整体 innerHTML 替换；消息条目使用骨架屏占位 |
| **ANSI 序列跨越多个 chunk** | StreamMux 层做 chunk 边界检测；不完整的 escape sequence 缓存到下一个 chunk |
| **JSON 事件被截断（半包）** | 按行缓冲 `\n` 分隔的 JSON；不完整的行等待下一个 chunk 拼接完整后再解析 |
| **非 UTF-8 或异常字节** | 使用 `TextDecoder('utf-8', { fatal: false })` 解码，忽略非法字节 |
| **stderr 与 stdout 交织** | StreamMux 按来源标记 chunk，即使交织也能按序插入到正确流中 |

**消息合并队列伪代码**：

> ⚠️ 注意：以下伪代码中的 `postMessage` 在 Extension Host 中不可直接使用。实际实现时，`ChatController` 需通过 `panel.webview.postMessage(...)` 发送。Webview 侧的 `postMessage` 是全局函数，只用于 `WebviewToExtension` 方向。

```ts
class MessagePatchQueue {
  private queue: Map<string, ChatSegment[]> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL = 50; // ms

  constructor(private postMessage: (msg: ExtensionToWebview) => void) {}

  push(messageId: string, segments: ChatSegment[]): void {
    const existing = this.queue.get(messageId) ?? [];
    this.queue.set(messageId, [...existing, ...segments]);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL);
  }

  private flush(): void {
    this.timer = null;
    for (const [id, segments] of this.queue) {
      this.postMessage({ type: 'message/patch', id, segments, append: true });
    }
    this.queue.clear();
  }
}
```

**Webview 侧增量渲染策略**：

- 每个 `ChatMessage` 对应一个 DOM 容器 `.chat-message[data-id="..."]`
- `message/append`：创建新容器并 append
- `message/patch`：找到对应容器，`insertAdjacentHTML('beforeend', renderedSegments)`
- 代码块和 diff 需要额外处理：如果前一个 patch 留下了未闭合的 `<pre><code>`，需要在续接时先修复 DOM 再追加新内容
- 长消息自动折叠：超过 2000 行的消息默认显示"显示全部"按钮

### 6.4 文件引用安全与校验

文件引用分两层处理：

1. 解析器只做候选识别，生成 `fileRef` segment。
2. 用户点击时由扩展侧 resolve + exists 校验。

扩展侧校验规则：

- 默认只允许打开 workspace folder 内文件。
- 多 root workspace 下，逐个判断目标路径是否位于任一 workspace folder 内。
- 相对路径按当前会话 cwd 或当前 workspace folder 解析。
- 绝对路径必须通过 allowlist 校验，不能直接打开任意系统文件。
- 拒绝 `javascript:`、`command:`、`data:text/html` 等伪路径或危险 URI。
- 对不存在文件给出提示，不在 Webview 内做文件系统访问。

---

## 7. Webview

### 7.1 注册方式

MVP 阶段优先只注册 **WebviewPanel**，降低生命周期与状态同步复杂度：

- **WebviewPanel**：通过命令 `claudeRouter.chat.open` 创建，`ViewColumn.Beside`，自动落在右侧。
- **WebviewView**：后续阶段再考虑注册到 Activity Bar 或 Secondary Side Bar。

如果后续同时支持 Panel 与 View，必须引入单例 `ChatSession`，多个视图只作为订阅者，避免重复启动 CLI 或消息分叉。

### 7.2 HTML 结构

```html
<div class="chat-root">
  <header class="chat-header">…</header>
  <main class="chat-list" data-role="messages"></main>
  <footer class="chat-input">
    <textarea></textarea>
    <button data-role="send"></button>
  </footer>
</div>
```

样式自有，使用 VS Code 主题变量（`--vscode-foreground` 等）。

### 7.3 安全

- `enableScripts: true`
- 严格 CSP：使用 `webview.cspSource` 和 `webview.asWebviewUri(...)`，不再使用旧的 `vscode-resource:` 表述。
- 只允许带 nonce 的脚本/样式，不允许任意 inline script。
- 所有用户/CLI 文本默认通过 DOM 文本节点写入；Markdown 渲染必须关闭 HTML 或做严格 sanitize。
- Webview 不直接执行文件系统操作，不直接打开外链，不直接执行 `command:` URI。

CSP 示例：

```text
default-src 'none';
img-src ${webview.cspSource} https: data:;
style-src ${webview.cspSource} 'nonce-${nonce}';
script-src 'nonce-${nonce}';
font-src ${webview.cspSource};
connect-src 'none';
```

Markdown 安全策略：

- `html: false`。
- 禁止或过滤 `javascript:`、`command:`、`data:text/html`。
- 外链点击统一发消息给扩展侧，由扩展侧使用 `vscode.env.openExternal`，必要时弹确认。
- 图片外链默认谨慎处理；如允许 `https:` 图片，应说明可能发生网络请求。
- 不把 CLI 原始输出直接赋给 `innerHTML`。

### 7.4 面板关闭行为

- 用户关闭 Webview 面板时，**不弹出"确认关闭"对话框**。VS Code 的 `WebviewPanel.onDidDispose` 已经给用户显式的关闭操作反馈（标签页消失）。
- 关闭后清理关联的 CLI 子进程和会话状态，避免后台残留。
- 如果会话中有正在进行的请求，关闭面板时应视为用户放弃该请求，自动执行 `CliProcess.cancel()` 或 `dispose()`。
- 恢复会话：只在下一次 `chat.open` 时从 `ChatSession` 持久化中读取历史，不自动恢复 Webview。

## 8. 消息协议（扩展 ↔ Webview）

```ts
// Extension → Webview
type ExtensionToWebview =
  | { type: 'session/init'; messages: ChatMessage[]; cliPath: string }
  | { type: 'message/append'; message: ChatMessage }
  | { type: 'message/patch'; id: string; segments: ChatSegment[]; pending?: boolean; append?: boolean }
  | { type: 'message/error'; id?: string; error: string; detail?: string }
  | { type: 'cli/status'; status: 'idle' | 'running' | 'exited' | 'error'; detail?: string }
  | { type: 'permission/request'; messageId: string; permission: ChatSegment['permission'] }
  | { type: 'composer/fill'; text: string; focus?: boolean }
  | { type: 'settings/open'; section?: string };

// Webview → Extension
type WebviewToExtension =
  | { type: 'webview/ready' }
  | { type: 'user/send'; text: string }
  | { type: 'user/cancel' }
  | { type: 'session/clear' }
  | { type: 'session/export' }
  | { type: 'file/open'; path: string; line?: number; endLine?: number }
  | { type: 'external/open'; href: string }
  | { type: 'permission/resolve'; messageId: string; permissionId: string; choiceId: string }
  | { type: 'permission/cancel'; messageId: string; permissionId: string }
  | { type: 'cli/restart' }
  | { type: 'cli/selectPath' }
  | { type: 'settings/open'; section?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
```

协议约定：

- 类型定义放在 `src/chat/protocol.ts`，扩展侧与 Webview 构建共享同一份 TypeScript 类型。
- `webview/ready` 触发 `session/init`，避免 Webview reload 后消息丢失。
- `message/patch.append === true` 表示把 segments 追加到已有消息；否则替换该消息的 segments。
- 每个用户请求内部保留 `requestId/sessionId`，便于取消、重启、日志关联。
- `pending=false` 表示该 assistant 消息流式输出结束。
- Webview 发来的所有路径、URL、日志文本都视为不可信输入，扩展侧必须二次校验。

文件打开实现：

```ts
const uri = await resolveWorkspaceFileUri(msg.path);
const doc = await vscode.workspace.openTextDocument(uri);
const sel = msg.line
  ? new vscode.Range(msg.line - 1, 0, (msg.endLine ?? msg.line) - 1, 0)
  : undefined;
await vscode.window.showTextDocument(doc, {
  selection: sel,
  preview: true,
  viewColumn: vscode.ViewColumn.One
});
```

Webview 永远只发送相对/绝对路径与行号，不做任何文件系统操作。`resolveWorkspaceFileUri` 必须执行第 6.4 节的 workspace allowlist 校验，不允许直接 `joinPath` 打开未经校验的绝对路径。

---

## 9. 渲染层（Webview 内）

- Markdown：`markdown-it`（MIT），开启 linkify、关闭 html。
- 代码高亮：`highlight.js`（BSD-3）或 Shiki（MIT）。
- diff：自渲染 `<pre>` + 行级 `+ / - / @@` 着色。
- 文件引用：把 `ChatSegment.kind === 'fileRef'` 渲染为：
  ```html
  <a class="file-ref" data-path="..." data-line="42">src/foo.ts:42</a>
  ```
  点击 → `postMessage({ type: 'file/open', ... })`。
- 工具卡片：折叠/展开，显示状态徽标。
- 权限卡片：按钮组直接发回 `permission/resolve`。

### 9.1 Webview 打包方案

当前项目以 `tsc` 为主，没有前端 bundler。若 Webview 引入 `markdown-it` / `highlight.js`，需要明确打包方式：

- MVP 可先不引入复杂高亮，仅使用 `<pre><code>` 和 CSS。
- 如使用 npm 依赖，建议新增轻量构建脚本，例如 `esbuild`：
  - `media/chat/main.ts` → bundle 到 `media/chat/main.js`
  - 禁止从 CDN 加载脚本。
- 确认 `.vscodeignore` / `package.json files` 不会排除 `media/chat/*`。
- **Webview 打包管线**：项目当前以 `tsc` 编译。Webview 侧的 `media/chat/main.ts` 需用 `esbuild` 额外打包为 `media/chat/main.js`（因为 `tsc` 不处理 import 合并）。建议在 `package.json` 中增加 `"build:webview": "esbuild media/chat/main.ts --bundle --outfile=media/chat/main.js"` 脚本，并在 CI 或 `vsce` prepublish 中调用。
- 第三方依赖许可证需要记录到 `NOTICE` 文件（如项目根目前无此文件，需新建）。
- Webview 资源全部通过 `webview.asWebviewUri` 引用。

---

## 10. 与现有项目的集成点

- 复用 `Logger`、`ConfigManager` 已有基础设施；新增 `chatConfigSlice` 读取 `chat.*` 配置。
- 命令在 `constants.ts::COMMANDS` 中新增：
  - `chat.open`
  - `chat.selectCli`
  - `chat.restart`
- 不与 `relay/` 端口逻辑互相依赖；聊天面板完全靠用户 CLI 启动，无需 Relay 端口。
- `extension.ts::activate` 中注册 `ChatController` / `ChatViewHost`；`deactivate` 中 dispose CLI 子进程。
- `llsTask` 相关能力通过 `chat/integration/taskFlowBridge.ts` 接入，不在 `ChatViewHost` 中直接写业务逻辑。

---

## 11. 类与方法注释规范（按全局要求）

按全局指令“所有的方法 类都加上注释”，新增模块统一使用 JSDoc：

- 类：用途、生命周期、典型调用方。
- 方法：参数、返回、副作用、异常情况。
- 与现有 `extension.ts` / `configView.ts` 的注释风格保持一致（中文 + `@param/@returns`）。

---

## 12. 实施步骤

> ⚠️ **硬性前提**：以下各阶段（1-9）均不得在「CLI 通信探针」完成前开始投入编码。
> 探针结果（第 4 节）可能回馈并修改以下步骤中的假设，例如 transport 类型、事件格式、取消机制。

1. **CLI 通信探针**（**前置条件，不可跳过**）
  - 按第 4 节验证目标 CLI 的 stdio 长连接 `stream-json`、输出格式、取消、权限提示；`-p` 和 PTY 只记录为降级/兜底路径。
   - 形成 fixture 与结论，再进入正式实现。
2. **配置 + 命令骨架**
   - `package.json` 新增 `chat.*` 配置项、命令、视图。
   - `constants.ts` 增加命令 id。
3. **CLI 选择 + 启动**
   - `cliResolver.ts` 弹窗选路径、写入配置。
  - `cliProcess.ts` 用 `--output-format stream-json --verbose --input-format stream-json` 启动用户 CLI 长连接，保持 stdin/stdout 双向 JSON Lines 通道。
4. **Webview 骨架**
   - 右侧 `WebviewPanel.createWebviewPanel(..., ViewColumn.Beside)`。
   - HTML + 输入框 + 消息列表 + 主题变量样式。
5. **消息协议联通**
  - `user/send` → 由 `StreamJsonCliAdapter` 包装成 CLI 接受的 stdin JSON Lines。
  - CLI stdout JSON Lines → 解析为 `text/markdown/tool/error` 等 segment，验证端到端流式。
6. **解析器接入**
   - 实现 `parseChunk`：先支持 `markdown` + `code` + `fileRef`。
   - Webview 渲染文件引用并支持点击跳转。
7. **diff / 错误 / 工具卡片**
   - 扩展解析器支持 diff/error，再加 tool 卡片（按 CLI 实际事件格式接入）。
8. **权限确认**
   - 仅当探针确认 CLI 有结构化权限事件时实现。
   - 解析 `permission` 事件 → Webview 卡片 → 回写 `permission/resolve`。
   - 如果 CLI 只是 TTY 文本提示，先保留为普通文本交互，不强行抽象权限卡片。
9. **健壮性**
   - CLI 异常退出自动提示、可一键重启。
   - 长输出截断 / 虚拟列表。
   - 取消正在进行的请求（写入 SIGINT 或 CLI 协议的取消指令）。

---

## 13. 替换现有“粘贴 + 系统级回车”链路

当前实现位于 [src/llsTask/paster.ts](src/llsTask/paster.ts)，由命令 `claudeRouter.pasteTaskFlowToClaude` / `claudeRouter.llsCcaiTask.continue` / `claudeRouter.testSimulateEnter` 触发，流程是：

1. `vscode.env.clipboard.writeText(prompt)` 写剪贴板
2. `vscode.commands.executeCommand('claude-vscode.focus')` 聚焦官方扩展的视图
3. `editor.action.clipboardPasteAction` 粘贴
4. `simulateEnterKeyAtSystemLevel()`：macOS `osascript`、Windows `PowerShell SendKeys`、Linux 不支持

这是“向官方 Claude Code 扩展的输入框塞内容并模拟系统回车”的旁路方案，缺点明显：

- 依赖官方扩展存在且视图 id 为 `claude-vscode`。
- 依赖 macOS 辅助功能权限 / Windows SendKeys 权限。
- 抢占用户剪贴板。
- Linux 无法自动回车。
- 任何前台焦点变化都会失败。

### 13.1 内置工具直接“填充并发送”

接入聊天 Webview 之后，所有这些内置工具（任务流、继续、测试）都改为：

```ts
chatController.appendUserMessageAndSend({
  text: prompt,
  source: 'llsCcaiTask.continue',
  autoSubmit: true
});
```

`ChatController.appendUserMessageAndSend` 内部：

1. 把消息推入会话状态：`ChatMessage{ role: 'user', segments: [{ kind: 'markdown', text: prompt }] }`。
2. `postMessage({ type: 'message/append', message })` → Webview 显示在消息列表里。
3. 调用 `taskFlowBridge.beforeSend(text)` 做任务流上下文注入。
4. 若 `autoSubmit`：通过 `CliAdapter.sendUserMessage(sendText)` 写入 CLI。
5. 不写剪贴板、不聚焦其它扩展、不调用 osascript / PowerShell。

如果调用方希望让用户先编辑再发送，可以走：

```ts
chatController.fillComposer({ text: prompt, focus: true });
```

Webview 收到 `{ type: 'composer/fill', text, focus }` 后把内容写入 `<textarea>`、可选聚焦，由用户决定何时按发送按钮或 Enter。

### 13.2 命令映射

| 旧命令 | 旧行为 | 新行为 |
|--------|--------|--------|
| `claudeRouter.pasteTaskFlowToClaude` | 剪贴板 + 粘贴 + 模拟回车 | `appendUserMessageAndSend({ text, autoSubmit: true })` |
| `claudeRouter.llsCcaiTask.continue` | 同上，附加“继续” | 同上，prompt 走任务流拼装 |
| `claudeRouter.testSimulateEnter` | 触发一次系统级回车做诊断 | 仅当用户仍想测试官方扩展旁路时保留；推荐废弃 |

### 13.3 可删除/收敛的代码

引入聊天面板并切换链路后，下列符号在内置工具路径上不再需要：

- [src/llsTask/paster.ts](src/llsTask/paster.ts)：`simulateEnterKeyAtSystemLevel` / `simulateEnterOnMac` / `simulateEnterOnWindows`
- [src/extension.ts](src/extension.ts) 中重复的 `simulateEnterKeyAtSystemLevel` / `simulateEnterOnMac` / `simulateEnterOnWindows`
- 对 `claude-vscode.focus` 的依赖
- `testSimulateEnter` 命令及 `sharedSettingsView` 里对应的测试按钮

迁移策略：

1. 先在 `ChatController` 提供 `appendUserMessageAndSend / fillComposer`。
2. `llsTask/paster.ts` 增加 `pasteToBuiltInChat()`，与 `pasteToClaudeCode()` 共存。
3. 配置项 `claudeCodeConfigHelper.taskFlow.target`：`builtinChat | externalClaudeCode`，**默认保留 `externalClaudeCode`**（向后兼容），通过 feature detection 决定是否显示 `builtinChat` 选项。
4. 提供命令 `claudeRouter.chat.forceExternalClaudeCode` 允许用户强制切回官方扩展。
5. 待用户稳定使用内置聊天后，再删除 osascript / PowerShell 实现与对应权限文案。
6. `paster.ts` 中增加 `isBuiltInChatAvailable(): boolean` 检测函数，自动降级。
7. 配置项 `taskFlow.target` 的默认值只有在 Chat 链路稳定运行 2 个以上发布版本后，才考虑改为 `builtinChat`。

**Feature detection 逻辑**：

```ts
function resolveTaskFlowTarget(config: Config, cliProcess: CliProcess | undefined): 'builtinChat' | 'externalClaudeCode' {
  const configured = config.taskFlow.target;
  if (configured === 'externalClaudeCode') return 'externalClaudeCode';
  if (configured === 'builtinChat') {
    // 只有 CLI 进程就绪时才使用内置聊天
    if (cliProcess?.isRunning()) return 'builtinChat';
    // CLI 未就绪时自动降级到官方扩展
    Logger.warn('taskFlow.target=builtinChat 但 CLI 未就绪，降级到 externalClaudeCode');
    return 'externalClaudeCode';
  }
  return 'externalClaudeCode'; // 兜底
}
```

### 13.4 与“不调用系统级回车”的对齐

- Webview 内 `<textarea>` 的回车由我们自己监听：Enter 发送，Shift+Enter 换行；这是 DOM 事件，不需要任何系统权限。
- 扩展 → CLI 的“发送”不是模拟键盘回车，而是向长连接 stdin 写入一行完整 `stream-json` 消息并以 `\n` 结束；如果降级到 PTY，才需要考虑写 `\r`。
- 整个链路里没有 `osascript` / `SendKeys` / `clipboard`，也就不再受系统辅助功能开关、前台焦点、键盘布局影响。

---

## 14. 移除内置 HTTP Relay

切到“扩展直接启动用户 CLI + Webview”后，原先的本地 HTTP 中转服务（监听 `127.0.0.1:port`，把 Claude Code 官方扩展的请求转发到上游 Provider）就不再需要：

- CLI 由我们启动并默认通过 stdio 长连接 `stream-json` 直连，不经过 Anthropic API/HTTP；PTY 仅作为实验兜底。
- 不再需要把 `ANTHROPIC_BASE_URL` 指到 `http://127.0.0.1:port`。
- 不再需要管理端口冲突、自动选端口、回写端口、状态栏 "CC Relay 端口/状态"。

### 14.1 待清理的模块

| 模块 | 现状 | 处理 |
|------|------|------|
| [src/relay/server.ts](src/relay/server.ts) | `RelayServer` HTTP 监听/状态机 | 删除 |
| [src/relay/router.ts](src/relay/router.ts) | `createRelayRouter` 路由分发 | 删除 |
| [src/relay/anthropicProxy.ts](src/relay/anthropicProxy.ts) | Anthropic 适配器 | 删除 |
| [src/relay/openaiChatProxy.ts](src/relay/openaiChatProxy.ts) | OpenAI Chat 适配器 | 删除 |
| [src/relay/openaiResponsesProxy.ts](src/relay/openaiResponsesProxy.ts) | OpenAI Responses 适配器 | 删除 |
| [src/relay/debugRecorder.ts](src/relay/debugRecorder.ts) | Relay 调试录制 | 删除（除非 Chat 也需要录制） |
| [src/relay/taskRequestInjection.ts] | 任务流请求注入 | 删除，逻辑迁移到 Chat 链路 |
| [src/relayStatusBar.ts](src/relayStatusBar.ts) | Relay 状态栏 | 删除 |
| `RELAY_STATE_KEY` / `DEFAULT_RELAY_PORT` / `RelayServerConfig` / `RelayStatus` | 在 [src/constants.ts](src/constants.ts) / [src/types.ts](src/types.ts) | 删除或缩减 |
| `ConfigManager.getRelayConfig / saveRelayConfig / normalizeRelay` | 持久化 Relay 配置 | 删除或在迁移期间标记 deprecated |
| `SettingsWriter.applyRelayConfig` | 把 `ANTHROPIC_BASE_URL=http://127.0.0.1:port` 写入 settings.json | 改为不再写入，或仅清理历史值 |
| 命令 `claudeRouter.restartRelay` | 重启 Relay | 删除 |
| 命令 `claudeRouter.refreshProviders / newProvider / editProviderItem / deleteProviderItem / setCurrentModel / clearCurrentModel` | 仅服务于 Relay 选模型 | Chat 模式下视情况保留：若仍要做 Provider 路由就保留，否则可裁掉 |
| 视图 `claudeRouter.providersView` | Provider 管理 UI | 同上 |

### 14.2 [extension.ts](src/extension.ts) 需要拆除的部分

- 模块级 `relayStatusBar / relayServer / currentRelayStatus`。
- `applySettingsSafely` 中关于 relay 端口的写入。
- `writeBackActualPort` 整个函数。
- `relayServer.setHandler(createRelayRouter(...))`。
- `relayServer.onStatusChange / restart / start / stop / dispose`。
- `relay.autoStart` 启动逻辑。
- `configManager.onChange` 回调里对 relay 状态的刷新。

`activate` 改成只做：

1. 初始化 `ConfigManager`（保留必要部分，去掉 relay 字段）。
2. 初始化 `ChatController / ChatViewHost`（按第 7 节）。
3. 初始化 `CliResolver / CliProcess / CliAdapter`（按第 5 节）。
4. 注册聊天命令（`chat.open / chat.selectCli / chat.restart`）。
5. 注册内置工具命令（任务流走第 13 节的填充并发送链路）。

`deactivate` 改成 dispose `ChatController / ChatViewHost / CliProcess`。

### 14.3 [settingsWriter.ts](src/settingsWriter.ts) 的处理

历史上写入了：

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
- `ANTHROPIC_AUTH_TOKEN=claude-code-relay`
- `claudeCode.disableLoginPrompt`
- `MANAGED_MARKER=claude-code-relay`

迁移策略：

1. 新版本启动时，如果检测到 `MANAGED_MARKER=claude-code-relay`，主动**清理**这几个键，避免用户官方扩展继续指向已经不存在的本地端口。
2. 不再写入 `ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN`。
3. `applyRelayConfig` 替换为 `cleanupLegacyRelaySettings()`，仅做一次清理。
4. 共享提示词、`extraEnvVars` 等与 Relay 无关的能力如需保留，迁到 Chat 模式的配置写入入口里。

### 14.4 [configManager.ts](src/configManager.ts) 与 [types.ts](src/types.ts) 的处理

- 删除 `RelayServerConfig / RelayStatus / RELAY_STATE_KEY / DEFAULT_RELAY_PORT`。
- `ConfigSnapshot` 中去掉 `relay / relayStatusText`。
- `WebviewMessage` 中删除 `saveClaudeSettings / saveRelayConfig` 等 Relay 相关消息类型，新增 Chat 相关消息（第 8 节）。
- Provider/Model 相关字段：
  - 如果未来 Chat 仍要在多 Provider 间路由，保留为“可选元信息”；
  - 如果完全交给用户自选 CLI，那么 Provider/Model 配置可以整体删除，UI 也相应裁剪。

### 14.5 [llsTask/](src/llsTask/) 与 Relay 的解耦

任务流目前是由 relay 在请求体里识别触发词 `GET_DIAGNOSTICS_TRIGGER_TOKEN` 并注入诊断数据；去掉 relay 后改为：

- 由 Chat 链路在“将用户输入交给 CLI 前”做同样的注入：
  - `taskFlowBridge.beforeSend(text)`：
    1. 调用 `llsTask/service.ts` 判断是否命中触发词；
    2. 若命中，把诊断数据拼到用户消息或追加成额外消息，再交给 `CliProcess.send`。
- `llsTask/autoContinue.ts / diagnostics.ts` 中提到 “relay will inject …” 的文案改为 “the chat host will inject …”。
- 删除 [src/relay/taskRequestInjection.ts] 后，所有调用方改为 `taskFlowBridge.beforeSend(text)`。

### 14.6 [package.json](package.json) 的处理

- `contributes.commands` 移除：`restartRelay`。
- `contributes.commands` 视情况移除：`refreshProviders / newProvider / editProviderItem / deleteProviderItem / setCurrentModel / clearCurrentModel`。
- `contributes.commands` 新增：`chat.open / chat.selectCli / chat.restart`。
- `contributes.views` 视情况移除 `providersView`，新增 Chat 视图入口（或仅以 WebviewPanel 提供）。
- `contributes.configuration` 移除 Relay 相关；新增 `chat.cliPath / cliArgs / cliCwd / transport`。
- `displayName / description / keywords` 更新为聊天面板形态（不要再以 “router/proxy” 为关键词）。

### 14.7 兼容与回滚

- 用户从旧版本升级上来：
  1. 第一次启动检测到 `MANAGED_MARKER=claude-code-relay`，弹一次性通知：“已移除本地中转服务，原 settings.json 中的 ANTHROPIC_BASE_URL 等条目已清理。”
  2. 不再读取 `RELAY_STATE_KEY`，迁移结束后可在下一个版本删除该 key 的清理代码。
- 回滚策略：保留 git 历史。双模式并存期间通过 `relay.enabled`（默认 true）和 `chat.enabled`（默认 false）控制，但并存期不超过 3 个发布版本，之后必须择一删除，避免长期分叉维护。

### 14.8 实施顺序（与第 12 节合并执行）

1. 先按第 12 节实现 Chat 链路（CLI 进程 + Webview + 解析器）。
2. **Chat 就绪检测**：通过探针结果 + 用户是否配置了 `chat.cliPath` + CLI 进程是否成功启动，综合判定 Chat 链路"就绪"。只有就绪后才激活 Chat 相关 UI 和命令。
3. 关闭 `relay.autoStart` 默认值，停止启动 HTTP 服务（避免 Chat 迁移期间 Relay 仍在处理请求，造成双重处理）。
4. 把 [llsTask/](src/llsTask/) 的触发注入从 relay 迁到 Chat 链路（此时 Relay 已停止运行，无双重处理风险）。
5. 在新版本里删除 [src/relay/](src/relay/) 与 [src/relayStatusBar.ts](src/relayStatusBar.ts)，配套清理 `extension.ts / configManager.ts / settingsWriter.ts / types.ts / constants.ts / package.json`。
6. 发布前再执行 [settingsWriter.ts](src/settingsWriter.ts) 的“清理历史 settings.json 条目”逻辑，避免用户官方扩展仍指向已经废弃的端口。
7. **分阶段默认值迁移**：
   - V1（Chat 首次发布）：`taskFlow.target` 默认 `externalClaudeCode`，`builtinChat` 作为可选值
   - V2（稳定验证后）：如果 telemetry 显示 Chat 使用率 > 80% 且无严重 issue，考虑将默认值改为 `builtinChat`
   - V3（最终态）：删除 `externalClaudeCode` 选项，仅保留 `builtinChat`

---

### 14.9 统一错误处理策略

系统级错误按以下层级处理：

1. **CLI 进程错误**（进程崩溃、启动失败、退出码非 0）：
   - `CliProcess` 捕获 `exit` 事件，通过 `ChatController` 向 Webview 发送 `message/error`（类型为 `cli/crash`），Webview 在消息列表顶部显示红色横幅："CLI 进程异常退出，点击重启"。
   - 启动失败时（如路径不存在、权限不足），弹 VS Code 原生错误通知。
2. **CLI 输出解析错误**（无法解析的行、JSON 解析失败）：
   - 解析器跳过该行，不阻塞后续流。原始文本作为 `text` segment 降级显示。
   - 统计解析失败率，超过阈值（如 5%）时向 Webview 发送 `cli/parseWarning` 提示。
3. **网络/代理错误**：
   - CLI 自身的网络问题（如 API 超时、代理配置错误）由 CLI 的 stderr 输出体现，解析器不额外包装。
   - 如果扩展检测到 `http_proxy`/`https_proxy` 环境变量未设置，而用户处于已知代理环境（通过 `globalState` 标记），可给出提示性通知。
4. **Webview 通信错误**（`postMessage` 失败）：
   - 扩展侧 `postMessage` 用 try/catch 包裹，失败时降级为 VS Code 原生消息提示。
5. **探针兼容性错误**（CLI 版本不满足、通信方式不匹配）：
   - 弹一次性通知，指向 `chat.enabled` 配置说明，建议用户使用 Relay 模式。
6. **LLS Task 注入错误**：
   - `TaskFlowBridge` 捕获注入异常，回退到 `paster.ts` 的旧路径（粘贴到官方扩展），保证用户任务不丢失。

所有错误应：
- 记录到 `Logger`（带 stack trace）。
- 通过 `ChatController` 统一上报到 Webview 显示（非 CLI 原始输出）。
- 不在 Webview 内直接 `console.error`。

---

## 15. 测试验证方案

### 15.1 单元测试

- `fileRefScanner.test.ts`
  - 相对路径、绝对路径、Windows 路径、中文路径、空格路径。
  - Markdown 链接、diff 路径、URL、包名、版本号误判。
  - `path:line:col` 与 `#L10-L20` 范围解析。
- `chatParser.test.ts`
  - 普通 Markdown。
  - fenced code block 跨 chunk。
  - diff 跨 chunk。
  - stderr 转 error。
  - JSON-line 半包 / 粘包。
  - ANSI 控制序列清理。
- `streamMux.test.ts`
  - stdout/stderr 顺序。
  - partial line。
  - 非 UTF-8 或异常 chunk。
- `cliResolver.test.ts`
  - 空路径。
  - 不存在路径。
  - Windows executable。
  - workspace cwd fallback。
  - 无 workspace 场景。
- `taskFlowBridge.test.ts`
  - 命中任务流触发词。
  - 未命中时不改写用户消息。
  - 诊断数据注入失败时的降级。

### 15.2 集成测试

提供 fake CLI：

- 回显输入。
- 分 chunk 输出 Markdown。
- 输出 code block。
- 输出 file ref。
- 模拟 stderr。
- 模拟退出码非 0。
- 模拟 permission request（仅用于结构化事件适配器验证）。

验证场景：

- `user/send` 能写入 fake CLI。
- CLI stdout 能增量 patch 到 assistant 消息。
- `file/open` 能打开 workspace 内文件。
- workspace 外路径被拒绝。
- `cli/restart` 清理旧进程并创建新进程。
- Webview reload 后通过 `webview/ready` 恢复内存会话。

### 15.3 手工验收矩阵

- macOS / Windows / Linux。
- 单 root / 多 root / 无 workspace。
- CLI path 为空首次选择。
- CLI path 不存在或无权限。
- CLI 进程崩溃。
- 长输出和超大 code block。
- 中文路径、空格路径。
- 权限不足路径。
- VS Code 主题切换。
- 离线环境。
- Webview reload / VS Code reload。

---

## 16. 隐私、日志与状态恢复

### 16.1 会话状态

- MVP 默认只保存内存会话，不把聊天内容写入磁盘。
- Webview reload 时从 `ChatSession` 内存恢复。
- VS Code reload 后默认不恢复聊天历史，除非用户后续明确启用。
- CLI 异常退出时，把当前 assistant 消息标记为 `pending=false` 并追加错误状态。

#### 16.1b 会话持久化策略

**问题**：Webview 在以下场景会被销毁：
- 用户关闭聊天面板
- VS Code 窗口 reload
- 系统内存不足时回收

如果 Webview 关闭后重开，当前内存会话全部丢失。分阶段解决：

| 阶段 | 策略 | 实现方式 |
|------|------|----------|
| **MVP** | 纯内存 + 用户提示 | Webview 关闭时不清除会话；通过 `webview/ready` 恢复；用户关闭面板时弹确认："关闭将丢失当前会话" |
| **V2** | sessionStorage 恢复 | 在 `ChatSession` 中将最近 N 条消息序列化，通过 `context.workspaceState` 持久化；VS Code 不重启时可恢复 |
| **V3** | 可选磁盘持久化 | 配置项 `chat.persistHistory`（默认 false）；启用时将消息写入 `${storagePath}/chat-history.json`；包含隐私提示 |

**状态恢复流程**：

```
VS Code reload / Webview reopen
  → ChatViewHost 创建 WebviewPanel
  → Webview 发送 'webview/ready'
  → ChatController 检查 ChatSession 是否有历史消息
    ├─ 有内存消息 → 发送 session/init 恢复显示
    ├─ 有 workspaceState 持久化消息 → 反序列化 → 发送 session/init
    └─ 无历史 → 发送空 session/init
  → CLI 进程重启（如果之前是运行状态）
  → 用户看到最后一条消息及提示："会话已恢复，CLI 已重新启动"
```

**隐私说明**：

- `chat.persistHistory` 默认关闭，内容不落盘
- 启用时在首次触发写入前弹一次性提示："聊天历史包含你的代码和对话内容，将写入扩展存储目录，请确保该目录仅你可访问"
- 用户可随时通过 `session/clear` 清除所有持久化历史

### 16.2 日志策略

- 默认不记录原始 CLI 输入输出。
- Debug raw log 必须由用户显式开启。
- 日志可能包含用户代码、路径、密钥、诊断信息，写入前要提示风险。
- 日志输出要做长度限制，避免把大段源码写进扩展日志。

### 16.3 输出限制

- 单 chunk 最大长度设限，超出后切分处理。
- 单条消息最大长度设限，超出后显示“已截断”。
- 长输出后续可引入虚拟列表，MVP 先用截断和折叠降低风险。
- 对异常高频输出做节流，避免 Webview `postMessage` 过载。

---

## 17. 多工作区与无工作区行为

- 多 root workspace：
  - CLI cwd 默认使用当前活动文件所属 workspace folder。
  - 文件引用 resolve 时遍历所有 workspace folder。
  - 同名相对路径命中多个 root 时，弹 QuickPick 让用户选择。
- 无 workspace：
  - 允许打开聊天，但文件引用跳转只允许用户显式选择或 CLI cwd 内路径。
  - 任务流诊断能力可能不可用，需要给出降级提示。
- 远程开发 / WSL：
  - CLI 路径属于远程扩展宿主环境，不是本机 UI 环境。
  - 文件选择、进程启动、路径校验都应遵循 VS Code extension host 所在环境。

---

## 18. 发布与兼容性

- 新增依赖前评估许可证、体积、native 模块打包风险。
- 若引入 `node-pty`，必须验证 VS Code Marketplace 打包、macOS arm64/x64、Windows、Linux 兼容性。
- `package.nls.json` / `package.nls.zh-cn.json` 补齐新增命令、配置项文案。
- README / CHANGELOG 更新 Chat Webview 使用方式、CLI 路径选择、隐私说明、已知限制。
- 扩展名称、描述、关键词避免让用户误认为官方 Claude Code 扩展。
- **网络/代理考虑**：CLI 自身的网络请求（API 调用）受其运行时环境变量（`http_proxy`/`https_proxy`/`NO_PROXY`）控制，扩展不直接插入或修改代理配置。但应记录探针阶段的网络可达性检测结果，在 CLI 启动失败时提示用户检查代理环境变量。如果 CLI 有内置的 proxy 配置选项，在探针阶段一并采集并记录到文档。
- 发布前执行类型检查、单元测试、Webview 手工验收。
