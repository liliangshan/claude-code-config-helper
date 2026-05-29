# 双 CLI 路由 + 主从模型协作改造设计

> 目标：把现有「主模型 + 专家 MCP 工具」的弱协作模式，改造成「常规模型常驻 + 专家模型常驻」的双 CLI 并行架构。
> 由前端的「路由类型」变量决定每条用户消息走哪条 CLI；常规模型识别到 `@llsExpert` 时切换路由，让专家 CLI 承接复杂任务。

---

## 1. 背景：当前的工作方式

为了把改造范围说清楚，先复盘当前实现。

### 1.1 单 CLI + 专家子进程

- 用户在 Chat Webview 里发送消息：`media/chat/index.html` 的 `composer-box`，前端走 `post({ type: 'user/send', ... })`，扩展宿主在 `extension.ts:1102` `case 'user/send'` 接收，最终通过 `streamJsonCliAdapter.sendUserMessage(text)` 写到唯一的 `cliProcess`（`src/chat/cli/cliProcess.ts` 的长生命周期 stream-json 子进程）。
- 整个扩展进程**只跑一条** Claude CLI 子进程，由 `cliProcess: CliProcess | undefined` 单例管理（`extension.ts:88` 附近）。
- 专家不是另一条独立 CLI，而是「主 CLI 通过 MCP 工具按需 spawn 出来的临时子进程」。链路：
  1. `chat.expertMode.*` 开启后，`ChatCliConfigService.getConfig()` 通过 `maybeInjectExpertMcpServer` 把 `llsExpert` 这个 stdio MCP server 注入到 `ChatCliConfig.mcpServers`（`src/chat/cli/cliConfig.ts:130` 附近）。
  2. 主 CLI 启动时把它通过 `--mcp-config` 参数传给 Claude CLI（`cliProcess.ts:appendMcpArgs` 行 ~390），主模型工具列表里因此多出 `mcp__llsExpert__ask_expert`。
  3. 主模型自己决定要不要调用 `ask_expert`。一旦调用，`expertMcpServer` 子进程通过 `fetch(LLS_EXPERT_RELAY_URL + '/__expert/run', ...)` 反向回调 Relay；Relay 路由 `src/relay/router.ts:294` 处接住，进而 `expertHandler.run(body, signal)` 调到 `ExpertRunnerService.run` → `ExpertRunner.run` → `createExpertCliProcessHost()` 临时 spawn 一条**专家 CLI**，跑完即 dispose。
  4. 专家 run 期间的事件通过 `chatViewHost.postMessage({ type: 'expert/event', event })` 推送给 webview，前端把它聚合到 `expertPanel`。
- 结论：**当前不存在两条常驻 CLI**，专家是「按需 spawn、跑完销毁」的一次性子进程，并且是否调用专家完全由主模型自己判断（基于工具描述与系统提示）。

### 1.2 专家模型选择 & 配置存储

- 专家模型选择由前端的「专家下拉」`data-role="expert-model-select"` 触发（`media/chat/main.js:623`），消息类型 `expert/model/select`。
- 扩展宿主侧 `extension.ts:1334 selectChatExpertModel(modelId)` → `saveExpertModelSelection(modelId)`：
  - 写入项目作用域 `chat.expertMode.project.enabled` / `chat.expertMode.project.model`（`ConfigurationTarget.Workspace`）
  - 同时写入全局作用域 `chat.expertMode.global.enabled` / `chat.expertMode.global.model`（`ConfigurationTarget.Global`）
- 读取由 `readExpertConfigFromVscode()`（`src/expertMode/expertConfig.ts:88`）按「项目 > 全局 > 默认」三层合并。
- 保存路径就是用户提到的「2 个地方」（项目 + 全局）。

### 1.3 当前模型选择（普通模型）

- 前端 `data-role="model-select"`（`media/chat/index.html:48`）是一个 `<select>` 下拉，列出全部 enabled provider 的全部 user-selectable 模型。
- 选中后前端 `post({ type: 'model/select', providerId, modelId })`，扩展宿主 `selectChatModel()` 会 `configManager.setCurrentModel(...)`，然后 `restartChatCli({ silent: true })` 重启唯一的那条 CLI 让 `--model providerId/modelId` 生效。

### 1.4 本地 HTTP（Relay）

- `RelayServer` 在 `extension.ts:2715` 创建，监听本地随机端口 `http://127.0.0.1:<port>`。
- 所有 Claude CLI 实例通过 env `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 把请求打回这个 Relay；Relay 内部按 `provider.apiType` 分发到 anthropic / openai-chat / openai-responses 三个 adapter，最终再访问真实 provider。
- 这条 Relay 已经被「主 CLI、专家 MCP 子进程、专家 CLI」共用，**不需要改架构层**——双 CLI 改造同样复用同一个 Relay 即可。

---

## 2. 改造目标

把上述「专家是被工具调出来的临时进程」改成「常规 + 专家两条常驻 CLI 并存，由路由变量决定本轮走哪一条」。具体要求（按用户原话拆解）：

1. **UI 重排**：
   - 把「专家模型」从输入框下方下拉改成**直接显示**（始终可见的常驻区域，不再藏在隐式的 `<select>` 里）。
   - 把「普通模型」原下拉改成**点击弹窗**（点击触发对话框/面板，里面分两栏：「普通任务模型」「专家任务模型」分别选择）。
2. **配置存储不变**：保持当前两个保存点
   - 普通模型：`chat.currentModel`（项目作用域，由 `configManager.setCurrentModel`）
   - 专家模型：`chat.expertMode.project.*` + `chat.expertMode.global.*`（项目 + 全局）
3. **启动时同时启动 2 条 CLI**：扩展激活后 ensureChatCliStarted 同时孵化「常规 CLI」和「专家 CLI」两条 stream-json 子进程。两条都接到同一条本地 Relay。
4. **路由类型变量**：宿主侧维护 `let activeRoute: 'normal' | 'expert' = 'normal'`。每条用户消息进来：
   - 默认走常规 CLI；
   - 常规 CLI 输出中检测到 `@llsExpert` 标记 → `activeRoute = 'expert'`，下一轮直接送给专家 CLI。
5. **常规模型的角色**：通过系统提示限制为只能做「编译、打包、git、PR、压缩上下文等基本操作」，遇到复杂任务必须回复 `@llsExpert` 触发专家。
6. **不动现有专家 MCP 工具链路**：路由切换在「主 CLI 之上」做，专家 MCP 工具（`ask_expert`）保持兼容关闭即可，避免双触发路径互相打架。

---

## 3. 设计总览

```
┌──────────────────────────── Webview (媒体层) ─────────────────────────────┐
│                                                                            │
│   header                                                                    │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │ LLS CLAUDE CHAT       │ Normal: <name>  · Expert: <name>            │  │  ← 顶部直接显示
│   │ status: running       │ [⚙ 选择模型]                                │  │  ← 点开打开弹窗
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│   messages                                                                 │
│   ...                                                                      │
│                                                                            │
│   composer                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  [textarea]                                                         │  │
│   │  [+]   [permission ▾]   [route badge: NORMAL / EXPERT]   [↑ Send]   │  │  ← 下面不再有模型下拉
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                       ║
                                       ║  user/send
                                       ▼
┌────────────────────────── 扩展宿主 (extension.ts) ───────────────────────┐
│                                                                          │
│  activeRoute: 'normal' | 'expert'   ← 模块级变量                           │
│                                                                          │
│  ┌──────────────────────────┐    ┌──────────────────────────┐            │
│  │  normalCliProcess        │    │  expertCliProcess        │            │
│  │  + StreamJsonCliAdapter  │    │  + StreamJsonCliAdapter  │            │
│  │  --model normalModel     │    │  --model expertModel     │            │
│  └──────────────────────────┘    └──────────────────────────┘            │
│             ║                              ║                              │
│             ╚════════════ shared ══════════╝                              │
│                            ▼                                              │
│   ┌────────────────────────────────────────────────────────────┐          │
│   │ RelayServer (http://127.0.0.1:<port>)                       │          │
│   │   /v1/messages  → adapter（anthropic / openai-chat / ...）  │          │
│   │   /__expert/run → 兼容保留，但路由侧默认不再触发它          │          │
│   └─────────────────────────────────────────────���──────────────┘          │
└──────────────────────────────────────────────────────────────────────────┘
```

关键点：
- **两条 CLI 共享同一条 Relay。** Relay 不需要分流，因为请求体里 `model = providerId/modelId` 已经显式标明走哪个上游。
- **路由切换发生在扩展宿主侧**，不在 Relay 内部。Relay 不感知 normal/expert 区别。
- **`@llsExpert` 检测只在 normal CLI 的输出流上做**；expert CLI 输出不再做检测，避免循环触发。

---

## 4. 配置层改造

### 4.1 沿用现有键，新增一个语义标记

| 键 | 作用域 | 用途 | 是否新增 |
|----|--------|------|----------|
| `claudeCodeConfigHelper.chat.currentModel` | resource | 普通任务模型（沿用 `configManager.setCurrentModel`）| ✗ |
| `claudeCodeConfigHelper.chat.expertMode.project.enabled` | resource | 专家任务模型启用开关 | ✗ |
| `claudeCodeConfigHelper.chat.expertMode.project.model` | resource | 专家任务模型 id（`providerId/modelId` 字符串）| ✗ |
| `claudeCodeConfigHelper.chat.expertMode.global.enabled` | application | 全局回退开关 | ✗ |
| `claudeCodeConfigHelper.chat.expertMode.global.model` | application | 全局回退模型 id | ✗ |

→ 用户要求「保存路口保存在现在的 2 个地方」，即继续：
- 普通模型保存于 `chat.currentModel`（项目级）；
- 专家模型同时保存于项目 + 全局两份（与 `saveExpertModelSelection` 行为一致）。

### 4.2 `expertMode.enabled` 语义重定义 + 旧专家 MCP 全量废弃

现在 `expertMode.enabled = true` 同时触发两件事：
1. 让 `ChatCliConfigService.getConfig` 把 `llsExpert` MCP server 注入主 CLI（→ 主模型工具列表多出 `mcp__llsExpert__ask_expert`）；
2. 让前端展示专家下拉「已选中」。

改造后：
- **`enabled` 仅表示「专家任务模型已选」**，不再控制 MCP 注入；它只决定「是否启动 expert CLI」与「webview 顶部专家名是否常驻显示」。
- **废弃整条 expert MCP / `ask_expert` / `/__expert/run` 链路**——所有相关源码与协议在本次改造中一并删除（不保留兼容）。删除清单：
  - `src/expertMode/expertMcpServer.ts`（stdio MCP 子进程脚本）
  - `src/expertMode/expertCliAdapter.ts`（按需 spawn 专家 CLI 的适配器）
  - `src/expertMode/expertRunner.ts` + `src/expertMode/expertRunnerService.ts`（专家执行状态机 + 组合根）
  - `src/expertMode/expertEvents.ts` + `src/expertMode/expertPromptBuilder.ts` + `src/expertMode/expertConstants.ts` 中与 `ask_expert` / `EXPERT_MCP_SERVER_NAME` / `EXPERT_TOOL_NAME` / `EXPERT_RELAY_*` 相关的全部常量、类型、辅助函数
  - `src/expertMode/__tests__/` 下面只测旧链路的用例
  - `src/expertMode/expertConfig.ts` 中的 `buildExpertConfig`（专家子进程派生配置，新方案由 `getDualConfigsWithRelayEnv` 替代）、`buildExpertMcpServerEntry`、`maybeInjectExpertMcpServer`（这三个直接整段删）
  - `src/relay/router.ts` 中的 `EXPERT_RELAY_PATH` 常量、`ExpertRelayHandler` / `ExpertRelayRunBody` / `ExpertRelayRunResult` 接口、`handleExpertRelayRun` 函数、`createRelayRouter` 的 `expertHandler` 参数与对应分支
  - `src/extension.ts` 中所有 `ExpertRunnerService` / `expertRunnerServiceRef` / `pendingExpertToolContext` / `expertHandler` 装配点（行号见附录）
  - `src/extension.ts` 中识别 `mcp__llsExpert__ask_expert` 工具调用的代码块（约 2304~2316 行附近的 ask_expert 工具上下文记录）
  - `src/chat/protocol.ts` 中的 `ChatExpertModelSelection`（保留，仍用于专家模型存储）以外，其它专家相关协议视情况调整：
    - `'expert/model/options'`、`'expert/model/select'`：**保留**，但前端入口从「composer 下拉」迁移到「模型弹窗」（详见 §7）
    - `'expert/event'` + `ExpertEventPayload`：**删除**（webview 不再渲染 `ExpertPanel`）
  - `media/chat/main.js` 中所有 `expertPanel*` / `expertEvent*` / `expertToolStream_*` 渲染逻辑，以及 `case 'expert/event'` 分支
  - `media/chat/style.css` 中专家面板配色与 `expertToolStream_*` 样式（保留 disabled 与边距规则的 fallback）
  - `media/chat/main.js` 与 `package.nls*.json` 中所有 `expertPanel*` / `expertEvent*` / `closeExpert` 相关 i18n key
  - `chat.expertMode.*` 这四个 key **保留**：仍用于持久化「专家任务模型」选择；`enabled` 改为「专家模型 id 非空时为 true」的衍生值
  - `EXPERT_MODE_DESIGN.md`：标记为「已废弃，被 `DUAL_CLI_ROUTING_PLAN.md` 取代」，文件本体保留作为历史记录

> 一刀切的好处：彻底消除「主模型自主调用 ask_expert」与「文本 `@llsExpert` 路由」两条触发路径并存的歧义；删除后 expert MCP server 子进程不再起、Relay 不再为它开后门、webview 不再渲染那个独立面板，新链路（`@llsExpert` 文本切路由 + 双 CLI）成为唯一专家入口。

---

## 5. 双 CLI 进程管理

### 5.1 新增模块级双实例

在 `extension.ts` 中：

```ts
// 把现有单例改为命名实例
let normalCliProcess: CliProcess | undefined;
let expertCliProcess: CliProcess | undefined;
let normalStreamJsonAdapter: StreamJsonCliAdapter | undefined;
let expertStreamJsonAdapter: StreamJsonCliAdapter | undefined;
let normalAdapterSubscription: vscode.Disposable | undefined;
let expertAdapterSubscription: vscode.Disposable | undefined;

// 路由变量
type ChatRoute = 'normal' | 'expert';
let activeRoute: ChatRoute = 'normal';
```

废弃单例 `cliProcess` / `streamJsonCliAdapter`（先保留兼容，逐步替换调用点）。

### 5.2 派生两个 ChatCliConfig

新增工厂 `buildDualLaunchConfigs(...)` 在 `chatCliConfig` 层：

```ts
// ChatCliConfigService 上加一个新方法
public async getDualConfigsWithRelayEnv(relayPort: number): Promise<{
    normal: ChatCliConfig;
    expert: ChatCliConfig | undefined;  // 未配置专家模型时返回 undefined
}> {
    const baseConfig = await this.getConfigWithRelayEnv(relayPort);

    // normal: 使用 chat.currentModel
    const normal: ChatCliConfig = {
        ...baseConfig,
        cliEnv: { ...baseConfig.cliEnv, LLS_CHAT_ROLE: 'normal' }
    };

    // expert: 用专家模型替换 model + ANTHROPIC_MODEL，同时移除 llsExpert MCP 注入
    const expertSelection = readExpertConfigFromVscode();
    if (!expertSelection.enabled || !expertSelection.model) {
        return { normal, expert: undefined };
    }
    const expert: ChatCliConfig = {
        ...baseConfig,
        model: expertSelection.model,
        cliEnv: {
            ...baseConfig.cliEnv,
            ANTHROPIC_MODEL: expertSelection.model,
            LLS_CHAT_ROLE: 'expert'
        },
        // 清理 expert MCP（即使 maybeInject 已经禁用，这里也兜底剥除）
        mcpServers: stripExpertServerFromMcp(baseConfig.mcpServers),
        strictMcpConfig: true
    };
    return { normal, expert };
}
```

> 注意 `model` 字段会被 `cliProcess.buildStreamJsonArgs` 转成 `--model <value>`，所以两条 CLI 启动参数自然不同。建议进一步把路由编码进本地 HTTP base path：normal 使用 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/normal`，expert 使用 `http://127.0.0.1:<port>/expert`。这样 Relay 可从 `POST /normal/v1/messages` / `POST /expert/v1/messages` 直接识别请求来源，`model` 只负责 provider/model 选择。
>
> path-based 本地 HTTP 路由可以替代 Relay 侧的显式 `LLS_CHAT_ROLE` / expert-mode 变量，因为 Relay 不能可靠读取发起请求的子进程 env，而 request path 是 HTTP 边界上的一等输入。它不能替代宿主侧 `activeRoute`：扩展仍需要该状态决定下一条用户消息走 normal 还是 expert，并驱动 UI 路由徽章与自动交棒状态机。
>
> 迁移期保留裸 `/v1/messages` 作为 normal 兼容入口；若 Claude CLI 未保留 `ANTHROPIC_BASE_URL` path prefix，则回退到现有 model/session/activeRoute 推断并记录 warning。

### 5.3 启动 / 重启 / 停止链路

替换 `startChatCliFromCurrentConfig()` 为 `startChatCliPair()`：

```ts
async function startChatCliPair(options: { forceRestart?: boolean } = {}): Promise<void> {
    const relayPort = await ensureRelayServerStarted();
    const { normal, expert } = await chatCliConfigService.getDualConfigsWithRelayEnv(relayPort);

    // resumeSessionId 单独处理：normal/expert 各自维护一份 sessionId 文件
    const normalLaunch = { ...normal, resumeSessionId: await chatCliSessionStore.readSessionId(normal.cwd, 'normal') };
    if (!options.forceRestart && normalCliProcess?.isRunningWithConfig(normalLaunch)) {
        // skip
    } else {
        await normalCliProcess?.stop();
        normalCliProcess = new CliProcess();
        await normalCliProcess.start(normalLaunch);
        rebuildNormalAdapter();
    }

    if (expert) {
        const expertLaunch = { ...expert, resumeSessionId: await chatCliSessionStore.readSessionId(expert.cwd, 'expert') };
        if (!options.forceRestart && expertCliProcess?.isRunningWithConfig(expertLaunch)) {
            // skip
        } else {
            await expertCliProcess?.stop();
            expertCliProcess = new CliProcess();
            await expertCliProcess.start(expertLaunch);
            rebuildExpertAdapter();
        }
    } else {
        await expertCliProcess?.stop();
        expertCliProcess = undefined;
        expertStreamJsonAdapter?.dispose();
        expertStreamJsonAdapter = undefined;
    }
}
```

`restartChatCli` 改为 `restartChatCliPair({ silent }: { silent?: boolean })`，内部并行重启两条。

### 5.4 SessionId 隔离

`ChatCliSessionStore` 现在只存一个 `chat-session.json`。改造：

- 新增可选 `kind: 'normal' | 'expert'` 参数（默认 `'normal'` 兼容旧调用）：
  - `chat-session.json` → 存 normal
  - `chat-session.expert.json` → 存 expert
- 这样两条 CLI `--resume` 各自的会话，避免互相覆盖。

> 必须分开存：normal 和 expert 是不同模型的不同 session_id，token budget 与压缩流程也按 sessionId 分桶。

### 5.5 Adapter 与 ParsedCliEvent 路由

`ensureStreamJsonCliAdapter` 拆成 `rebuildNormalAdapter()` / `rebuildExpertAdapter()`，每个内部都调用 `new StreamJsonCliAdapter(<其 cliProcess>, onPermissionDenied)`，并把 `event` 派发到 `handleParsedCliEvent(event, source: 'normal' | 'expert')`。

`handleParsedCliEvent` 增加来源参数：
- `source === 'normal'`：在 segments 文本里检测 `@llsExpert`（详见 §6）。
- `source === 'expert'`：直接渲染，不做任何路由检测；同时在消息上贴 `data-route="expert"`，前端视觉上区分（边框配色或角标）。

---

## 6. 路由控制（核心）

### 6.1 路由变量与流转

```
+-----------+    user/send     +------------------+
| Webview   | ---------------> | extension.ts     |
+-----------+                  | sendUserMessage  |
                               +--------+---------+
                                        |
                                        v
                                routeForNext(text)
                                  |
                                  +-- if text starts with '@llsExpert' or activeRoute=='expert'
                                  |       send to expertCliAdapter
                                  +-- else
                                          send to normalCliAdapter
```

判定规则：
1. 用户输入文本 trim 后以 `@llsExpert` 开头 → 强制走 expert，并把 `@llsExpert` 前缀剥除后再发送。
2. 否则按 `activeRoute` 走。
3. expert CLI 跑完一轮（`result` event）后，**不自动回退到 normal**。回退只发生在两种时机：
   - 用户在 webview 顶部按下「切回普通」按钮（手动）；
   - expert CLI 完整 finish 且其输出包含 `@llsNormal` 标记（可选第二阶段，避免一直锁定专家）。
4. 第一版只实现「normal → expert」单向自动跳转 + 手动切回，避免规则太复杂。

### 6.2 检测 `@llsExpert`（在 normal CLI 输出流上做）

在 `StreamJsonCliAdapter` 的 `onParsedEvent` 上挂一个轻量观察器（不要侵入 adapter 内部）：

```ts
// extension.ts
function watchNormalForExpertHandoff(event: ParsedCliEvent) {
    if (event.type !== 'segments') return;
    const text = event.segments.map(s => s.text ?? '').join('');
    if (containsExpertHandoff(text)) {
        switchRouteToExpert({ reason: 'normal-replied-handoff' });
    }
}

function containsExpertHandoff(text: string): boolean {
    // 单词边界匹配，避免误中代码片段或文件名
    return /(^|[\s,;:.!?])@llsExpert\b/i.test(text);
}
```

切换实现：

```ts
async function switchRouteToExpert(meta: { reason: string }) {
    if (activeRoute === 'expert') return;
    activeRoute = 'expert';
    Logger.info(`[route] switched to expert: reason=${meta.reason}`);
    await chatViewHost?.postMessage({ type: 'route/changed', route: 'expert' });
    // 把 normal CLI 最近一段输出做摘要后注入 expert CLI 作为 seed？
    // 第一版不做：让用户的下一条消息成为 expert 的输入，避免数据耦合。
}
```

> 关键：**切换是「下一条用户消息生效」**——当前正在流式的 normal 回复继续输出完，避免硬切流时 webview 显示一半。

### 6.3 `sendUserMessageToCli` 改写

```ts
async function sendUserMessageToCli(text: string, options: { hidden?: boolean } = {}): Promise<void> {
    // 用户主动以 @llsExpert 开头：强制 expert 并剥前缀
    let route: ChatRoute = activeRoute;
    let outgoing = text;
    const trimmed = text.trim();
    if (/^@llsExpert\b/i.test(trimmed)) {
        route = 'expert';
        activeRoute = 'expert';
        outgoing = trimmed.replace(/^@llsExpert\b\s*/i, '');
        await chatViewHost?.postMessage({ type: 'route/changed', route: 'expert' });
    }

    const adapter = route === 'expert' ? expertStreamJsonAdapter : normalStreamJsonAdapter;
    if (!adapter) {
        if (route === 'expert') {
            await appendAssistantSegments([{ kind: 'error', text: '\n未配置专家模型，无法走专家任务模型。请先在「选择模型」中选择专家模型。\n' }], true);
            return;
        }
        throw new Error('CLI adapter 未就绪');
    }

    activeAssistantMessageId = undefined;
    if (!options.hidden) {
        const assistantMessage = await createActiveAssistantMessage({ route });
        // ↑ assistant 气泡上贴 data-route, 前端按颜色/角标区分专家
    }
    await ensureChatCliStarted(); // 保证 pair 都启动
    await adapter.sendUserMessage(outgoing);
}
```

### 6.4 系统提示注入（限制 normal CLI 的能力）

normal CLI 启动参数追加 `--append-system-prompt <text>`，内容大致：

```
You are the **dispatcher model**. Your scope is limited to lightweight engineering chores:
- compile / build / test commands
- packaging tasks (bundling, version bumps, publishing dry-runs)
- git inspection (status, log, diff, blame)
- creating / commenting on / merging Pull Requests
- compacting / summarizing the running conversation context

If the user asks for anything else — code analysis, refactoring, debugging,
multi-step implementation, design proposals — you MUST reply with exactly
one short sentence containing the literal token `@llsExpert` followed by
a one-line restatement of the task. Do NOT attempt the work yourself.

Examples:
  user: "重构这个模块" → assistant: "@llsExpert 请重构 src/foo/bar.ts 中的模块。"
  user: "git status"  → assistant: <run git status>
```

Expert CLI 的系统提示则与现在 `buildExpertAppendedSystemPrompt` 类似，但去掉「不要再调用 ask_expert」（现在没有这个工具了），改成「你是被 dispatcher 切换路由后激活的高能力模型」。

`cliProcess.buildStreamJsonArgs` 已经支持把额外 `cliArgs` 透传，因此把 `--append-system-prompt <文本>` 由 `ChatCliConfigService` 在构造 normal/expert 各自的 `cliArgs` 时注入即可（或者新增 `appendSystemPrompt?: string` 字段，更显式）。

### 6.5 Token budget / 自动压缩

`TokenBudgetService` 现在按 sessionId 分桶——双 CLI 各自有不同 sessionId，自然分开统计；不需要改 budget 服务。

唯一要注意的：`createSessionResetter()` 当前只重启唯一 CLI。改造后两条 CLI 都可能各自触发压缩，所以要：
- 保留现在的 `sessionResetter`，把它绑定到 normal CLI；
- 给 expert CLI 单独再造一个 `expertSessionResetter`，注入到 expert 那条桶里；
- `TokenBudgetService` 已经按 sessionId 路由了，每个桶自带它自己的 resetter，不冲突。

实施时把现在的 `tokenBudgetService` 工厂调用改成两次 setup 即可（或者 service 本身扩展成「按 sessionId 注册不同 resetter」）。

---

## 7. UI 改造

### 7.1 顶部直显的「专家模型」+「点击弹窗」选择

`media/chat/index.html` `<header class="chat-header">` 内追加：

```html
<div class="chat-models" data-role="models-bar">
    <span class="chat-models__item">
        <span class="chat-models__label" data-i18n="modelsBarNormal">普通：</span>
        <span class="chat-models__name" data-role="normal-model-name">—</span>
    </span>
    <span class="chat-models__sep">·</span>
    <span class="chat-models__item">
        <span class="chat-models__label" data-i18n="modelsBarExpert">专家：</span>
        <span class="chat-models__name" data-role="expert-model-name">—</span>
    </span>
    <button type="button" class="chat-models__edit" data-role="open-model-picker"
            data-i18n="openModelPicker" title="选择模型">⚙</button>
</div>
```

`composer-toolbar__left` 中的 `<select data-role="model-select">` 与 `<select data-role="expert-model-select">` 直接删除（保留 permission-mode 与 token meter）。

### 7.2 模型选择弹窗

新建 webview 内置浮层 `<dialog>` 或绝对定位 `<div class="model-picker">`，结构：

```
┌─ 模型选择 ────────────────────────────────────────────────┐
│                                                            │
│  普通任务模型（compile / build / git / pr / 上下文压缩）  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  ◯ provider/model A   ← 当前                        │  │
│  │  ◯ provider/model B                                 │  │
│  │  ...                                                 │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│  专家任务模型（复杂分析、重构、设计、调试）                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  ◯ 关闭专家                                         │  │
│  │  ◯ provider/model A                                 │  │
│  │  ◉ provider/model B   ← 当前                        │  │
│  │  ...                                                 │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│   [取消]                              [保存并重启 CLI]    │
└────────────────────────────────────────────────────────────┘
```

实现要点：
- 模型列表来源不变：`postChatModelOptions()` + `postChatExpertModelOptions()` 已经把同一份 provider/model 列表推给前端。前端把它们渲染为两栏 radio。
- 「保存」点击 → 一次性发送两条已有协议消息：
  - `{ type: 'model/select', providerId, modelId }`（普通）
  - `{ type: 'expert/model/select', modelId }`（专家；`'' = 关闭`）
- 扩展宿主 `selectChatModel` 与 `selectChatExpertModel` 现在内部各自 `restartChatCli({ silent: true })`。改造后改为统一调度：仅在两次 select 都处理完之后调用 `restartChatCliPair({ silent: true })`，避免双重重启。

### 7.3 路由徽章（NORMAL / EXPERT）

`composer-toolbar__left` 增加：

```html
<span class="chat-route-badge" data-role="route-badge" data-route="normal">NORMAL</span>
```

收到扩展宿主 `{ type: 'route/changed', route }` 时切换 `data-route`，CSS 给两个状态不同的颜色（normal 偏中性、expert 偏强调色）。点击徽章可手动切回 normal（发送 `route/select { route: 'normal' }`）。

### 7.4 i18n key

新增：`modelsBarNormal` / `modelsBarExpert` / `openModelPicker` / `pickerTitle` / `pickerNormalSection` / `pickerExpertSection` / `pickerSave` / `pickerCancel` / `routeBadgeNormal` / `routeBadgeExpert` / `routeAutoSwitched` / `expertNotConfigured`。

---

## 8. 协议（Webview ↔ Extension）

### 8.1 新增/修改的扩展 → Webview 消息

```ts
// 新增
| { type: 'route/changed'; route: 'normal' | 'expert' }
| {
    type: 'models/snapshot';   // 取代分别推送的两个 model/options
    normalModels: ChatModelOption[];
    expertModels: ChatModelOption[];
    currentNormal: { providerId: string; modelId: string } | null;
    currentExpert: ChatExpertModelSelection;
  }
```

旧的 `model/options` 与 `expert/model/options` 短期内保留，前端先用 `models/snapshot` 渲染弹窗，等旧 webview 兼容期过后删除。

### 8.2 新增/修改的 Webview → 扩展消息

```ts
// 新增
| { type: 'route/select'; route: 'normal' | 'expert' }   // 用户手动切回
| {
    type: 'models/applyPair';
    normal: { providerId: string; modelId: string } | null;
    expert: { providerId: string; modelId: string } | null;  // null = 关闭
  }
```

`models/applyPair` 一次性下发两个选择，扩展宿主串行执行：
1. `configManager.setCurrentModel(normal)`
2. `saveExpertModelSelection(expert ? buildRoutedModelId(expert.providerId, expert.modelId) : '')`
3. `restartChatCliPair({ silent: true })`
4. `postModelsSnapshot()` 把最终状态推回 webview

旧的 `model/select` / `expert/model/select` 单独路径保留（手动切换某一边时仍可使用），但弹窗优先走新接口。

---

## 9. 兼容性 & 迁移（一刀切策略）

| 模块 | 改前 | 改后 | 处理 |
|------|------|------|------|
| `cliProcess` 单例 | 1 条 | 2 条（normal + expert） | 全局变量改名为 `normalCliProcess` / `expertCliProcess`，一次性替换所有引用 |
| `streamJsonCliAdapter` | 1 个 | 2 个 | 同上 |
| `expertMode.enabled` 触发 MCP 注入 | 主 CLI 内嵌 `ask_expert` | **彻底移除** | 删除 `buildExpertMcpServerEntry` / `maybeInjectExpertMcpServer` / `buildExpertConfig`；MCP 字典里不再出现 `llsExpert` |
| `/__expert/run` HTTP 路由 | Relay 暴露 + 鉴权 + 调用 ExpertRunnerService | **彻底删除** | router.ts 里 `EXPERT_RELAY_PATH` 分支整段移除；`expertHandler` 参数移除 |
| `expertMcpServer.ts` stdio 子进程 | 主 CLI spawn 出来作为 MCP server | **删除文件** | `out/expertMode/expertMcpServer.js` 编译产物随源码删除一起消失 |
| `ExpertRunner / ExpertRunnerService / ExpertCliProcessHost` | 临时 spawn 专家 CLI | **删除文件** | 新方案由常驻 `expertCliProcess` 直接走 stream-json，不需要状态机包装 |
| `'expert/event'` webview 协议 | 推送专家面板事件 | **删除** | webview 不再渲染独立的 `ExpertPanel`；专家输出走主聊天流，气泡上贴 `data-route="expert"` 标识 |
| `'expert/model/options'` / `'expert/model/select'` | composer 下拉单独刷新 | **保留**（入口迁移到模型弹窗） | 后端逻辑不变，只换前端触发位置 |
| sessionId 文件 | `chat-session.json` | `chat-session.json` + `chat-session.expert.json` | `ChatCliSessionStore` 增加 `kind` 参数；老文件保留作 normal session |
| 配置键 `chat.expertMode.*` | 控制 MCP 注入 + 选模型 | 仅控制选模型 | **键不删**，语义更窄：`enabled` 由 `model` 非空衍生 |

**没有 feature flag、没有过渡期**：升级即生效。旧版本 webview 配合新版本扩展时，因为 webview 资源是扩展自带的，不存在版本错配；唯一兼容点是用户的 `settings.json` 里若手动配过 `chat.mcpServers.llsExpert`（罕见），会被忽略——`stripExpertServerFromMcp` 在 `getDualConfigsWithRelayEnv` 中始终对 normal/expert 两条 CLI 都执行一次。

---

## 10. 实施分阶段

> 当前状态检查（2026-05-28）：本节按仓库当前代码状态标注完成度。
>
> 状态说明：`[x]` 已完成；`[~]` 部分完成 / 有残留；`[ ]` 未完成。
>
> - [x] **阶段 0：删除旧专家 MCP 链路（已完成）**
>   - [x] 已删除旧链路核心文件：`expertMcpServer.ts`、`expertCliAdapter.ts`、`expertRunner.ts`、`expertRunnerService.ts`、`expertEvents.ts`、`expertPromptBuilder.ts`。
>   - [x] 已删除旧链路专测文件：`expertIntegration.test.ts`、`expertMcpServer*.test.ts`、`expertRunner.test.ts`。
>   - [x] `src/expertMode/expertConfig.ts` 已只保留配置读取/合并逻辑，旧 `buildExpertConfig` / `buildExpertMcpServerEntry` / `maybeInjectExpertMcpServer` 已移除。
>   - [x] `src/relay/router.ts` 已移除 `/__expert/run` / `expertHandler` 旧 HTTP 路由。
>   - [x] `src/chat/protocol.ts` 已无 `expert/event` / `ExpertEventPayload`。
>   - [x] `src/chat/cli/cliAdapter.ts` 中识别 `mcp__llsExpert__ask_expert` / `ask_expert` 的输入处理代码已移除。
>   - [x] `src/expertMode/expertConstants.ts` 中只服务旧链路的常量已删除；`stripExpertServerFromMcp` 内联了 `LEGACY_EXPERT_MCP_SERVER_NAME` 字面量用于兜底剥除历史 settings 残留。
>   - [x] `EXPERT_MODE_DESIGN.md` 不存在于当前仓库，无需添加 deprecated 横幅（确认无需处理）。
>
> - [x] **阶段 1：宿主双进程（已完成）**
>   - [x] `src/chat/cli/cliConfig.ts` 新增 `getDualConfigsWithRelayEnv(relayPort)`，并定义 `DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT` / `DEFAULT_EXPERT_APPEND_SYSTEM_PROMPT` 默认 prompt 常量，支持通过 `chat.dispatcher.appendSystemPrompt` / `chat.expert.appendSystemPrompt` 覆盖。
>   - [x] `src/chat/cli/types.ts` 新增 `appendSystemPrompt?: string` 字段。
>   - [x] `src/chat/cli/cliProcess.ts` 的 `buildStreamJsonArgs` 已把 `appendSystemPrompt` 转换为 `--append-system-prompt` 启动参数（用户 `cliArgs` 已有时不重复注入）。
>   - [x] `src/chat/cli/sessionStore.ts` 新增 `kind: 'normal' | 'expert'` 参数，分别落盘 `chat-session.json` / `chat-session.expert.json`，向后兼容旧文件名。
>   - [x] `src/extension.ts` 模块级双实例 `normalCliProcess` / `expertCliProcess` + 双 `StreamJsonCliAdapter`，配套 `startChatCliPair` / `restartChatCliPair` / `stopChatCliPair`。
>   - [x] `activeRoute` 状态机已实现：normal CLI 输出 `@llsExpert` 自动切路由、用户消息前缀强制走专家、专家未配置时直接报错。
>   - [x] Token budget / 自动压缩按 sessionId 分桶，normal / expert 两条 CLI 各自注册 `SessionResetter`。
>
> - [x] **阶段 2：UI 重排（已完成）**
>   - [x] `media/chat/index.html` 顶部新增 `chat-models` 模型条 + 齿轮按钮 + 原生 `<dialog>` 模型选择弹窗；composer 内删除两个旧 `<select>`，新增 `data-role="route-badge"`。
>   - [x] `media/chat/main.js` 实现模型弹窗渲染 / 保存（一次性下发 `models/applyPair`）、路由徽章状态机（监听 `route/changed` 并允许点击发 `route/select`）、删除旧下拉绑定与 `ExpertPanel` 渲染代码。
>   - [x] `media/chat/style.css` 新增 chat-models / model-picker dialog / route-badge 样式。
>   - [x] `src/chat/protocol.ts` 新增 `ChatRoute`、`route/changed`、`route/select`、`models/snapshot`、`models/applyPair`。
>
> - [x] **阶段 3：测试 & 文档（已完成）**
>   - [x] 新增单元测试：`src/chat/__tests__/cliConfigDual.test.ts`（含 vscode stub）、`src/chat/__tests__/expertHandoff.test.ts`（含单词边界与代码片段误命中防御）、`src/chat/__tests__/sessionStoreKind.test.ts`（normal / expert 两条 session 互不串扰）。
>   - [x] `npm run typecheck` 通过，`npm test` 全部 58 个用例通过。
>   - [x] 已更新 `README.md`（新增「Dual CLI Routing」章节）与 `CHANGELOG.md`（2.0.23 条目）。
>   - [ ] 手动 QA 留给发版前交付到测试同学执行。

> 只描述拆分，不在这里写代码。

**阶段 0：删除旧专家 MCP 链路（先破后立）**
1. 新增分支 `feat/dual-cli-routing`。
2. 删除文件：`src/expertMode/expertMcpServer.ts`、`expertCliAdapter.ts`、`expertRunner.ts`、`expertRunnerService.ts`、`expertEvents.ts`、`expertPromptBuilder.ts`，以及 `src/expertMode/__tests__/` 下所有用例。
3. 清理 `src/expertMode/expertConfig.ts`：删 `buildExpertConfig` / `buildExpertMcpServerEntry` / `maybeInjectExpertMcpServer` / `stripExpertServerFromMcp`，仅保留 `resolveExpertConfig` + `readExpertConfigFromVscode`。
4. 清理 `src/expertMode/expertConstants.ts`：删除 `EXPERT_MCP_SERVER_NAME` / `EXPERT_TOOL_NAME` / `EXPERT_RELAY_*` / `EXPERT_*_TIMEOUT_MS` / `EXPERT_PERMISSION_MODE` 等只服务于旧链路的常量。
5. 清理 `src/relay/router.ts`：删 `EXPERT_RELAY_PATH` 常量、`ExpertRelayHandler` / `ExpertRelayRunBody` / `ExpertRelayRunResult` 接口、`handleExpertRelayRun` 函数，以及 `RelayRouterDeps.expertHandler` 字段与 `createRelayRouter` 中处理该路径的整段分支。
6. 清理 `src/extension.ts`：删 `ExpertRunnerService` import 与 `expertRunnerServiceRef` / `pendingExpertToolContext` 模块变量、`chatCliConfigService.setExpertRelayEnv` 调用、`expertHandler` 装配；删除识别 `mcp__llsExpert__ask_expert` 工具调用的上下文记录代码块（约 2304~2316 行）。
7. 清理 `src/chat/protocol.ts`:删 `'expert/event'` 消息类型与 `ExpertEventPayload`（保留 `ChatExpertModelSelection`、`'expert/model/options'`、`'expert/model/select'`,这三项继续给「模型弹窗」用）。
8. 清理 `src/chat/cli/cliConfig.ts`：从 `ChatCliConfigService.getConfig` 中移除 `maybeInjectExpertMcpServer` 调用与 `expertRelayBaseUrl` / `expertRelayAuthToken` 字段、`setExpertRelayEnv` / `getConfigWithCachedRelayEnv` 方法。
9. 清理 `media/chat/main.js`：删 `case 'expert/event'`、`expertPanel*` 渲染、`expertToolStream_*` 工具卡片注入；删 `closeExpert` / `expertPanel*` / `expertEvent*` 等 i18n key 与所有语言对应翻译。
10. 清理 `media/chat/style.css`：删除专家面板专用样式块（`expertToolStream_*` / `.expert-panel*`）。
11. 清理 `package.json`：四个 `chat.expertMode.*` 配置项**保留**（仍用于持久化「专家任务模型」选择），仅检查描述文案是否需要更新。
12. `EXPERT_MODE_DESIGN.md` 顶部加 `> Deprecated：本文档描述的 MCP 专家链路已在 v2.x 移除，新方案见 DUAL_CLI_ROUTING_PLAN.md` 说明，正文不动作为历史档案。
13. 跑 `npm run typecheck` 直至通过；提交「废弃 expert MCP 链路」单独一次 commit。

**阶段 1：宿主双进程**
14. 在 `src/chat/cli/cliConfig.ts` 新增 `getDualConfigsWithRelayEnv(relayPort)`，内部继续使用 `readExpertConfigFromVscode` 决定是否产出 expert config；同时把「剥除 mcpServers 中残留的 llsExpert 条目」（兼容用户历史 settings.json）作为通用步骤。
15. `ChatCliSessionStore` 增加 `kind: 'normal' | 'expert'` 参数（默认 `'normal'`），落盘文件分别为 `chat-session.json` / `chat-session.expert.json`。
16. `extension.ts` 模块级双实例 `normalCliProcess` / `expertCliProcess` + 双 `StreamJsonCliAdapter`；新增 `startChatCliPair / restartChatCliPair / stopChatCliPair`，`ensureChatCliStarted` 内部一次性保证两条都起来（专家未配置时只起 normal）。
17. `sendUserMessageToCli(text)` 按 `activeRoute` + `@llsExpert` 前缀分流；`createActiveAssistantMessage({ route })` 在气泡上贴 `data-route`，前端按颜色/角标区分专家。
18. `handleParsedCliEvent(event, source: 'normal' | 'expert')`：`source==='normal'` 时检测 `@llsExpert` 自动切路由（详见 §6.2）。
19. 系统提示注入：在 `getDualConfigsWithRelayEnv` 里给 normal 的 `cliArgs` 追加 `--append-system-prompt <dispatcher 限制>`，给 expert 追加 `--append-system-prompt <专家声明>`；提示文案允许通过 `chat.dispatcher.appendSystemPrompt` / `chat.expert.appendSystemPrompt` 两个新配置覆盖。
20. 一次性替换历史 `cliProcess` / `streamJsonCliAdapter` 全局引用为 `normal*`；`restartChatCli` 路由到 `restartChatCliPair`。

**阶段 2：UI 重排**
21. Webview HTML：`<header>` 加直显模型条（普通名 · 专家名）+ 齿轮按钮；composer 内删除 `data-role="model-select"` 与 `data-role="expert-model-select"` 两个 `<select>`；composer 加路由徽章 `data-role="route-badge"`。
22. 新增「模型选择弹窗」组件：原生 `<dialog>` + 两栏 radio（普通任务模型 / 专家任务模型）+ 保存/取消按钮。
23. 协议层加 `'route/changed'`、`'route/select'`、`'models/snapshot'`、`'models/applyPair'`。
24. 弹窗保存 → 一次性下发 `models/applyPair` → 扩展宿主串行 `setCurrentModel` + `saveExpertModelSelection` + `restartChatCliPair`，避免双重重启。
25. 路由徽章点击 → `route/select { route: 'normal' }` 手动切回 normal。

**阶段 3：测试 & 文档**
26. 单元测试：`getDualConfigsWithRelayEnv`（含 expertMode 关闭时不产出 expert）、`@llsExpert` 检测正则（含单词边界、误命中代码片段）、`@llsExpert` 前缀剥除。
27. 集成测试：双 CLI 启动 → normal 输出包含 `@llsExpert` → 下一条消息走 expert；`@llsExpert` 强制走专家；专家未配置时 toast 报错且 `activeRoute` 不切换。
28. 手动 QA 用例（见 §12）。
29. `README.md` 加「双 CLI 路由」章节；`CHANGELOG.md` 加版本条目；`EXPERT_MODE_DESIGN.md` 已在阶段 0 标 deprecated。

---

## 11. 失败模式 & 回退

| 场景 | 现象 | 回退 |
|------|------|------|
| expert CLI 启动失败（路径错、拒绝 spawn）| `expertCliProcess` undefined，路由切到 expert 时报错 | UI toast「专家未启动」+ 自动 `activeRoute='normal'`，下一条仍走 normal |
| normal CLI 输出里包含代码片段误命中 `@llsExpert` | 误切换 | 用单词边界正则 `(^|[\s,;:.!?])@llsExpert\b`；切换前在 webview 显示「检测到切换标记，下一条走专家」浮条，给用户 5s 内撤销机会（Phase 2 优化） |
| expert 模型未配置 | 用户主动 `@llsExpert` 时 `expertCliProcess` 不存在 | 直接报错 toast，不切换，不影响 normal 会话 |
| 两条 CLI 并发耗资源 | 内存翻倍 | 在「专家模型未选」时不启动 expert CLI（§5.3 已处理） |
| Relay 重启 | 两条 CLI 都需要刷新 `ANTHROPIC_BASE_URL` | `ensureRelayServerStarted` 后调用 `restartChatCliPair({ silent: true })` |

---

## 12. QA 用例

1. **冷启动 + 默认路由**：扩展激活 → 两条 CLI 启动 → 发送 `git status` → normal CLI 应执行并返回结果，路由保持 `normal`。
2. **触发自动切换**：发送 `请帮我重构这个文件` → normal CLI 回复一句 `@llsExpert 请重构 ...` → webview 路由徽章变 EXPERT → 用户再发任意消息 → 走 expert CLI。
3. **强制走专家**：发送 `@llsExpert 给我一个 b-tree 的实现` → 直接走 expert，且 `@llsExpert` 前缀已被剥除。
4. **手动切回**：点徽章 → 路由恢复 normal。
5. **专家未配置**：弹窗里专家选「关闭」→ 重启 CLI → expertCliProcess 不存在 → `@llsExpert` 强制时 toast 报错。
6. **配置持久化**：重启 VS Code，弹窗里两个选择仍是上次保存值；项目设置文件里两组 key 都更新。
7. **Token 压缩**：让 normal 自动压缩、expert 自动压缩各自跑一次，确认两个桶互不干扰。
8. **与现有 expertMcpServer 共存**：旧版本 webview 升级前打开新扩展 → MCP 工具不再注入，老的 `/__expert/run` 路由仍能 401（鉴权 token 一致时返回 200，跑老的专家 runner，但主 CLI 现在不会触发它）。

---

## 13. 待评审的取舍

| 取舍点 | 选项 A | 选项 B | 倾向 |
|--------|--------|--------|------|
| `@llsExpert` 命中后是否携带 normal 输出作为 seed 给 expert | 是（更连贯） | 否（用户的下一条 user 消息为入口，避免上下文耦合） | **B**（第一版） |
| expert 跑完是否自动 fallback 回 normal | 是（自动） | 否（用户手动切） | **否**，避免规则太复杂；用户随时点徽章切回 |
| `expertMode.enabled` 是否复用现有键 | 是 | 新加键 `chat.routes.expert.enabled` | **是**（不破坏现有用户配置） |
| 普通模型保存键 | 沿用 `chat.currentModel` | 改名 `chat.routes.normal.model` | **沿用** |
| 老的 `/__expert/run` MCP 链路 | 直接删除 | 保留兼容 | **直接删除**——一刀切，新方案是唯一专家入口 |
| Webview 弹窗实现 | 原生 `<dialog>` | 自定义浮层 | 原生 `<dialog>` 简单、无障碍属性自带，**优先**；如样式与扩展主题不一致再换 |

---

## 14. 文件级改动清单（汇总）

> 实施时按阶段提交，避免一次大 diff。

**新增 / 修改：**
- `package.json`：保留所有 `chat.expertMode.*` 键；新增 `claudeCodeConfigHelper.chat.dispatcher.appendSystemPrompt` / `claudeCodeConfigHelper.chat.expert.appendSystemPrompt` 两个可选字符串配置（允许用户覆盖默认 prompt）。
- `src/constants.ts`：增加 `CHAT_ROUTE_DEFAULT` / `CHAT_DISPATCHER_PROMPT_KEY` / `CHAT_EXPERT_PROMPT_KEY`；删除 `EXPERT_MCP_SERVER_NAME` / `EXPERT_TOOL_NAME` 等只服务旧链路的导出。
- `src/chat/cli/types.ts`:在 `ChatCliConfig` 加 `appendSystemPrompt?: string` 字段；保留 `ExpertModeConfig`（仍用作模型选择存储）。
- `src/chat/cli/cliConfig.ts`：新增 `getDualConfigsWithRelayEnv`；移除 `expertRelayBaseUrl` / `expertRelayAuthToken` / `setExpertRelayEnv` / `getConfigWithCachedRelayEnv` / `maybeInjectExpertMcpServer` 调用；从 `getConfig` 中读两段 prompt。
- `src/chat/cli/cliProcess.ts`：在 `buildStreamJsonArgs` 中支持把 `config.appendSystemPrompt` 转成 `--append-system-prompt`（已有用户 cliArgs 透传，缺失时由 config 注入）。
- `src/chat/cli/sessionStore.ts`：`readSessionId(cwd, kind?)` / `writeSessionId(cwd, sessionId, kind?)` / `clearSessionId(cwd, kind?)`，默认 `kind='normal'`。
- `src/chat/protocol.ts`：增加 `ChatRoute`、`'route/changed'`、`'route/select'`、`'models/snapshot'`、`'models/applyPair'`；删除 `'expert/event'` 与 `ExpertEventPayload`。
- `src/extension.ts`：双 CLI 模块级变量、双 adapter 装配、`startChatCliPair / restartChatCliPair / stopChatCliPair`、`activeRoute` 状态机、`@llsExpert` 检测、`sendUserMessageToCli` 路由分支、新协议消息处理、模型 snapshot 推送、路由 toast；删除 `ExpertRunnerService` 引入与所有装配点、`pendingExpertToolContext`、识别 `mcp__llsExpert__ask_expert` 的代码块、`chatCliConfigService.setExpertRelayEnv` 调用。
- `src/relay/router.ts`：删 `EXPERT_RELAY_PATH` / `ExpertRelayHandler` / `ExpertRelayRunBody` / `ExpertRelayRunResult` / `handleExpertRelayRun` / `RelayRouterDeps.expertHandler`。
- `src/expertMode/expertConfig.ts`：仅保留 `resolveExpertConfig` + `readExpertConfigFromVscode` + 工具函数；删除 `buildExpertConfig` / `buildExpertMcpServerEntry` / `maybeInjectExpertMcpServer` / `stripExpertServerFromMcp`（后者搬到 `cliConfig.ts` 内部用作残留清理）。
- `src/expertMode/expertConstants.ts`：删除 `EXPERT_MCP_SERVER_NAME` / `EXPERT_TOOL_NAME` / `EXPERT_RELAY_*` / `EXPERT_*_TIMEOUT_MS` / `EXPERT_PERMISSION_MODE` 等。
- `media/chat/index.html`：header 加模型条 + 齿轮按钮、加模型选择 `<dialog>`、删除 composer 内两个 `<select>`、加路由徽章。
- `media/chat/main.js`：模型弹窗组件、路由徽章状态机、协议适配；删除所有 `expertPanel*` / `expertEvent*` / `expertToolStream_*` 渲染逻辑、`case 'expert/event'` 分支、`closeExpert` / `expertPanel*` / `expertEvent*` i18n key 与各语言对应翻译。
- `media/chat/style.css`：模型条 + 弹窗 + 徽章样式；删除 `expertToolStream_*` / `.expert-panel*` 样式块。
- `package.nls.json` / `package.nls.zh-cn.json`：新 i18n key（snapshot / picker / route badge / route handoff toast / not configured）。

**删除文件（整个文件移除）：**
- `src/expertMode/expertMcpServer.ts`
- `src/expertMode/expertCliAdapter.ts`
- `src/expertMode/expertRunner.ts`
- `src/expertMode/expertRunnerService.ts`
- `src/expertMode/expertEvents.ts`
- `src/expertMode/expertPromptBuilder.ts`
- `src/expertMode/__tests__/` 下所有专测旧链路的用例

**文档：**
- `EXPERT_MODE_DESIGN.md`：顶部加 deprecated 横幅，正文保留作历史档案。
- `README.md`：加「双 CLI 路由」章节。
- `CHANGELOG.md`：新增条目「移除 expert MCP / `ask_expert` 工具，引入双 CLI 路由」。

---

## 15. 与现有 README 的衔接

`README.md` 现在主推「Claude 模型路由」，加一节「双 CLI 路由」介绍：

```
## 双 CLI 路由（v2.x.x+）
- 普通模型与专家模型现在可以同时常驻，由前端「路由徽章」与 `@llsExpert` 标记控制走向。
- 在聊天面板顶部点齿轮按钮，分别选择「普通任务模型」与「专家任务模型」。
- 普通模型负责轻量工程操作（编译、打包、git、PR、压缩上下文），遇到复杂任务回复 `@llsExpert` 自动切换。
- 你也可以直接以 `@llsExpert ...` 开头强制走专家。
```

---

## 16. 旧专家 MCP（`ask_expert`）链路废弃说明

- 旧链路核心：主 CLI 通过 `--mcp-config` 拉起 `expertMcpServer.js` 这条 stdio MCP server，主模型工具列表里出现 `mcp__llsExpert__ask_expert`；模型自主调用后，子进程通过 `fetch(ANTHROPIC_BASE_URL + '/__expert/run')` 反向回调扩展宿主，再 spawn 一条临时专家 CLI（`ExpertRunner / ExpertRunnerService`），跑完即销毁。
- 该链路在本次改造中**整段废弃并删除**：
  - 删除源码：`expertMcpServer.ts`、`expertCliAdapter.ts`、`expertRunner.ts`、`expertRunnerService.ts`、`expertEvents.ts`、`expertPromptBuilder.ts`，以及 `expertConfig.ts` 中相关函数。
  - 删除 Relay 路由：`/__expert/run` 整段 + `expertHandler` 注入参数。
  - 删除 webview 协议：`'expert/event'` + `ExpertEventPayload`，以及前端 `ExpertPanel` 渲染。
  - 保留：`chat.expertMode.*` 四个配置键（仅作专家模型选择存储）、`ChatExpertModelSelection` / `'expert/model/options'` / `'expert/model/select'`（继续给「模型弹窗」使用）。
- 替代关系：「主模型自主调度专家」→「dispatcher CLI 通过文本 `@llsExpert` 切换路由 → 用户下一条消息直接送给常驻 expert CLI」。
- 与新方案不并存：没有 feature flag、没有 dual track；删除即生效，避免两条触发路径并存导致行为不可预测。

---

## 附录 A：现有关键代码锚点（实施时直接对照）

| 主题 | 文件 | 行号 |
|------|------|------|
| 唯一 CLI 启动 | `src/extension.ts` | `startChatCliFromCurrentConfig` ~846 |
| 唯一 CLI 重启 | `src/extension.ts` | `restartChatCli` ~643 |
| 用户消息入口 | `src/extension.ts` | `case 'user/send'` ~1102 |
| 普通模型选择 | `src/extension.ts` | `selectChatModel` ~1310 |
| 专家模型选择 | `src/extension.ts` | `selectChatExpertModel` ~1334 |
| 专家选择持久化 | `src/extension.ts` | `saveExpertModelSelection` ~364 |
| 专家选择读取 | `src/extension.ts` | `readEffectiveExpertModelSelection` ~343 |
| 普通下拉前端 | `media/chat/index.html` | 行 48 `data-role="model-select"` |
| 专家下拉前端 | `media/chat/main.js` | 行 623 `data-role="expert-model-select"` |
| 专家下拉协议 | `src/chat/protocol.ts` | `'expert/model/options'` ~247 / `'expert/model/select'` ~441 |
| 专家 MCP 注入 | `src/expertMode/expertConfig.ts` | `maybeInjectExpertMcpServer` ~243 |
| 专家 HTTP 路由 | `src/relay/router.ts` | `/__expert/run` ~294 |
| 专家进程组合根 | `src/expertMode/expertRunnerService.ts` | `ExpertRunnerService.run` ~113 |
| 双 CLI 设计的关键替换点 | `cliProcess` / `streamJsonCliAdapter` 的所有引用 | `grep -n "cliProcess\\.\|streamJsonCliAdapter" src/extension.ts` |

