# 任务流持久化缓存方案

## 目标

任务流在**创建**和**更新**时把状态持久化到项目 `.LLSOAI/` 目录，VS Code / 扩展下次启动时自动载入上次未完成的任务流，避免重启后丢失任务进度与原始用户上下文。

## 背景与现状

- 任务流状态目前只存在内存中：`LlsTaskService.snapshot`（`src/llsTask/service.ts`），重启即丢失。
- 快照结构 `LlsTaskSnapshot`（`src/llsTask/types.ts`）已包含需要持久化的全部字段：
  - `workflow`（含 `title` / `summary` / `tasks[]`，每个 task 有 `id/title/description/status`）
  - `planningDocumentPath`
  - `originalUserPrompt`
  - `lastError`
  - `updatedAt`
- 状态变更入口集中且清晰：
  - 创建：`createWorkflow()`
  - 更新：`updateTaskStatuses()`
  - 标记/上下文：`markWorkflowCreationPending()`
  - 清空：`clear()`
  - 所有变更最终都会调用私有的 `emitChange()`。
- `.LLSOAI/` 目录已是既有约定，且已有成熟的持久化范式可参考：
  - `src/relay/tokenBudget/store.ts`（`TokenCountStore`）：`resolveRoot()` 优先取 `workspaceFolders[0]`，无工作区回退 `os.homedir()`；`.LLSOAI/<file>.json`；`fs.mkdir(recursive)`；原子写。
  - `src/chat/cli/sessionStore.ts`：同样的 `.LLSOAI` 根目录解析。

## 存储位置与文件格式

- 文件：`.LLSOAI/task-flow.json`
- 根目录解析：复用现有约定——优先 `vscode.workspace.workspaceFolders[0].uri.fsPath`，无工作区回退 `os.homedir()`。
- JSON schema（带 `version` 便于将来迁移）：

```jsonc
{
  "version": 1,
  "savedAt": "2026-05-30T08:00:00.000Z",
  "snapshot": {
    "workflow": {
      "title": "...",
      "summary": "...",
      "tasks": [
        { "id": "1", "title": "...", "description": "...", "status": "in_progress" }
      ]
    },
    "planningDocumentPath": ".LLSOAI/plan.md",
    "originalUserPrompt": "把所有 console.log 改成 logger",
    "lastError": null,
    "updatedAt": 1748592000000
  }
}
```

- 只持久化「业务快照」字段，不持久化运行期易失标志（如 `workflowCreationPending` /
  `workflowUpdateMissing` / `preContinueCompactionUntil`）。这些是续推调度态，重启后应从
  干净状态重新计算，避免恢复出错误的「待创建/缺工具」状态。

## 设计

### 1. 新增 `TaskFlowStore`（`src/llsTask/store.ts`）

仿照 `TokenCountStore` 写一个轻量持久化层，仅负责读写 `.LLSOAI/task-flow.json`：

```ts
export interface PersistedTaskFlow {
  version: number;
  savedAt: string;
  snapshot: LlsTaskSnapshot;
}

export class TaskFlowStore {
  async load(): Promise<LlsTaskSnapshot | null>;   // 文件不存在 / 解析失败 / 版本不符 → null
  async save(snapshot: LlsTaskSnapshot): Promise<void>; // mkdir -p 后原子写
  async clear(): Promise<void>;                    // 删除文件（忽略 ENOENT）
  private resolveRoot(): string;                   // 同 TokenCountStore
}
```

要点：
- `save` 用「写临时文件 + rename」原子落盘，避免半截 JSON。
- 反序列化时做防御校验：`workflow.tasks` 必须是数组；非法直接当成 null（损坏文件不应阻塞启动）。
- 失败只 `Logger.warn`，绝不抛出影响主流程。

### 2. `LlsTaskService` 接入持久化

构造函数注入一个可选的 `TaskFlowStore`（可选是为了让现有单测无需改桩）：

```ts
constructor(
  private readonly configManager: ConfigManager,
  private readonly store?: TaskFlowStore
) {}
```

写入时机（防抖落盘）：
- 在 `emitChange()` 里统一触发一次 `void this.persist()`——所有变更（创建 / 更新 / 标记 /
  清空）都已经过 `emitChange()`，集中一处即可，避免遗漏。
- `persist()` 内部做去重/防抖（例如 250ms trailing），避免一次批量 `updateTaskStatuses`
  连续触发多次磁盘写。
- `clear()` 走 `store.clear()` 删除文件，而不是写一个空 workflow。

载入时机：
- 新增 `public async restore(): Promise<void>`：从 `store.load()` 读回快照，仅当
  `workflow` 非空且**未全部完成**时才恢复到内存（已完成的任务流没有续推价值，恢复反而会
  在下次打开时弹「运行中」类提示）。
- 恢复后 `emitChange()` 让 UI（任务流状态视图）立即反映；但要注意避免「载入即又触发一次
  persist 写回」的无谓写——可在 restore 路径用一个内部标志跳过该次 persist。

### 3. extension 启动时调用 restore

`activate()` 中现在是：

```ts
llsTaskService = new LlsTaskService(configManager);
```

改为：

```ts
const taskFlowStore = new TaskFlowStore();
llsTaskService = new LlsTaskService(configManager, taskFlowStore);
await llsTaskService.restore();   // 失败内部已吞掉，不阻塞激活
```

`restore()` 完成后，已有的 `llsTaskService.onDidChange(() => postChatTaskFlowStatus())`
订阅会把恢复出来的任务流推给 webview。

### 4. 恢复后在 Chat webview 内弹对话框提示「继续 / 清除」

恢复出未完成任务流后，**不自动续推**，而是在 **Chat webview 内弹自定义对话框**让用户决定。
已确认的三项交互决策：

- **形式**：webview 内自定义对话框（不是 VS Code 原生通知）。
- **弹出时机**：**用户首次打开 Chat 面板时**才弹（不是扩展激活时）。
- **「继续」语义**：点「继续」时**先启动 CLI，等 CLI 启动完成后自动发送续推提示**，
  用户无需手动回车。

#### 协议改动（`src/chat/protocol.ts`）

- 扩展 → webview：新增
  ```ts
  | { type: 'taskFlow/restorePrompt'; title: string; summary: string; progress: string }
  ```
  携带恢复出的任务流标题/摘要/进度（如 `2/5`），供对话框展示。
- webview → 扩展：新增
  ```ts
  | { type: 'taskFlow/restoreChoice'; choice: 'continue' | 'clear' | 'dismiss' }
  ```

#### 触发流程

1. `activate()` 中 `await llsTaskService.restore()` 把磁盘任务流读回内存（见 §2/§3），
   并设一个内存标志 `pendingRestorePrompt = true`（仅当恢复出未完成 workflow 时）。
2. 现有 `chatViewHost.onDidReceiveMessage` 已处理 `webview/ready`（`extension.ts:2125 / 4347`）。
   在 `webview/ready` 处理里：若 `pendingRestorePrompt` 为真，则
   `postMessage('taskFlow/restorePrompt', …)`，然后把标志置回 false（只弹一次）。
   `webview/ready` 即「面板首次加载完成」的信号，天然满足「首次打开 Chat 面板时才弹」。
3. webview 端渲染对话框（沿用 Chat 现有弹层样式），三个按钮回传 `taskFlow/restoreChoice`。

#### 扩展端处理 `taskFlow/restoreChoice`

- **continue**（核心：等 CLI 起好后自动发，不需手动）：
  1. `await ensureChatCliStarted()` —— 点继续时才启动 CLI，并 **await 到启动完成**。
  2. `await appendUserMessageAndSend(llsTaskService.buildContinuePrompt())` ——
     直接把续推提示作为一条 user 消息**自动提交**到 CLI（复用续推 submitter 同一条链路），
     不再用 `fillBuiltInChatComposer`（那个只填入不发送）。
  3. 失败兜底：若 `appendUserMessageAndSend` 抛错，记录日志并 toast 提示用户可手动重发。
- **clear**：
  - `autoContinueScheduler.cancel(...)` + `resetMissingToolCounter(...)` + `llsTaskService.clear()`
    （`clear()` 删除 `.LLSOAI/task-flow.json`）。
- **dismiss**（关闭对话框 / 取消）：
  - 内存保留恢复出的任务流，磁盘文件保留，用户之后仍可从任务流菜单继续。

> 复用提示：clear 的动作与 `openLlsCcaiTask` 第 3 分支（`extension.ts:659-676`）一致，
> 建议抽成 `clearRestoredTaskFlow()` 复用。continue 这里改用 `appendUserMessageAndSend`
> 自动提交，与原「运行中」分支「填入不发送」不同——这是本次明确要求的差异。

### 5. 与续推调度的关系

- 恢复出 active workflow 后，**不自动续推**；只有用户在 webview 对话框点「继续」后，
  才在 CLI 启动完成时自动发送一次续推提示（见上节）。
- `AutoContinueScheduler` 的计数器（缺工具熔断等）保持启动即 0，不持久化。

## 边界与注意

1. **多工作区**：按 `workspaceFolders[0]` 定位，与现有 token-budget / session 行为一致；
   多根工作区只认第一个根。
2. **无工作区**：回退 `~/.LLSOAI/task-flow.json`，行为与 `TokenCountStore` 对齐。
3. **已完成任务流**：`restore` 时跳过（不恢复），但磁盘文件可在 `clear()` 或下次创建时被覆盖/删除。
4. **损坏文件**：load 失败一律当 null，并 warn；不删除原文件，方便用户排查。
5. **并发写**：`persist()` 防抖 + 原子 rename，单进程内足够；本扩展不存在多进程并发写同一文件。
6. **隐私**：`originalUserPrompt` 会落盘到项目目录。`.LLSOAI/` 已存放 session / token / debug
   等数据，属于既有约定范围；如担心可在文档里提示用户将 `.LLSOAI/` 加入 `.gitignore`。

## 测试计划

- `src/llsTask/__tests__/store.test.ts`（新增）：
  - save → load 往返一致。
  - 文件不存在 → load 返回 null。
  - 损坏 JSON / 缺 tasks → load 返回 null 且不抛。
  - clear 删除文件；对不存在文件调用 clear 不报错。
- `service` 层：
  - `createWorkflow` 后 store 收到一次 save（用内存桩 store 断言）。
  - `updateTaskStatuses` 后 save，且内容含最新 status。
  - `clear()` 调用 store.clear()。
  - `restore()`：active 未完成 → 恢复并 emitChange；已完成 → 不恢复。

## 实施步骤

1. 新增 `src/llsTask/store.ts`（`TaskFlowStore`）。
2. `LlsTaskService` 构造注入可选 store；`emitChange()` 触发防抖 `persist()`；`clear()` 删文件；新增 `restore()`。
3. `src/chat/protocol.ts` 新增 `taskFlow/restorePrompt`（扩展→webview）与 `taskFlow/restoreChoice`（webview→扩展）两个消息类型。
4. webview 端（`media/` 下 Chat UI）实现恢复对话框：收到 `taskFlow/restorePrompt` 弹层展示标题/摘要/进度，三按钮回传 `taskFlow/restoreChoice`。新增对话框文案（各语言）。
5. `extension.ts`：`activate()` 装配 store + `await restore()` + 设 `pendingRestorePrompt`；在 `webview/ready` 处理里按需 `postMessage('taskFlow/restorePrompt')`（只弹一次）；新增 `taskFlow/restoreChoice` 处理（continue=启动 CLI 后 `appendUserMessageAndSend` 自动发续推；clear=清空删文件；dismiss=保留）。
6. 新增 store 与 service 持久化单测。
7. 编译 + 跑 `out/llsTask/__tests__/*.test.js` 与既有 router 回归；webview 改动需手动在面板里验证对话框与「继续自动发送」。
8. 升小版本号、打包、提交推送。

## 不做 / 未来可选

- 不做跨工作区合并、不做历史多版本归档（只保留当前一个任务流）。
- 不做加密；如有需要再单独评估。
- 不把易失续推标志持久化。

