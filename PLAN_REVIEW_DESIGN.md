# 方案模型 + 审查模型设计

> 在现有「普通 + 专家」双 CLI 路由基础上，新增方案模型（Plan）与审查模型（Review），
> 由普通模型（normal / dispatcher）作为唯一编排器，协调「写方案 → 审查 → 修改 → 通过」闭环。

---

## 0. 当前代码基线

当前仓库已经完成了部分基础铺垫：

- `ChatRoute` 已扩展为 `'normal' | 'expert' | 'plan' | 'review'`。
- `ChatCliSessionKind` 已扩展为 `'normal' | 'expert' | 'plan' | 'review'`。
- `.LLSOAI/chat-session.plan.json` 与 `.LLSOAI/chat-session.review.json` 文件名已存在。
- `constants.ts` 已定义 plan/review 的 mode 配置 key 与 append prompt 配置 key。
- `DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT` 当前仍只覆盖 expert handoff 与任务流场景，尚未加入 plan/review 编排规则。
- `extension.ts` 的运行时逻辑目前仍主要是 normal/expert 双路由：busy、adapter、session、clear、restart、permission、route select 等路径还需要扩展到 plan/review。

因此实施应避免重复改已完成的类型/常量，只补齐运行时、配置派生、编排、UI/测试等缺口。

---

## 1. 总体架构

```
                    ┌──────────────────┐
                    │   普通模型编排器   │  ← 唯一编排决策者
                    │   normal CLI      │
                    └───┬────┬────┬────┘
                        │    │    │
              ┌─────────┘    │    └──────────┐
              ▼              ▼               ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │ 方案模型   │  │ 审查模型   │  │ 专家模型      │
        │ plan CLI │  │ review   │  │ expert CLI   │
        └──────────┘  └──────────┘  └──────────────┘
```

### 1.1 职责边界

- **normal CLI**：轻量任务 + 路由编排；识别何时交给 expert/plan/review；处理 plan/review 完成后的下一步决策。
- **expert CLI**：复杂实现、调试、重构、任务流延续；不参与 plan/review token 编排。
- **plan CLI**：只产出方案/设计/修订版方案，不执行实现，不调用路由 token。
- **review CLI**：只审查 plan CLI 输出，给出 `APPROVED` 或 `CHANGES_REQUESTED`，不执行实现，不调用路由 token。

### 1.2 关键原则

- normal/expert/plan/review 四条 CLI 运行时彼此隔离，各自拥有进程、adapter、busy 状态与 sessionId 文件。
- normal 是唯一编排决策者；plan/review 完成后只能回调 normal，不能互相直接调用。
- plan/review 默认不 resume 旧 Claude CLI session：每次启动使用 fresh context，以避免方案和审查受到旧轮次污染。
- plan/review 仍要持久化最新 sessionId，用于 token budget、日志诊断、sessionId→route 映射和自动压缩分桶。
- 用户可手动切换路由，但自动闭环只由 normal 输出的内部 `@llsPlan*` token 触发。

---

## 2. 基础类型与配置

### 2.1 已完成的类型

```ts
// src/chat/protocol.ts
export type ChatRoute = 'normal' | 'expert' | 'plan' | 'review';

// src/chat/cli/sessionStore.ts
export type ChatCliSessionKind = 'normal' | 'expert' | 'plan' | 'review';
```

Session 文件对应关系：

| kind | 文件 |
|------|------|
| normal | `.LLSOAI/chat-session.json` |
| expert | `.LLSOAI/chat-session.expert.json` |
| plan | `.LLSOAI/chat-session.plan.json` |
| review | `.LLSOAI/chat-session.review.json` |

### 2.2 配置 key

当前 `constants.ts` 已定义下列 key，后续需要接入读取与 schema/UI：

| key | scope | 用途 |
|-----|-------|------|
| `chat.planMode.project.enabled` | resource | 项目级方案模型启用开关 |
| `chat.planMode.project.model` | resource | 项目级方案模型 id |
| `chat.planMode.global.enabled` | application | 全局方案模型启用开关 |
| `chat.planMode.global.model` | application | 全局方案模型 id |
| `chat.plan.appendSystemPrompt` | resource | 方案模型 system prompt 覆盖 |
| `chat.reviewMode.project.enabled` | resource | 项目级审查模型启用开关 |
| `chat.reviewMode.project.model` | resource | 项目级审查模型 id |
| `chat.reviewMode.global.enabled` | application | 全局审查模型启用开关 |
| `chat.reviewMode.global.model` | application | 全局审查模型 id |
| `chat.review.appendSystemPrompt` | resource | 审查模型 system prompt 覆盖 |

合并规则与 expertMode 一致：`project > global > 默认关闭`。

### 2.3 配置读取建议

不要继续复用名为 `ExpertModeConfig` 的类型承载 plan/review，建议引入通用类型：

```ts
export interface RoutedModelModeConfig {
    enabled: boolean;
    model: string;
}
```

然后：

- `ExpertModeConfig` 可以作为别名或继续保留。
- 新增 `resolveRoutedModelModeConfig(...)` 纯函数，复用 expert 当前的三层合并语义。
- `readPlanConfigFromVscode()` / `readReviewConfigFromVscode()` 使用 plan/review 对应 key。
- 单测覆盖 project/global/default、显式 false 覆盖、空 model 回退等场景。

---

## 3. CLI 配置派生

### 3.1 ChatCliConfig 字段扩展

`ChatCliConfig` 当前只有 `expertMode?: ExpertModeConfig`。需要扩展为：

```ts
interface ChatCliConfig {
    expertMode?: RoutedModelModeConfig;
    planMode?: RoutedModelModeConfig;
    reviewMode?: RoutedModelModeConfig;
}
```

### 3.2 getDualConfigsWithRelayEnv 重命名

当前 `ChatCliConfigService.getDualConfigsWithRelayEnv()` 只返回 normal/expert。新增 plan/review 后建议重命名为 `getRoutedConfigsWithRelayEnv()`，返回四路配置：

```ts
public async getRoutedConfigsWithRelayEnv(relayPort: number): Promise<{
    normal: ChatCliConfig;
    expert: ChatCliConfig | undefined;
    plan: ChatCliConfig | undefined;
    review: ChatCliConfig | undefined;
}>;
```

兼容方案：若希望降低改动面，可以先保留旧函数名但扩展返回值；长期应改名，避免「dual」与四路实际不符。

### 3.3 配置派生规则

- normal：沿用当前模型，注入 dispatcher prompt。
- expert：沿用 `chat.expertMode.*` 模型，注入 expert prompt。
- plan：沿用 `chat.planMode.*` 模型，注入 plan prompt。
- review：沿用 `chat.reviewMode.*` 模型，注入 review prompt。

所有非 normal 路由都需要：

- 覆盖 `model` 与 `ANTHROPIC_MODEL`。
- 使用路由专属本地 HTTP base path，例如 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/expert|plan|review`，让 Relay 能从请求路径直接识别来源路由。
- 复用 relay 端口与 base config。
- `strictMcpConfig` 是否强制开启需明确：
  - expert 当前强制 true。
  - plan/review 建议也强制 true 并继承 stripped MCP 配置，避免旧 MCP 残留或额外工具干扰纯规划/审查。

`LLS_CHAT_ROLE=plan/review/expert` 这类显式角色环境变量不应再作为 Relay 归因的主机制：HTTP 请求进到 Relay 时只能可靠看到路径、方法、headers、body，不能自然看到发起该请求的子进程环境变量。它最多保留为 CLI 子进程日志/调试信息；若本地 HTTP path 方案验证通过，可删除或降级为非功能性诊断字段。

---

## 4. extension.ts 运行时状态

### 4.1 模块级变量

新增 plan/review 对应 normal/expert 的运行时对象：

```ts
let planCliProcess: CliProcess | undefined;
let reviewCliProcess: CliProcess | undefined;

let planStreamJsonAdapter: StreamJsonCliAdapter | undefined;
let reviewStreamJsonAdapter: StreamJsonCliAdapter | undefined;

let planStreamJsonAdapterSubscription: vscode.Disposable | undefined;
let reviewStreamJsonAdapterSubscription: vscode.Disposable | undefined;
let planCliStatusSubscription: vscode.Disposable | undefined;
let planCliExitSubscription: vscode.Disposable | undefined;
let reviewCliStatusSubscription: vscode.Disposable | undefined;
let reviewCliExitSubscription: vscode.Disposable | undefined;

let planRelayActiveCount = 0;
let reviewRelayActiveCount = 0;
let planBusy = false;
let reviewBusy = false;

let lastKnownPlanChatCliSessionId = '';
let lastKnownReviewChatCliSessionId = '';
```

并把：

```ts
const assistantTurnTextBySource: Record<ChatRoute, string> = {
    normal: '',
    expert: '',
    plan: '',
    review: ''
};
```

### 4.2 路由 helper 必须全量扩展

以下 helper 当前仍是 normal/expert 分支，必须改为四路：

- `setRelayRouteBusy(route, busy, reason)`：增加 plan/review activeCount 与总 running 判断。
- `getCliProcessForRoute(route)`。
- `getStreamAdapterForRoute(route)`。
- `getSessionIdForRoute(route)`。
- `isRouteBusy(route)`。
- `resetRouteBusy(route)`。
- `resetAllRouteBusy()`。
- `cancelRouteProcess(route)`。
- `resolveRouteForSessionId(sessionId)` 继续依赖 `chatSessionRouteById`，但 session init 必须记录 plan/review。
- `currentChatCliSessionIdSync()` 如存在 route 分支，也要覆盖 plan/review。

`chat/running` Webview 消息当前只看 `normalBusy || expertBusy`，要改为四路任一 busy。

---

## 5. 启动/停止生命周期

### 5.1 startChatCliPair 扩展/重命名

建议将 `startChatCliPair()` 重命名为 `startChatCliRoutes()`；若暂不重命名，至少更新注释，避免仍称「pair」。

启动策略：

1. normal 总是启动，并 resume normal session。
2. expert 配置存在时启动，并 resume expert session。
3. plan 配置存在时启动，但不读取/传入 `resumeSessionId`。
4. review 配置存在时启动，但不读取/传入 `resumeSessionId`。
5. plan/review 未配置时 dispose 上一次残留进程与 adapter。

示例：

```ts
if (plan) {
    planCliProcess ??= new CliProcess();
    bindPlanCliStatusHandlers();
    const planLaunchConfig = { ...plan, resumeSessionId: undefined };
    await planCliProcess.start(planLaunchConfig);
    rebuildPlanAdapter();
} else {
    await disposePlanCli('未配置方案模型');
}
```

### 5.2 dispose 函数

新增：

- `disposePlanCli(reason)`
- `disposeReviewCli(reason)`

必须执行：

- `resetRouteBusy('plan'/'review')`
- dispose status/exit subscription
- dispose adapter subscription
- dispose adapter
- stop + dispose CLI process
- 清空对应变量

### 5.3 stop/restart/clear

所有 lifecycle 调用点必须从 normal/expert pair 更新为四路：

- `restartChatCliPair` → 重启四路。
- `stopChatCliPair` → stop normal，dispose expert/plan/review。
- `session/clear` → 删除 normal/expert/plan/review 四个 sessionId 文件，清空四个 lastKnown sessionId，并重启四路。
- token budget reset → 根据 sessionId route 删除对应 session 文件，并重启四路。

---

## 6. plan/review 编排流程

### 6.1 内部 token

| token | 触发者 | 用途 |
|-------|--------|------|
| `@llsPlanTask <描述>` | normal | 把用户的方案/设计任务交给 plan CLI |
| `@llsPlanReview` | normal | 把最近一次 plan 输出交给 review CLI |
| `@llsPlanRevise <修改要求>` | normal | 把 review 意见和修改要求送回 plan CLI |
| `@llsPlanDone` | normal | 无需审查或审查关闭，结束方案流程 |
| `@llsPlanApproved` | normal | 审查通过，结束方案流程 |

这些 token 只在 normal CLI 的最终输出中识别。plan/review/expert 输出中出现这些 token 必须忽略，避免循环。

### 6.2 状态缓存

为了让 `@llsPlanReview` 能可靠拿到「最近一次方案」，需要 extension 侧维护最小状态：

```ts
interface PlanReviewWorkflowState {
    active: boolean;
    originalUserTask: string;
    latestPlanText: string;
    latestReviewText: string;
    revisionCount: number;
    maxRevisions: number;
}
```

建议 `maxRevisions = 3`，达到上限后 normal 应总结并询问用户是否继续，避免无限 plan→review 循环。

### 6.3 normal → plan

`watchNormalForPlanHandoff(finalText)` 检测 `@llsPlanTask`：

1. 提取 token 后的 task instruction。
2. `cancelRouteProcess('normal')`，避免 normal 的 token 文本继续流式输出。
3. 初始化 `PlanReviewWorkflowState`。
4. `switchChatRoute('plan', 'normal-plan-handoff')`。
5. `sendUserMessageToCli(instruction, { hidden: true, forceRoute: 'plan' })`。

当前 `sendUserMessageToCli` 只有 `forceExpert`，需要泛化为：

```ts
sendUserMessageToCli(text, { hidden?: boolean; forceRoute?: ChatRoute })
```

并保留 `forceExpert` 作为兼容包装或直接迁移调用点。

### 6.4 plan done → normal

`handleParsedCliEvent(..., source: 'plan')` 收到最终输出：

1. 记录 `latestPlanText`。
2. 如果 hidden 响应被吞掉，仍必须执行编排回调；因此不要把 plan/review done 回调放在 `hiddenCliResponseTurns` return 之后。
3. 构造隐藏消息发给 normal：

```text
The plan model has completed the following plan for the user's request.

<original_user_task>
...
</original_user_task>

<plan_output>
...
</plan_output>

Decide the next orchestration step:
- If review is enabled, reply only with @llsPlanReview.
- If review is disabled or unnecessary, reply with @llsPlanDone followed by a concise user-facing summary.
- Do not implement the plan.
```

4. `switchChatRoute('normal', 'plan-done-callback')`。
5. `sendUserMessageToCli(callbackPrompt, { hidden: true, forceRoute: 'normal' })`。

### 6.5 normal → review

`watchNormalForPlanHandoff(finalText)` 检测 `@llsPlanReview`：

1. 确认 review adapter 存在；不存在则回 normal 并提示用户或走 `@llsPlanDone` 降级。
2. 用 `latestPlanText` 构造审查 prompt，而不是只发送 token 后文本。
3. `switchChatRoute('review', 'normal-review-handoff')`。
4. `sendUserMessageToCli(reviewPrompt, { hidden: true, forceRoute: 'review' })`。

### 6.6 review done → normal

`handleReviewDone(finalText)`：

1. 记录 `latestReviewText`。
2. 构造隐藏消息发给 normal：

```text
The review model has reviewed the latest plan.

<plan_output>
...
</plan_output>

<review_output>
...
</review_output>

Decide the next orchestration step:
- If the review verdict is CHANGES_REQUESTED and revisionCount < maxRevisions, reply only with @llsPlanRevise followed by the required changes.
- If the review verdict is APPROVED, reply with @llsPlanApproved followed by a concise user-facing summary.
- If revisionCount has reached maxRevisions, stop the loop and ask the user whether to continue.
```

### 6.7 normal → plan revision

`@llsPlanRevise <feedback>`：

1. `revisionCount += 1`。
2. 组合 original task + latest plan + review feedback。
3. 发给 plan CLI 生成修订版方案。
4. 完成后再回到 6.4。

### 6.8 结束 token

- `@llsPlanDone`：清理 workflow active 状态，停留 normal，向用户显示 normal 的总结。
- `@llsPlanApproved`：清理 workflow active 状态，停留 normal，向用户显示 approved 总结。

结束 token 不应再触发 hidden handoff。

---

## 7. handleParsedCliEvent 改造

当前签名是：

```ts
async function handleParsedCliEvent(event: ParsedCliEvent, source: 'normal' | 'expert' = 'normal')
```

需要改为：

```ts
async function handleParsedCliEvent(event: ParsedCliEvent, source: ChatRoute = 'normal')
```

最终文本处理逻辑应统一：

```ts
const finalText = assistantTurnTextBySource[source].trim();
assistantTurnTextBySource[source] = '';

if (source === 'normal') {
    await watchNormalForExpertHandoff(finalText);
    await watchNormalForPlanHandoff(finalText);
} else if (source === 'plan') {
    await handlePlanDone(finalText);
} else if (source === 'review') {
    await handleReviewDone(finalText);
}
```

注意事项：

- `segments` with `event.done` 与独立 `done` 两条路径都可能产生 final text，要避免重复触发回调。
- hidden response 计数只控制是否显示 assistant 消息，不应阻止内部编排回调。
- `session/init` 写入 sessionId 时要对四路设置 `lastKnown*` 并写入 `chatSessionRouteById`。
- `handleToolPermissionRequest` 的 `source` 参数也要从 `'normal' | 'expert'` 改为 `ChatRoute`。

---

## 8. System Prompt

### 8.1 Plan prompt

```text
You are the **plan model** in a multi-model orchestration system. Your job is to
produce clear, structured plans, designs, and technical proposals.

You receive a fresh task from the normal dispatcher. You do not have reliable
access to prior conversation history unless it is included in the prompt.

Output a well-structured plan covering:
- Requirements and assumptions
- Architecture / design decisions
- Implementation steps
- Validation and test strategy
- Risks, tradeoffs, and alternatives

Do not execute implementation steps. Do not use routing tokens such as
@llsExpert, @llsPlanReview, @llsPlanRevise, @llsPlanDone, or @llsPlanApproved.
Return only the plan content.
```

### 8.2 Review prompt

```text
You are the **review model** in a multi-model orchestration system. Your job is
to review plans produced by the plan model for quality, correctness, and
completeness.

You receive the plan content from the normal dispatcher. You do not have reliable
access to prior conversation history unless it is included in the prompt.

Evaluate the plan against:
- Completeness: Are all requirements addressed?
- Correctness: Are the technical decisions sound and consistent with the repo?
- Clarity: Is the plan easy to understand and implement?
- Validation: Are tests and manual verification covered?
- Risks: Are potential issues identified and mitigated?

Start with exactly one verdict line:
VERDICT: APPROVED
or
VERDICT: CHANGES_REQUESTED

Then provide concise findings. If changes are requested, list specific required
fixes. Do not use routing tokens and do not implement the plan.
```

### 8.3 Dispatcher prompt addition

Add to `DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT`:

```text
You are also the orchestrator for plan/review workflows.

When the user asks for a plan, design, proposal, architecture document, or
implementation plan, delegate to the plan model by replying with exactly one
short sentence containing @llsPlanTask followed by the task description.

When a plan result is sent back to you internally:
- If the review model is enabled and the plan should be reviewed, reply only with @llsPlanReview.
- If review is disabled or unnecessary, reply with @llsPlanDone followed by a concise user-facing summary.

When a review result is sent back to you internally:
- If the verdict is CHANGES_REQUESTED, reply only with @llsPlanRevise followed by the requested changes.
- If the verdict is APPROVED, reply with @llsPlanApproved followed by a concise user-facing summary.

Do not perform the planning or review yourself once you decide to delegate.
```

---

## 9. Webview / UI 影响

### 9.1 路由显示

当前 UI 已支持 `route/changed` 的 `ChatRoute` 类型扩展，但实际展示可能仍只区分 normal/expert。需要检查并补齐：

- assistant message route badge：normal/expert/plan/review 四种显示。
- 顶部或输入框路由状态：显示 plan/review 正在运行。
- `chat/running` route 字段：允许 plan/review。

### 9.2 模型选择 UI

当前模型快照只有 normal + expert。若要可视化配置 plan/review，需要扩展：

- `postModelsSnapshot()` 返回 plan/review 模型列表与当前选择。
- `models/applyPair` 改为更通用的 `models/applyRoutes`，或新增兼容消息。
- `expert/model/select` 之外新增 plan/review select 消息，或统一为 routed model select。

如果第一阶段不做 UI，可以先只支持 settings.json 配置，但文档和测试要明确。

### 9.3 用户可见消息

建议 plan/review 的中间输出默认可见，并带 route badge；normal 的内部编排 token 输出应隐藏或被 cancel，避免用户看到 `@llsPlan*` 控制 token。

---

## 10. Relay / token budget

### 10.1 路径到路由映射

本地 HTTP Relay 应优先用请求路径区分 normal/expert/plan/review，而不是用模型 ID 或 `LLS_CHAT_ROLE`：

```txt
normal  CLI: ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/normal  -> POST /normal/v1/messages
expert  CLI: ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/expert  -> POST /expert/v1/messages
plan    CLI: ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/plan    -> POST /plan/v1/messages
review  CLI: ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/review  -> POST /review/v1/messages
```

Relay 入口解析第一个 path segment：

```ts
type RelayRoutePath = 'normal' | 'expert' | 'plan' | 'review';

function parseRoutedPath(path: string): { route: ChatRoute; upstreamPath: string } | undefined {
    const match = path.match(/^\/(normal|expert|plan|review)(\/.*)$/);
    if (!match) return path === '/v1/messages' ? { route: 'normal', upstreamPath: path } : undefined;
    return { route: match[1] as ChatRoute, upstreamPath: match[2] };
}
```

之后只允许 `upstreamPath === '/v1/messages'`。`route` 写入 `RelayUpstreamRequestInfo`，`onUpstreamRequestStart/End` 直接使用该 route 更新 busy 状态。

这个方案可以替代 Relay 侧的显式 expert-mode/role 变量，因为来源路由已经编码在 HTTP request target 中，且同端口多 CLI 共用时仍无歧义。

不能替代的是扩展宿主侧的 `activeRoute` 状态：宿主仍需要它决定下一条用户消息发送给哪条 `StreamJsonCliAdapter`，以及驱动 Webview route badge、手动切换、plan/review workflow 编排。

兼容策略：

- 暂时保留裸 `POST /v1/messages`，按 `normal` 处理，降低迁移风险。
- 启动后做一次 smoke test 或记录首个请求路径，确认 Claude CLI 会保留 `ANTHROPIC_BASE_URL` 的 path prefix。
- 若某个 CLI 版本不保留 base path，回退到当前 model/session/activeRoute 推断，但必须记录 warning。

### 10.2 模型到路由映射（降级）

`resolveRouteForRelayModel(providerId, modelId)` 仅作为无 path 前缀时的降级路径，需要增加 plan/review 匹配：

```ts
if (planConfig.enabled && planConfig.model === fullModelId) return 'plan';
if (reviewConfig.enabled && reviewConfig.model === fullModelId) return 'review';
```

注意：如果 normal/expert/plan/review 配置了同一个模型 ID，单靠 modelId 无法可靠区分路由。更稳妥的方案是优先使用 CLI 注入的角色环境或请求侧上下文；若当前 relay 只能看 modelId，则必须定义优先级并记录限制。建议优先级为当前 activeRoute/sessionId 映射 > role env > modelId 匹配。

### 10.3 token budget reset

自动压缩按 sessionId 分桶。plan/review 接入后必须保证：

- `session/init` 将 plan/review sessionId 写入 `chatSessionRouteById`。
- resetter 删除正确 route 的 session 文件。
- 重启后等待对应 route 的新 sessionId。
- plan/review fresh 启动策略与 token budget reset 不冲突：reset 后仍可拿到新 sessionId，但下一次正常启动不 resume。

---

## 11. 失败与降级策略

必须明确这些边界行为：

- plan 未配置：normal 检测到需要 plan 时应直接说明未配置，或 fallback 到 expert；不要静默失败。
- review 未配置：plan 完成后 normal 走 `@llsPlanDone`。
- review 启用但 adapter 不存在：降级为 `@llsPlanDone` 并提示 review 不可用。
- plan/review CLI 退出或报错：清理 busy 状态，回 normal，向用户显示错误。
- 用户取消：取消当前 activeRoute，对 plan/review workflow 标记中止。
- 用户手动切路由：不自动清理 workflow，但下一次 plan/review token 应仍按 workflow state 判断是否有效。
- revision 超过上限：停止自动循环，询问用户是否继续。

---

## 12. 实施顺序

1. **配置读取层**
   - 引入通用 `RoutedModelModeConfig` / resolver。
   - 实现 `readPlanConfigFromVscode()` / `readReviewConfigFromVscode()`。
   - 给配置合并补单测。

2. **CLI 配置派生**
   - 扩展 `ChatCliConfig`。
   - 将 `getDualConfigsWithRelayEnv` 扩展/重命名为四路配置。
   - 新增 plan/review 默认 prompt 与 override 接入。

3. **extension runtime 四路化**
   - 增加 plan/review 进程、adapter、busy、session 变量。
   - 扩展所有 route helper。
   - 扩展 start/stop/restart/dispose/clear/token-budget reset。

4. **事件处理与编排**
   - `handleParsedCliEvent` source 改为 `ChatRoute`。
   - 实现 `watchNormalForPlanHandoff`。
   - 实现 `handlePlanDone` / `handleReviewDone`。
   - 泛化 `sendUserMessageToCli` 的 force route 参数。

5. **Relay 路由与 token budget**
   - 补 plan/review model/session route 解析。
   - 覆盖 active count 与 running 状态。

6. **UI 与配置入口**
   - 最小版：settings.json only + route badge 可显示 plan/review。
   - 完整版：模型选择弹窗加入 plan/review 两栏。

7. **测试**
   - config resolver 单测。
   - sessionStore kind 单测已存在则补 plan/review 覆盖。
   - plan handoff parser 单测。
   - normal→plan→normal→review→normal 编排单测。
   - review changes requested 的 revision loop 单测。
   - session/clear 删除四个 session 文件的测试。
   - typecheck + 现有 chat/relay 测试。

---

## 13. 待讨论

- plan/review 是否必须在 UI 中配置，还是第一版只支持 settings.json？
- plan/review 中间输出默认是否对用户可见，还是只展示最终 normal 总结？
- plan/review 是否允许工具调用？建议第一版继承当前权限，但 prompt 明确禁止执行实现。
- review 模型未配置时，是否允许 normal 自行做轻量 review，还是直接跳过审查？
- relay 模型重复时，是否需要引入显式 route header/env，避免 modelId 匹配歧义？

---

## 14. plan/review 进程生命周期策略

normal/expert 沿用「随 chat 启动而常驻」是合理的：normal 每条消息都用，expert 在专家模式开启时几乎每个复杂任务都用。plan/review 的使用模式完全不同——只在用户明确要求写方案、且 normal 编排决定走 plan/review 时才被触发，多数会话整场都用不到。因此值得专门讨论它们的进程生命周期策略。

### 14.1 两种候选策略

**策略 A：全程常驻**
- 在 `startChatCliRoutes()` 中，只要 plan/review 配置存在就立即 `start`，与 normal/expert 同步生命周期。
- workflow 之间复用同一个进程。
- 仅在配置变更、`session/clear`、`stopChatCliPair` 时 dispose。

**策略 B：按需启动 + 闲置回收（推荐）**
- 启动 chat 时不拉起 plan/review；只在 `watchNormalForPlanHandoff` 命中 `@llsPlanTask` 或 `@llsPlanReview` 时按需 lazy-start。
- workflow 内（一次或多次 plan↔review 循环）复用进程。
- workflow 结束后启动空闲计时器，到期 dispose。

### 14.2 维度对比

| 维度 | 策略 A：全程常驻 | 策略 B：按需启动 + 闲置回收 |
|------|------------------|------------------------------|
| 触发频次匹配度 | 低（多数会话不会用到 plan/review，常驻浪费资源） | 高（只在真正需要时启动） |
| 资源占用 | 长期多挂 2 个 Claude CLI 进程 + 2 路 stdio + 2 份 MCP 工具集 | 仅在 workflow 期间占用进程 |
| 冷启动延迟 | 0（已就绪） | 一次 `claude --bare --print` 启动开销（约 1–2 秒） |
| fresh context 一致性 | 与策略 B 等价（两者都不 resume session） | 与策略 A 等价 |
| 配置变更复杂度 | 改 plan/review 模型需 dispose + restart 整路 | 改后不立即生效，等下次触发时拿新配置 lazy-start |
| 失败隔离 | plan/review 启动失败会污染整体 chat 启动流程 | 启动失败只影响本次 workflow，可降级到 `@llsPlanDone` |
| token budget / sessionId | 正常分桶 | sessionId 在首次启动时写入，正常分桶 |
| 实现复杂度 | 低（与 normal/expert 同模板） | 中（多一个 lazy ensure helper + idle timer） |
| 用户心智 | 「打开 chat 就起了 4 个 CLI」 | 「需要时才起，对用户透明」 |

### 14.3 关键判断点

策略 B 优于策略 A 的核心理由有 3 条：

1. **plan/review 是无状态的**。本方案明确规定 plan/review 每次启动都不 `--resume` 旧 session（§1.2、§5.1），因此「保留进程」并不能保留对话上下文，常驻的唯一价值只剩省一次冷启动。
2. **冷启动开销可接受**。Claude CLI `--bare --print` 启动通常在 1–2 秒级别，相对一次完整 plan/review 推理耗时占比很小，且用户在等待第一条 plan 输出时本就有心理预期。
3. **失败面更小**。常驻会让 plan/review 启动错误（模型不可用、相关 MCP 加载失败、网络异常）变成「打开 chat 就报错」的全局问题；按需启动则可以把错误局限在本次 workflow，并在 normal 中以 `@llsPlanDone` 形式降级。

策略 A 仅在以下条件成立时更合适，目前都不满足：

- plan/review 被设计成响应每条用户消息（如默认 review pipeline）。
- 冷启动耗时显著（数十秒级）。
- plan/review 需要长期保留 Claude CLI 内部状态。

### 14.4 推荐结论

**plan/review 采用策略 B：按需启动 + 闲置回收**。

具体规则：

- **冷启动时机**：normal 输出命中 `@llsPlanTask` / `@llsPlanReview` 时，由 `ensurePlanCliStarted()` / `ensureReviewCliStarted()` 检查目标进程是否存在或已 exited；不存在则 `start`，存在则直接复用。
- **进程复用窗口**：一个 `PlanReviewWorkflowState` 期间复用同一进程；plan↔review 多次循环不重启。
- **闲置回收**：workflow 结束（`@llsPlanDone` / `@llsPlanApproved` / 用户取消 / revision 超上限）后启动空闲计时器，建议默认 **10 分钟**，到期 `disposePlanCli('idle-timeout')` / `disposeReviewCli('idle-timeout')`。任何新的 workflow 命中会重置或取消计时器。
- **配置变更**：plan/review 模型或开关改变时，如进程已起则 dispose 当前实例；不预热重启，下次触发时按新配置 lazy-start。
- **未配置**：保持当前 dispose 残留实例的语义。
- **`session/clear`**：清除 plan/review 的 sessionId 文件并 dispose 已起的进程；不主动冷启动。
- **`restartChatCliPair`**：只重启 normal/expert；plan/review 等下次触发再起。

### 14.5 对前述章节的影响

采纳策略 B 后，文档对应章节需要同步调整：

- **§1.2 关键原则**：把「四条 CLI 运行时彼此隔离，各自拥有进程」改为「normal 常驻；expert 按配置常驻；plan/review 按需 lazy-start + 闲置回收；四路一旦运行起来彼此隔离」。
- **§5.1 startChatCliRoutes**：plan/review 分支从「配置存在则 start」改为「配置存在则准备好 launch 参数缓存，但不 start」；新增 `ensurePlanCliStarted()` / `ensureReviewCliStarted()` 由编排回调调用。
- **§5.3 stop/restart/clear**：明确 `restartChatCliPair` 不会主动拉起 plan/review；`session/clear` 仍要清四路 sessionId 文件并 dispose 已起的 plan/review。
- **§6.3 / §6.5 normal→plan / normal→review**：在 `switchChatRoute` 之前调用对应 `ensure*` helper；启动失败时回 normal 并显式提示，必要时降级到 `@llsPlanDone`。
- **§11 失败与降级**：补一条「lazy start 失败 → 回 normal 并告知用户，workflow 标记中止」。
- **§12 实施顺序**：把「lazy start + idle timer」单列为一步（建议放在 §3「extension runtime 四路化」之后、编排实现之前），避免与 normal/expert 常驻生命周期混在一起。
- **新增运行时变量**：`planIdleDisposeTimer`、`reviewIdleDisposeTimer`、`planLaunchConfigCache`、`reviewLaunchConfigCache`。
- **测试补充**：
  - `ensurePlanCliStarted()` 首次启动 + 复用 + 已 exited 重启三种路径。
  - workflow 结束 idle 计时器触发 dispose 的测试。
  - lazy start 失败时降级到 `@llsPlanDone` 的测试。
  - 配置变更后 dispose 旧实例、下次触发以新配置启动的测试。
