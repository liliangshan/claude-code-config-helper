# Claude Code 配置助手 — V3 重构开发文档（终版）

> **状态**：设计冻结 / 待实施
> **决策日期**：2026-05-20
> **核心策略**：**完全照搬**参考扩展 `liliangshan.openapi-compatible-copilot` 的"提供商 + 模型 + 配置 UI"代码资产，**不依赖**参考扩展运行（不通过 extension API 共享），把代码物理拷贝到本扩展内；并新增**本地 HTTP 中转服务**，让 Claude Code 通过 `http://127.0.0.1:<port>` 间接使用所有上游协议。
>
> **为什么不共享而是照搬**：用户已确认两份独立配置可接受；零运行时耦合；可独立发布；卸载参考扩展不受影响。
>
> **当前实施范围（2026-05-20 决策）**：第一阶段页面迁移已完成，下一步实施**第二阶段：状态栏 + 最小 HTTP 中转服务 + settings.json 完整写入闭环**。本阶段做三件事：1）新增状态栏显示，开启时展示中转运行状态和当前模型显示名称；2）启动本地 HTTP 服务并且只处理/转发 Claude Code 必需的 `POST /v1/messages`；3）完成 `settings.json` 写入闭环，把 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_SKIP_AUTH_LOGIN`、`claudeCode.disableLoginPrompt` 和额外环境变量按当前页面配置写入。 本阶段暂不实现完整协议转换矩阵、复杂健康检查端点和 leader/follower 竞选接管。
>
> **默认中转端口（2026-05-20 决策）**：固定使用 `17783` 作为默认端口；后续真正实现中转服务时，如果该端口被本扩展 leader 占用则当前窗口作为 follower 复用，如果被外部程序占用则从 `17784` 起递增寻找空闲端口。

---

## 1. 顶层架构（一图全览）

```
┌─────────────────────────────────────────────────────────────────────┐
│                    本扩展 liliangshan-anthropic.claude-code           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Webview (Panel + Sidebar)                                    │  │
│  │ ┌──────────────────────────────────────────────────────────┐ │  │
│  │ │  Claude Code 配置区（顶部，本扩展独有）                    │ │  │
│  │ │  • 当前使用模型：[Provider/Model ▼]   • 中转端口：17783    │ │  │
│  │ │  • 本地中转服务：[● Running on 127.0.0.1:17783]            │ │  │
│  │ │  • [一键写入 Claude Code settings.json]                  │ │  │
│  │ └──────────────────────────────────────────────────────────┘ │  │
│  │ ┌──────────────────────────────────────────────────────────┐ │  │
│  │ │  提供商管理区（照搬参考扩展 configView）                  │ │  │
│  │ │  ─ Provider 卡片列表（启用开关、API Key、模型列表、拉取）  │ │  │
│  │ │  ─ 新建/编辑模态框                                        │ │  │
│  │ │  ─ 导入/导出 JSON                                         │ │  │
│  │ └──────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌────────────────────────┐   ┌──────────────────────────────────┐ │
│  │ ConfigManager          │   │ LocalRelayServer (HTTP)          │ │
│  │ - providers (globalState)│  │ listen 127.0.0.1:<port>         │ │
│  │ - apiKeys (secretStorage)│  │                                  │ │
│  │ - currentModel (globalState)│ POST /v1/messages   ← Claude Code│ │
│  │ - relayPort (globalState)│  │  ↓                               │ │
│  └──────────┬─────────────┘   │ Anthropic ←→ OpenAI 转换器       │ │
│             │                  │  ↓                               │ │
│             └─────────────────→│ 上游 API (按 currentModel)       │ │
│                                └──────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ SettingsWriter                                               │  │
│  │ 写入 settings.json 的 claudeCode.environmentVariables：       │  │
│  │   ANTHROPIC_BASE_URL = http://127.0.0.1:<relayPort>          │  │
│  │   ANTHROPIC_AUTH_TOKEN = "<sentinel>" (任意值，中转不校验)    │  │
│  │   ANTHROPIC_MODEL = "<provider.id>/<model.modelId>"          │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                ↑
                                │ Claude Code 扩展（不修改）
                                │ 读 settings.json 注入 ANTHROPIC_* env vars
                                │ 之后所有请求都打到 127.0.0.1:<port>
                                ↓
                       [Anthropic Messages API 请求]
```

### 关键设计

1. **ANTHROPIC_BASE_URL 永远指向 `127.0.0.1:<relayPort>`**，不再随提供商切换而变。
2. **切换"当前模型"**只改 `ANTHROPIC_MODEL` 这一项 env 变量；本地中转根据 modelId 查询是哪个 provider 并使用对应的上游 BaseURL/密钥/headers。
3. **`ANTHROPIC_MODEL` 用 `<providerId>/<modelId>` 复合格式**，让本地中转能反查到 provider。例如 `deepseek-prod/deepseek-chat`。
4. **本地中转的协议路由**：根据 provider.apiType 决定怎么转：
   - `anthropic` → 直接转发（仅替换 host 和鉴权头）
   - `openai-compatible` → Anthropic Messages ↔ OpenAI Chat Completions 协议转换（照搬 `utils/anthropicConverter.ts`）
   - `v1-response` → Anthropic Messages ↔ OpenAI Responses 协议转换（照搬 `utils/v1ResponseConverter.ts`）
5. **中转服务的生命周期（多 VS Code 窗口安全）**：采用 **方案 C：leader election + HTTP 心跳**。
    - 每个 VS Code 窗口激活扩展后都会参与竞选。
    - 第一个成功监听 `127.0.0.1:<relayPort>` 的窗口成为 **leader**，负责运行唯一的本地中转服务。
    - 后续窗口发现端口已被本扩展占用后成为 **follower**，不再启动 server，只通过心跳确认 leader 存活。
    - leader 关闭后，follower 通过心跳失败检测到 leader 消失，并重新竞选接管同一个端口。
    - 不使用 gRPC；默认也不使用 WebSocket。轻量 HTTP ping 足够确认 leader 是否存活，零第三方依赖。
6. **HTTP 中转不做鉴权**（只 listen 127.0.0.1），Claude Code 发来的 token 直接忽略，使用 provider 配置的 apiKey 与上游通信。
7. **照搬资产物理拷贝，不通过 npm 或 extension API 共享**。后续参考扩展更新时，由维护者人工 diff 拉过来。

---

## 2. 文件结构（重构后）

```
liliangshan-anthropic.claude-code/
├── DEV_PLAN_V3.md            ← 本文档
├── PLAN.md                    ← 旧的总规划（保留供历史回溯）
├── README.md
├── package.json               ← 大改：新增 commands/views，删旧
├── tsconfig.json              ← 增加 "lib": ["ES2020", "DOM"]（HTTP server 用不到，无需改）
├── media/
│   ├── main.css               ← 删除（被 configView.css 替代）
│   ├── main.js                ← 删除（被 configView.js 替代）
│   ├── configView.css         ← 【照搬+裁剪】参考项目 assets/configView/configView.css
│   └── configView.js          ← 【照搬+裁剪】参考项目 assets/configView/configView.js
├── resources/
│   └── activity-bar.svg       ← 保留
└── src/
    ├── extension.ts           ← 重写：注册命令 + 启动中转服务 + TreeView
    ├── constants.ts           ← 重写
    ├── types.ts               ← 重写（照搬参考 + 加 authMode/customHeaders/extraEnvVars/skipAuthLogin）
    ├── logger.ts              ← 保留
    │
    ├── configManager.ts       ← 【照搬+裁剪】参考 src/configManager.ts
    │
    ├── providersTreeView.ts   ← 替代旧 profilesTreeView.ts
    ├── relayStatusBar.ts      ← 【新增】状态栏显示运行状态 + 当前模型显示名称
    │
    ├── modelFetcher.ts        ← 保留并适配新 apiType 枚举
    │
    ├── settingsWriter.ts      ← 重写：只写中转端口 + 当前模型
    │
    ├── relay/                 ← 【新增】本地 HTTP 中转服务
    │   ├── server.ts          ← HTTP server (Node http 模块，零依赖)
    │   ├── leaderElection.ts  ← 多窗口 leader/follower 竞选与心跳
    │   ├── router.ts          ← 路由派发到不同协议转换
    │   ├── anthropicProxy.ts  ← apiType=anthropic 透传
    │   ├── openaiAdapter.ts   ← apiType=openai-compatible 转换（包装 utils/anthropicConverter）
    │   ├── v1ResponseAdapter.ts ← apiType=v1-response 转换（包装 utils/v1ResponseConverter）
    │   └── portFinder.ts      ← 找空闲端口
    │
    ├── utils/                 ← 【照搬】参考 src/utils/
    │   ├── anthropicConverter.ts
    │   ├── v1ResponseConverter.ts
    │   ├── openaiChunk.ts
    │   └── visionContent.ts   ← 视觉内容处理（保留以便支持多模态）
    │
    └── views/
        ├── configView.ts      ← 【照搬+裁剪】参考 src/views/configView.ts
        └── configViewHtml.ts  ← 拆出 HTML 模板部分（可选，保持单文件也行）
```

**删除的旧文件**：
- `src/profileManager.ts`、`src/profilesTreeView.ts`、`src/secretStore.ts`、`src/configStore.ts`
- `src/webview/html.ts`、`src/webview/panel.ts`、`media/main.js`、`media/main.css`

---

## 3. 数据模型（types.ts）

### 3.1 完全照搬参考

```ts
/** 提供商配置（持久化形态：不含 apiKey） */
export interface ProviderConfigWithoutSecrets {
    id: string;
    name: string;
    baseUrl: string;
    apiType: 'openai-compatible' | 'anthropic' | 'v1-response';
    models: ModelConfig[];
    enabled: boolean;
    autoFetchModels: boolean;
    createdAt: number;

    /** 是否已配置 apiKey（指示性字段，真正 key 在 SecretStorage） */
    hasApiKey: boolean;

    // ===== 本扩展独有字段（参考扩展没有，因为它不写 settings.json） =====

    /** 鉴权方式（决定中转服务发往上游的鉴权头格式） */
    authMode: 'auth_token' | 'api_key' | 'none';
    /** 自定义请求头（中转服务转发时附加） */
    customHeaders: Array<{ key: string; value: string }>;
}

/** 模型配置 */
export interface ModelConfig {
    modelId: string;
    displayName: string;
    contextLength: number;
    maxTokens: number;
    vision: boolean;
    toolCalling: boolean;
    temperature: number;
    topP: number;
    samplingMode: 'temperature' | 'top_p' | 'both' | 'none';
    isUserSelectable?: boolean;
    transformThink?: boolean;
    preserveReasoningContent?: boolean;
}

/** 含密钥的运行时形态（仅在中转服务/编辑表单内部使用） */
export interface ProviderConfig extends Omit<ProviderConfigWithoutSecrets, 'hasApiKey'> {
    apiKey: string;
}
```

### 3.2 本扩展独有

```ts
/** 当前使用模型（全局选择，决定 ANTHROPIC_MODEL 写什么） */
export interface CurrentModelSelection {
    providerId: string;
    modelId: string;
}

/** 本地中转服务配置 */
export interface RelayServerConfig {
    /** 监听端口（0=自动选） */
    port: number;
    /** 是否在扩展激活时自动启动 */
    autoStart: boolean;
    /** Claude Code 写入 settings.json 时额外要塞的环境变量 */
    extraEnvVars: Array<{ name: string; value: string }>;
    /** 写 CLAUDE_CODE_SKIP_AUTH_LOGIN=1 */
    skipAuthLogin: boolean;
    /** 写 claudeCode.disableLoginPrompt=true */
    disableLoginPrompt: boolean;
}
```

### 3.3 持久化键

| 存储                 | 键                                                  | 内容                                |
| -------------------- | --------------------------------------------------- | ----------------------------------- |
| `globalState`        | `claudeRouter.providers`                            | `ProviderConfigWithoutSecrets[]`    |
| `globalState`        | `claudeRouter.currentModel`                         | `CurrentModelSelection`             |
| `globalState`        | `claudeRouter.relay`                                | `RelayServerConfig`                 |
| `secrets`            | `claudeRouter.providerApiKey.<providerId>`          | `string`                            |

---

## 4. 本地 HTTP 中转服务（核心新增）

### 4.1 端点

```
POST /v1/messages         ← Claude Code Anthropic Messages API（第二阶段唯一处理/转发端点，流式 + 非流式）
```

**第二阶段只启动最小 HTTP 服务并处理 `POST /v1/messages`。**

也就是说，本阶段不暴露也不实现 `GET /`、`GET /healthz`、`GET /__claude-router-ping__` 等辅助端点；这些健康检查和多窗口 leader 心跳端点留到后续阶段再实现。`Claude Code` 实际只会调用 `POST /v1/messages`，因此第二阶段优先打通这条主链路。

后续多窗口 leader/follower 阶段再追加：

```
GET  /                    ← 健康检查（返回 {"ok": true, "service": "..."} ）
GET  /healthz             ← 同上
GET  /__claude-router-ping__ ← 多 VS Code 窗口 leader 心跳探测
```

`/__claude-router-ping__` 返回固定签名，用于确认占用端口的是不是本扩展自己的中转服务：

```json
{
  "ok": true,
  "service": "liliangshan-anthropic.claude-code-relay",
  "protocol": 1,
  "pid": 12345,
  "startedAt": 1779285130121,
  "role": "leader"
}
```

### 4.1.1 多窗口 leader election / 心跳机制

VS Code 多窗口场景下，每个窗口都有独立的 Extension Host 进程，因此**不能让每个窗口都启动一个不同端口的中转服务**。否则全局 `settings.json` 中的 `ANTHROPIC_BASE_URL` 会被不同窗口互相覆盖。

本扩展采用 **单端口、单 leader、多 follower** 模型：

1. 所有窗口都读取同一个 `relay.port`（默认 17783）。
2. 扩展激活时先尝试监听 `127.0.0.1:<relayPort>`。
3. 如果监听成功：当前窗口成为 **leader**，启动 HTTP 中转并写入 settings.json。
4. 如果监听失败且错误为 `EADDRINUSE`：
   - 立即请求 `GET http://127.0.0.1:<relayPort>/__claude-router-ping__`。
   - 如果返回固定签名 `service === 'liliangshan-anthropic.claude-code-relay'`：说明端口由另一个窗口的本扩展占用，当前窗口成为 **follower**，不启动 server。
   - 如果签名不匹配或请求失败：说明端口被外部程序占用，进入端口冲突处理（提示用户或自动 +1，见 §4.4）。
5. follower 使用 `setInterval` 每 5 秒 ping leader。
6. 连续失败 3 次（约 15 秒）后认为 leader 已关闭或崩溃。
7. follower 等待一个随机抖动 `100ms ~ 1000ms`，然后重新尝试监听同一个端口。
8. 第一个监听成功的 follower 接管成为新 leader；其他 follower 因 `EADDRINUSE` 回到 follower 状态。

伪代码：

```ts
/**
 * 多窗口中转服务竞选器。
 *
 * 只保证同一台机器、同一用户、同一个 VS Code profile 下只有一个 relay leader。
 * 端口本身就是最终互斥锁；HTTP ping 用于区分"自己人"与外部程序。
 */
class RelayLeaderElection {
    async start(): Promise<void> {
        const port = await config.getRelayPort();
        const result = await tryListen(port);
        if (result.ok) {
            this.becomeLeader(result.server);
            return;
        }

        if (result.errorCode === 'EADDRINUSE' && await this.pingOwnRelay(port)) {
            this.becomeFollower(port);
            return;
        }

        await this.handleExternalPortConflict(port);
    }

    private becomeFollower(port: number): void {
        let failed = 0;
        this.heartbeatTimer = setInterval(async () => {
            if (await this.pingOwnRelay(port)) {
                failed = 0;
                return;
            }

            failed += 1;
            if (failed < 3) return;

            clearInterval(this.heartbeatTimer);
            await wait(randomBetween(100, 1000));
            await this.start();
        }, 5000);
    }
}
```

**为什么不用 WebSocket / gRPC：**

- 这里只需要确认 leader 是否存活，HTTP ping 足够。
- gRPC 会引入额外依赖与打包复杂度，不适合 VS Code 扩展里做轻量本地服务。
- WebSocket 适合做实时推送，但目前配置变更可以通过 `globalState` + 轻量 poll 解决；如后续需要实时广播 UI 状态，可在同一 HTTP server 上追加 WebSocket，但不是 V3 必需项。

### 4.1.2 状态栏状态同步

每个 VS Code 窗口都显示一个状态栏 item。第二阶段先显示**是否已开启本地中转服务、监听端口、当前模型显示名称**；后续 leader/follower 阶段再扩展为显示当前窗口在 relay 集群中的角色。

状态栏不只是装饰，它也是 Claude Code 当前路由状态的快速确认入口：用户可以立即知道中转是否已开启，以及当前会转发到哪个模型。模型显示优先使用 `ModelConfig.displayName`，没有显示名称时回退到 `modelId`。

状态枚举：

```ts
/**
 * 本地中转服务在当前 VS Code 窗口中的运行状态。
 */
export type RelayStatus =
    | { kind: 'starting'; port: number }
    | { kind: 'leader'; port: number; pid: number; startedAt: number }
    | { kind: 'follower'; port: number; leaderPid?: number; lastPingAt?: number }
    | { kind: 'reconnecting'; port: number; failedCount: number }
    | { kind: 'stopped'; port?: number }
    | { kind: 'error'; port?: number; message: string };
```

显示规则：

| 状态 | 状态栏 text | tooltip | 点击行为 |
| ---- | ----------- | ------- | -------- |
| `starting` | `$(sync~spin) CC Relay 17783 启动中` | `正在启动本地 Claude Code 中转服务...` | 打开配置面板 |
| `leader` / 已开启 | `$(radio-tower) CC Relay 17783 ● <模型显示名称>` | `本地中转服务已开启\n端口：17783\n当前模型：<providerName>/<modelDisplayName>` | 打开配置面板 |
| `follower`（后续阶段） | `$(plug) CC Relay 17783 ↗ <模型显示名称>` | `当前窗口复用其他窗口的中转服务（follower）\n当前模型：<providerName>/<modelDisplayName>` | 打开配置面板 |
| `reconnecting`（后续阶段） | `$(sync~spin) CC Relay 接管中` | `检测到 leader 心跳失败，正在尝试接管...` | 打开配置面板 |
| `stopped` | `$(circle-slash) CC Relay 未开启` | `本地中转服务未运行` | 执行 `claudeRouter.restartRelay` |
| `error` | `$(error) CC Relay 错误` | `启动失败：<message>` | 执行 `claudeRouter.restartRelay` |

状态更新来源：

1. `RelayLeaderElection` 在角色变化时触发事件：
   - `starting`
   - `leader`
   - `follower`
   - `reconnecting`
   - `stopped`
   - `error`
2. `RelayStatusBar` 订阅该事件并更新 VS Code `StatusBarItem`。
3. Webview 也订阅同一状态源，顶部 Claude Code 配置区显示相同状态，避免状态栏与面板不一致。

实现草图：

```ts
/**
 * 管理状态栏中的 Claude Code Relay 状态显示。
 *
 * 该类只负责 UI 显示，不负责启动/停止中转服务；
 * 实际状态由 RelayLeaderElection 推送。
 */
export class RelayStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    /** 根据 relay 状态刷新状态栏文本、tooltip 与命令。 */
    update(status: RelayStatus): void {
        switch (status.kind) {
            case 'leader':
                this.item.text = `$(radio-tower) CC Relay ${status.port} ● ${currentModelDisplayName}`;
                this.item.tooltip = `本地 Claude Code 中转服务已开启\n端口=${status.port}\n当前模型=${currentProviderName}/${currentModelDisplayName}`;
                this.item.command = 'claudeRouter.openConfigPanel';
                break;
            case 'follower':
                this.item.text = `$(plug) CC Relay ${status.port} ↗ ${currentModelDisplayName}`;
                this.item.tooltip = `当前窗口复用其他窗口的 Claude Code 中转服务（follower）\n当前模型=${currentProviderName}/${currentModelDisplayName}`;
                this.item.command = 'claudeRouter.openConfigPanel';
                break;
            // 其他状态同表格。
        }
        this.item.show();
    }

    /** 释放状态栏 item。 */
    dispose(): void {
        this.item.dispose();
    }
}
```

状态栏显示是 **每个窗口独立的**：

- 第二阶段已开启中转时显示 `CC Relay 17783 ● <模型显示名称>`
- 未选择模型时显示 `CC Relay 17783 ● 未选择模型`
- 后续 leader/follower 阶段：leader 窗口显示 `CC Relay 17783 ● <模型显示名称>`
- 后续 leader/follower 阶段：follower 窗口显示 `CC Relay 17783 ↗ <模型显示名称>`
- leader 关闭后，某个 follower 接管成功，该窗口自动从 `↗` 变成 `●`
- 其他 follower 保持 `↗`

### 4.2 路由逻辑

```ts
async function handleMessages(req: Anthropic.MessageRequest, res: ServerResponse) {
    // 1) 从请求体 model 字段提取 providerId / modelId
    //    格式：`<providerId>/<modelId>`，若没有 / 则用 currentModel
    const { providerId, modelId } = parseModelId(req.body.model);

    // 2) 找到 provider（含 apiKey）
    const provider = await configManager.getProviderWithSecret(providerId);
    if (!provider || !provider.enabled) return res.writeHead(404).end(JSON.stringify({error: ...}));

    // 3) 根据 apiType 派发
    switch (provider.apiType) {
        case 'anthropic':
            return forwardToAnthropic(provider, modelId, req, res);
        case 'openai-compatible':
            return adaptToOpenAI(provider, modelId, req, res);
        case 'v1-response':
            return adaptToV1Response(provider, modelId, req, res);
    }
}
```

### 4.3 协议转换照搬

参考扩展的 `src/utils/anthropicConverter.ts` 和 `v1ResponseConverter.ts` 已经实现了 Anthropic ↔ OpenAI 的双向转换（messages 字段、tools 字段、system prompt、流式 chunk）。**整文件照搬到本扩展** `src/utils/`，再用 `relay/openaiAdapter.ts` 把它包装成 HTTP 路由处理器即可。

### 4.4 端口选择

启动时：
1. 读 `relay.port`，若为 0 或被占则从 17783 起步递增找空闲端口
2. 找到后**回写**到 `globalState`，**同步重写** settings.json 中的 `ANTHROPIC_BASE_URL`
3. 状态栏显示 `CC Relay 17783 ● <模型显示名称>`；未选择模型时显示 `CC Relay 17783 ● 未选择模型`

### 4.5 实现规模

- `server.ts` ~150 行（Node http 模块裸搭，零依赖）
- `leaderElection.ts` ~120 行（多窗口 leader/follower 竞选与 HTTP 心跳）
- `router.ts` ~100 行
- `anthropicProxy.ts` ~80 行
- `openaiAdapter.ts` ~150 行（大部分转换逻辑在 utils/）
- `v1ResponseAdapter.ts` ~150 行
- `portFinder.ts` ~30 行

合计中转服务自研代码约 **780 行**（不含照搬的 utils/ 协议转换器 ~500 行）。

---

## 5. settingsWriter 新规则

```ts
/**
 * 重写 settings.json 中的 claudeCode.* 字段。
 *
 * 触发时机：
 *   - 中转服务启动/重启（拿到实际端口后）
 *   - 用户切换"当前模型"
 *   - 用户改 relayPort / 中转配置
 *   - 用户点"一键写入 Claude Code 配置"按钮
 *   - 用户禁用了当前模型所在 provider → 清空
 *
 * 写入内容：
 *   ANTHROPIC_BASE_URL = "http://127.0.0.1:<relayPort>"
 *   ANTHROPIC_AUTH_TOKEN = "claude-code-relay"  （任意非空 sentinel，中转不校验）
 *   ANTHROPIC_MODEL = "<providerId>/<modelId>"
 *   CLAUDE_CODE_SKIP_AUTH_LOGIN = "1"（如果 relay.skipAuthLogin === true）
 *   + relay.extraEnvVars 透传
 *
 * 不再每个 provider 单独写 ANTHROPIC_BASE_URL —— 永远指向本地中转。
 *
 * 合并算法继续用 __CLAUDE_ROUTER_MANAGED__ marker 块，保留用户手写其他变量。
 */
```

---

## 6. Webview UI 详细规格

### 6.1 区块顺序（从上到下）

1. **Header**（标题 + 导入/导出按钮）
2. **Claude Code 配置区**（本扩展独有，灰底高亮）
   ```
   ┌───────────────────────────────────────────────────────────┐
   │ Claude Code 当前配置                          [一键写入]  │
   │                                                          │
   │ 当前使用模型：[Provider/Model ▼]   [清空]                │
   │ 中转服务： ● Running on http://127.0.0.1:17783           │
   │ 端口：[17783] [应用]   ☑ 扩展启动时自动启动              │
   │ ☑ skipAuthLogin   ☑ disableLoginPrompt                  │
   │                                                          │
   │ 额外环境变量（透传到 claudeCode.environmentVariables）   │
   │  + 添加                                                  │
   │                                                          │
   │ ⚠ 提示：选中 openai-compatible / v1-response 类型的模型 │
   │   时，必须保证本地中转服务正在运行。                     │
   └───────────────────────────────────────────────────────────┘
   ```
3. **提供商列表**（完全照搬参考扩展 configView 的 provider 卡片）
   - 每个卡片：name / baseUrl / apiType / hasApiKey / enabled 开关 / autoFetch 开关 / 编辑 / 删除 / 拉取模型
   - 卡片展开后显示模型列表，每行：modelId / displayName / 编辑 / 删除 / **isUserSelectable 复选框**（控制该模型是否出现在顶部下拉里）
4. **+ 新建提供商** 按钮 + 模态框（照搬）
5. **+ 添加模型** 模态框（照搬，含全部高级参数）

### 6.2 顶部"当前使用模型"下拉数据来源

```js
function getSelectableModels() {
    const list = [];
    for (const provider of providers) {
        if (!provider.enabled) continue;
        for (const model of provider.models) {
            if (model.isUserSelectable === false) continue;
            list.push({
                value: `${provider.id}/${model.modelId}`,
                providerName: provider.name,
                modelDisplay: model.displayName || model.modelId,
                apiType: provider.apiType,
            });
        }
    }
    return list;
}

// 渲染时按 provider.name 分组成 <optgroup>
```

### 6.3 删减清单（相对于参考扩展 configView）

完全删除：
- 多语言切换（保留中文一份，translations 对象只塞 zh-cn）
- Expert Mode 设置区
- Solution Provider 设置区
- LLS Task 设置区
- Prompt Enhancement 设置区（含 context cache）
- Chat History 设置区
- Global / Project System Prompt
- Force TODO Enabled
- Project Settings tab（只保留 Global）
- "在 Copilot 中显示厂商"相关的文案（参考扩展是 Copilot Provider，我们不是）

新增到表单：
- 提供商表单追加：`authMode` 单选 + `customHeaders` KV 列表
- "Claude Code 配置区" 整块（§6.1）

---

## 7. package.json contributes 设计

```jsonc
{
    "activationEvents": [
        "onStartupFinished"  // 中转服务启动需要
    ],
    "contributes": {
        "commands": [
            { "command": "claudeRouter.openConfigPanel",    "title": "打开配置面板", "category": "Claude Code 配置" },
            { "command": "claudeRouter.refreshProviders",   "title": "刷新", "category": "Claude Code 配置" },
            { "command": "claudeRouter.newProvider",        "title": "新建提供商", "category": "Claude Code 配置" },
            { "command": "claudeRouter.editProviderItem",   "title": "编辑提供商", "category": "Claude Code 配置" },
            { "command": "claudeRouter.deleteProviderItem", "title": "删除提供商", "category": "Claude Code 配置" },
            { "command": "claudeRouter.setCurrentModel",    "title": "切换当前使用模型", "category": "Claude Code 配置" },
            { "command": "claudeRouter.clearCurrentModel",  "title": "清空当前模型", "category": "Claude Code 配置" },
            { "command": "claudeRouter.restartRelay",       "title": "重启本地中转服务", "category": "Claude Code 配置" },
            { "command": "claudeRouter.openSettingsJson",   "title": "打开 settings.json" },
            { "command": "claudeRouter.reloadWindow",       "title": "重载窗口" },
            { "command": "claudeRouter.exportConfig",       "title": "导出配置" },
            { "command": "claudeRouter.importConfig",       "title": "导入配置" }
        ],
        "viewsContainers": {
            "activitybar": [
                { "id": "claudeRouter", "title": "Claude Code 配置", "icon": "resources/activity-bar.svg" }
            ]
        },
        "views": {
            "claudeRouter": [
                { "id": "claudeRouter.providersView", "name": "提供商" }
            ]
        }
    }
}
```

不再使用 `chatProvider` proposed API，**无需进 Insiders / 无需扩展白名单**。

---

## 8. 分批实施计划（10 批）

> **当前执行第二阶段：状态栏 + 最小 HTTP 中转服务 + settings.json 完整写入闭环。**
>
> 第一阶段页面迁移已完成。
>
> 第二阶段目标：
> 1. 新增状态栏 item；
> 2. 如果本地中转已开启，状态栏显示运行状态、端口和当前模型显示名称；
> 3. 启动最小 Node http 服务，只监听 `127.0.0.1:<port>`；
> 4. HTTP 服务只处理/转发 `POST /v1/messages`，其他路径不作为本阶段目标；
> 5. 暂不实现完整 leader/follower 竞选接管；
> 6. 完成 `settings.json` 完整写入闭环：点击“一键写入”、切换当前模型、修改端口/中转配置、启动/重启中转服务时都要写入最新 Claude Code 配置；
> 7. 写入内容包括 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_SKIP_AUTH_LOGIN`、额外环境变量和 `claudeCode.disableLoginPrompt`；
> 8. 每个类和方法继续保持中文注释。
>
> 第三阶段及以后再实施：leader/follower 心跳接管、状态栏角色细分与完整协议转换矩阵。

| 批次 | 范围                                                                                          | 代码量    | 验证                          |
| ---- | --------------------------------------------------------------------------------------------- | --------- | ----------------------------- |
| B1   | 清空旧 V1 代码（删除 profileManager/secretStore/configStore/profilesTreeView/webview 目录）   | -         | `tsc` 退出 0（只有 logger 等） |
| B2   | 重写 `types.ts` + `constants.ts` + `logger.ts` 校准 + 简化版 `extension.ts` 占位              | ~400 行   | `tsc` 退出 0                  |
| B3   | 照搬 + 裁剪 `configManager.ts`（删 expert/solution/llsTask/promptEnhancement/chatHistory/systemPrompt/forceTodo/language） | ~400 行   | `tsc` 退出 0 |
| B4   | 重写 `settingsWriter.ts`（按"中转端口 + 当前模型"写）+ `modelFetcher.ts` 适配 apiType         | ~200 行   | `tsc` 退出 0                  |
| B5   | 照搬 `src/utils/` 全部协议转换器                                                              | ~500 行   | `tsc` 退出 0                  |
| B6   | 【第二阶段】新增 `src/relay/` 最小 server/router（只处理 `POST /v1/messages`）+ `relayStatusBar.ts`（显示状态、端口、当前模型显示名称）+ 打通 `settingsWriter.ts` 完整写入闭环 | ~420 行   | `tsc` 退出 0 + 手测端口监听 + `/v1/messages` 转发 + 状态栏状态/模型显示变化 + settings.json 写入正确 |
| B7   | 新增 `relay/openaiAdapter.ts` + `v1ResponseAdapter.ts`（用 utils/ 转换器）                    | ~300 行   | `tsc` 退出 0                  |
| B8   | 照搬 + 裁剪 `views/configView.ts`（删多语言/expert/solution/llsTask/promptEnhancement/chatHistory/systemPrompt/forceTodo） | ~1000 行 | `tsc` 退出 0 |
| B9   | 照搬 + 裁剪 `media/configView.css` + `media/configView.js`，新增"Claude Code 配置区"           | ~2200 行  | `tsc` + 手动打开面板看渲染    |
| B10  | 完整扩展入口 `extension.ts`（注册命令、TreeView、启动中转、wiring 所有组件） + `package.json` 完成 + README/CHANGELOG | ~250 行   | F5 调试通过 |

**预计总代码量**：约 5500 行（其中照搬 ~3000 行 + 新写 ~2500 行）。
**预计交互轮次**：每批 1-3 轮，共 ~15-25 轮工具调用。

---

## 9. 风险评估

| 风险                                                                | 影响 | 缓解                                                                       |
| ------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| 参考扩展的协议转换器有 bug / 未覆盖某些 Claude Code 请求形态        | 高   | 先实现 `anthropic` 透传打通主路径；openai/v1response 列为 V3.1 增量交付      |
| 本地 HTTP 中转可能与其他扩展抢端口                                  | 中   | portFinder 自动递增；启动后回写 settings.json 让 CC 知道实际端口             |
| Claude Code 升级后协议有变                                          | 中   | 中转层透传 + 转换层保持版本化，README 列已知兼容版本                         |
| 用户两个扩展都装会有两份提供商                                      | 低   | 用户已确认接受；可在 README 标注"两个扩展配置独立"                           |
| 参考扩展未来更新，本扩展不同步                                      | 中   | 在每个照搬文件顶部加 `// COPIED FROM liliangshan.openapi-compatible-copilot@3.0.3 (date)` 注释 |
| 中转服务漏密钥到日志                                                | 高   | Logger 强制 redaction：所有写日志的地方过滤 Authorization / x-api-key       |
| 端口被 ngrok / docker / 别的程序占了                                | 低   | portFinder 已处理；状态栏报错；命令面板提供"重启中转"                        |
| Anthropic 流式响应转 OpenAI 流式 chunk 时性能瓶颈                   | 低   | Node http 原生 stream + 现成的 SSE chunk 实现，单机 100QPS 没问题            |

---

## 10. 实施前必须确认的最终选项

请在动手前对以下选项**逐条勾选**。我假设默认勾✅的会按那条走，你不同意请改：

### ✅ Q1：照搬资产是物理 copy 而非 npm 包
- ✅ **物理 copy**（推荐，零依赖）
- ☐ 抽 npm 包 `@liliangshan/oai-config-core` 两个扩展都引用（开发成本高）

### ✅ Q2：中转服务的运行环境
- ✅ **Node http 模块裸搭，零第三方依赖**（包体积小）
- ☐ 用 `express` / `fastify`（包体积+）
- ☐ 用 `undici`（仅作为 client，server 还是 http）

### ✅ Q3：中转服务的端口策略
- ✅ **默认 17783，被占则自动 +1 找空闲；回写持久化**
- ☐ 强制用户配置
- ☐ 不持久化，每次启动随机端口

### ✅ Q4：当前模型为空 / 该 provider 被禁用时
- ✅ **清空 settings.json 中所有 ANTHROPIC_***（Claude Code 自动回退默认）
- ☐ 保留 BaseURL，仅清 ANTHROPIC_MODEL（Claude Code 会用默认 model）

### ✅ Q5：拉取模型时 V1 / V2 / V3 哪些 API 端点
- ✅ **照搬参考扩展的现有实现**（anthropic: `/v1/models`; openai: `/v1/models`; v1-response: `/v1/models`），都用 GET
- ☐ 不实现，全部手动添加

### ✅ Q6：本地中转的安全性
- ✅ **只 listen 127.0.0.1（loopback）**，不接受外部连接
- ☐ 监听所有接口（不推荐）

### ✅ Q7：状态栏
- ✅ **加一个状态栏 item**：开启时显示 `$(radio-tower) CC Relay 17783 ● <模型显示名称>`，点击打开配置面板
- ☐ 不加状态栏

### Q8：照搬代码的归属声明
- ☐ 每个文件顶部加 `// Vendored from liliangshan.openapi-compatible-copilot@3.0.3, last-sync 2026-05-20` 注释
- ☐ README 单独写一节"代码来源声明"
- ✅ **两者都加**

### Q9：图标/品牌
- ✅ **保留当前 `resources/activity-bar.svg`**（A 字形）
- ☐ 换成参考扩展的 logo

### Q10：分批执行节奏
- ✅ **B1-B10 顺序推进，每批独立验证**（推荐）
- ☐ B1+B2+B3 合并一次性提交（风险大）

---

## 11. 风险缓冲：分阶段交付里程碑

为避免一次性 5500 行变更出问题，明确**两个可用状态点**：

### 里程碑 M1（B1-B7 完成后）— "Anthropic Only 可用"
- 中转服务运行
- 提供商管理 UI 完整可用
- **但只支持 `apiType = 'anthropic'`**，其他类型在 UI 灰显 + 提示"V3.1 支持"
- Claude Code 可以通过本地中转使用 Anthropic 兼容厂商

### 里程碑 M2（B1-B10 完成后）— "全协议可用"
- 加上 OpenAI 兼容与 Responses API 转换
- 完整交付

每个里程碑独立可用、独立验证。

---

## 12. 决策记录

| 决策                                | 选择                                  |
| ----------------------------------- | ------------------------------------- |
| 配置共享方式                        | 物理 copy（非 API / 非 npm）          |
| 中转服务实现                        | Node http 裸搭                        |
| 数据迁移                            | 不迁移（用户确认还没有数据）          |
| 旧文件                              | 全部删除                              |
| 多语言                              | 砍掉，只保留中文                      |
| Project Settings                    | 砍掉，只保留 Global                   |
| Expert/Solution/Task/PromptEnh/...  | 全部砍掉                              |
| ANTHROPIC_BASE_URL                  | 永远 127.0.0.1:port，不再切换         |
| 切换模型                            | 仅改 ANTHROPIC_MODEL                  |
| modelId 格式                        | `<providerId>/<modelId>`              |

---

> **当前状态**：本文档冻结。
>
> **下一步**：进入 **第二阶段**：实现状态栏显示（运行状态 + 当前模型显示名称）、只处理/转发 `POST /v1/messages` 的最小本地 HTTP 服务，以及 `settings.json` 完整写入闭环。
