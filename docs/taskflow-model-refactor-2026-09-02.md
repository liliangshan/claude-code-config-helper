# 移除专家/方案/审查，引入任务流模型（落地方案）

日期：2026-09-02
状态：待实施

## 1. 目标

1. 彻底移除「专家模式」「方案模式」「审查模式」三套功能及其全部配置、UI、流程编排。
2. 新增「任务流模型」，工作区级保存，任务流触发时自动切换到该模型。
3. 未配置任务流模型时回退到当前主模型，不阻断使用。
4. 输入框下方原「专家」模型 chip 改为显示「任务流」模型。

## 2. 决策记录

| 议题 | 决策 |
| --- | --- |
| `src/expertMode/` 及 ask_expert MCP 工具链 | 整目录删除，模型不再能调用 ask_expert |
| planReviewWorkflow 流程编排 | 整套删除，不保留「方案→审查」自动转接 |
| 任务流模型未配置 | 回退主模型，输入框 chip 显示「—」 |
| 压缩模型（compactionMode） | **不动**，保持现状 |
| 任务流模型作用域 | 仅工作区级（`ConfigurationTarget.Workspace`），不写全局 |

## 3. 影响面

`expert` / `planMode` / `reviewMode` 在 40+ 个文件中出现。本方案按「删除」「改写」「新增」分三类组织。

## 4. 阶段 A：整文件删除

以下文件全部删除，无需保留任何内容：

### A.1 专家模式目录

| 文件 | 说明 |
| --- | --- |
| `src/expertMode/expertConfig.ts` | 专家配置读写（**先抽走压缩相关代码，见 A.1.1**） |
| `src/expertMode/askExpertMcpServer.ts` | ask_expert MCP 服务端 |
| `src/expertMode/expertSubturnService.ts` | 专家子轮次执行 |
| `src/expertMode/expertTriggers.ts` | 专家触发判定 |
| `src/expertMode/expertConstants.ts` | 专家常量 |
| `src/expertMode/__tests__/expertConfig.test.ts` | 测试 |
| `src/expertMode/__tests__/expertTriggers.test.ts` | 测试 |
| `src/expertMode/__tests__/askExpertMcpServer.test.ts` | 测试 |
| `src/expertMode/__tests__/expertSubturnMessages.test.ts` | 测试 |

删除后 `src/expertMode/` 目录应为空并一并移除。

### A.1.1 前置搬迁：压缩配置读取

`expertConfig.ts` 里混入了压缩模式的代码，压缩模式**保留不动**，因此删除该文件前
必须先把下列符号搬到新文件 `src/chatRuntime/compactionConfig.ts`：

| 符号 | 行 | 说明 |
| --- | --- | --- |
| `RoutedModelModeConfig`（类型） | — | 压缩配置结构，仍需要 |
| `defaultRoutedModelModeConfig` | 97 | 默认值 |
| `resolveRoutedModelModeConfig()` | 134 | 工作区/全局优先级合并 |
| `readCompactionConfigFromVscode()` | 187 | 唯一保留的读取入口 |
| `readRoutedModelModeConfigFromVscode()` | 319 | 上者的内部实现 |
| `firstDefinedBoolean()` / `firstNonEmptyString()` | 341 / 356 | 私有工具 |
| `readWorkspaceInspectValue()` / `readGlobalInspectValue()` | 371 / 381 | 私有工具 |
| `readWorkspaceBooleanOrUndefined()` / `readGlobalBooleanOrUndefined()` | 388 / 399 | 私有工具 |
| `readWorkspaceStringOrUndefined()` / `readGlobalStringOrUndefined()` | 412 / 425 | 私有工具 |

`expertConfig.ts` 中其余符号（`ExpertUserTriggerMode`、`ExpertSubturnOptions`、
`defaultExpertSubturnOptions`、`defaultExpertModeConfig`、`resolveExpertConfig`、
`readExpertConfigFromVscode`、`readPlanConfigFromVscode`、`readReviewConfigFromVscode`、
`readExpertSubturnOptions`、`readStringEnum`、`readNumberInRange`）随文件删除。

压缩配置的两个消费方都要改 import 源为 `'../chatRuntime/compactionConfig'`：
`src/relay/router.ts:21`、`src/chat/cli/cliConfig.ts`（后者的 expert 相关 import
在阶段 E.1 一并处理，此处只改 compaction 这一条）。


### A.2 方案/审查流程编排

| 文件 | 说明 |
| --- | --- |
| `src/chatRuntime/planReviewWorkflow.ts` | 方案→审查流程编排 |
| `src/chat/routing/planReviewWorkflow.ts` | 路由侧配套 |

### A.3 专家相关测试

| 文件 | 说明 |
| --- | --- |
| `src/chat/__tests__/cliAdapter.askExpert.test.ts` | 整文件删除 |

### A.4 需改写而非删除的测试

| 文件 | 处理 |
| --- | --- |
| `src/chat/__tests__/cliConfigDual.test.ts` | 双配置语义随 expert 消失，删除 expert 相关用例；若整文件仅测 expert，则整文件删除 |
| `src/chat/cli/__tests__/cliConfig.dualConfigs.test.ts` | 同上 |
| `src/chat/cli/__tests__/cliConfig.dispatcherPrompt.test.ts` | 移除 expert 分支断言 |
| `src/chat/__tests__/sessionStoreKind.test.ts` | 移除 expert/plan/review 会话种类用例 |
| `src/chat/__tests__/cliProcess.mcpSkills.test.ts` | 移除 ask_expert 工具注入断言 |
| `src/relay/__tests__/routerPath.test.ts` | 移除 expert/plan/review 路由用例 |
| `src/relay/__tests__/tokenBudgetIntegration.test.ts` | 同上 |
| `src/relay/__tests__/taskRequestInjection.test.ts` | 同上 |
| `src/relay/tokenBudget/__tests__/compactor.test.ts` | 同上 |
| `src/chat/__tests__/llsTaskService.test.ts` | 同上 |

同时更新 `package.json` 的 `test` 脚本 glob，移除已删测试文件的显式入口。

## 5. 阶段 B：配置项与常量

### B.1 `src/constants.ts`

**删除**以下常量（行号为当前值，实施时以符号名为准）：

| 常量 | 行 |
| --- | --- |
| `CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY` | 174 |
| `CHAT_EXPERT_MODE_PROJECT_MODEL_KEY` | 182 |
| `CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY` | 190 |
| `CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY` | 197 |
| `CHAT_PLAN_MODE_PROJECT_ENABLED_KEY` | 216 |
| `CHAT_PLAN_MODE_PROJECT_MODEL_KEY` | 224 |
| `CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY` | 232 |
| `CHAT_PLAN_MODE_GLOBAL_MODEL_KEY` | 237 |
| `CHAT_PLAN_APPEND_SYSTEM_PROMPT_KEY` | 243 |
| `CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY` | 251 |
| `CHAT_REVIEW_MODE_PROJECT_MODEL_KEY` | 259 |
| `CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY` | 267 |
| `CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY` | 272 |
| `CHAT_REVIEW_APPEND_SYSTEM_PROMPT_KEY` | 278 |
| `CHAT_EXPERT_APPEND_SYSTEM_PROMPT_KEY` | 299 |
| `CHAT_EXPERT_USER_TRIGGER_MODE_KEY` | 309 |
| `CHAT_EXPERT_MAX_STEPS_KEY` | 312 |
| `CHAT_EXPERT_STEP_TIMEOUT_MS_KEY` | 315 |
| `CHAT_EXPERT_TOTAL_TIMEOUT_MS_KEY` | 318 |
| `CHAT_EXPERT_MAX_CALLS_PER_TURN_KEY` | 321 |

**新增**（放在 `TASK_FLOW_TARGET_KEY` 附近，与既有任务流常量归组）：

```ts
/**
 * 任务流模型（工作区级）。
 *
 * 形如 `providerId/modelId`；为空表示未配置，此时任务流回退到当前主模型。
 * 仅写入 workspace 作用域，不写全局。
 */
export const CHAT_TASK_FLOW_MODEL_KEY = 'chat.taskFlow.model';
```

**保留不动**：`CHAT_COMPACTION_MODE_*` 全部 4 个常量。

### B.2 `package.json` → `contributes.configuration`

**删除** 16 个配置项（403–498 行区间内）：

- `claudeCodeConfigHelper.chat.expertMode.{project,global}.{enabled,model}`（4 项）
- `claudeCodeConfigHelper.chat.planMode.{project,global}.{enabled,model}`（4 项）
- `claudeCodeConfigHelper.chat.reviewMode.{project,global}.{enabled,model}`（4 项）
- `claudeCodeConfigHelper.chat.expert.*`（appendSystemPrompt / userTriggerMode / maxSteps / stepTimeoutMs / totalTimeoutMs / maxCallsPerTurn）
- `claudeCodeConfigHelper.chat.plan.appendSystemPrompt`、`claudeCodeConfigHelper.chat.review.appendSystemPrompt`

**保留** `claudeCodeConfigHelper.chat.compactionMode.*` 4 项。

**新增** 1 项：

```json
"claudeCodeConfigHelper.chat.taskFlow.model": {
    "type": "string",
    "default": "",
    "scope": "resource",
    "description": "%configuration.chat.taskFlow.model.description%"
}
```

`scope` 用 `resource` 以支持工作区级覆盖。

### B.3 i18n 文案

同步删除 `package.nls.json` 及各语言变体中所有 `configuration.chat.expertMode.*` /
`configuration.chat.planMode.*` / `configuration.chat.reviewMode.*` /
`configuration.chat.expert.*` / `configuration.chat.plan.*` /
`configuration.chat.review.*` 键，新增 `configuration.chat.taskFlow.model.description`。

## 6. 阶段 C：路由类型收敛

### C.1 `src/chat/protocol.ts:4`

```ts
// 改前
export type ChatRoute = 'normal' | 'expert' | 'plan' | 'review';
// 改后
export type ChatRoute = 'normal' | 'taskFlow';
```

`ChatRoutedModelSelection`（219 行）保持结构不变，仅使用方改变。

### C.2 `src/chatRuntime/routeState.ts`

`ChatRoute` 收敛后以下三处的 `Record` 字面量会编译报错，逐一改写：

| 行 | 改前 | 改后 |
| --- | --- | --- |
| 49 | `routes: Record<ChatRoute, ChatRouteRuntime>` 含 4 键 | 仅保留 `normal`、`taskFlow` |
| 57 | `assistantTurnTextBySource = { normal:'', expert:'', plan:'', review:'' }` | `{ normal: '', taskFlow: '' }` |
| 60 | `hiddenCliResponseTurnsByRoute = { normal:0, expert:0, plan:0, review:0 }` | `{ normal: 0, taskFlow: 0 }` |

`chatSessionRouteById`、`chatRouteState`、`pendingAskUserRequests`、
`setRelayRouteBusy()` 均按类型自动收敛，无需改动函数体。

## 7. 阶段 D：模型选择（核心）

文件：`src/chatRuntime/modelSelection.ts`

### D.1 删除

| 符号 | 行 | 说明 |
| --- | --- | --- |
| `EffectiveExpertModelSelection` | 69 | 接口 |
| `readEffectiveExpertModelSelection()` | 91 | |
| `readEffectivePlanModelSelection()` | 126 | |
| `readEffectiveReviewModelSelection()` | 145 | |
| `saveExpertModelSelection()` | 166 | |
| `savePlanModelSelection()` | 182 | |
| `saveReviewModelSelection()` | 209 | |
| `selectChatExpertModel()` | 369 | |

**保留**：`readEffectiveCompactionModelSelection()`（110）、
`saveCompactionModelSelection()`（193）、`getInspectedWorkspaceValue()`（77）、
`getInspectedGlobalValue()`（82）、`findModelDisplayName()`（220）、
`isSelectableModel()`（260）、`assertSelectableSubModel()`（277）、
`selectChatModel()`（348）。

### D.2 新增读取函数

```ts
/**
 * 读取生效的任务流模型。
 *
 * 仅读工作区级配置；未配置时返回空串，由调用方回退到当前主模型。
 *
 * @returns 形如 `providerId/modelId` 的模型标识；未配置时为空串。
 */
export function readEffectiveTaskFlowModelSelection(): string {
    const inspect = vscode.workspace
        .getConfiguration(CONFIG_NAMESPACE)
        .inspect<string>(CHAT_TASK_FLOW_MODEL_KEY);
    return getInspectedWorkspaceValue(inspect) ?? '';
}
```

注意：不复用 `ChatRoutedModelSelection`（它带 `enabled` 字段，任务流模型没有
独立开关，空串即未配置）。

### D.3 新增保存函数

```ts
/**
 * 保存任务流模型到工作区配置。
 *
 * @param modelId 形如 `providerId/modelId`；传空串表示清除配置。
 */
export async function saveTaskFlowModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = (modelId || '').trim();
    await vscode.workspace
        .getConfiguration(CONFIG_NAMESPACE)
        .update(CHAT_TASK_FLOW_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
}
```

与被删的 `saveExpertModelSelection()` 不同：**只写 Workspace，不写 Global**，
也不需要配套的 `enabled` 键。

### D.4 改写 `getModelLabelForRoute()`（230）

```ts
// 改前：237 行判 route === 'expert'，241 行判 route === 'plan'
// 改后：
export function getModelLabelForRoute(route: ChatRoute): string {
    if (route === 'taskFlow') {
        const modelId = readEffectiveTaskFlowModelSelection();
        // 未配置时回退主模型标签，与实际执行行为保持一致
        if (!modelId) return getModelLabelForRoute('normal');
        return findModelDisplayName(modelId);
    }
    // ... normal 分支保持不变
}
```

### D.5 改写 `handleModelsApplyPair()`（303）

签名从 5 参降为 3 参：

```ts
// 改前
export async function handleModelsApplyPair(
    normal: ...,
    expert: { providerId: string; modelId: string } | null,
    plan: ... | null,
    review: ... | null,
    compaction: ... | null
)
// 改后
export async function handleModelsApplyPair(
    normal: { providerId: string; modelId: string },
    taskFlow: { providerId: string; modelId: string } | null,
    compaction: { providerId: string; modelId: string } | null
)
```

函数体对应调整：删除 313–315 行三条 `assertSelectableSubModel`，改为
`assertSelectableSubModel('任务流', taskFlow)`；删除 325–330 行 expert/plan/review
的保存，改为 `await saveTaskFlowModelSelection(taskFlow ? \`${taskFlow.providerId}/${taskFlow.modelId}\` : '')`；
compaction 分支（331–332）原样保留。

## 8. 阶段 E：运行时改写

### E.1 `src/chat/cli/cliConfig.ts`

| 位置 | 处理 |
| --- | --- |
| 27 行 import `readExpertConfigFromVscode` / `readPlanConfigFromVscode` / `readReviewConfigFromVscode` | 删除整条 import |
| 28 行 import `ASK_EXPERT_MCP_SERVER_NAME` | 删除 |
| 60 行 `SUB_ROUTE_IDS` 含 `'expert'`/`'plan'`/`'review'` | 整个常量删除（收敛后无子路由） |
| 106–125 行 ask_expert 调度指引段 | 删除 |
| 157–178 行 `DISPATCHER_PLAN_REVIEW_PROMPT`（`@llsPlanTask` 等 5 个 token） | 删除 |
| 181–211 行 `DEFAULT_EXPERT_APPEND_SYSTEM_PROMPT` / `LEGACY_EXPERT_APPEND_SYSTEM_PROMPT` | 删除 |
| 214 行起 `DEFAULT_PLAN_APPEND_SYSTEM_PROMPT` / `DEFAULT_REVIEW_APPEND_SYSTEM_PROMPT` | 删除 |
| `getRoutedConfigsWithRelayEnv()` | 返回值从 `{ normal, expert, plan, review }` 收敛为 `{ normal }`；内部不再构造子路由配置 |

任务流不需要独立 CLI 进程——它只是换模型后走 normal CLI，所以这里不新增任何
路由配置分支。

### E.2 `src/chatRuntime/cliLifecycle.ts`

| 行 | 处理 |
| --- | --- |
| 294 | `const { normal, expert, plan, review } = await ...` → `const { normal } = await ...` |
| 325–329 | expert CLI 停用块整段删除 |
| 330–344 | plan/review 的 `launchConfigCache` 写入整段删除 |
| ~351 起 | `disposePlanCli()` / `disposeReviewCli()` 及其调用点删除 |

`startChatCliPair()` 名字保留但语义变为「只启 normal 一条」，函数注释同步改写。

### E.3 `src/chatRuntime/chatMessaging.ts`

| 行 | 处理 |
| --- | --- |
| 17 | 删除 `startsWithExpertPrefix` / `stripExpertPrefix` import |
| 40 | 依赖接口删除 `runUserTriggeredExpertSubturn` 字段 |
| 469 | `sendUserMessageToCli()` 签名去掉 `forceExpert`，保留 `forceRoute?: ChatRoute` |
| 476–479 | 用户前缀判定块整段删除，`route` 只由 `forceRoute` 决定，默认 `'normal'` |
| 501–504 | expert sub-turn 分支删除 |
| 636–637 | `isRouteBusy('expert')` / `cancelRouteProcess('expert')` 删除 |

`forceRoute: 'taskFlow'` 是任务流唯一入口（见阶段 F）。

### E.4 `src/chatRuntime/cliEventHandlers.ts`

| 行 | 处理 |
| --- | --- |
| 33 | 依赖字段 `watchNormalForExpertHandoff` 删除 |
| 78–80 | `expertHandled` 与 `planHandled` 合并逻辑删除，直接返回 false |
| 125–126 | 函数注释里 `@llsExpert` 路由检测说明删除 |
| 173–174 | `source === 'expert'` 分支删除 |

### E.5 `src/chatRuntime/webviewMessages.ts`

| 行 | 处理 |
| --- | --- |
| 18 | 删除 expertTriggers import |
| 58 / 61 | 删除 `readEffectiveExpertModelSelection` / `selectChatExpertModel` import，改引 `readEffectiveTaskFlowModelSelection` |
| 113–115 | `switchRouteToExpert()` 整个函数删除 |
| 136 | `postChatExpertModelOptions()` 调用改为 `postChatTaskFlowModelOptions()` |
| 151–159 | `forceExpert` 前缀判定删除，`sendUserMessageToCli(prompt)` 不再传该选项 |
| 177–178 | 消息类型 `'expert/model/select'` → `'taskFlow/model/select'`，调用 `selectChatTaskFlowModel()` |
| 214 | `handleModelsApplyPair(message.normal, message.taskFlow, message.compaction)` |
| 243–251 / 328–332 | 会话清理里 `'expert'` 及日志文案改为只处理 normal/taskFlow |
| 469–486 | `postChatExpertModelOptions()` → `postChatTaskFlowModelOptions()`，消息类型 `'taskFlow/model/options'` |
| 538–594 | 合并 options 构造里 `expertModels`/`currentExpert` → `taskFlowModels`/`currentTaskFlow`；plan/review 组删除 |
| 604–611 | `switchChatRoute()` 里 `route === 'expert'` 的适配器检查删除 |

新增 `selectChatTaskFlowModel(modelId)`：解析 `providerId/modelId` 后调
`saveTaskFlowModelSelection()`，再 `postChatTaskFlowModelOptions()` 回推。

### E.6 `src/activation/wiring.ts` / `shutdown.ts`

| 文件 | 行 | 处理 |
| --- | --- | --- |
| wiring.ts | 33–34 | 删除 `runUserTriggeredExpertSubturn` / `watchNormalForExpertHandoff` import |
| wiring.ts | 45 / 116 | `postChatExpertModelOptions` → `postChatTaskFlowModelOptions` |
| wiring.ts | 88 / 123 | 对应依赖注入项删除 |
| wiring.ts | 169 | `['专家模型列表', postChatExpertModelOptions]` → `['任务流模型列表', postChatTaskFlowModelOptions]` |
| shutdown.ts | 12 | 删除 `disposeExpertSubturnService` import |
| shutdown.ts | 21 | `ROUTE_DISPOSE_ORDER` → `['normal', 'taskFlow']` |
| shutdown.ts | 66 | `disposeExpertSubturnService()` 调用删除 |

### E.7 `src/relay/`

| 文件 | 行 | 处理 |
| --- | --- | --- |
| `taskRequestInjection.ts` | 21 | 删除 `EXPERT_NATIVE_AGENT_TOOL_NAME` import |
| `taskRequestInjection.ts` | 197–200 | 注释中「强制走 ask_expert」说明删除，并同步删除依赖该常量的 Agent 工具拦截分支 |
| `taskRequestInjection.ts` | 50 / 79 / 87 | 这几处的 `expert` 是英文单词（"expert AI programming assistant"），**不要动** |
| `router.ts` | 21 | import 源改为 `'../chatRuntime/compactionConfig'` |
| `router.ts` | 112 | `/^\/(normal\|expert\|plan\|review)(\/.*)$/` → `/^\/(normal\|taskFlow)(\/.*)$/` |
| `router.ts` | 128 | 注释里 `normal/expert` 改为 `normal/taskFlow` |
| `tokenBudget/compactor.ts` | — | 按 `ChatRoute` 收敛后的编译报错逐处改写，压缩逻辑本身不动 |

## 9. 阶段 F：任务流自动切模型

文件：`src/taskFlow/taskFlowCommands.ts`

### F.1 新增内部函数

```ts
/**
 * 任务流发起前把聊天主模型切到任务流模型。
 *
 * 未配置任务流模型时不做任何切换，静默沿用当前主模型。
 */
async function applyTaskFlowModelIfConfigured(): Promise<void> {
    const modelId = readEffectiveTaskFlowModelSelection();
    if (!modelId) return;
    const separatorIndex = modelId.indexOf('/');
    if (separatorIndex <= 0) return;
    await selectChatModel(modelId.slice(0, separatorIndex), modelId.slice(separatorIndex + 1));
}
```

### F.2 调用点

| 函数 | 处理 |
| --- | --- |
| `sendTaskFlowPrompt()` | 发送前 `await applyTaskFlowModelIfConfigured();` |
| `trySendTaskFlowPromptToBuiltInChat()`（~233） | 同上，且发送时传 `forceRoute: 'taskFlow'` |

`buildTaskFlowPrompt()`、`openLlsCcaiTaskMenu()`、`maybePostTaskFlowRestorePrompt()`
不改。`TASK_FLOW_TARGET_KEY` / `TaskFlowTarget` 保持原样。

## 10. 阶段 G：Webview UI

### G.1 `media/chat/index.html`

| 行 | 改前 `data-role` | 改后 |
| --- | --- | --- |
| 24 | `expert-model-name` | `taskflow-model-name` |
| 69 | `composer-expert-chip` | `composer-taskflow-chip` |
| 71 | `composer-expert-chip-name` | `composer-taskflow-chip-name` |
| 112 | `model-picker-expert-select` | `model-picker-taskflow-select` |

模型选择弹窗里的「方案模型」「审查模型」两个 `select` 及其容器整块删除，
「压缩模型」保留。

### G.2 `media/chat/main.js`

| 位置 | 处理 |
| --- | --- |
| 437 / 439 | `composerExpertChipEl` / `composerExpertChipNameEl` 改名为 taskflow 版并同步选择器 |
| ~1341–1395 | chip 渲染逻辑改读任务流模型；未配置时名称显示 `'—'` |
| 5379 | 点击绑定改用新变量名，仍打开 `openModelPicker` |
| i18n | `closeExpert`→`closeTaskFlow`；`expertModelSelectTitle`/`Aria`→`taskFlowModelSelectTitle`/`Aria`；`modelsBarExpert`→`modelsBarTaskFlow`；`pickerExpertSection`→`pickerTaskFlowSection`；`expertNotConfigured`→`taskFlowNotConfigured` |
| i18n 删除 | `pickerPlanSection`、`pickerReviewSection`、`expertPanelTitle`、`expertPanelStatus*`、`expertEvent*` |
| i18n 保留 | `ccTaskFlow`（'CC任务流' 快捷按钮，~908 行）、`pickerCompactionSection` |
| 专家运行面板 | 对应 DOM 渲染与事件处理整块删除 |

文案统一用「任务流模型」。

### G.3 `src/chat/protocol.ts` 消息契约

| 消息 | 改动 |
| --- | --- |
| `expert/model/options` → `taskFlow/model/options` | 载荷字段 `models` / `current` 结构不变 |
| `expert/model/select` → `taskFlow/model/select` | 同上 |
| `models/apply` | 载荷 `{ normal, expert, plan, review, compaction }` → `{ normal, taskFlow, compaction }` |
| 合并 options 消息 | `expertModels`/`currentExpert` → `taskFlowModels`/`currentTaskFlow`；plan/review 字段删除 |

`media/chat/main.js` 侧收发这些消息的分支同步改名。

## 11. 阶段 H：验证与收尾

1. `npx tsc --noEmit -p ./` 必须零错误（`ChatRoute` 收敛会暴露所有遗漏点，是主要
   的正确性闸门）。
2. `npm test` 全绿；预期用例数因阶段 A.4 删减而下降，届时以实际值为准。
3. MCP `get_errors` 复查 VS Code 侧诊断。
4. `npx vsce package` 走一遍打包，确认 `package.json` 配置项与 `package.nls.*`
   键一一对应（缺键会以 `%configuration.xxx%` 原样显示）。
5. `package.json` 版本号 +1。
6. 遗留设置说明：用户 `settings.json` 里旧的 `chat.expertMode.*` /
   `chat.planMode.*` / `chat.reviewMode.*` / `chat.expert.*` 键在扩展删除声明后会被
   VS Code 标记为「未知配置」，但不影响功能。本次**不写迁移代码**，仅在
   CHANGELOG 中提示用户可自行清理。

## 12. 实施顺序建议

按依赖倒序推进，每步保持可编译：

1. A.1.1 压缩配置搬迁 + `router.ts` import 改源（独立可验证）
2. 阶段 B 常量与配置项（含 i18n）
3. 阶段 D modelSelection.ts 新函数（先加后删）
4. 阶段 C `ChatRoute` 收敛 —— 此时开始大面积编译报错
5. 阶段 E 逐文件消错
6. 阶段 A 删文件
7. 阶段 F 任务流接线
8. 阶段 G Webview
9. 阶段 H 验证




