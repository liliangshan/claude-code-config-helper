# AskUserQuestion 提问工具与网关转发问题分析

## 现象

1. 模型调用 AskUserQuestion 弹出提问选择框后，有时**还没等用户选择**，后面就自动继续发请求（网关继续转发上游请求）。
2. 有时会**同时弹出多个**提问弹窗。

## CLI 侧机制（从 claude 2.1.141 二进制提取）

AskUserQuestion 的答案不是走普通 tool 执行，而是走**授权通道**回传：

- `checkPermissions()` 固定返回 `{ behavior: "ask", message: "Answer questions?", updatedInput }`，
  即每次调用都会发一条 `control_request`（subtype `can_use_tool`）。
- 输入 schema 带一个隐藏字段 `answers`（"User answers collected by the permission
  component"）：官方 UI 在授权环节让用户选择，然后把答案塞进
  `control_response.updatedInput.answers` 回给 CLI。
- CLI 拿到 allow 响应后，`call()` 直接把 `updatedInput` 里的 `answers` 打包成
  `tool_result: "User has answered your questions: ..."`，**立即继续下一轮上游请求**。
- 若 answers 为空，则 tool_result 为「(no option selected)」，模型同样会继续跑。

## 扩展侧现状

- `src/extension.ts:2402 handleToolPermissionRequest`：收到 `can_use_tool` 后弹
  VS Code 通用「允许/拒绝」模态框；点允许时 `updatedInput: event.input` **原样回传，
  没有填 answers** → CLI 认为"已回答（空答案）"，立刻继续 → 表现为"弹窗后自动发请求"。
- `bypassPermissions` 模式（cliProcess.ts:359）：不接 `--permission-prompt-tool stdio`，
  授权请求被 CLI 内部自动放行 → 问题被静默跳过，连弹窗都没有。
- relay 本身是无状态 HTTP 转发，"继续发请求"的发起方是 CLI，不是网关多发。
- **Chat webview 已有完整的提问弹窗**（main.js:3154 `showAskUserQuestionModal`，
  由 main.js:2712 在流式渲染遇到 `tool.name === 'AskUserQuestion'` 时触发，
  使用 style.css 第 14 节 `.ask-modal` 样式）。但它的回传走的是
  `user/send` **普通用户消息**，与 CLI 的授权通道完全脱节。

## 真正的问题链路

弹窗与工具结果是两条互不相干的通道：

```
模型调用 AskUserQuestion
 ├─ 流式 tool_use → webview → 弹出 ask-modal（等用户选择）
 └─ CLI checkPermissions "ask" → 授权通道：
     ├─ bypass 模式（--dangerously-skip-permissions）：
     │    静默自动放行 → answers 为空 → tool_result "(no option selected)"
     │    → 模型立刻继续 ← ★ 弹窗还开着，后面就自动发请求
     └─ 非 bypass 模式（stdio）：
          extension.ts:2412 弹 VS Code「允许/拒绝」框 → 点允许时
          updatedInput 原样回传（无 answers）→ 同样空答案 → 模型继续
```

用户随后在 ask-modal 里点选提交 → 以新 user 消息发出 → 又触发一轮对话。

## 多弹窗原因

1. **空答案循环**：模型拿到 "(no option selected)" 后经常**重新调用
   AskUserQuestion** → 新 toolUseId → `askUserQuestionShown` 去重失效 →
   新 overlay 直接叠在旧弹窗上（弹窗无取消按钮，旧的关不掉）。
2. **单轮多个 tool_use**：模型可在一条消息里发多个 AskUserQuestion 调用，
   每个 segment 各弹一个 modal，无排队。
3. **双通道重复**：非 bypass 模式下 VS Code「Answer questions?」模态框与
   webview ask-modal 会同时出现，视觉上就是"弹出多个"。
4. **user/send 回传再触发**：用户提交答案作为新消息发出后，模型基于文本答案
   继续，若之前空答案轮里它已再次提问，两轮弹窗交错。

## 修复方案（待确认）

核心：把 ask-modal 的答案**改走授权通道**，让 CLI 阻塞等待真实答案。

1. `handleToolPermissionRequest`（extension.ts:2402）对
   `toolName === 'AskUserQuestion'` 分流：不弹 VS Code 框，改为向 webview 发
   新协议消息 `askUser/request { requestId, questions }`；webview 复用现有
   ask-modal 渲染，提交时回 `askUser/answers { requestId, answers, notes }`；
   扩展把 answers 填进 `updatedInput.answers`（自定义补充填进 annotations.notes）
   后 `respondToToolPermission(allow)`。CLI 在收到回包前完全阻塞 →
   上游请求自然停止，无需改 relay。
2. main.js:2712 的流式触发路径**取消直接弹窗**（改为渲染普通工具卡片或忽略），
   弹窗只由 `askUser/request` 驱动，消除双通道重复。
3. **排队**：webview 维护 FIFO，同一时刻只显示一个 ask-modal，上一个回包后
   再弹下一个。
4. bypass 模式：`--dangerously-skip-permissions` 下没有授权通道，无法拦截。
   方案 A（推荐）：bypass 模式也改回 `--permission-prompt-tool stdio` +
   扩展侧对除 AskUserQuestion 外的所有 can_use_tool 一律立即自动 allow，
   等效 bypass 且提问可拦；需实测该组合下 CLI 行为。
   方案 B：bypass 模式维持现状（提问被空答案跳过），文档里说明限制。
5. 历史回放（session/init）路径维持现有 pending 逻辑，但由于答案已写进
   tool_result，重放时不会再出现"未答复"状态，旧弹窗不会复现。

## 兼容性风险

- expert / plan / review 路由同样挂 stdio 授权通道；提问弹窗需带路由标识，
  回包要送回对应路由的 adapter（`getStreamAdapterForRoute(source)` 已支持）。
- 用户长时间不答 → CLI 一直阻塞：这正是期望行为（网关不再转发），
  但任务流场景已在 taskRequestInjection.ts:215 屏蔽了该工具，不受影响。

## 落地实施清单（具体到文件和方法）

### 第 1 步：协议扩展 — `src/chat/protocol.ts`

- `ExtensionToWebview` 联合类型新增：
  `| { type: 'askUser/request'; requestId: string; route: ChatRoute; questions: AskUserQuestionItem[] }`
- `WebviewToExtension` 联合类型新增：
  `| { type: 'askUser/answers'; requestId: string; route: ChatRoute; answers: Record<string, string>; notes?: string }`
- 新增导出接口 `AskUserQuestionItem`：
  `{ question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }`

### 第 2 步：扩展宿主分流与回包 — `src/extension.ts`

- 新增模块级 `pendingAskUserRequests: Map<string, { route: ChatRoute }>`
  （key = requestId），记录已发给 webview、等待回答的提问。
- 改 `handleToolPermissionRequest(event, source)`（约 :2402）：
  开头加分支——`event.toolName === 'AskUserQuestion'` 时：
  1. 从 `event.input` 解析 `questions`（非法时按原逻辑走通用弹窗兜底）；
  2. `pendingAskUserRequests.set(event.requestId, { route: source })`；
  3. `chatViewHost?.postMessage({ type: 'askUser/request', requestId, route: source, questions })`；
  4. `return`（不弹 VS Code 模态框、不立刻回包 → CLI 阻塞等待）。
- 新增 `handleAskUserAnswers(message)`：
  1. 校验 `pendingAskUserRequests.has(requestId)`，取 route 后删除条目；
  2. `getStreamAdapterForRoute(route)` 拿 adapter；
  3. 组 `updatedInput = { ...原 input, answers, ...(notes ? { annotations } : {}) }`
     —— 原 input 需在 pending Map 里一并暂存（Map value 增加 `input` 字段）；
  4. `adapter.respondToToolPermission(requestId, { behavior: 'allow', updatedInput, updatedPermissions: [] })`。
- `handleChatWebviewMessage`（:2480）switch 新增
  `case 'askUser/answers': handleAskUserAnswers(message); return;`
- CLI 进程退出/重启时清理：在现有 cli/status 或 restart 路径调用
  `pendingAskUserRequests.clear()`，避免残留死等条目。

### 第 3 步：webview 弹窗改接授权通道 — `media/chat/main.js`

- `handleExtensionMessage`（:4813）switch 新增
  `case 'askUser/request': enqueueAskUserRequest(message); break;`
- 新增 FIFO 队列 `askUserQueue` 与 `activeAskUserRequest`；
  新增 `enqueueAskUserRequest(message)`：入队后若无活动弹窗则
  `showAskUserQuestionModal` 展示队首；提交回包后 shift 弹下一个。
- 改 `showAskUserQuestionModal`（:3154）：
  1. 增加参数形态支持 `{ requestId, route, questions }`（授权通道模式）；
  2. 授权模式提交时不再 `post({ type: 'user/send', ... })`，改为
     `post({ type: 'askUser/answers', requestId, route, answers, notes })`
     —— answers 按 CLI 约定组成 `{ [questionText]: '选项1, 选项2' }`
     （多选逗号分隔；未选且有自定义输入时值取 '(notes only)'）；
  3. 保留原 user/send 分支仅供历史回放兜底（第 5 步会移除实时触发）。
- 改流式触发点（:2712）：`segment.tool.name === 'AskUserQuestion'` 时
  **不再调用 showAskUserQuestionModal**，改为 `appendToolCard(container, segment)`
  正常渲染卡片（弹窗唯一入口变为 askUser/request）。
- 历史回放钩子 `finalizeHistoryReplayAskUser`（:3089）：改为不弹窗
  （答案已写进 tool_result，回放时不存在"未答复"状态）；保留函数壳与
  `historyReplayMode` 复位。

### 第 4 步：bypass 模式拦截（方案 A）— `src/chat/cli/cliProcess.ts` + `src/extension.ts`

- `buildStreamJsonArgs`（:356）bypass 分支：保留
  `--dangerously-skip-permissions` 的同时**追加**
  `this.appendPermissionPromptToolArgs(args)`（需实测：CLI 在两参数并存时
  仍会对 `checkPermissions() === 'ask'` 的工具发 can_use_tool；若实测冲突，
  退回方案 B——bypass 下提问被跳过，文档说明）。
- `handleToolPermissionRequest`：非 AskUserQuestion 的请求在
  bypass 模式下（读 `chatCliConfigService.getConfig().permissionMode`）
  直接 `respondToToolPermission(allow)` 自动放行，不弹框，保持 bypass 体验。

### 第 5 步：i18n 与测试

- `media/chat/main.js` chatTranslations：新增/复用弹窗文案 key
  （已有 assistantNeedsConfirmation / askOneQuestion 等，无需大改）。
- `src/chat/__tests__/` 新增用例：
  - cliAdapter：`respondToToolPermission` 带 `updatedInput.answers` 的
    control_response JSON 结构断言；
  - extension 层（若有 harness）：askUser/request → askUser/answers 闭环、
    队列去重、CLI 重启清理 pending。

### 实施顺序与验证

1→2→3 完成后即修复"弹窗后自动发请求"与"重复弹窗"（非 bypass 模式）；
4 解决 bypass 模式；每步完成后 `npm run compile && npm test`，
最后打包 VSIX 实测：普通模式提问阻塞、选择后继续、连续两问排队展示。
