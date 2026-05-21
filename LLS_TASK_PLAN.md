# LLS CCAI @llsccai-task 任务流设计方案

> 本文为方案设计文档，仅用于规划，**不会修改任何代码**。
> 参考实现：`/Users/lls/wwwroot/liliangshan/vcode/liliangshan.openapi-compatible-copilot`
> （以下简称 **LLS OAI**）。

---

## 1. 目标

为 LLS CCAI（Claude Code 客户端方向）补齐 `@llsccai-task` 任务流能力。

由于 **Claude Code 客户端没有 GitHub Copilot Chat 的 `@participant` 入口**，
所以我们不能像 LLS OAI 那样直接通过 `vscode.chat.createChatParticipant('lls-task', ...)` 接住请求。

LLS CCAI 的策略是：

1. **在本地 Relay 服务器拦截 `POST /v1/messages` 请求体**；
2. 判断最后一条 `role: "user"` 的消息内容中是否包含触发标记 `@llsccai-task`；
3. 如果包含，则不直接转发给上游模型，而是：
   1. 用 **CCAI 自己配置的任务流模型**（`claudeCodeConfigHelper.llsTask.providerId/modelId`）
      去请求一次"规划 JSON"；
   2. 解析返回的任务流 JSON，写入扩展内的任务流状态；
   3. 构造一段"任务流上下文 + 继续推进指令"的中文/英文提示文本，
      使用 **剪贴板 + 聚焦 Claude Code 输入框 + 延时 + 粘贴** 的方式
      自动把这段提示填回 Claude Code 聊天框，由主模型继续工作；
4. 同时把本次 `/v1/messages` 请求以一种"安全"的方式回响 / 终止，避免主模型同时再回答一遍。

> 命名说明：参考项目使用的是 `@lls-task`，CCAI 这边使用 **`@llsccai-task`**，
> 以避免和 LLS OAI 在同一 VS Code 实例下混淆，并明确归属 LLS CCAI。

---

## 2. 现状对比

### 2.1 参考实现（LLS OAI）

- 入口：`vscode.chat.createChatParticipant('lls-task', handler)`，
  用户在 Copilot Chat 输入 `@lls-task ...` 时由 VS Code 直接路由到 `LlsTaskService.handleChatRequest`。
- 输入：`vscode.ChatRequest`，可以包含 `references`（拖入的方案文档）和自由文本。
- 输出：通过 `vscode.ChatResponseStream` 在 Copilot Chat 中流式显示。
- 推进：通过 `insertIntoChatInput()`（内部走 `workbench.action.chat.open`）
  把"继续推进"提示注入到 Copilot Chat 输入框。

关键文件：

```
liliangshan.openapi-compatible-copilot/
  src/llsTask/messages.ts        # 多语言文案与启动占位符
  src/llsTask/service.ts         # 任务流核心：解析文档、调模型、生成 JSON、推进
  src/promptEnhancementStatusBar.ts
    └── export async function insertIntoChatInput(prompt, autoSend)
        └── workbench.action.chat.open({ query, isPartialQuery })
```

### 2.2 LLS CCAI 现状

- 没有 Chat Participant 入口，**Claude Code 客户端**直接通过 HTTP 调
  本地 Relay (`http://127.0.0.1:<port>/v1/messages`) 与模型对话。
- 已有 `claudeRouter.pasteTaskFlowToClaude` 命令，
  使用 `vscode.env.clipboard.writeText` + `claude-vscode.focus` + `delay(500)` +
  `editor.action.clipboardPasteAction`，可作为"自动粘贴"参考实现。
- 已经有独立配置：
  - `claudeCodeConfigHelper.llsTask.providerId`
  - `claudeCodeConfigHelper.llsTask.modelId`
- 已经有共享配置：
  - `openapicopilot.systemPrompt`（系统提示词，仍与 LLS OAI 共享）

关键文件：

```
src/relay/router.ts                # /v1/messages 路由
src/relay/anthropicProxy.ts        # anthropic apiType 透传适配器
src/configManager.ts               # 任务流 provider/model 读写
src/extension.ts                   # 已有 pasteTaskFlowToClaude 命令实现
src/views/sharedSettingsView.ts    # 全局设置面板：任务流 provider/model 下拉
```

---

## 3. 触发判定：在 Relay 中识别 `@llsccai-task`

### 3.1 触发标记

- **触发关键字**：`@llsccai-task`
- **位置要求**：必须出现在请求体 `messages` 数组中
  **最后一条 `role === "user"`** 的消息文本里。
  - 这是 Claude Code 当前一轮真正用户输入的位置。
  - 之前轮次的 user 消息（历史）不触发，避免历史中出现就反复触发。
- **大小写**：建议大小写不敏感匹配，例如 `/(^|\s)@llsccai-task(\s|$)/i`。

### 3.2 兼容 anthropic content 结构

Anthropic `messages` 协议下，`message.content` 既可能是：

```jsonc
{ "role": "user", "content": "@llsccai-task xxx" }
```

也可能是：

```jsonc
{
  "role": "user",
  "content": [
    { "type": "text", "text": "@llsccai-task xxx" },
    { "type": "image", "source": { ... } }
  ]
}
```

判定时需要兼容两种结构：

```ts
function extractLastUserText(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
            return m.content
                .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
                .map((p: any) => p.text)
                .join('\n');
        }
        return '';
    }
    return '';
}

function isLlsCcaiTaskTriggered(messages: any[]): boolean {
    const text = extractLastUserText(messages);
    return /(^|\s)@llsccai-task(\s|$)/i.test(text);
}
```

### 3.3 触发后从 user 消息中提取"规划文本"

去掉触发标记后剩余的文本就是用户提供的"方案规划文本"。

```ts
function extractPlanningText(messages: any[]): string {
    const text = extractLastUserText(messages);
    return text.replace(/(^|\s)@llsccai-task(\s|$)/gi, ' ').trim();
}
```

- 如果剩余文本为空，则回响一段引导："请把方案规划文档内容贴在 `@llsccai-task` 后面"。
- 如果有内容，则进入下一步"调任务流模型生成 JSON"。

---

## 4. 调任务流模型生成任务流 JSON

完全参考 `LlsTaskService.generateWorkflow`，要点：

### 4.1 取任务流 provider/model

```ts
const providerId = configManager.getLlsTaskProviderId();
const modelId = configManager.getLlsTaskModelId();
```

- 都为空 → 回响错误提示："请先在全局设置中选择 CCAI 任务流提供商和模型"。
- provider 必须是 `enabled === true`，model 必须是 `isUserSelectable !== false`，
  与设置面板下拉过滤规则保持一致。

### 4.2 构造请求体

```ts
const requestBody = {
    model: model.modelId,
    messages: [
        { role: 'system', content: buildSystemPrompt(language) },
        { role: 'user',   content: `File: custom @llsccai-task prompt\n\n${planningText}` }
    ],
    stream: false,
    temperature: model.temperature,
    top_p: model.topP,
    max_tokens: Math.min(model.maxTokens || 4096, 8192)
};
```

### 4.3 system prompt（与 LLS OAI 对齐，关键字替换）

```
You are the @llsccai-task workflow planner.
Analyze the provided solution planning document and convert it into a task workflow configuration.

Output language for titles and descriptions: <resolved UI language>.

You MUST output only a valid JSON object. Do not output Markdown or explanations.
The JSON schema is:
{
  "title": "workflow title",
  "summary": "short summary",
  "tasks": [
    { "id": "1", "title": "task title", "description": "task description", "status": "pending" }
  ]
}

Rules:
- If the document is not a solution/planning document, still extract a practical workflow from its actionable content.
- tasks must be a non-empty array.
- status must be one of: pending, in_progress, completed.
- Use pending for new tasks unless the document explicitly marks progress.
```

### 4.4 适配三种 apiType

参考 `LlsTaskService.requestModel`：

| apiType            | 路径                  | 鉴权                                           | body 转换                                           |
| ------------------ | --------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `openai-compatible`| `/chat/completions`   | `Authorization: Bearer <apiKey>`               | 直接发原始 chat-completions body                    |
| `anthropic`        | `/messages`           | `x-api-key` + `anthropic-version: 2023-06-01`  | `convertOpenAIRequestToAnthropic` 转 Anthropic body |
| `v1-response`      | `/responses`          | `Authorization: Bearer <apiKey>`               | `convertChatCompletionsToResponsesAPI` 转 Responses body |

CCAI 目前 relay 只内置了 `anthropic` 适配器，本任务流调用是**直接 fetch 上游**，
与 relay 适配器互不依赖，所以三种 apiType 都可以独立支持。
（必要时把转换器从 LLS OAI 抽出对应函数移植过来。）

### 4.5 解析响应

```
text = extractResponseText(response, apiType);
match = text.match(/\{[\s\S]*\}/);
parsed = JSON.parse(match[0]);
```

- 失败 → 回响"任务流模型未返回合法 JSON"。
- 成功 → 规范化 task 字段并保存到 `LlsTaskService` 内存 state。

---

## 5. 把"继续推进"提示自动粘贴回 Claude Code 输入框

LLS OAI 的做法是 `workbench.action.chat.open({ query, isPartialQuery })`，
CC 客户端用不了这个。

CCAI 沿用现有 `pasteTaskFlowToClaude` 已经验证可行的模式：

```ts
async function pasteToClaudeCode(prompt: string): Promise<void> {
    // 1. 写剪贴板
    await vscode.env.clipboard.writeText(prompt);
    // 2. 聚焦 Claude Code 聊天输入框
    await vscode.commands.executeCommand('claude-vscode.focus');
    // 3. 等待 UI 切换完成
    await new Promise(r => setTimeout(r, 500));
    // 4. 执行 VS Code 的标准粘贴动作
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
}
```

> `claude-vscode.focus` 是 Claude Code 扩展提供的命令；
> `editor.action.clipboardPasteAction` 是 VS Code 内置命令。
> 当前 `src/extension.ts` 的 `pasteTaskFlowToClaude` 已经在用同样的组合，
> 实测可行，可直接复用。

### 5.1 提示文本构造

参考 `LlsTaskService.buildMainModelPrompt`：

```
Active @llsccai-task workflow is available for the current workspace.

Workflow label: <localized 'LLS Task'>
Progress: <completed>/<total>

Workflow JSON:
<JSON.stringify(workflow, null, 2)>

Workflow usage rules:
1. Use this workflow as execution guidance when the user request is related to the current work.
2. You may NOT modify task titles, descriptions, order, summary, or content.
3. You may only update task status by calling update_llsccai_task_workflow.
...
```

> CCAI 这里建议把工具名称统一改为 `update_llsccai_task_workflow`，
> 避免被 LLS OAI 同名工具吞掉调用。具体工具如何提供给 Claude Code，
> 由后续工具暴露机制决定（MCP / 自定义协议），本文先不展开。

### 5.2 自动继续推进（默认开启的延时重发）

CCAI 默认开启自动续推，**不通过任何用户设置开关控制**。规则非常简单：

> **当 relay 监测到主模型本轮响应「结束」且本轮没有任何 `tool_use` 输出时，
> 启动一个 15 秒固定延时定时器**；定时器到期后自动把「继续推进」提示
> 复制 → 粘贴 → 模拟回车发送。
>
> **当 CC 客户端发来下一个 `/v1/messages` 请求时，如果定时器仍在等待，则取消它**
> （用户已经在主动推进，不需要补刀）。

#### 5.2.1 "非工具调用结束"的判定

Anthropic 流式响应里，主模型本轮是否调用了工具可以从两处判断：

- SSE 事件序列里出现过任何 `content_block_start.content_block.type === 'tool_use'`；
- 或最终 `message_delta` 的 `stop_reason === 'tool_use'`。

Relay 在 SSE 链路上维护一个 per-request 标志位 `sawToolUseInThisTurn`：

- 每个 `content_block_start` 检查 `type === 'tool_use'` → 置位；
- 收到 `message_stop`（或 `message_delta(stop_reason)`，以先到者为准）后判定：
  - `sawToolUseInThisTurn === true` → **不调度**自动续推（主模型本轮已主动推进
    了，Claude Code 会自然带 `tool_result` 发下一轮）；
  - `sawToolUseInThisTurn === false` → **调度** `AutoContinueScheduler.schedule(15000)`。

非流式（`stream:false`）路径同样适用：解析最终响应体 `content[]`，若不包含
`type === 'tool_use'` 的 block，则在响应回写完成后调度自动续推。

#### 5.2.2 延时重发流程

```
AutoContinueScheduler.schedule(15000)
        │
        ▼ setTimeout(15000)
再次快照检查：
    workflow 存在？        ── 否 → no-op
    isWorkflowCompleted？  ── 是 → no-op
    定时器已被取消？        ── 是 → no-op（请见 5.2.3）
        │
        ▼
paster.pasteToClaudeCode(buildContinuePrompt(snapshot))
        ├─ 剪贴板写入"继续推进"提示
        ├─ claude-vscode.focus
        ├─ delay(500)
        ├─ editor.action.clipboardPasteAction
        ├─ delay(300)
        └─ simulateEnterKeyAtSystemLevel()   ← 见 5.4，始终启用
```

#### 5.2.3 何时启动 / 取消定时器

定时器全局唯一（模块内 `currentTimer: NodeJS.Timeout | undefined`），
任何"启动"前都先 `cancel()` 旧的。

| 事件                                                          | 行为                                  |
| ------------------------------------------------------------- | ------------------------------------- |
| 任意一次 `/v1/messages` 主模型响应结束且**无 `tool_use`**     | **schedule(15000)**（先 cancel 再起） |
| 收到任意新的 `/v1/messages` 请求（router 入口）               | **cancel()**：用户主动续推了，撤掉补刀 |
| 主模型本轮 `tool_use` 命中 `update_llsccai_task_workflow`     | **cancel()**：扩展端已自动推进         |
| 用户手动触发 `claudeRouter.llsCcaiTask.continue`              | **cancel()**：用户已自己粘贴并发送了   |
| `LlsTaskService.isWorkflowCompleted()` 变为 true              | **cancel()**                          |
| `LlsTaskService.clear()` / 扩展 `deactivate`                  | **cancel()**                          |

> 关键不变量：**定时器存活时，绝不能再有第二个并发定时器**；任何 schedule 都必须
> 先 cancel。这也是 5.2.4 "router 入口处取消"得以保证不与 5.2.1 "响应结束处启动"
> 互相抢跑的前提。

#### 5.2.4 与 router 入口的协同

```
router.handleMessages(req)
  ├─ 1. 一进入就 autoContinueScheduler.cancel()
  │     （无论是 @llsccai-task 触发还是普通透传，新请求都意味着用户已在推进）
  ├─ 2. 走 detector / 透传 / 工具注入逻辑
  ├─ 3. 等到 interceptor 在响应链路尾端判定
  │     若本轮没有 tool_use → autoContinueScheduler.schedule(15000)
  └─ 4. 返回响应
```

这样无论用户是手动发了下一句、还是主模型立刻又开始下一轮工具循环，
旧的 15s 定时器都会被取消，避免重复粘贴。

---

## 5.4 自动回车（Auto-Enter）

仅"粘贴"不够，Claude Code 输入框拿到剪贴板内容后还需要用户按一次回车才会发送。
CCAI 在 paster 流程末尾**始终调用一次系统级模拟回车**，已经在 `src/extension.ts` 的
`simulateEnterKeyAtSystemLevel()` 中验证可用：

| 平台   | 方案                                                          | 是否需要授权                                       |
| ------ | ------------------------------------------------------------- | -------------------------------------------------- |
| macOS  | `osascript -e 'tell application "System Events" to key code 36'` | 需要：「系统设置 → 隐私与安全性 → 辅助功能」勾选 VS Code |
| Windows| `powershell.exe ... SendKeys::SendWait("{ENTER}")`            | 不需要                                             |
| Linux  | 暂不支持，仅写日志，自动续推退化为"只粘贴不发送"              | -                                                  |

> VS Code 命令层（`type` / `default:type` / `workbench.action.chat.submit` /
> `claude-vscode.send` / `claude-vscode.submit`）**已确认全部不可用**，
> Claude Code 输入框是 webview 内部 DOM，VS Code 命令层触达不到，且 Claude Code
> 扩展未注册任何 send/submit 命令（已查 `claude-code-2.1.145` 的 package.json）。

#### 5.4.1 时序

```
writeClipboard → claude-vscode.focus → delay(500) → paste
              → delay(300) → simulateEnterKeyAtSystemLevel()
```

第二次 delay(300) 是给输入框 DOM 完成粘贴渲染留时间，避免模拟回车时光标还在
"键入中"状态。

#### 5.4.2 行为约定

- **自动续推（5.2 调度路径）**：始终模拟回车自动发送，无开关。
- **手动 `llsCcaiTask.continue`**：始终模拟回车自动发送，与自动续推一致。
- **状态栏"启动占位提示"场景**（用户首次点击发起 `@llsccai-task`）：
  仅粘贴占位文本，**不模拟回车**，让用户先在输入框里补全规划内容再手动发送。

上述差异由 paster 的内部参数控制：

```ts
paster.pasteToClaudeCode(prompt, { autoSubmit: true | false });
```

但**该参数不对用户暴露**，自动续推与 continue 命令固定传 `true`，启动占位
固定传 `false`。

#### 5.4.3 测试入口

全局设置页已经提供「测试模拟回车 / Test Simulated Enter」按钮 + 命令
`claudeRouter.testSimulateEnter`，用于在不依赖任务流的情况下验证当前平台的
模拟回车是否可用；首次失败会引导用户开启 macOS 辅助功能权限。

---

## 5.3 工具注入（关键）

仅靠"剪贴板粘贴提示词"只能让主模型知道任务流的存在，但**主模型没办法回写状态**。
LLS OAI 是通过在 OpenAI `requestBody.tools` 数组中追加一个 `update_lls_task_workflow`
工具，由扩展端拦截 `tool_calls` 后本地执行（不发给上游也不返回外部），见
`provider.ts` 的 `_buildUpdateLlsTaskWorkflowTool` 与 `_executeLlsTaskWorkflowToolAsJson`：

```ts
// LLS OAI 的内置工具构造
{
  name: 'update_lls_task_workflow',
  description: 'Update only the status of existing @lls-task workflow tasks ...',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      updates: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string', enum: ['pending','in_progress','completed','blocked'] }
          },
          required: ['taskId','status']
        }
      }
    },
    required: ['updates']
  }
}
```

LLS OAI 出站时把它合并进 OpenAI chat-completions 的 `tools[]`：

```ts
const builtInTools = [
  ...(timelineService ? buildTimelineTools() : []),
  buildGetErrorsTool(),
  ...(llsTaskService?.getSnapshot().workflow ? [buildUpdateLlsTaskWorkflowTool()] : []),
];
requestBody.tools = mergeToolsWithBuiltIns(options.tools, builtInTools)
  .map(tool => ({ type: 'function', function: { ... } }));
```

并通过 `_isAutoExecutedTool(name)` 在 tool 调用回来时拦截：

```ts
if (this._isLlsTaskWorkflowTool(name)) {
  return JSON.stringify(this._llsTaskService.updateTaskStatuses(updates));
}
```

—— **不会**把 `update_lls_task_workflow` 发送给上游模型作为 tool_result，而是
扩展本地执行后把结果以 `tool` 消息塞回会话，让主模型继续下一轮。

### 5.3.1 CCAI 怎么注入（Anthropic 协议）

CCAI 的 Relay 透传的是 Anthropic `/v1/messages`，工具格式与 OpenAI 不同，
结构如下（Anthropic Tool Use 规范）：

```jsonc
{
  "model": "...",
  "messages": [...],
  "tools": [
    {
      "name": "update_llsccai_task_workflow",
      "description": "Update only the status of existing @llsccai-task workflow tasks ...",
      "input_schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "updates": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "taskId": { "type": "string" },
                "status": { "type": "string",
                  "enum": ["pending","in_progress","completed","blocked"] }
              },
              "required": ["taskId","status"]
            }
          }
        },
        "required": ["updates"]
      }
    }
  ]
}
```

**注入时机**：在 `src/relay/anthropicProxy.ts` 真正 fetch 上游之前，
解析 `parsedBody`，若当前任务流存在（`LlsTaskService.getSnapshot().workflow` 非空）：

1. 读取已有 `parsedBody.tools`（Claude Code 自带的工具，比如 Read/Bash 等）；
2. 合并我们自己的工具数组：
   ```ts
   const builtIns = [];
   if (llsTaskService.hasActiveWorkflow()) {
     builtIns.push(buildUpdateLlsCcaiTaskWorkflowTool());
   }
   const existing = Array.isArray(parsedBody.tools) ? parsedBody.tools : [];
   const existingNames = new Set(existing.map((t: any) => t?.name));
   parsedBody.tools = [
     ...existing.filter((t: any) => !existingNames.has(t?.name) || !builtIns.some(b => b.name === t.name)),
     ...builtIns
   ];
   ```
3. 同步在请求体中加一段 `system` 提示词（参考 LLS OAI 5.3.x），告诉主模型：
   > 当任务实际进度变化时必须调用 `update_llsccai_task_workflow`，
   > 单次调用只能更新状态，禁止修改标题/描述/顺序。
4. 重新 `JSON.stringify(parsedBody)` 写回到上游 fetch body。

> ⚠️ 注意：Claude Code 客户端发请求时已经带了一组 system + tools。**插入工具时不能覆盖**
> 它原有的 tools；插入 system 文案时也建议追加，而不是替换。Anthropic 协议里 `system`
> 既可以是字符串也可以是 `text[]`，需要兼容两种情况。

### 5.3.2 拦截 `tool_use` 输出（关键）

Claude（assistant）会以 `content` 中包含 `{ "type": "tool_use", "name": "update_llsccai_task_workflow", "input": {...} }` 的形式调用工具。Anthropic 的工具循环是：

```
client → /v1/messages (with tools)
server → 200 with content[ tool_use ]
client → /v1/messages (append user turn with tool_result for that tool_use_id)
server → 200 with content[ text ]
```

也就是说工具结果**由客户端（Claude Code）回传**，不是服务端自己执行。
CCAI Relay 在中间扮演两个角色：

**A. 非流式响应路径**（容易实现）

- 收到上游响应后解析 `content`；
- 找到 `tool_use` 且 `name === 'update_llsccai_task_workflow'`：
  1. 调用 `LlsTaskService.updateTaskStatuses(input.updates)`；
  2. **改写响应**：把这个 `tool_use` 留下（让 Claude Code 看到一次工具调用闭环），
     同时在 relay 内部记忆"该 tool_use_id 已由本地执行"，等 Claude Code 下一次
     `messages` 携带 `tool_result` 时**就地拦截**并返回我们本地执行得到的 JSON 字符串；
  3. 或者更简单：相应去掉 `tool_use`，把 `content` 替换为一个 `text` 节点
     `"Workflow status updated: 2/5 done."`，让 Claude Code 不再来回交接。
     这种方式实现简单但语义稍弱。

**B. 流式响应路径**（SSE）

- 监听上游 SSE 事件：
  - `message_start` → 缓存元信息；
  - `content_block_start type=tool_use name=update_llsccai_task_workflow` → 进入拦截缓存模式；
  - `input_json_delta` → 累积 JSON 文本到缓存；
  - `content_block_stop` → 解析累积 JSON，调本地 service 更新状态；
  - 然后把这个 tool_use block **改写为 text block** 转发下去，例如：
    ```
    event: content_block_start
    data: { "type":"content_block_start", "index":N, "content_block":{ "type":"text","text":"" } }

    event: content_block_delta
    data: { "type":"content_block_delta", "index":N, "delta":{ "type":"text_delta", "text":"Workflow status updated: 2/5 done." } }

    event: content_block_stop
    data: { "type":"content_block_stop", "index":N }
    ```
  - 这样 Claude Code 不需要二次回传 tool_result，会话自然继续。

> 首版建议：**只支持 stream=true 的拦截转写为 text**（路径 B 的"改写为 text" 变种）。
> 实现成本可控，且和当前 Relay 主链路一致。如果需要严谨地把 tool_use → tool_result
> 跑完整个循环，再增量实现。

### 5.3.3 工具注入与触发解耦

- **`@llsccai-task` 触发**只发生在还没有 workflow 的时候，用于生成第一份 JSON；
- **工具注入**只在 `LlsTaskService.getSnapshot().workflow` 存在时启用；
- 主模型自然完成所有任务（`isWorkflowCompleted()`）后，relay 停止注入工具，
  也停止把"继续推进"提示自动粘贴。

### 5.3.4 LLM 端可见的工具与扩展端"伪工具"

- 我们注入到 Anthropic `tools[]` 中的 `update_llsccai_task_workflow` **真的会被 LLM 看到**，
  这是 LLM 调用的入口。
- 扩展端通过拦截 SSE / 响应里的 `tool_use` 做"本地伪执行"，对上游而言这个工具相当于
  LLS OAI 的 `_isAutoExecutedTool`：永远不会真正暴露给后端去运行，由扩展兜底。
- 后续如果还要注入更多扩展能力（例如 `get_errors` / `timeline_*`），按同样的模式
  并入 `builtIns` 数组即可。

---

## 6. Relay 的整体处理流程

```
Claude Code
   │  POST /v1/messages   (含 messages[], tools[], system)
   ▼
CCAI Relay (router.ts)
   │  1. 解析 body
   │  2. 取最后一条 role=user 消息文本
   │  3. 是否包含 @llsccai-task ?
   │
   ├── 是 ──▶ LlsTaskService.handleRelayTrigger
   │           ├─ 提取规划文本
   │           ├─ 调任务流 provider/model 拿 workflow JSON
   │           ├─ 保存 workflow
   │           ├─ 复制"继续推进提示" → focus → 延时 → 粘贴
   │           └─ 用一段合法 Anthropic 响应回当前 /v1/messages
   │
   └── 否 ──▶ 进入工具注入分支：
              ├─ 有活跃 workflow ?
              │    ├─ 是 → 在 parsedBody.tools 追加 update_llsccai_task_workflow
              │    │       在 system 追加任务流使用规则
              │    └─ 否 → 透传不动
              ├─ AnthropicProxyAdapter.handle 真正 fetch 上游
              └─ 在响应/SSE 通路上拦截 tool_use(update_llsccai_task_workflow)：
                   ├─ 调用 LlsTaskService.updateTaskStatuses(input.updates)
                   ├─ 把该 tool_use block 改写为 text block 下发
                   └─ 不再要求 Claude Code 回传 tool_result
```

### 6.1 拦截响应建议

为不破坏 Claude Code 客户端协议，可以让 relay 直接返回一段**合法的非流式 Anthropic 响应**，
内容是一句"已为你生成任务流，请稍候在输入框继续"：

```json
{
  "id": "msg_llsccai_task_<ts>",
  "type": "message",
  "role": "assistant",
  "model": "<modelId>",
  "content": [
    { "type": "text", "text": "已生成 @llsccai-task 任务流，正在自动把继续推进指令贴回输入框。" }
  ],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

如果原请求是 `stream: true`，则需要伪造一段 SSE：
`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` →
`message_delta(stop_reason=end_turn)` → `message_stop`。
这部分实现复杂度较高，可以放到下一阶段。

---

## 7. 配置与命令清单（设计层面，不动代码）

### 7.1 复用现有配置

| 配置 key                                                 | 用途                                             | 是否共享 LLS OAI |
| -------------------------------------------------------- | ------------------------------------------------ | ---------------- |
| `claudeCodeConfigHelper.llsTask.providerId`              | 任务流提供商 ID                                  | 否（CCAI 独立）  |
| `claudeCodeConfigHelper.llsTask.modelId`                 | 任务流模型 ID                                    | 否（CCAI 独立）  |
| `claudeCodeConfigHelper.language`                        | UI 语言（决定任务流文案）                        | 否（CCAI 独立）  |
| `openapicopilot.systemPrompt`                            | 系统提示词                                       | 是               |

> 自动续推延时（固定 15s）与是否模拟回车（始终启用）均为**默认行为，不暴露设置项**。

### 7.2 新增命令（仅设计）

| 命令 ID                                       | 触发位置                  | 行为                                                 |
| --------------------------------------------- | ------------------------- | ---------------------------------------------------- |
| `claudeRouter.llsCcaiTask.openMenu`           | 状态栏（点击，统一入口）  | 按当前快照路由：QuickPick 进度 / 清空 / 启动占位提示 |
| `claudeRouter.llsCcaiTask.showProgress`       | 命令面板                  | 单独弹任务进度 QuickPick                             |
| `claudeRouter.llsCcaiTask.continue`           | 命令面板                  | 手动再次"粘贴继续推进提示"到 Claude Code 聊天框（会重置自动续推定时器） |
| `claudeRouter.llsCcaiTask.clear`              | 命令面板                  | 清空当前任务流状态（同时取消自动续推定时器）         |
| `claudeRouter.testSimulateEnter`              | 命令面板 / 全局设置按钮   | 测试系统级模拟回车是否可用（已实现）                 |

### 7.3 新增模块（仅设计）

```
src/llsTask/
  messages.ts        # @llsccai-task 多语言文案（继承 ResolvedAppLanguage）
  detector.ts        # extractLastUserText / isLlsCcaiTaskTriggered / extractPlanningText
  service.ts         # 调任务流模型、解析 JSON、维护 workflow 状态、提供 buildContinuePrompt
  paster.ts          # pasteToClaudeCode(prompt, { autoSubmit }) 复用 pasteTaskFlowToClaude 模式
                     #   autoSubmit=true 时在粘贴后调用 simulateEnterKeyAtSystemLevel
                     #   autoSubmit 仅供内部代码使用，不暴露给用户配置
  autoContinue.ts    # AutoContinueScheduler: schedule() / cancel()，固定 15s 延时，
                     #   触发时调 paster.pasteToClaudeCode(buildContinuePrompt, { autoSubmit: true })
                     #   router 入口、tool_use 命中、completed/clear/deactivate 都调 cancel()
  responder.ts       # 构造 anthropic 非流式 / 流式响应（拦截当前 /v1/messages）
  tools.ts           # buildUpdateLlsCcaiTaskWorkflowTool() / mergeAnthropicTools()
                     #   注入 update_llsccai_task_workflow，合并 Claude Code 自带 tools
  interceptor.ts     # 解析 SSE / 非流式响应中的 tool_use，调 service.updateTaskStatuses，
                     #   并把对应 block 改写为 text block 转发回客户端
src/relay/router.ts  # 在适配器分发之前增加 LLS_CCAI_TASK 触发分支
src/relay/anthropicProxy.ts
                     # 在出站 fetch 前注入 tools / system；在响应/SSE 通路套上 interceptor
src/taskFlowStatusBar.ts
                     # 改造：依赖注入 configManager + llsTaskService，
                     # 订阅 service.onDidChange / config 变化，渲染 N/M 进度、
                     # tooltip 任务列表、点击走 claudeRouter.llsCcaiTask.openMenu
```

---

## 8. 多语言文案约定

- 复用 `ResolvedAppLanguage`（已支持 en/zh-cn/zh-tw/ko/ja/fr/de）。
- 文案 key 与 LLS OAI 对齐，但前缀统一为 `llsCcaiTask.`：
  - `llsCcaiTask.statusLabel`（状态栏标签，如"任务流"/"LLS Task"）
  - `llsCcaiTask.missingModel`
  - `llsCcaiTask.providerNotFound`
  - `llsCcaiTask.analyzing`
  - `llsCcaiTask.completed`
  - `llsCcaiTask.failed`
  - `llsCcaiTask.continuePrompt`
  - `llsCcaiTask.planningPathLabel`
- 任务流 system prompt 中 "Output language for titles and descriptions" 使用
  当前已解析语言名称（参考 LLS OAI 的 `LLS_TASK_STATUS_TEXT`）。

---

## 9. 风险与边界

1. **历史误触发**：必须只在"最后一条 user 消息"匹配，
   否则主模型把历史里的 `@llsccai-task` 复述出来会反复触发。
2. **流式响应**：Claude Code 默认走 `stream:true`，伪造 SSE 复杂，
   首版可选择**强制按非流式响应**返回，或者直接 `204 No Content`，
   并立即触发"自动粘贴"。需要在 CC 客户端实测哪种最稳。
3. **重复粘贴**：自动粘贴时如果用户正在输入，可能打断输入。
   建议在 paster 中：
   - 写剪贴板前先保留旧剪贴板内容（可选）；
   - focus 之后 delay 500ms 再粘贴；
   - 粘贴后不自动按回车，由用户确认。
4. **任务流模型未配置**：直接通过 relay 响应一段错误文本，
   并附操作建议："请先在 LLS CCAI 全局设置中选择任务流 Provider/Model"。
5. **大文本规划**：任务流 model 的 `max_tokens` 用 `Math.min(maxTokens, 8192)` 限制，
   规避超长输出。
6. **隐私**：不要把 `@llsccai-task` 后的用户文本写入日志的明文，只记录长度与首尾摘要。
7. **工具注入冲突**：Claude Code 自带 tools (Read/Bash/Edit/...) 必须保留；
   合并时按 `tool.name` 去重，且只覆盖**我们自己**的工具名（如 `update_llsccai_task_workflow`），
   不要覆盖客户端已有工具。
8. **流式 tool_use 改写**：必须正确按 `index` 累积 `input_json_delta`，否则会出现
   把别的 content_block 改写错的情况；不命中我们工具名的 tool_use **必须原样转发**。
9. **system 注入兼容性**：Anthropic `system` 字段可能是 `string` 或 `Array<{type:'text',text}>`；
   两种结构都需要兼容追加，不要直接覆盖。
10. **task 状态注入只在有 workflow 时**：没有活跃 workflow 时严禁注入工具与规则，
    避免污染普通对话。
11. **状态栏刷新风暴**：`service.onDidChange` 在每次 `updateTaskStatuses` 都会触发，
    `refresh()` 必须是轻量函数（不要在里面做 I/O 或长字符串拼装）；
    高频更新场景考虑 50ms 节流。
12. **状态栏 QuickPick 与工具回写互斥**：QuickPick 仅做"查看"，
    用户选择某条任务时**不允许直接改 status**（语义上由主模型工具回写），
    防止与 `update_llsccai_task_workflow` 工具回写竞争出现状态错乱。
13. **多窗口共享**：VS Code 多窗口下每个窗口都会创建自己的状态栏 item；
    `LlsTaskService` 的 workflow 存在内存里，跨窗口不共享。
    若需跨窗口同步，可后续把 workflow 落到 `context.globalState`（不在首版考虑）。
14. **自动续推误发**：15s 定时器到期后会自动粘贴并模拟回车，
    若此时用户正在 Claude Code 输入框手动输入，可能被插入并发送。
    缓解策略全部内置、不需要用户配置：
    - 收到任意新的 `/v1/messages` 请求时 router 入口立刻 `cancel()`，意味着用户
      只要在 15s 内自己发了下一句，就不会再被补一刀；
    - 工具回写、completed、clear、deactivate 都 `cancel()`；
    - schedule 之前永远先 `cancel()`，不会出现并发定时器。
15. **模拟回车依赖系统权限**：macOS 首次使用需要在「系统设置 → 隐私与安全性 → 辅助功能」
    勾选 VS Code；Windows 通过 PowerShell SendKeys 无需授权，但需要 VS Code 窗口处于
    前台；Linux 暂不支持，自动续推退化为"只粘贴不发送"。失败时通过全局设置中
    的「测试模拟回车」按钮 + 命令面板 `claudeRouter.testSimulateEnter` 自助排查。
16. **定时器跨重载**：扩展 `deactivate` 必须 `autoContinueScheduler.cancel()`；
    窗口重载后 workflow 不持久化，定时器自然失效，与 13 条一致。

---

## 10. 与现有 `pasteTaskFlowToClaude` 的关系

| 项目                              | 当前实现                                       | 任务流后调整                                  |
| --------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| `claudeRouter.pasteTaskFlowToClaude` | 写死一段中文提示，剪贴板+focus+粘贴            | 提示文本改由 `LlsTaskService.buildContinuePrompt()` 生成（如果有 workflow） |
| 状态栏按钮 `CC任务流`             | 点击触发上面这条命令                           | 行为不变，但点击后能"基于真实任务流"生成提示  |

---

## 10.1 VS Code 状态栏交互（关键）

参考 LLS OAI `src/statusBar.ts` 的 `initLlsTaskStatusBar`：
状态栏不是静态文案，它会随任务流、配置、语言变化实时刷新，
并承担"无任务流时启动任务流、有任务流时查看/操作进度"的统一入口。

### 10.1.1 当前 CCAI 状态栏现状

`src/taskFlowStatusBar.ts` 当前只是：

- 固定文本 `$(checklist) CC任务流`
- tooltip 固定 `复制任务流内容并粘贴到 Claude Code 聊天框`
- 点击执行 `claudeRouter.pasteTaskFlowToClaude`

**缺少**：进度显示、按任务流变化刷新、tooltip 列出任务列表、未配置模型时引导设置、
完成后引导新建。

### 10.1.2 目标行为（对齐 LLS OAI）

| 任务流状态                       | 状态栏 text                       | tooltip                                                | 点击行为                                                                       |
| -------------------------------- | --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 无 workflow + 未配置任务流模型   | `$(checklist) 任务流`             | `请先在 LLS CCAI 全局设置中选择任务流 Provider/Model`  | 打开全局设置面板（已有命令）                                                   |
| 无 workflow + 已配置任务流模型   | `$(checklist) 任务流`             | `点击向 Claude Code 发送 @llsccai-task 启动任务流`     | 调 paster：把 `@llsccai-task <占位提示>` 复制 → focus → 延时 → 粘贴            |
| 有 workflow + 进行中             | `$(checklist) 任务流 2/5`         | 任务流标题 + 每条任务 `序号 状态图标 标题 (状态文本)` | 弹 QuickPick 展示任务列表（不在 quickPick 中改状态，由主模型工具回写）         |
| 有 workflow + 已完成             | `$(check) 任务流 5/5`             | 任务列表 + `点击新建任务流`                            | 提示用户是否清空当前 workflow，确认后 `LlsTaskService.clear()` 并允许重新触发  |

### 10.1.3 刷新触发源

状态栏需要订阅以下事件，命中即调 `refresh()` 更新文案：

```ts
context.subscriptions.push(
    llsTaskService.onDidChange(() => refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
        if (
            event.affectsConfiguration('claudeCodeConfigHelper.language') ||
            event.affectsConfiguration('claudeCodeConfigHelper.llsTask.providerId') ||
            event.affectsConfiguration('claudeCodeConfigHelper.llsTask.modelId')
        ) {
            refresh();
        }
    }),
    configManager.onDidChange(() => refresh()) // provider/model 启用状态变化也要刷新
);
```

状态变更链路：

```
LlsTaskService.updateTaskStatuses() / setWorkflow() / clear()
        │
        ▼ emit onDidChange(snapshot)
TaskFlowStatusBar.refresh()
        ├─ snapshot.workflow → 计算 completed/total → 更新 text、tooltip
        ├─ 没 workflow + 缺模型 → 提示设置
        └─ 没 workflow + 有模型 → 提示启动
```

### 10.1.4 状态栏 tooltip 内容

tooltip 用 `MarkdownString` 也可以，但 LLS OAI 用的是 `string` 多行：

```
<workflow.title>
进度: <completed>/<total>

1. ✓ Task A (已完成)
2. ↻ Task B (进行中)
3. ○ Task C (待办)
4. ⚠ Task D (阻塞)
5. ○ Task E (待办)

（完成时追加）点击可清空当前任务流并发起新的 @llsccai-task。
```

图标统一：`✓ completed`、`↻ in_progress`、`⚠ blocked`、`○ pending`。

### 10.1.5 点击命令分发

把目前的单命令 `claudeRouter.pasteTaskFlowToClaude` 升级为统一入口
`claudeRouter.llsCcaiTask.openMenu`（参考 LLS OAI `openapicopilot.llsTask.openMenu`），
按当前快照决定子动作：

```ts
async function openLlsCcaiTaskMenu() {
    const snapshot = llsTaskService.getSnapshot();
    if (snapshot.workflow && !llsTaskService.isWorkflowCompleted()) {
        await llsTaskService.showProgress(); // QuickPick 列出任务
        return;
    }
    if (snapshot.workflow && llsTaskService.isWorkflowCompleted()) {
        const confirmed = await vscode.window.showInformationMessage(
            '当前任务流已全部完成，是否清空并发起新任务流？',
            { modal: false },
            '清空并新建', '取消'
        );
        if (confirmed === '清空并新建') {
            llsTaskService.clear();
        }
        return;
    }
    const providerId = configManager.getLlsTaskProviderId();
    const modelId = configManager.getLlsTaskModelId();
    if (!providerId || !modelId) {
        await vscode.commands.executeCommand('claudeRouter.openGlobalSharedSettings');
        return;
    }
    // 已配置但无 workflow：粘贴 @llsccai-task 启动占位文本
    const language = configManager.getResolvedUiLanguage();
    await paster.pasteToClaudeCode(LLS_CCAI_TASK_START_PROMPT[language]);
}
```

### 10.1.6 状态栏 alignment / priority 建议

- 沿用 `StatusBarAlignment.Right`，priority 取 `98`（与 LLS OAI 一致），
  让任务流位于"当前模型/Relay 状态"之后、`Remote Notification` 之前；
- `statusBarItem.name = 'LLS CCAI Task Workflow'`（命令面板显示用）；
- `statusBarItem.show()` 一直显示，便于用户随时启动任务流。

### 10.1.7 与 Relay 工具注入的联动

- Relay 拦截到 `tool_use(update_llsccai_task_workflow)` → 调 service →
  `service.onDidChange` 触发状态栏刷新；
- 用户在状态栏 QuickPick 中只能"查看"，**不能直接改任务状态**，
  否则与"状态由主模型 update 工具回写"的语义冲突。

### 10.1.8 重构当前 `TaskFlowStatusBar`

把现有类改成依赖注入：

```ts
new TaskFlowStatusBar(configManager, llsTaskService);
```

构造函数里订阅 `onDidChange` 并初次 `refresh()`，
`dispose()` 时一并 dispose 订阅。**不要再写死中文文案**，
全部改为 `t('llsCcaiTask.*')` 走 i18n。

---

## 11. 落地步骤建议（仅规划，不在本次改动）

> 验收标准：**本设计的任务流落地阶段不做单元测试 / 不做端到端冒烟验收**，
> 每一步只要按描述完成代码编写、`npm run typecheck && npm run compile`
> 全部通过即视为该步骤完成；功能行为由用户在真实 Claude Code 客户端中自行确认。

1. 新增 `src/llsTask/detector.ts`，实现 `@llsccai-task` 触发检测：
   - `extractLastUserText` 兼容 string / array-of-blocks 两种 content；
   - `isLlsCcaiTaskTriggered` 大小写不敏感，仅匹配"最后一条 user 消息"；
   - `extractPlanningText` 去除触发词后返回剩余规划文本。
2. 新增 `src/llsTask/service.ts`，参考 LLS OAI `LlsTaskService`，
   实现 `generateWorkflow` / `requestModel` / `parseWorkflowResponse` /
   `buildContinuePrompt` / `updateTaskStatuses` / `hasActiveWorkflow` /
   `isWorkflowCompleted` / `clear` / `onDidChange` 事件。
3. 新增 `src/llsTask/paster.ts`，封装：
   - `pasteToClaudeCode(prompt: string, options?: { autoSubmit?: boolean })`：
     剪贴板 → `claude-vscode.focus` → delay(500) → paste → delay(300) →
     如 `autoSubmit` 为真则调用 `simulateEnterKeyAtSystemLevel()`；
   - 与 `src/extension.ts` 现有的 `pasteTaskFlowToClaude` / `runSimulateEnterTest`
     抽出的公共底层函数对齐（`simulateEnterOnMac` / `simulateEnterOnWindows`）。
4. **新增 `src/llsTask/autoContinue.ts`**：
   - 暴露 `AutoContinueScheduler` 单例：`schedule()` / `cancel()`；
   - 固定 15 秒延时，**不读任何用户配置**；
   - 内部维护单个 `setTimeout` 句柄，触发时再做一次快照检查（workflow 存在、
     未完成、未被取消）后调用
     `paster.pasteToClaudeCode(service.buildContinuePrompt(snapshot), { autoSubmit: true })`；
   - `schedule()` 内部先 `cancel()` 旧定时器，保证全局只有一个。
5. **新增 `src/llsTask/tools.ts`**：
   - `buildUpdateLlsCcaiTaskWorkflowTool()` 返回 Anthropic 工具定义（含 `input_schema`）；
   - `mergeAnthropicTools(existing, builtIns)` 合并并按名字去重；
   - `buildLlsCcaiTaskSystemRule(language)` 返回任务流使用规则系统提示。
6. **新增 `src/llsTask/interceptor.ts`**：
   - 非流式：解析响应 `content[]`，命中 `tool_use(update_llsccai_task_workflow)` 时
     调 `service.updateTaskStatuses(input.updates)`，把该 block 改写为 text block，
     返回新的响应体；同时调用 `autoContinueScheduler.cancel()`；
   - 流式：维护一个 `tool_use` 累积器（按 `index` 隔离），在 `content_block_stop`
     时调 service，并把这一组 SSE 事件改写为对应的 text block 事件序列下发；
     在 `message_stop` 触发后，若本轮未出现过 `tool_use`，调用
     `autoContinueScheduler.schedule()`（固定 15s）；否则调 `cancel()`。
7. **改 `src/relay/anthropicProxy.ts`**：在真正发请求前根据
   `LlsTaskService.hasActiveWorkflow()` 注入 `tools[]` 与 system 规则；
   在响应处理路径（含 SSE）外套 `interceptor`。
8. 在 `src/relay/router.ts` 增加 `@llsccai-task` 触发分支，命中时调用
   `LlsTaskService.handleRelayTrigger`，由 service 决定如何响应当前 `/v1/messages`
   （最先实现：非流式 200 OK + 自动粘贴）；**router 入口需要在任何路径之前
   都先调 `autoContinueScheduler.cancel()`**，体现"新请求一到就取消旧定时器"语义。
9. 在 `src/extension.ts` 注册 service / autoContinueScheduler 和命令：
   - `claudeRouter.llsCcaiTask.openMenu`（状态栏点击入口）
   - `claudeRouter.llsCcaiTask.showProgress`
   - `claudeRouter.llsCcaiTask.continue`（手动续推，执行前先 `cancel()` 定时器）
   - `claudeRouter.llsCcaiTask.clear`（会 `cancel()` 定时器）
   - `claudeRouter.testSimulateEnter`（已实现，保留）
10. **重构 `src/taskFlowStatusBar.ts`**：
    - 构造函数注入 `ConfigManager` 和 `LlsTaskService`；
    - 订阅 `llsTaskService.onDidChange` / `configManager.onDidChange` /
      `vscode.workspace.onDidChangeConfiguration('claudeCodeConfigHelper.*')`；
    - `refresh()` 按 10.1.2 表格渲染（无 workflow 缺模型 / 无 workflow 有模型 /
      进行中 / 已完成）；
    - `item.command = 'claudeRouter.llsCcaiTask.openMenu'` 统一入口；
    - 移除写死中文，全部走 i18n。
11. 在英文 / 中文 / 其它已支持语言的翻译资源中补齐 `llsCcaiTask.*` 文案。
12. **最终验证**：执行一次 `npm run typecheck && npm run compile`，
    输出无错误即视为整个任务流落地完成；**不需要在 Claude Code 客户端做行为冒烟，
    也不写任何单元 / 集成测试**。

---

## 12. 一句话摘要

> CCAI 用 **Relay 拦截最后一条 user 消息里是否含 `@llsccai-task`** 替代 LLS OAI 的
> `@lls-task` chat participant 入口；命中后用 CCAI 独立配置的任务流模型生成 JSON，
> 然后 **剪贴板 + `claude-vscode.focus` + 延时 + `editor.action.clipboardPasteAction`**
> 把"继续推进"提示自动粘到 Claude Code 输入框。
> 同时在后续每次 `/v1/messages` 透传时 **向 Anthropic `tools[]` 注入 `update_llsccai_task_workflow`**
> 工具与任务流系统提示，并在 SSE/响应中 **拦截该工具的 `tool_use`**，本地调
> `LlsTaskService.updateTaskStatuses(...)` 并把 block 改写为 text 返回，
> 让主模型可以真正回写任务状态。
> VS Code 状态栏由 `TaskFlowStatusBar` 订阅 `service.onDidChange` 与配置变更，
> 实时显示 `任务流 N/M` 与任务列表 tooltip，点击走 `claudeRouter.llsCcaiTask.openMenu` 统一入口：
> 无 workflow 时按是否配置任务流模型分别引导设置或粘贴 `@llsccai-task` 启动；
> 有 workflow 进行中弹 QuickPick 查看进度；已完成时引导清空并新建。
> 若主模型本轮响应结束且没有 `tool_use`，`AutoContinueScheduler` 固定 15 秒后自动
> **重粘"继续推进"提示并模拟系统级回车**（macOS osascript / Windows PowerShell SendKeys，
> 始终启用，无开关）；只要 CC 客户端在 15 秒内发来任意新请求，router 入口会立即
> `cancel()` 该定时器避免误发。整套等价于 LLS OAI 的"扩展端自动执行工具 + 任务流
> 状态栏 + 自动续推"模式；**落地阶段不做单元 / 集成 / 冒烟测试，编译通过即视为完成。**
