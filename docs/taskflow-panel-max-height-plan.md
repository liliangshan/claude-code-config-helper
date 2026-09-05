# CC 任务流面板最大高度实施方案

## 目标

将 Chat 输入区上方的 CC 任务流面板限制为最大 `40vh`。任务较少时保持自然高度；超出后仅任务列表内部滚动，标题栏、输入框和底部控制区保持可见。

验收目标：

- 展开态整体高度不超过当前 Chat Webview 高度的 40%。
- 少量任务不强制撑满 `40vh`，避免留下空白。
- 超长任务列表仅在面板内部滚动，面板标题栏保持固定可见。
- 折叠态只保留标题栏，不保留空滚动区域。
- 不改变任务流协议、持久化、自动续推或任务状态更新逻辑。

## 涉及文件与方法

### 1. 面板创建和 DOM 结构

文件：`media/chat/main.js`

- `ensureTaskFlowTodoPanel()`（约 609—625 行）：创建 `.taskFlowTodoPanel_07S1Yg`，并插入输入区的 `.context-panel` 之前。
- `hasRenderableTaskFlowTodos()`（约 633—635 行）：判断当前快照是否包含可渲染任务。
- `renderTaskFlowTodoPanel()`（约 643—714 行）：重建标题栏和 `.taskFlowTodoList_07S1Yg`；折叠时只生成标题栏，不生成列表。
- `updateTaskFlowTodoStatus()`（约 721—737 行）：接收新快照后触发重绘。

展开态 DOM 结构为：

- `.taskFlowTodoPanel_07S1Yg`
  - `.taskFlowTodoHeader_07S1Yg`
  - `.taskFlowTodoList_07S1Yg`
    - 多个 `.taskFlowTodoItem_07S1Yg`

本需求无需修改这些方法。现有结构已经把标题栏和列表分开，适合直接通过 CSS 让根面板限高、列表内部滚动。

### 2. 前端状态接收

文件：`media/chat/main.js`

- `handleExtensionMessage()`（约 4993 行起）：处理扩展发来的消息。
- `taskFlow/status` 分支（约 5146—5148 行）：调用 `updateTaskFlowTodoStatus()`。

文件：`src/chatRuntime/webviewMessages.ts`

- `postChatTaskFlowStatus()`（约 588—602 行）：读取任务服务快照并发送 `{ type: 'taskFlow/status', snapshot }`。
- Webview ready 初始化分支（约 140—159 行）：首次打开 Chat 时补发当前任务流状态。

文件：`src/chat/chatViewHost.ts`

- `postMessage()`（约 134—155 行）：缓存最近一次任务流状态并包装为 Webview 消息。
- `postLastTaskFlowStatus()`（约 181—190 行）：Webview 重建或重新打开时补发缓存状态。

这些方法只负责状态传输，不参与高度计算，不应修改。

### 3. 任务流状态来源

文件：`src/llsTask/service.ts`

- `createWorkflow()`（约 342—370 行）：创建任务流。
- `updateTaskStatuses()`（约 300—332 行）：更新任务状态。
- `clear()`（约 196—206 行）：清除任务流。
- `emitChange()`（约 423—426 行）：向订阅方发出最新快照。

本次只调整展示约束，不修改服务层。

## 实施方案

本节仅针对原有 CC 任务流面板限高，只修改 `media/chat/style.css` 中两个现有选择器。上文“不修改方法/协议”的范围也仅限此项；下文新增的后台任务列表需要单独接入事件、状态和渲染链路。本文件只记录实施方案，当前不实施代码改动。

### 区块一：任务流根面板

位置：`.taskFlowTodoPanel_07S1Yg`（约 441—450 行）。

在保留现有边框、圆角、背景、阴影和 `overflow: hidden` 的基础上增加：

- `display: flex`
- `flex-direction: column`
- `max-height: 40vh`
- `min-height: 0`

职责：

- 根面板约束标题栏、列表、内边距和边框的合计高度。
- `max-height` 而非固定 `height`，保证短列表和折叠态仍使用自然高度。
- `overflow: hidden` 继续负责圆角裁切，不让滚动内容越过面板边界。

### 区块二：任务列表

位置：`.taskFlowTodoList_07S1Yg`（约 500—505 行）。

增加：

- `flex: 1 1 auto`
- `min-height: 0`
- `overflow-y: auto`
- `overflow-x: hidden`
- `overscroll-behavior: contain`

可选增加 `scrollbar-gutter: stable`，用于常驻滚动条平台减少文字横向跳动；如果希望 macOS 覆盖式滚动条不预留空间，可不添加。

职责：

- 列表达到可用高度后收缩并成为唯一的纵向滚动容器。
- 标题栏不进入滚动区域，滚动任务时始终可见。
- `min-height: 0` 是纵向 flex 子元素能够缩小并触发内部滚动的关键。
- `overscroll-behavior: contain` 防止列表滚到边缘后立即带动外层消息列表。

## 扩展方案：后台任务可展开列表

### 目标与事件规则

参考 CC 任务流待办面板，在输入区上方新增独立的“后台任务（数量）”列表。默认展开，点击标题可折叠；只展示仍在运行的任务，完成后直接移除，不保留完成历史。最后一个任务移除后，整个面板消失。此节仍然只是方案，不修改业务代码。

处理用户提供的两类事件：

- `system/background_tasks_changed`：读取 `tasks` 中的 `task_id`、`task_type`、`description`，按 ID 去重后更新当前列表。该样例没有 `status`，应作为运行中的任务展示，不能要求必须含有 `in_progress`。
- `system/task_updated`：按 `task_id` 合并 `patch`；当 `patch.status` 为 `completed` 时立即移除对应任务。样例中的 `abd0a5678ac0a7f65` 应先显示“分析 H3-T 通道方案”，完成补丁到达后消失。
- `failed`、`cancelled`、`canceled`、`killed` 等明确终态也应移除，避免永久显示运行中。仅在 `end_time` 为有效结束时间时才可作为结束依据，不能把 `null` 或字段存在本身视为完成。
- 暂将 `background_tasks_changed.tasks` 约定为完整当前快照：空数组清空列表，快照中不存在的任务移除。实施前需用真实事件序列验证上游是否确为全量语义；若为增量，必须调整为合并，不能误删仍在运行的任务。
- 未知 ID 的完成补丁直接忽略，重复完成操作保持幂等；未知 ID 的非终态补丁缺少描述等信息时不创建空白条目。
- 不再把这两类事件生成普通 System 卡片或原始 JSON 正文；其他系统事件保持现有行为。

### 1. CLI 事件解析

文件：`src/chat/cli/cliAdapter.ts`

已有方法与拟修改点：

- `ParsedCliEvent`：增加 `backgroundTasks/snapshot` 和 `backgroundTasks/update` 类型分支，分别携带任务快照、任务 ID 与补丁；保留来源会话 ID（若存在）。
- **新增** `parseSystemBackgroundTaskEvent(record)`：精确匹配上述两个 system subtype，验证字段后转换成内部事件。不完整事件不创建空白任务。
- `parseJsonEvent()`：在 `parseSystemGenericEvent()` 之前调用新解析方法，避免先被通用 System 卡片解析消耗。
- `stripEmbeddedSystemTaskEvents()`：嵌入正文中的同类系统 JSON 复用新解析方法，通过现有 `emitAdHoc()` 转发并从展示文本中剥离，不再降级为卡片。
- `parseSystemTaskEvent()`：不要仅将这两个 subtype 加入静默忽略集合，否则虽然隐藏 JSON，却无法更新后台任务列表。

### 2. 宿主状态与事件分发

**拟新增文件**：`src/chatRuntime/backgroundTasks.ts`。

后台任务状态与 CC 任务流分开管理，不写入 `src/llsTask/service.ts`、聊天消息或 `.LLSOAI/task-flow.json`。建议维护属于当前 CLI 会话/进程代次的 `Map<task_id, task>`，新增以下带注释的方法：

- `replaceBackgroundTasks(tasks)`：验证并应用当前列表快照，返回独立的展示快照。
- `applyBackgroundTaskPatch(taskId, patch)`：只合并补丁明确提供的字段，终态按 ID 删除，不用缺失字段覆盖描述。
- `getBackgroundTasksSnapshot()`：返回任务数组副本，避免发送后又被原地修改。
- `resetBackgroundTasks()`：在真实会话切换或 CLI 生命周期结束时清空。

文件：`src/chatRuntime/cliEventHandlers.ts`

- 修改 `handleParsedCliEvent()`：增加两个后台任务事件分支，先同步合并宿主状态，再推送完整快照；不要调用 `appendAssistantSegments()`，也不要把任务更新当成助手回复完成。
- 状态合并必须发生在首次 `await` 前，避免异步事件处理导致快照与完成补丁乱序。拒绝旧会话或已替换进程的迟到事件。

### 3. 消息协议、缓存与重建

文件：`src/chat/protocol.ts`

- **新增** `BackgroundTaskPayload`，至少包含 `taskId`、`taskType`、`description`。
- 在 `ExtensionToWebview` 增加 `backgroundTasks/status`，携带所属会话和合并后的完整 `tasks` 数组。前端不再重复实现补丁合并。

文件：`src/chat/chatViewHost.ts`

- 参考 `lastTaskFlowStatus`，**新增** `lastBackgroundTasksStatus` 缓存。
- 修改 `postMessage()`：在检查 Webview 是否存在前缓存后台任务状态，空数组也必须覆盖缓存。
- **新增** `postLastBackgroundTasksStatus()`；在 `resolveWebviewView()`、`open()` 的初始化之后补发缓存，防止视图重建时列表丢失。

文件：`src/chatRuntime/webviewMessages.ts`

- **新增** `postChatBackgroundTasksStatus()`，读取宿主状态并推送完整快照。
- 修改 `dispatchChatWebviewMessage()` 的 `webview/ready` 分支：补发当前列表，包括空列表；页面 ready 前的发送不能代替此兜底。
- 在真正的 `session/clear`、`session/resume` 会话切换流程中清空旧状态并推送空列表。普通 Webview `session/init` 重绘不等于切换 CLI 会话，不能无条件清空。

文件：`src/chatRuntime/cliLifecycle.ts`

- 在 `stopChatCliPair()`、`rebuildNormalAdapter()`、`handleChatCliExit()` 对应的真实停止、替换和退出路径清理后台任务，并使旧进程迟到事件失效。
- 预期退出不一定进入 `handleChatCliExit()`，不能只在该方法清理。
- 主助手的普通 `done/result` 不代表后台任务完成，不应清空；任务可以在主回复结束后继续运行。
- `normal/taskFlow` 共用 normal CLI，不应仅因为 UI 路由名称不同维护两份列表。

### 4. 前端可折叠面板

文件：`media/chat/main.js`

参考 `taskFlowTodoState`、`ensureTaskFlowTodoPanel()`、`renderTaskFlowTodoPanel()` 和 `updateTaskFlowTodoStatus()`，新增独立实现：

- `backgroundTasksState`：保存最新任务数组及 `collapsed`，默认展开；更新任务时不重置折叠状态。
- `ensureBackgroundTasksPanel()`：创建带 `data-role="background-tasks-panel"` 的 section，挂载到 `composer-shell`、上下文面板之前。
- `renderBackgroundTasksPanel()`：标题显示“后台任务（N）”，标题按钮同步 `aria-expanded`，点击切换折叠。展开时逐项显示运行中图标、描述及必要的类型信息；描述用 `textContent`，不能作为 HTML 插入。空数组时移除整个 section。
- `updateBackgroundTasksStatus(tasks)`：替换前端展示快照并调用渲染；重绘时保留折叠状态，必要时记录并恢复列表 `scrollTop`。
- `handleExtensionMessage()`：增加 `backgroundTasks/status` 分支，调用上述更新方法。若携带会话 ID，应拒绝不属于当前会话的快照。
- 在 `main.js` 现有多语言词条中补充后台任务标题、运行中及展开/折叠提示，不复用文案含义不同的 CC 任务流标题。

面板顺序固定为 CC 任务流、后台任务、Claude TodoWrite、上下文及输入区。为避免创建事件先后顺序影响位置，实施时同步检查 `ensureTaskFlowTodoPanel()`、`ensureClaudeTodoPanel()` 的插入锚点，必要时抽出统一的面板排序方法；不能只依靠新面板首次插入的位置。

文件：`media/chat/style.css`

- 新增 `.backgroundTasksPanel_07S1Yg`、`.backgroundTasksHeader_07S1Yg`、`.backgroundTasksList_07S1Yg`、`.backgroundTasksItem_07S1Yg`，参考现有任务流面板颜色、圆角和进行中图标。
- 根面板使用纵向 flex、`max-height: 40vh`、`min-height: 0` 及裁切；标题显式设置 `flex-shrink: 0`，列表设置 `min-height: 0`、`overflow-y: auto`、`overscroll-behavior: contain`。
- 不使用固定高度，折叠后只剩标题；不改消息正文内的工具卡样式。
- 两面板同时展开时不能各占 `40vh`：建议由统一排序/布局方法给 composer 设置“双面板可见”状态，CSS 将 CC 与后台任务面板各限为 `20vh`；只有一个面板可见时仍为 `40vh`。此约束仅覆盖这两个面板，Claude TodoWrite 同时很长及极矮窗口仍需独立验证，不能声称已保证所有组合下输入区可见。

### 5. 回归测试与验收

文件：`src/chat/__tests__/cliAdapterSystemTaskEvent.test.ts`

- 新增后台快照与增量补丁解析测试，断言产生后台任务事件而不是 System 卡片或原始 JSON。
- 修改现有将 `task_updated` 期望为 System 卡片的用例；保留 `api_retry` 等不相关系统事件的原有断言。
- 覆盖嵌入正文形式，保证状态只更新一次且正文不残留系统 JSON。

拟新增文件：`src/chatRuntime/__tests__/backgroundTasks.test.ts`

- 用文中任务 ID 验证“收到快照出现一项 → 收到 completed 补丁变为零项”。
- 覆盖多个任务、相同 ID 去重、重复完成、未知 ID 完成、空快照、无 status 的运行任务和其他终态。
- 覆盖部分补丁保留描述、会话重置、旧进程迟到事件不污染新会话。

实际 Webview 验收：

1. 收到示例 `background_tasks_changed` 后显示“后台任务（1）”和“分析 H3-T 通道方案”，没有额外 System 卡片。
2. 点击标题折叠/展开正常；折叠期间新增任务会更新数量，但不强制展开。
3. 收到示例 `task_updated/completed` 后移除条目，最后一项完成时移除面板，不显示完成历史。
4. 长列表内部滚动，标题保持可见；与 CC 任务流共存时高度按上述预算限制，输入区域仍可操作。
5. Webview 重建后补发运行中快照；清空后的空快照也能重放，不复活旧任务。
6. 会话切换、CLI 退出/替换清空列表；主回复结束但后台任务仍在运行时保持显示。

实施代码后，先检查 VS Code 诊断，再运行 TypeScript 编译、相关回归测试及前端语法检查，最后进行 Webview 手动验收。当前仅修改本文档，不执行上述尚未实现的功能验收。


