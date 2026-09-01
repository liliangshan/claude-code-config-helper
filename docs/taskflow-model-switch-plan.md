# 任务流模型切换设计（2026-09-02）

## 目标

配置了任务流专用模型时，**在每次续推前把主 CLI 的模型切到任务流模型并重启**，
任务流跑完（完成 / 清空）后再还原回原来的主模型。创建阶段始终用主模型。

不拉第二个 CLI 子进程 —— 沿用同一个进程、同一个 `--resume` 会话，
上下文和 session_id 保持连续。

## 为什么不用独立子 CLI 通道

独立通道能把「任务流跑着时的普通消息」隔离到主模型，但：

- 任务流进行中在同一个聊天窗口发的消息，本来就是针对当前任务流发的，
  用任务流模型是**期望行为**，不需要隔离；
- 独立进程是另一条会话，上下文和 session_id 都是新的，任务流看不到之前的对话；
- 需要新增一整套进程生命周期（启停、adapter 重建、状态订阅、孤儿进程回收）。

切主模型方案则天然复用现有会话：`startChatCliPair()`（`cliLifecycle.ts:281-282`）
重启时会读 `chatCliSessionStore.readSessionId(cwd, 'normal')` 并传
`--resume <sessionId>`（`cliProcess.ts:394`），所以**切模型重启不丢上下文**。

## 现状（问题）

| 环节 | 现状 | 问题 |
| --- | --- | --- |
| 切换动作 | `src/taskFlow/taskFlowCommands.ts:216 applyTaskFlowModelIfConfigured()` 调 `selectChatModel()` | 改了全局 `currentModel` 且**永不还原** |
| 调用时机 | 只在 `sendTaskFlowPrompt()` / `trySendTaskFlowPromptToBuiltInChat()` | 等于「创建时」就换模型，**方向刚好反了** |
| 续推 | `src/activation/wiring.ts:129` submitter `appendUserMessageAndSend(text)` | 续推时不做任何模型判断 |
| 提交前钩子 | `AutoContinueBeforeSubmit`（`autoContinue.ts:28`）已存在但**未注入**（`wiring.ts:127` 注释「不注入 beforeSubmit」） | 现成的切模型 + 延时插入点被闲置 |
| 还原 | 无 | 任务流结束后普通对话一直用任务流模型 |

即：现在是「创建时换、之后不还原」，目标是「创建不换、**每次续推前判断**、结束还原」。

**每次续推前判断**：`applyTaskFlowModelForContinue()` 幂等 —— 模型已经对就直接返回，
不重启；模型不对才 `selectChatModel()` → 重启 CLI，**重启完成后再延时一小段**才提交
续推 prompt（新进程 `--resume` 恢复会话需要时间，立刻写 stdin 可能被丢）。

## 改动清单

### 1. `src/chatRuntime/modelSelection.ts` — 切换与还原

新增三个导出函数。原主模型存 `workspaceState`（不是内存变量），
这样 VS Code 崩溃或窗口重载后，下次激活仍能还原。

```ts
/** workspaceState 键：任务流切换模型前的原主模型 `providerId/modelId`。 */
const TASK_FLOW_PREVIOUS_MODEL_KEY = 'llsccai.taskFlow.previousMainModel';
```

- `applyTaskFlowModelForContinue(): Promise<TaskFlowModelSwitchResult>`
  返回 `'skipped' | 'unchanged' | 'switched'`，**每次续推前调用，幂等**：
  1. `readEffectiveTaskFlowModelSelection()` 为空 → `'skipped'`（不切，用主模型）；
  2. 解析出 `providerId/modelId`，与 `getConfigManager().getCurrentModel()` 相同
     → `'unchanged'`（已经在任务流模型上，**不重启**，这是第二次及以后续推的常态路径）；
  3. 不同 → 若 `workspaceState` 里还没存原模型，先把当前 `getCurrentModel()` 存进去
     （已存则不覆盖，避免第二次切换把原模型写成任务流模型）；
  4. `await selectChatModel(providerId, modelId, { silent: true })`（内部已含
     `setCurrentModel` + `postChatModelOptions` + `restartChatCliPair({ silent: true })`，
     见 `modelSelection.ts:238-252`）；
  5. `'switched'`。
  解析失败或模型已被禁用（`selectChatModel` 会抛）→ 记日志，返回 `'skipped'` 降级主模型。
  **只有 `'switched'` 才需要延时**，见第 2 条。

- `restoreMainModelAfterTaskFlow(reason: string): Promise<void>`
  从 `workspaceState` 读原模型；没有就直接 return（幂等）。
  读到则先清键、再 `await selectChatModel(providerId, modelId)`，
  最后记一条 `Logger.info`。**先清键**是为了避免还原过程中抛错导致下次重复还原。
  原模型对应的 provider/model 已被删除时 `selectChatModel` 会抛 —— 捕获后只清键、
  记 warn，不打断任务流结束流程。

- `hasPendingTaskFlowModelRestore(): boolean`
  `workspaceState` 里存在原模型键即返回 true，供激活期补偿还原用。

修改：
- `saveTaskFlowModelSelection()`（第 118 行）：用户中途改了任务流模型，
  下一次续推的第 2 步自然会发现模型不同并重新切换，**不用额外处理**。

### 2. `src/chatRuntime/modelSelection.ts` — 切换后的延时续推

重启 CLI 是异步的：`restartChatCliPair()` 返回时子进程刚 spawn 完，
`--resume` 恢复会话、MCP 桥握手都还在路上，立刻写 stdin 有丢消息风险。
所以切换成功后**先等一小段再返回**，让 beforeSubmit 天然把续推推迟：

```ts
/** 切模型重启 CLI 后，等待新进程 resume 会话就绪再提交续推的静置时长。 */
const TASK_FLOW_MODEL_SETTLE_DELAY_MS = 1_500;
```

在 `applyTaskFlowModelForContinue()` 第 4 步之后、返回 `'switched'` 之前
`await new Promise(resolve => setTimeout(resolve, TASK_FLOW_MODEL_SETTLE_DELAY_MS))`。

`'unchanged'` / `'skipped'` **不延时** —— 常态路径不能被无谓拖慢，
一整轮任务流只有第一次续推吃这 1.5 秒。

### 3. `src/activation/wiring.ts` — 注入 beforeSubmit，续推前判断模型

`AutoContinueBeforeSubmit`（`autoContinue.ts:28`）本就在 submitter 之前被
`await`（`autoContinue.ts:329-331`），是「先判断、必要时重启、再续推」的现成插点。
把第 127 行的「不注入 beforeSubmit」改为：

```ts
// 每次续推提交前判断模型：配了任务流模型且当前不是它，就先切换并重启 CLI，
// 由 applyTaskFlowModelForContinue 内部静置后再返回，随后才提交续推 prompt。
AutoContinueScheduler.setBeforeSubmit(async () => {
    if (!getLlsTaskService()?.hasActiveWorkflow()) return;
    await applyTaskFlowModelForContinue();
});
AutoContinueScheduler.setSubmitter(async (text) => {
    await appendUserMessageAndSend(text, { forceRoute: 'taskFlow' });
});
```

`beforeSubmit` 抛错会被 `runIfCurrent` 的 catch 吞掉并**跳过本次续推**
（`autoContinue.ts:339-342`），所以 `applyTaskFlowModelForContinue()` 内部必须
自己 try/catch 降级，绝不向外抛。

`hasActiveWorkflow()` 判断保证创建阶段（workflow 还没建出来）不会切模型；
`chatMessaging.ts` **不用改** —— 切换发生在调用它之前，
`ensureChatCliStarted()` 与 `getStreamAdapterForRoute()` 拿到的都是重启后的新实例。

### 4. `src/extension.ts` — 任务流结束时还原

第 103 行已有订阅：

```ts
context.subscriptions.push(llsTaskService.onDidChange(() => {
    void postChatTaskFlowStatus();
}));
```

扩展为：`!snapshot.workflow || llsTaskService.isWorkflowCompleted()` 时
`void restoreMainModelAfterTaskFlow('workflow-finished')`。
`emitChange()` 在 `updateTaskStatuses`（`service.ts:323`）和 `clear()` 里都会触发，
所以最后一个任务标记 completed 的那一刻就会还原。

激活期补偿（`activate()` 内、`restorePersistedChatSession()` 之后）：

```ts
// 上次会话在任务流中途被强制关闭时，workspaceState 里可能残留原主模型；
// 此时没有活动 workflow 就说明任务流已经不需要任务流模型了，直接还原。
if (hasPendingTaskFlowModelRestore() && !llsTaskService.hasActiveWorkflow()) {
    void restoreMainModelAfterTaskFlow('activate-compensate');
}
```

有活动 workflow 时不还原 —— 用户重开窗口后继续推进，仍应留在任务流模型上。

### 5. `src/taskFlow/taskFlowCommands.ts` — 删掉「创建时换模型」

- 删除 `applyTaskFlowModelIfConfigured()`（第 216 行）及其两处调用：
  `sendTaskFlowPrompt()`（第 235 行）、`trySendTaskFlowPromptToBuiltInChat()`（第 256 行）。
- 删除第 14 行的 `readEffectiveTaskFlowModelSelection` / `selectChatModel` import。
- `trySendTaskFlowPromptToBuiltInChat()` 里的 `forceRoute: 'taskFlow'`（第 258 行）保留 ——
  它只影响 busy 记账与工具注入，不影响模型；创建阶段因此天然走主模型。

### 6. `src/llsTask/autoContinue.ts` — 无需改

`AutoContinueBeforeSubmit` 类型（第 28 行）、`setBeforeSubmit()`（第 160 行）与
`runIfCurrent()` 里的 `await beforeSubmit()`（第 331 行）都已具备，只是没人注入。
本方案只在 `wiring.ts` 里填上这个空位，调度器本身一行不动。

## 完整链路

```
用户点 CC任务流 / 输入 @lls-task
  └─ trySendTaskFlowPromptToBuiltInChat：forceRoute='taskFlow'
       └─ 主模型调 create 工具建 workflow                    ← 创建始终用主模型

AutoContinueScheduler 到点（4 秒后）→ runIfCurrent
  ├─ resolvePromptForCurrentKind() 为空 → 直接结束，不切模型
  └─ beforeSubmit()                                        ← 每次续推前判断
       ├─ 没有活动 workflow（仍在创建）→ 直接返回
       └─ applyTaskFlowModelForContinue()   ← 幂等
            ├─ 没配任务流模型 → 'skipped'，继续用主模型
            ├─ 当前已是任务流模型 → 'unchanged'，不重启不延时（第 2 次起的常态）
            └─ 不是 → 存原主模型到 workspaceState
                       → selectChatModel(silent) → 重启 CLI（--resume 保留会话）
                       → 静置 1.5s 等新进程就绪 → 'switched'
  └─ submitter(prompt) → appendUserMessageAndSend(text, { forceRoute:'taskFlow' })
       └─ ensureChatCliStarted() → adapter 已是重启后的实例 → 发送

最后一个任务 completed / 用户清空
  └─ llsTaskService.onDidChange
       └─ restoreMainModelAfterTaskFlow() → 清 workspaceState 键
            → selectChatModel(原主模型) → 再重启一次 CLI（同样 --resume）
```

一整轮任务流总共只重启 CLI 两次：切入一次、还原一次；只有切入那次多等 1.5 秒。

## 注意点

- **上下文不丢**：重启走 `startChatCliPair()` → `readSessionId(cwd, 'normal')` →
  `--resume`，session_id 与对话历史都保持不变。这正是本方案相对独立子进程的核心优势。
- **重启期间的 busy 状态**：`restartChatCliPair()`（`cliLifecycle.ts:316`）会
  `resetAllRouteBusy()`，续推消息是在重启 + 静置完成之后才写 stdin 的，不会丢。
- **beforeSubmit 不能抛**：抛错会被 `runIfCurrent` catch 并跳过本次续推
  （`autoContinue.ts:339-342`）。切模型失败必须内部降级成主模型继续，不能中断任务流。
- **别弹 toast**：`selectChatModel()` 末尾（第 251 行）有
  `showChatToast('success', '模型已切换为：…')`。任务流自动切换不该刷屏，
  需要给 `selectChatModel` 加一个 `options.silent` 抑制 toast（模型下拉刷新仍要做，
  否则 UI 与实际模型不一致）。这是唯一需要动 `selectChatModel` 签名的地方。
- **崩溃残留**：靠 workspaceState + 激活期补偿还原覆盖；最坏情况是主模型停在
  任务流模型上，用户手动改回即可，不会有孤儿进程。
- **任务流进行中发普通消息**：会用任务流模型 —— 这是接受的行为
  （此时发的消息本就是针对当前任务流的）。

## 落地顺序

1. `modelSelection.ts`：`selectChatModel` 加 silent 选项 +
   `applyTaskFlowModelForContinue`（含静置延时）/ `restoreMainModelAfterTaskFlow` /
   `hasPendingTaskFlowModelRestore`
2. `wiring.ts`：注入 `setBeforeSubmit`，submitter 保持 `forceRoute:'taskFlow'`
3. `extension.ts`：onDidChange 还原 + 激活期补偿
4. 删掉 `taskFlowCommands.ts` 的 `applyTaskFlowModelIfConfigured`
5. 单测：创建阶段（无活动 workflow）不切模型、没配任务流模型时返回 skipped、
   已在任务流模型时返回 unchanged 且不重启不延时、切换失败时不抛、
   workflow 完成后还原、原模型键在还原后被清空

