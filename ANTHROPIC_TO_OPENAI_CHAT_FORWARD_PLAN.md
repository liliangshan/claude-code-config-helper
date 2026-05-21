# Anthropic → OpenAI Chat Completions 转发方案

## 1. 背景与目标

当前 Relay 仅实现 `apiType=anthropic` 的同协议透传（`POST /v1/messages` →
`{provider.baseUrl}/messages`）。本方案补齐 `apiType=openai-compatible` 的能力：

- 接收来自 Claude Code 的 **Anthropic Messages API** 请求（`POST /v1/messages`）。
- 转换为 **OpenAI Chat Completions** 请求转发到 `{provider.baseUrl}/chat/completions`。
- 把上游返回的 OpenAI 格式（JSON 或 SSE）转回 Anthropic 格式响应给 Claude Code。
- 保持任务流注入、`@llsccai-task` 工具拦截、自动续推、Debug 日志等现有能力不变。

> **流式实时性说明**：现有 `interceptAnthropicResponse` 是整段 body 后处理。
> 普通无任务流命中场景下，OpenAI Chat SSE chunk 转换后会**实时**逐字写给客户端；
> 一旦本轮命中本地 workflow 工具拦截（`create_llsccai_task_workflow` /
> `update_llsccai_task_workflow`），见 §7.x，要么走**增量式 Anthropic SSE
> interceptor**，要么降级为缓冲完整 SSE 后再返回，详见下文。

> 转发路径不带 `/v1`：上游端点固定为 `{baseUrl}/chat/completions`，由 provider 的
> `baseUrl` 自行决定是否包含 `/v1`（用户可在配置里写
> `https://api.example.com` 或 `https://api.example.com/v1`，扩展不再追加 `/v1`）。

参考实现（反向方向）：`liliangshan.openapi-compatible-copilot`
`src/utils/anthropicConverter.ts`，本方案做的是**反向**——把请求从 Anthropic 转到
OpenAI，再把响应从 OpenAI 转回 Anthropic。

## 2. 触发链路

```
Claude Code
  └─ POST http://127.0.0.1:<port>/v1/messages   (Anthropic 请求体)
       └─ src/relay/router.ts
            ├─ provider.apiType === 'anthropic'        → AnthropicProxyAdapter（已有）
            └─ provider.apiType === 'openai-compatible' → OpenAIChatProxyAdapter（新增，本方案）
                 ├─ 注入任务流 tools / system rule（与 anthropic 路径一致）
                 ├─ 转换 Anthropic 请求 → OpenAI Chat Completions 请求
                 ├─ POST {baseUrl}/chat/completions
                 └─ 流式 / 非流式：OpenAI 响应 → Anthropic 响应
                      └─ 走 interceptAnthropicResponse（任务流工具本地拦截、自动续推）
```

## 3. 新增文件

| 文件 | 作用 |
| --- | --- |
| `src/relay/openaiChatProxy.ts` | `UpstreamAdapter`：负责注入任务流、协议转换、上游请求、响应转换、Debug 落盘。 |
| `src/relay/converters/anthropicToOpenAIChat.ts` | 请求体方向转换（Anthropic → OpenAI Chat）。 |
| `src/relay/converters/openAIChatToAnthropic.ts` | 响应体方向转换：JSON / SSE 两套，含流式状态机。 |
| `src/relay/taskRequestInjection.ts` | 从 `anthropicProxy.ts` 抽出的任务流公共注入模块，供 anthropic / openai-compatible / v1-response 三个 adapter 共用。 |
| `src/relay/openAIHeaders.ts` | OpenAI / Responses 公用的鉴权和请求头构建（与 Anthropic 鉴权独立）。 |

所有新增类、方法、接口都加 JSDoc 注释（与现有约定一致："所有的方法 类都加上注释"）。

> **重要前置**：当前 `injectLlsTaskRequestBody`、`stripLlsTaskControlMessages`、
> `forceLlsTaskUpdateToolChoice`、`HEADER_BLOCKLIST` 等都是 `src/relay/anthropicProxy.ts`
> 的私有符号，新 adapter 无法直接 import。实施第 1 步必须先将这些拆到
> `src/relay/taskRequestInjection.ts` / `src/relay/openAIHeaders.ts`
> 公共模块并导出。详见 §10.x「与现有代码的落地改造」。

## 4. 端点与请求头

- 上游 URL：
  ```ts
  // 使用安全的 URL join，避免 baseUrl 末尾 '/'、含 query 等情况下拼错。
  const url = joinUpstreamUrl(provider.baseUrl, '/chat/completions');
  ```
- 请求头由 `buildOpenAIForwardHeaders(provider, incomingHeaders)` 构造：
  - `Content-Type: application/json`
  - 鉴权（**与 Anthropic 鉴权独立**，不要复用 `applyAuthHeaders`）：
    - `authMode = 'auth_token'` 或 `'api_key'` → `Authorization: Bearer <key>`
    - `authMode = 'none'` → 不带鉴权
    - **不要**自动添加 `x-api-key`，**不要**自动添加 `anthropic-version`。
  - 透传 `customHeaders`，但过滤 `HEADER_BLOCKLIST`：
    `authorization`、`x-api-key`、`x-auth-token`、`host`、`content-length`、
    `connection`、`accept-encoding`、`proxy-authorization`。
    用户在 `customHeaders` 显式指定 `Authorization` 时按 provider 配置策略
    决定是否覆盖（默认遵循用户显式值优先，但仍记录 debug warning）。
  - 移除 Anthropic 专属头：`anthropic-version`、`anthropic-beta`。

## 5. 请求转换（Anthropic → OpenAI Chat Completions）

### 5.1 顶层字段映射

| Anthropic | OpenAI Chat | 说明 |
| --- | --- | --- |
| `model` | `model` | 由扩展按 `modelId` 重写，与现有 anthropic 透传一致。 |
| `system` | `messages[0]={ role:'system', content }` | 数组形态拼接为单条文本。 |
| `messages` | `messages` | 见 5.2 详细规则。 |
| `tools` | `tools` | 见 5.3。 |
| `tool_choice` | `tool_choice` | 见 5.4。 |
| `temperature` | `temperature` | 直接透传。 |
| `top_p` | `top_p` | 直接透传。 |
| `max_tokens` | `max_tokens` | 直接透传，缺省不设。 |
| `stream` | `stream` | 直接透传。 |
| `stop_sequences` | `stop` | 数组直接传。 |
| `metadata.user_id` | `user` | 可选透传。 |

### 5.2 messages 规则

- Anthropic `system`（字符串或 `[{type:'text', text}]`）合并为单条
  `{ role: 'system', content }`，放在 `messages` 数组最前面。
  - 仅拼接 `type==='text'` 块；带 `cache_control` 的属性被忽略并记录一条
    `ConversionWarning`（见 §10.x 降级策略）。
- 遍历 `messages[]`：
  - `role: 'user' | 'assistant'`，`content` 形态：
    - 字符串 → 直接作为 `content` 字符串。
    - 数组（`text` / `image` / `tool_use` / `tool_result` 混合）→ 按规则展开：
      - `text` → `{ type:'text', text }`。
      - `image`（仅 user 消息有意义）：
        - `source.type==='base64'` → `{ type:'image_url', image_url:{ url:
          'data:<media_type>;base64,<data>' } }`
        - `source.type==='url'` → `{ type:'image_url', image_url:{ url } }`
        - assistant 角色出现 image → 转为 `[assistant image omitted]` 文本，
          并记录 warning。
      - `tool_use`（只可能出现在 assistant content）→ 抽出成为 OpenAI 的
        `tool_calls`：
        ```json
        {
          "id": "<tool_use.id>",
          "type": "function",
          "function": {
            "name": "<tool_use.name>",
            "arguments": "<JSON.stringify(tool_use.input)>"
          }
        }
        ```
        同一条 assistant 的多个 `tool_use` 合并到一个 `tool_calls` 数组里。
        OpenAI Chat 允许 assistant 同时存在 `content` 字符串与 `tool_calls`，
        因此若 assistant 既有文本块又有 tool_use：
        - 文本块合并为 `content`（缺省字符串）。
        - tool_use 合并到 `tool_calls`。
        - 不要拆成两条 assistant message。
      - `tool_result`（出现在 user content）→ 拆分成 OpenAI 的
        `{ role:'tool', tool_call_id:<tool_use_id>, content }`，按出现顺序追加。
        - **`content` 强制转纯字符串**：`tool_result.content` 数组中的 text 块
          按原文拼接；image 块降级为 `[image omitted in tool result: <media_type>]`，
          并记录 warning（原始图片只进 Debug，不发上游）。
        - 如果同一 user 消息里既有普通文本又有多个 `tool_result`：
          - 先输出所有 `tool_result` → 多条 `role:'tool'`。
          - 再输出剩余文本/图片 → 一条 `role:'user'`。
- **未知 / 不支持 block 的降级策略**：
  - `thinking` / `redacted_thinking` → 默认忽略，仅写 Debug。
  - `server_tool_use` / `web_search_tool_result` / `computer_use` 等 Anthropic
    扩展 block → 转为 `[unsupported block: <type>]` 文本并记录 warning，
    **不**转成 OpenAI function tool。
  - 其他未知 type → 同上文本占位 + warning。
- 连续相同 role 的 OpenAI 消息不强制合并（OpenAI 允许）。

### 5.3 tools 转换

```text
Anthropic: { name, description, input_schema }
OpenAI:    { type:'function', function:{ name, description, parameters } }
```

- `input_schema` 缺失或非对象 → `parameters = { type:'object', properties:{} }`。
- 保留扩展自身注入的 `create_llsccai_task_workflow` / `update_llsccai_task_workflow`
  工具，注入流程在转换之前完成（与 anthropic 透传完全一致）。

### 5.4 tool_choice 转换

| Anthropic | OpenAI Chat |
| --- | --- |
| `{ type:'auto' }` | `'auto'` |
| `{ type:'any' }` | `'required'` |
| `{ type:'tool', name }` | `{ type:'function', function:{ name } }` |
| `{ type:'none' }`（罕见） | `'none'` |
| 未设置 | 不设置 |

强制 `tool_choice = { type:'tool', name:'update_llsccai_task_workflow' }`
（任务流缺失回写补偿）也走同样转换。

## 6. 响应转换（OpenAI Chat → Anthropic Messages）

响应有两种：**非流式 JSON** 与 **流式 SSE**。两者最终都要让 Claude Code 看到
Anthropic 协议字段，并保证 `interceptAnthropicResponse` 仍能识别 `tool_use` /
`text`。

### 6.1 非流式 JSON

OpenAI Chat Completions：
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop|tool_calls|length|content_filter",
      "message": {
        "role": "assistant",
        "content": "..." | null,
        "tool_calls": [
          { "id": "...", "type": "function", "function": { "name": "...", "arguments": "{...}" } }
        ],
        "reasoning_content": "..." (可选)
      }
    }
  ],
  "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 }
}
```

转换为 Anthropic：
```json
{
  "id": "msg_<id>",
  "type": "message",
  "role": "assistant",
  "model": "<modelId>",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "tool_use", "id": "...", "name": "...", "input": { ... } }
  ],
  "stop_reason": "end_turn|tool_use|max_tokens|stop_sequence",
  "stop_sequence": null,
  "usage": { "input_tokens": 10, "output_tokens": 20 }
}
```

- `finish_reason` 映射（含兜底）：
  - `stop` → `end_turn`
  - `length` → `max_tokens`
  - `tool_calls` → `tool_use`
  - `function_call`（旧式） → `tool_use`
  - `content_filter` → `end_turn`（附加 `content[0]` 为说明文本）
  - `null` / `undefined`：若 `tool_calls` 非空 → `tool_use`，否则 → `end_turn`
  - 其他未知值 → `end_turn`，记录 Debug warning
- `tool_calls[].function.arguments` 是 JSON 字符串 → 解析为对象再放进
  `input`；解析失败则 `input = {}`，并在 `content` 末尾追加一条 `text` 说明。
- `reasoning_content` 不映射到 Anthropic content（保持 stop_reason 与
  Anthropic 语义一致），但保留在 Debug 日志中。

### 6.2 流式 SSE

OpenAI Chat Completions 流式分片（`data: {...}\n\n`，结束 `data: [DONE]`），
需要把流转换成 Anthropic 的 7 类事件：

```
event: message_start          { type:'message_start', message:{ id, role, model, content:[], usage:{...} } }
event: content_block_start    { index, content_block:{ type:'text'|'tool_use', ... } }
event: content_block_delta    { index, delta:{ type:'text_delta'|'input_json_delta', ... } }
event: content_block_stop     { index }
event: message_delta          { delta:{ stop_reason, stop_sequence }, usage:{ output_tokens } }
event: message_stop           { type:'message_stop' }
event: ping                   保持连接（可选）
```

状态机字段：
```ts
/**
 * 单个 OpenAI tool_call 在流式过程中的累积状态。
 * 必须按 tool_calls[].index 分桶，禁止用顺序推断。
 */
interface ToolCallStreamState {
    /** OpenAI tool_calls[].index */
    openAiIndex: number;
    /** 对应 Anthropic content_block 的 index，未发 start 时为 undefined */
    anthropicBlockIndex?: number;
    /** OpenAI tool_call.id，可能跨 chunk 才到齐 */
    id?: string;
    /** OpenAI tool_call.function.name，可能跨 chunk 才到齐 */
    name?: string;
    /** 累积的 function.arguments JSON 字符串 */
    argumentsJson: string;
    /** 是否已发出 content_block_start */
    started: boolean;
    /** 是否已发出 content_block_stop */
    closed: boolean;
}

/**
 * Chat Completions SSE → Anthropic SSE 的整体转换状态。
 */
interface OpenAIChatToAnthropicState {
    messageId: string;             // 由 OpenAI id 派生，例如 'msg_' + chatcmpl id
    model: string;
    messageStartEmitted: boolean;
    currentTextIndex?: number;     // 文本块在 Anthropic content 中的 index
    textBlockOpen: boolean;
    /** OpenAI tool_calls[].index -> ToolCallStreamState */
    toolCalls: Map<number, ToolCallStreamState>;
    /** 下一个可用的 Anthropic content_block index */
    nextBlockIndex: number;
    promptTokens: number;
    completionTokens: number;
    finishReason?: string;
}
```

流式映射规则：

1. **首个 chunk**：发出 `message_start`：
   ```json
   { "type":"message_start", "message":{ "id":"msg_<id>", "type":"message",
     "role":"assistant", "model":"<modelId>", "content":[],
     "stop_reason":null, "stop_sequence":null,
     "usage":{ "input_tokens":0, "output_tokens":0 } } }
   ```
2. **文本增量**（`choices[0].delta.content` 为字符串）：
   - 首次出现：发 `content_block_start { index:n, content_block:{ type:'text', text:'' } }`，
     `textBlockOpen=true`，`currentTextIndex=n`。
   - 后续：发 `content_block_delta { index:n, delta:{ type:'text_delta', text:<delta> } }`。
3. **tool_call 增量**（`choices[0].delta.tool_calls[]`，**必须严格按 index 分桶**）：
   - 对每个 delta 元素：取 `call.index`，从 `state.toolCalls` 中取出或新建
     `ToolCallStreamState`。
   - 合并 `id`、`function.name`、`function.arguments`：
     ```ts
     if (call.id) tc.id = call.id;
     if (call.function?.name) tc.name = call.function.name;
     if (typeof call.function?.arguments === 'string') tc.argumentsJson += call.function.arguments;
     ```
   - **`content_block_start` 触发条件**：仅当 `tc.id && tc.name && !tc.started` 时：
     - 关闭仍开着的 text 块（发 `content_block_stop`，`textBlockOpen=false`）。
     - 分配 `tc.anthropicBlockIndex = state.nextBlockIndex++`。
     - 发 `content_block_start { index, content_block:{ type:'tool_use',
       id:tc.id, name:tc.name, input:{} } }`，置 `tc.started=true`。
     - 若此时已累积了 `argumentsJson`，立刻补发一条
       `content_block_delta { delta:{ type:'input_json_delta',
       partial_json:tc.argumentsJson } }`。
   - **arguments delta 在 start 已发出后**：直接发
     `content_block_delta { index:tc.anthropicBlockIndex, delta:{
     type:'input_json_delta', partial_json:<本次 delta> } }`。
   - **禁止**用"下一个 tool 出现"作为关闭上一个 tool block 的条件。Anthropic
     content block 必须顺序输出且不交错；若多 tool_call 的 delta 交错到达，
     允许它们在状态机中并发累积，但只在所有 tool 都需关闭时按 index 顺序输出
     `content_block_stop`。
4. **usage**（OpenAI Chat `stream_options.include_usage`）：
   - 由于很多 OpenAI-compatible provider 对未知字段严格校验会因
     `stream_options` 报 400，**本方案默认不主动注入** `stream_options.include_usage`。
   - 启用方式（按优先级）：
     1. 用户在 `provider.customRequestFields` 中显式指定；
     2. 配置开关 `provider.openai.streamIncludeUsage = true`；
     3. 首次请求返回 400 且错误指向 `stream_options` 时，自动重试一次去掉该字段。
   - usage 缺失时，`message_delta.usage.output_tokens` 取 `0`，**不要用 delta
     字符长度估算 token 数**（伪造 token 会影响调用方计费/限速逻辑）。
5. **finish_reason**：
   - 收到带 `finish_reason` 的 chunk 时：
     - 关闭所有仍未关闭的 `toolCalls`：按 `openAiIndex` 升序，对每个未
       `started` 的，如其 `id && name` 已到齐则补发 `content_block_start +
       content_block_delta(argumentsJson)`，否则记录 warning 并跳过（绝不发
       缺 id 或 name 的非法 tool_use）。然后发 `content_block_stop`，置 `closed=true`。
     - 关闭仍打开的 text 块。
     - 发 `message_delta { delta:{ stop_reason:<map>, stop_sequence:null },
       usage:{ output_tokens:completionTokens } }`。
6. **`data: [DONE]`** 或上游流自然结束：
   - 若尚未收到 `finish_reason`，按"5. finish_reason"流程合成兜底：有 tool_call
     → `tool_use`，否则 `end_turn`。
   - 发 `message_stop` 后结束响应流。
7. **保持连接**：长时间无数据时可周期发 `event: ping`（与 Anthropic 官方一致）。

### 6.3 错误与中断

- 上游 4xx/5xx 非 SSE：原文读取后包装为 Anthropic 错误体；按 HTTP 状态码映射
  `error.type`：

  | HTTP 状态码 | Anthropic `error.type` |
  | --- | --- |
  | 400 | `invalid_request_error` |
  | 401 | `authentication_error` |
  | 403 | `permission_error` |
  | 404 | `not_found_error` |
  | 408 | `request_timeout` |
  | 413 | `request_too_large` |
  | 429 | `rate_limit_error` |
  | 500 / 502 / 503 / 504 | `api_error` |
  | 529 / 上游显式 overloaded | `overloaded_error` |
  | 其他 | `api_error` |

  统一形态：
  ```json
  { "type":"error", "error":{ "type":"<mapped>", "message":"<masked details>" } }
  ```
  `message` 必须**脱敏**：移除 URL query、`Authorization`、`x-api-key`、cookie、
  bearer token 等敏感片段。
- 上游中途断开：
  - 若尚未发出 `message_start`：返回 Anthropic JSON 错误体。
  - 若已发出 `message_start`：先关闭所有 open content block 与可能未关闭的
    tool_call，发 `message_delta { stop_reason:'end_turn', ... }` 再发
    `event: error` 与 `message_stop`，避免 Claude Code SSE 状态机停在
    "block 仍打开"。
  - 自动续推由 `interceptAnthropicResponse` 决定（与 anthropic 透传一致）。

## 7. 任务流注入与本地拦截

- **请求注入**：在协议转换**之前**先按 Anthropic 协议注入 system rule 与
  `create_llsccai_task_workflow` / `update_llsccai_task_workflow` 工具，
  之后再转 OpenAI Chat 格式。这样可以复用从 `anthropicProxy.ts` 抽出的
  任务流注入公共逻辑，无需再写一份 OpenAI 形态的注入。
  > 实施前需要先把 `injectLlsTaskRequestBody` 从 `anthropicProxy.ts`
  > 抽到 `src/relay/taskRequestInjection.ts` 公共模块（详见 §10.x）。
- **响应拦截**：必须分为两条路径，详见 §7.x。

### 7.x 流式拦截与实时性约束

现有 `interceptAnthropicResponse(body, contentType, deps)` 是整段响应**后处理**
函数，**不能**在已经写出 SSE chunk 后再改写 workflow tool_use。因此新增
Chat adapter 必须显式区分两种场景：

#### 场景 A：普通无任务流命中（默认实时流式）

1. OpenAI Chat SSE chunk 到达后立即由 `OpenAIChatToAnthropicStreamConverter`
   转换为 Anthropic SSE 并**实时**写给客户端。
2. 同时 tee 一份完整 Anthropic SSE 文本到内存 buffer，仅用于 Debug 日志
   `responseBody` 与可能的 fallback 处理。
3. 上游流结束后，把 buffered Anthropic SSE 文本传入
   `interceptAnthropicResponse`：
   - 若 interceptor 未识别到本地 workflow tool 调用（最常见路径）：直接
     `DebugRecorder.record`，不改写已发送内容。
   - 若 interceptor 识别到 workflow tool（理论上不会在此场景出现，但要兜底）：
     由于 SSE 已发完，无法回滚，记录 warning，依赖下一轮自动续推补偿。

#### 场景 B：任务流可能命中（增量式拦截，推荐实现）

适用于：

- `LlsTaskService.hasActiveWorkflow()` 为真（已有活跃 workflow）；
- 或 `LlsTaskService.hasPendingWorkflowCreation()` 为真（本轮触发了
  `@llsccai-task`，等待创建 workflow）；
- 或 `LlsTaskService.shouldForceWorkflowUpdateTool()` 为真（强制 tool_choice）。

实现方式（**优先级 1：增量式 Anthropic SSE Transform**）：

- 新增 `LlsTaskStreamingInterceptor`：一个 Transform，输入 Anthropic SSE 文本，
  输出经任务流改写后的 Anthropic SSE 文本：
  - 解析 `content_block_start`：若 `content_block.type==='tool_use'` 且
    `name ∈ {create_llsccai_task_workflow, update_llsccai_task_workflow}`，
    标记此 block 为"workflow tool"，**暂不**向客户端输出原始 tool_use 事件，
    而是缓冲后续 delta。
  - 累积 `content_block_delta.input_json_delta.partial_json`。
  - 在 `content_block_stop` 时本地执行 workflow tool：
    - `LlsTaskService.createWorkflow(parsedInput)` 或
      `LlsTaskService.updateTaskStatuses(parsedInput.updates)`。
    - 把该 tool block 改写为 Anthropic `content_block_start/.../stop` 的
      `text` 块，文本内容为工具执行结果（人类可读 summary）。
    - 重新分配 Anthropic block index，保证编号单调连续。
  - 若最终 `message_delta.stop_reason === 'tool_use'` 且**仅命中 workflow
    tool**，改写为 `end_turn`。
  - 非 workflow tool 的 tool_use block 原样转发。
- 该 Transform 与 `OpenAIChatToAnthropicStreamConverter` 串联：
  ```
  上游 OpenAI Chat SSE
    → OpenAIChatToAnthropicStreamConverter
      → LlsTaskStreamingInterceptor
        → Claude Code (Anthropic SSE)
  ```
- 流结束后再调用一次 `LlsTaskService` 检查 `workflowUpdateMissing` 状态，
  必要时调度自动续推（与现有 `AutoContinueScheduler` 行为一致）。

实现方式（**优先级 2：缓冲降级**，作为优先级 1 未实现前的临时方案）：

- 当判定属于场景 B 时，关闭实时流：
  - 把上游 SSE 完全缓冲为 Anthropic SSE 文本。
  - 整段传入现有 `interceptAnthropicResponse` 处理。
  - 把处理后结果一次性写给 Claude Code。
- 验收时必须明确告知用户：任务流命中轮次流式输出会"卡一下"，普通轮次仍逐字
  输出。

#### 验收必须分别覆盖

- 场景 A：普通流式文本逐字输出，无卡顿；
- 场景 A：普通流式 `tool_calls` 能被 Claude Code 正常接收并执行；
- 场景 B：`create_llsccai_task_workflow` 命中时不向 Claude Code 暴露原始
  workflow tool_use，状态栏出现新 workflow；
- 场景 B：`update_llsccai_task_workflow` 命中时本地回写状态，下一轮自动续推
  正常触发；
- 场景 B：`workflowUpdateMissing` 强制 `tool_choice` 后，下一轮上游仍按预期发出
  `update_llsccai_task_workflow` tool_call 并被本地拦截。

## 8. Debug 日志（与现有 `.LLSOAI/YYYY-MM-DD.json` 兼容）

现有 `DebugRecorder.extractRequestMessages` 只读取 `requestBody.messages`。
若把转换后的 OpenAI 请求体作为 `requestBody`，会破坏按 Anthropic messages 内容
去重的语义（system 进入 messages[0]、tool_result 变成 role:'tool' 等）。

因此约定：

- `DebugRecorder.record(entry).requestBody` 必须继续传入**已重写 model、已完成
  任务流注入、但尚未转换为 OpenAI Chat** 的 Anthropic 请求体（JSON 序列化）。
  这样 `.LLSOAI/YYYY-MM-DD.json` 中保存的仍是 Anthropic 形态 messages，按天
  去重逻辑不变。
- 如需排查上游实际载荷，扩展 `DebugRecordEntry` 增加可选字段：
  ```ts
  /**
   * Debug 落盘所需的一条记录。
   */
  interface DebugRecordEntry {
      /** 已注入任务流、未做协议转换的 Anthropic 请求体（用于 messages 去重）。 */
      requestBody: string;
      /** 实际发送给上游的 OpenAI Chat 请求体（仅排查用，不参与去重）。 */
      upstreamRequestBody?: string;
      /** 转换回 Anthropic 形态后的最终响应体（流式情况下是拼接的 SSE 文本）。 */
      responseBody: string;
      /** 上游原始 OpenAI Chat 响应体（仅排查用）。 */
      upstreamResponseBody?: string;
      // ...其余既有字段
  }
  ```
- `responseBody` 写入**已转换回 Anthropic 的响应**，与 anthropic 透传保持一致，
  方便 grep 任务流工具调用与 stop_reason。
- `DebugRecorder` 自身不需要再次改造去重算法；只需新增字段写入即可。

## 9. 配置层改动（最小化）

- `ProviderConfig.apiType === 'openai-compatible'` 不再被透传层拒绝。
- `src/relay/router.ts` 当前已经通过 `adapters: UpstreamAdapter[]` 注入
  `adapterMap`，**不需要**在 router 内硬编码 if/switch。新增 adapter 的接入
  方式是在创建 router/server 的扩展启动处注册：
  ```ts
  // 创建 relay 时
  const adapters: UpstreamAdapter[] = [
      anthropicProxyAdapter,
      openaiChatProxyAdapter,        // 新增
      // openaiResponsesProxyAdapter,  // v1-response 方案
  ];
  ```
- 模型列表（`src/modelFetcher.ts`）与转发路径的 `/v1` 策略**单独决策**：
  - 转发路径：固定 `{baseUrl}/chat/completions`，扩展不追加 `/v1`。
  - modelFetcher：保留现有行为（视实现追加 `/v1/models` 或不追加）。
  - 配置 UI 文案需提示用户：`baseUrl` 是否包含 `/v1` 由用户决定；转发和模型
    列表共用同一 `baseUrl`。
- `v1-response` 走另一份方案（见 `ANTHROPIC_TO_OPENAI_RESPONSES_FORWARD_PLAN.md`）。

## 10. 关键边界条件

| 场景 | 处理 |
| --- | --- |
| Claude Code 工具结果含图片 | 仅在 user `tool_result` 中将图像降级为 `[image omitted in tool result: <media_type>]` 文本占位；OpenAI `role:'tool'` 的 content 强制为字符串，不携带 `image_url`。原始图像仅进入 Debug。 |
| 任务流强制 `tool_choice=update_llsccai_task_workflow` | 转换为 OpenAI `{ type:'function', function:{ name:'update_llsccai_task_workflow' } }`。 |
| `tool_use` 跨多个 chunk 的 partial JSON | 按 `tool_calls[].index` 累积；`id` 与 `name` 齐全前不发 `content_block_start`，详见 §6.2。 |
| 上游不支持 `stream_options.include_usage` | 默认**不**注入该字段；usage 缺失时 `output_tokens=0`，不伪造估值。详见 §6.2 规则 4。 |
| `system` 数组含 `cache_control` | 只拼接 text，忽略 `cache_control` 并记录 warning。 |
| `system` 与首条 user 之间不允许空消息 | 转换时空 system 不输出；空 user content 跳过。 |
| Anthropic `thinking` / `redacted_thinking` 历史块 | 默认忽略；仅写 Debug。 |
| Anthropic `server_tool_use` / `web_search_tool_result` / `computer_use` | 转为 `[unsupported block: <type>]` 文本并记录 warning，不转 OpenAI function tool。 |
| `baseUrl` 末尾带 `/` 或包含 query / hash | 使用 `joinUpstreamUrl` 安全拼接，避免 `//chat/completions` 或 query 丢失。 |
| `baseUrl` 包含 `/v1` | 直接拼接，最终上游路径仍为 `<baseUrl>/chat/completions`，**扩展不再自行添加 `/v1`**。 |
| 上游返回未知 `finish_reason` | 见 §6.1 finish_reason 映射兜底；记录 Debug warning。 |

### 10.x 与现有代码的落地改造（前置）

当前 `src/relay/anthropicProxy.ts` 中以下符号是私有函数，新 adapter 不能直接复用：

- `injectLlsTaskRequestBody`
- `shouldForceLlsTaskUpdateTool`
- `forceLlsTaskUpdateToolChoice`
- `stripLlsTaskControlMessages`
- `appendSystemRule`
- `mergeAnthropicTools`
- `filterAnthropicToolsByName`
- `HEADER_BLOCKLIST`
- `redactHeaders`

实施第 1 步必须先抽公共模块（**不修改既有行为**，只做导出/迁移）：

- `src/relay/taskRequestInjection.ts`
  - 导出 `injectLlsTaskRequestBody(requestBody, ctx, deps): InjectedRequest`
    单一公共 API（内部仍封装 active/create/pending 三种分支与
    `forceLlsTaskUpdateToolChoice`、`stripLlsTaskControlMessages` 等 helper）。
  - 导出 `appendSystemRule`、`mergeAnthropicTools`、`filterAnthropicToolsByName`
    供新 adapter 复用。
- `src/relay/openAIHeaders.ts`
  - 导出 `buildOpenAIForwardHeaders(provider, incomingHeaders): Record<string, string>`。
  - 导出 `applyOpenAIAuthHeaders(headers, provider): void`：
    - `authMode='auth_token' | 'api_key'` → `Authorization: Bearer <key>`。
    - `authMode='none'` → 不加。
    - **绝不**自动加 `anthropic-version` 或 `x-api-key`。
  - 复用 `HEADER_BLOCKLIST` 与 `redactHeaders`（也建议同步迁出到一个共享
    `src/relay/forwardHeadersCommon.ts`）。
- 安全 URL join helper：
  - 提供 `joinUpstreamUrl(baseUrl: string, path: string): string`，使用 `new URL()`
    实现，处理：末尾 `/`、含 `/v1`、含 query / hash、`baseUrl` 已含目标 path
    （此时回退为原样使用并记录 warning）。
- `AnthropicProxyAdapter` 同步切换到这些公共模块，行为保持不变；这一步要单独
  跑一次 `npm run typecheck && npm run compile` 验证回归。

### 10.y 协议转换单测矩阵（建议）

实施时建议为 converter 编写下列测试用例（纯函数，便于单测）：

- system: string / `[{type:'text'}]` / 带 `cache_control` / 空数组。
- user: string / text + image(base64) / text + image(url) / 多 tool_result 混排 /
  tool_result 含图像降级 / 空 content。
- assistant: text / text + multi tool_use / 仅 tool_use / 含 `thinking` 应忽略 /
  含 `server_tool_use` 应降级。
- tools: 含 / 不含 `input_schema` / `input_schema` 非对象。
- tool_choice: auto / any / tool(name) / none / 未设置 / 强制
  `update_llsccai_task_workflow`。
- 流式：
  - 仅文本逐字流。
  - 文本 + 单 tool_call（arguments 分片）。
  - 多 tool_call **按 index 交错** delta。
  - tool_call 的 `id` / `name` 分片到达。
  - 收到 `[DONE]` 但缺 `finish_reason`。
  - 上游中途断流。
- 非流式：
  - `finish_reason=null` + 有 `tool_calls`。
  - `finish_reason=function_call` 旧式。
  - `tool_calls[].function.arguments` 非法 JSON。
- 错误：401 / 429 / 500 / 自定义 4xx；message 必须脱敏。
- 任务流：场景 A 普通流；场景 B 命中 workflow 工具被本地拦截；
  `workflowUpdateMissing` 强制 tool_choice 下一轮命中。

## 11. 实施步骤（建议顺序）

0. **前置抽取（必须先做）**：按 §10.x 把 `injectLlsTaskRequestBody` 等任务流
   注入函数和 OpenAI 鉴权 header 构建抽到 `src/relay/taskRequestInjection.ts`
   与 `src/relay/openAIHeaders.ts`；`AnthropicProxyAdapter` 同步切换到这些
   公共模块；先跑一次 `npm run typecheck && npm run compile` 确认无回归。
1. 新增 `src/relay/converters/anthropicToOpenAIChat.ts`：纯函数，配单测覆盖
   §10.y 列出的用例（text / image / tool_use / tool_result / tool_choice /
   system 数组 / cache_control / thinking / server_tool_use 等）。
2. 新增 `src/relay/converters/openAIChatToAnthropic.ts`：
   - `convertOpenAIChatJsonToAnthropic(json)`
   - `OpenAIChatToAnthropicStreamConverter`：`feed(rawSseChunk)` 输出 Anthropic
     SSE 文本；严格按 §6.2 状态机实现 `ToolCallStreamState`。
3. 新增 `src/relay/openaiChatProxy.ts`：实现 `UpstreamAdapter`，从公共模块
   import `injectLlsTaskRequestBody`、`buildOpenAIForwardHeaders` 等，
   响应链路按 §7.x 区分场景 A / B：
   - 场景 A：实时流式转换 + tee Debug。
   - 场景 B：实现 `LlsTaskStreamingInterceptor`，或临时降级为缓冲完整 SSE
     后调用 `interceptAnthropicResponse`。
4. 扩展启动处注册 `openaiChatProxyAdapter` 到 router 的 `adapters` 数组
   （§9）；router 本身无需改 switch。
5. 运行 `npm run typecheck && npm run compile`。
6. 用本地伪上游（如 simple Node mock）按 §10.y 矩阵验证：
   - 非流式文本应答。
   - 流式文本应答。
   - tool_calls 流式应答（含多 tool_call 交错、id/name 分片）。
   - `@llsccai-task` 创建/更新 workflow 全链路（场景 B 增量拦截或缓冲降级）。
   - 错误场景：401 / 429 / 500 / 上游中途断流。

## 12. 验收清单

- [ ] `apiType=openai-compatible` 的 provider 能完成 Claude Code 一次普通对话。
- [ ] **场景 A**：普通无任务流命中时，流式响应在 Claude Code 中逐字输出，
      无吞字、无卡顿。
- [ ] **场景 A**：流式 `tool_calls`（含多 tool_call 交错、`id`/`name` 分片）能
      被 Claude Code 正常接收并执行。
- [ ] **场景 B**：`@llsccai-task` 触发后能创建 workflow，**不**向 Claude Code
      暴露原始 `create_llsccai_task_workflow` 工具调用，状态栏更新，
      自动续推工作。
- [ ] **场景 B**：`update_llsccai_task_workflow` 在 OpenAI tool_calls 协议下被
      本地拦截，状态栏进度同步更新；`workflowUpdateMissing` 强制 `tool_choice`
      在下一轮正常生效。
- [ ] `.LLSOAI/YYYY-MM-DD.json` 中能看到去重后的**Anthropic 形态** messages
      （不是 OpenAI Chat 形态）。
- [ ] 上游 URL 始终是 `{baseUrl}/chat/completions`，**不会出现 `/v1/chat/completions`
      由扩展添加**。
- [ ] 鉴权头使用 `Authorization: Bearer <key>`，**不**自动添加 `x-api-key` 或
      `anthropic-version`。
- [ ] 错误响应（401 / 429 / 500 / 上游断流）按 §6.3 错误码映射返回，
      message 已脱敏。
- [ ] 未默认注入 `stream_options.include_usage`；usage 缺失时 `output_tokens=0`，
      不伪造估值。
