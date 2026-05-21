# Anthropic → OpenAI Responses 转发方案

## 1. 背景与目标

补齐 `apiType=v1-response` 的转发能力：

- 接收 Claude Code 的 **Anthropic Messages API** 请求（`POST /v1/messages`）。
- 转换为 **OpenAI Responses API** 请求转发到 `{provider.baseUrl}/responses`。
- 把上游 Responses 协议（JSON 或 SSE）转换回 Anthropic Messages 协议响应给
  Claude Code。
- 保持任务流注入、`@llsccai-task` 工具拦截、自动续推、Debug 日志等现有能力。

> 转发路径不带 `/v1`：上游端点固定为 `{baseUrl}/responses`，由 provider 的
> `baseUrl` 自行决定是否包含 `/v1`。

> **流式实时性说明**：现有 `interceptAnthropicResponse` 是整段 body 后处理。
> 普通无任务流命中场景下，Responses SSE 转换后会**实时**逐字写给客户端；
> 一旦本轮命中本地 workflow 工具拦截，见 §7.x，要么走**增量式 Anthropic SSE
> interceptor**，要么降级为缓冲完整 SSE 后再返回。

参考实现（反向方向）：`liliangshan.openapi-compatible-copilot`
`src/utils/v1ResponseConverter.ts`。本方案做的是**反向**——把请求从 Anthropic
转到 Responses，再把响应从 Responses 转回 Anthropic。

## 2. 触发链路

```
Claude Code
  └─ POST http://127.0.0.1:<port>/v1/messages   (Anthropic 请求体)
       └─ src/relay/router.ts
            ├─ provider.apiType === 'v1-response' → OpenAIResponsesProxyAdapter（新增，本方案）
                 ├─ 注入任务流 tools / system rule（Anthropic 形态，与现有 anthropic 透传一致）
                 ├─ 转换 Anthropic 请求 → OpenAI Responses 请求
                 ├─ POST {baseUrl}/responses
                 └─ Responses 响应 → Anthropic 响应
                      └─ 走 interceptAnthropicResponse（任务流工具本地拦截、自动续推）
```

## 3. 新增文件

| 文件 | 作用 |
| --- | --- |
| `src/relay/openaiResponsesProxy.ts` | `UpstreamAdapter`：请求/响应转换 + 注入 + 拦截 + Debug 落盘。 |
| `src/relay/converters/anthropicToOpenAIResponses.ts` | 请求体方向转换（Anthropic → OpenAI Responses）。 |
| `src/relay/converters/openAIResponsesToAnthropic.ts` | 响应体方向转换：JSON + SSE 状态机。 |
| `src/relay/taskRequestInjection.ts` | 从 `anthropicProxy.ts` 抽出的任务流公共注入模块（与 Chat 方案共用）。 |
| `src/relay/openAIHeaders.ts` | OpenAI / Responses 公用的鉴权和请求头构建（与 Chat 方案共用）。 |

所有新增类、方法都加 JSDoc 注释。

> **重要前置**：`injectLlsTaskRequestBody` 等任务流注入相关函数在
> `src/relay/anthropicProxy.ts` 中是私有符号，必须先抽到公共模块才能被
> Responses adapter 复用。详见 §10.x「与现有代码的落地改造」。

## 4. 端点与请求头

- 上游 URL：
  ```ts
  // 使用安全 URL join，处理 baseUrl 末尾 '/'、含 query / hash、含 /v1 等。
  const url = joinUpstreamUrl(provider.baseUrl, '/responses');
  ```
- 请求头由 `buildOpenAIForwardHeaders(provider, incomingHeaders)` 构造：
  - `Content-Type: application/json`
  - 鉴权（**与 Anthropic 鉴权独立**）：
    - `authMode='auth_token' | 'api_key'` → `Authorization: Bearer <key>`
    - `authMode='none'` → 不带鉴权
    - **不要**自动添加 `x-api-key` / `anthropic-version`。
  - 透传 `customHeaders`，过滤 `HEADER_BLOCKLIST`。
  - 移除 Anthropic 专属头：`anthropic-version`、`anthropic-beta`。

## 5. 请求转换（Anthropic Messages → OpenAI Responses）

OpenAI Responses 与 Chat Completions 的关键差异：

- 字段名：`messages` → **`input`**，`system` → **`instructions`**。
- `input[]` 元素既可以是 `{ role, content }` 的对话项，也可以是
  `{ type:'function_call', call_id, name, arguments }` 与
  `{ type:'function_call_output', call_id, output }` 等结构化项。
- `max_tokens` → **`max_output_tokens`**。
- `tool_choice` 形式与 Chat Completions 不同（见 5.4）。

### 5.1 顶层字段映射

| Anthropic | OpenAI Responses | 说明 |
| --- | --- | --- |
| `model` | `model` | 由扩展按 `modelId` 重写。 |
| `system`（字符串或文本数组） | `instructions` | 多段拼成单条字符串，使用 `\n` 连接；空则不传该字段。仅拼接 `type==='text'` 块，带 `cache_control` 的属性忽略并记录 warning。 |
| `messages` | `input` | 见 5.2。 |
| `tools` | `tools` | 见 5.3。 |
| `tool_choice` | `tool_choice` | 见 5.4。 |
| `temperature` | `temperature` | 直接透传。 |
| `top_p` | `top_p` | 直接透传。 |
| `max_tokens` | `max_output_tokens` | 字段名变更。 |
| `stream` | `stream` | 直接透传。 |
| `metadata` | `metadata` | 仅当为 plain object 时透传；非对象记录 warning 并丢弃。 |
| `metadata.user_id` | `user`（同时映射） | 如存在，同时映射到 Responses 顶层 `user`。 |
| `stop_sequences` | （不映射） | Responses 标准不直接支持 `stop`；按 provider 能力可选实现，默认不传。 |

**未在 Anthropic 请求中出现的 Responses 字段（默认不生成、不透传）**：

| Responses 字段 | 默认行为 |
| --- | --- |
| `parallel_tool_calls` | 默认不传；可由 provider 配置启用。 |
| `reasoning` | 默认不传；如需启用由 provider 配置控制。 |
| `store` | 默认不传（避免上游存储私密对话）。 |
| `truncation` | 默认不传。 |
| `previous_response_id` | 默认不传；Claude Code 当前不传递多轮 response id。 |
| `response_format` / `text.format` | 默认不传；如需 JSON mode 由 provider 配置控制。 |
| `seed` | 默认不传。 |
| `top_logprobs` / `logprobs` | 默认不传。 |

未知字段一律**白名单透传**：仅 provider 配置中显式启用的字段才会出现在
上游请求体，避免污染或触发上游 400。

### 5.2 input 规则

遍历 Anthropic `messages[]`：

- `role: 'user'`：
  - `content` 为字符串 → `{ role:'user', content:[{ type:'input_text', text }] }`。
  - `content` 数组：
    - `text` → `{ type:'input_text', text }`。
    - `image`：
      - `source.type==='base64'` → `{ type:'input_image',
        image_url:'data:<media_type>;base64,<data>' }`
      - `source.type==='url'` → `{ type:'input_image', image_url:'<url>' }`
    - `tool_result`：拆出为独立顶层项 `{ type:'function_call_output',
      call_id:<tool_use_id>, output:<contentToPlainText> }`，按出现顺序追加到
      `input`（不放在 user.content 内）。
      - `output` 必须是字符串：text 块按原文拼接；image 块降级为
        `[image omitted in tool result: <media_type>]` 并记录 warning。
- `role: 'assistant'`：
  - 文本块 → `{ role:'assistant', content:[{ type:'output_text', text }] }`。
    > **兼容性说明**：部分 Responses 兼容实现只接受 message content 的
    > `input_text`，不接受历史 assistant message 的 `output_text`。本方案默认
    > 按 OpenAI 官方文档使用 `output_text`；若 provider 上游返回 400 指向
    > content type，由 provider 配置开关降级为 `input_text` 或纯字符串。
  - `tool_use` 块 → 独立顶层项：
    ```json
    {
      "type": "function_call",
      "call_id": "<tool_use.id>",
      "name": "<tool_use.name>",
      "arguments": "<JSON.stringify(tool_use.input)>"
    }
    ```
    - 同一条 assistant 消息既有文本又有 tool_use：先输出 assistant 文本项，
      再依次输出多个 `function_call` 项。
- **未知 / 不支持 block 的降级策略**：
  - `thinking` / `redacted_thinking` → 默认忽略，仅写 Debug。
  - `server_tool_use` / `web_search_tool_result` / `computer_use` →
    转为 `input_text:'[unsupported block: <type>]'` 并记录 warning。
  - 其他未知 type → 同上文本占位 + warning。

> Responses 协议中 system 走 `instructions`，**不要**在 `input` 里放
> `{ role:'system' }`。

### 5.2.x `id` 与 `call_id` 配对规则

Responses API 中：

- `function_call.id` 是 **Responses output item id**（形如 `fc_xxx`），
  仅用于 Responses 自身的 output item 引用。
- `function_call.call_id` 是 **工具调用配对 id**，用于把
  `function_call_output` 配回对应的 `function_call`。
- Anthropic `tool_use.id` 必须映射为 Responses `call_id`，因为后续
  `tool_result.tool_use_id` 要转回 `function_call_output.call_id`。

转换规则：

- Anthropic assistant `tool_use` 历史 → Responses input `function_call`：
  - `call_id = tool_use.id`
  - `name = tool_use.name`
  - `arguments = JSON.stringify(tool_use.input ?? {})`
  - `id` 默认**省略**（由上游自行分配/兼容缺失）；仅在某 provider 明确要求
    `id` 时，生成一个稳定的 `fc_<hash(tool_use.id)>`，并**绝不**与 `call_id`
    设为同值。
- Anthropic user `tool_result` → Responses input `function_call_output`：
  - `call_id = tool_result.tool_use_id`
  - `output = contentToPlainText(tool_result.content)`
- Responses output `function_call` → Anthropic `tool_use`（响应方向）：
  - `tool_use.id = function_call.call_id`
  - 若 `call_id` 缺失，**才** fallback 到 `function_call.id`，并记录 warning。

### 5.3 tools 转换

Anthropic：`{ name, description, input_schema }`
OpenAI Responses：
```json
{
  "type": "function",
  "name": "<name>",
  "description": "<description>",
  "parameters": <input_schema || { type:'object', properties:{} }>
}
```

- 顶层结构与 Chat Completions 不同：**没有** `function:{...}` 嵌套层。
- 保留任务流自注入工具
  `create_llsccai_task_workflow` / `update_llsccai_task_workflow`，
  转换前由 `injectLlsTaskRequestBody` 注入。

### 5.4 tool_choice 转换

| Anthropic | OpenAI Responses |
| --- | --- |
| `{ type:'auto' }` | `'auto'` |
| `{ type:'any' }` | `'required'` |
| `{ type:'tool', name }` | `{ type:'function', name }` |
| `{ type:'none' }` | `'none'` |
| 未设置 | 不设置 |

> 注意：Responses 的 `{ type:'function', name }` **不包含** Chat Completions
> 那层 `function:{ name }` 嵌套。

强制 `tool_choice = { type:'tool', name:'update_llsccai_task_workflow' }`
（任务流缺失回写补偿）→ `{ type:'function', name:'update_llsccai_task_workflow' }`。

## 6. 响应转换（OpenAI Responses → Anthropic Messages）

### 6.1 非流式 JSON

OpenAI Responses 完整对象（节选关键字段）：
```json
{
  "id": "resp_xxx",
  "object": "response",
  "model": "...",
  "status": "completed|incomplete|failed",
  "output": [
    { "type": "message", "role": "assistant",
      "content": [{ "type": "output_text", "text": "..." }] },
    { "type": "function_call", "id":"...", "call_id":"...", "name":"...", "arguments":"{...}" }
  ],
  "incomplete_details": { "reason": "max_output_tokens|content_filter" },
  "usage": { "input_tokens": 10, "output_tokens": 20 }
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
    { "type": "tool_use", "id": "<call_id>", "name": "...", "input": { ... } }
  ],
  "stop_reason": "end_turn|tool_use|max_tokens|stop_sequence",
  "stop_sequence": null,
  "usage": { "input_tokens": 10, "output_tokens": 20 }
}
```

规则：

- `output[]` 顺序保留：`message.content[].output_text` → `text` 块；
  `function_call` → `tool_use` 块。
- `function_call.arguments` 是 JSON 字符串 → 解析为对象放进 `input`；
  解析失败 → `input = {}`。
- **`tool_use.id` 必须用 `function_call.call_id`**（见 §5.2.x）；
  若 `call_id` 缺失，fallback 到 `function_call.id` 并记录 warning。
- `stop_reason` 推导：
  - `output` 包含 `function_call` → `tool_use`。
  - `incomplete_details.reason==='max_output_tokens'` → `max_tokens`。
  - `incomplete_details.reason==='content_filter'` → `end_turn`（附加说明文本）。
  - `status==='completed'` → `end_turn`。
  - 其他 → `end_turn` 兜底，附加文本说明并记录 warning。
- `usage` 必须**只取 input/output tokens**，不要把整个 `usage` 对象（含
  `input_tokens_details` / `output_tokens_details` / cached / reasoning 等
  Responses 专属 details）传给 Anthropic：
  ```ts
  usage: {
      input_tokens: Number(response.usage?.input_tokens ?? 0),
      output_tokens: Number(response.usage?.output_tokens ?? 0),
  }
  ```

### 6.2 流式 SSE

OpenAI Responses 流式事件名（节选必备）：

| 事件 | 含义 |
| --- | --- |
| `response.created` | 响应开始。 |
| `response.in_progress` | 进行中（不输出 Anthropic 事件，仅日志）。 |
| `response.output_item.added` | 新增 output 项（message / function_call）。 |
| `response.content_part.added` | 新增 content part（output_text 等）。 |
| `response.output_text.delta` | 文本增量。 |
| `response.output_text.done` | 文本部分结束。 |
| `response.output_text.annotation.added` | 文本注解（默认忽略；可记录 Debug）。 |
| `response.refusal.delta` / `response.refusal.done` | 拒绝消息（转为 text delta + done）。 |
| `response.reasoning_text.delta` / `response.reasoning_text.done` | 推理过程（默认仅 Debug，不转 Anthropic）。 |
| `response.function_call_arguments.delta` | function_call.arguments 增量。 |
| `response.function_call_arguments.done` | function_call.arguments 完成。 |
| `response.output_item.done` | output 项结束。 |
| `response.completed` | 响应完成（含 usage / status / incomplete_details）。 |
| `response.incomplete` | 响应未完成（含 incomplete_details.reason）。 |
| `response.failed` | 响应失败（已开始时关闭 blocks 后 error/message_stop；未开始时返回 JSON error）。 |
| `response.error` / 顶层 `error` | 错误事件，见 §6.3。 |

> **关于事件字段**：Responses SSE 事件中的 `output_index` 是**事件顶层字段**
> （`event.output_index`），不是 `item.output_index`。`content_part` 与
> `output_text` 相关事件还会带 `content_index`。状态机必须按
> `output_index` 与 `content_index` 联合定位 Anthropic content block。

转换状态机字段：

```ts
/**
 * 流式中尚未关闭的某个 function_call 累积状态。
 */
interface PendingFunctionCall {
    /** Anthropic 分配的 block index */
    blockIndex: number;
    /** 工具调用配对 id，即 Responses function_call.call_id */
    callId: string;
    /** Responses output item id，仅用于 fallback / 日志 */
    itemId?: string;
    /** 工具名 */
    name: string;
    /** 累积的 arguments JSON 字符串 */
    argumentsJson: string;
    /** 是否已发出 content_block_start */
    started: boolean;
    /** 是否已关闭 */
    closed: boolean;
}

/**
 * OpenAI Responses SSE → Anthropic SSE 的整体转换状态。
 */
interface OpenAIResponsesToAnthropicState {
    messageId: string;             // 'msg_' + resp.id
    model: string;
    messageStartEmitted: boolean;
    nextBlockIndex: number;

    /** output_index -> Anthropic content_block index（用于 output_item.done 兜底定位） */
    outputItemToBlock: Map<number, number>;
    /** Responses output item id -> Anthropic content_block index（按 item_id 索引时使用） */
    itemIdToBlock: Map<string, number>;
    /** `${output_index}:${content_index}` -> Anthropic content_block index（文本 part 必须用） */
    contentPartToBlock: Map<string, number>;

    /** 仍处于打开状态的 Anthropic content_block index */
    openBlocks: Set<number>;

    /** Anthropic block index -> 'text' | 'tool_use' */
    blockType: Map<number, 'text' | 'tool_use'>;
    /** function_call output_index -> PendingFunctionCall */
    functionCalls: Map<number, PendingFunctionCall>;

    promptTokens: number;
    completionTokens: number;
    stopReason?: string;
    sawFunctionCall: boolean;
    finished: boolean;
}
```

事件映射规则：

1. **`response.created`**：发出 Anthropic `message_start`：
   ```json
   { "type":"message_start", "message":{ "id":"msg_<resp.id>", "type":"message",
     "role":"assistant", "model":"<modelId>", "content":[],
     "stop_reason":null, "stop_sequence":null,
     "usage":{ "input_tokens":0, "output_tokens":0 } } }
   ```
2. **`response.in_progress`**：不输出 Anthropic 事件，仅日志。
3. **`response.output_item.added`**：
   - 取 `outputIndex = Number(event.output_index)`，**绝不**使用
     `item.output_index`。
   - `item.type === 'message'`：等 `content_part.added` 再发块；**自身不发**
     `content_block_start`。
   - `item.type === 'function_call'`：
     - 分配 `blockIndex = state.nextBlockIndex++`。
     - 记录映射：
       - `outputItemToBlock.set(outputIndex, blockIndex)`
       - 若 `item.id` 存在：`itemIdToBlock.set(item.id, blockIndex)`
     - 计算 `callId`：优先 `item.call_id`，缺失才 fallback 到 `item.id` 并
       记录 warning（见 §5.2.x）。
     - 记录 `functionCalls.set(outputIndex, { blockIndex, callId, itemId:item.id,
       name:item.name, argumentsJson:'', started:false, closed:false })`。
     - 发 `content_block_start { index:blockIndex,
       content_block:{ type:'tool_use', id:callId, name, input:{} } }`，
       置 `started=true`，`openBlocks.add(blockIndex)`，
       `blockType.set(blockIndex, 'tool_use')`，`sawFunctionCall=true`。
4. **`response.content_part.added`**（`part.type === 'output_text'`）：
   - 取 `outputIndex = Number(event.output_index)`，
     `contentIndex = Number(event.content_index)`。
   - 分配 `blockIndex = state.nextBlockIndex++`。
   - `contentPartToBlock.set(`${outputIndex}:${contentIndex}`, blockIndex)`。
   - 若 `outputItemToBlock` 尚未记录该 outputIndex，也同步记录一份（用于
     `output_item.done` 兜底）。
   - 发 `content_block_start { index, content_block:{ type:'text', text:'' } }`，
     `openBlocks.add(blockIndex)`，`blockType.set(blockIndex, 'text')`。
5. **`response.output_text.delta`** / **`response.output_text.done`**：
   - 用 `${event.output_index}:${event.content_index}` 在 `contentPartToBlock`
     找到 `blockIndex`。
   - delta：发 `content_block_delta { index, delta:{ type:'text_delta',
     text:<event.delta> } }`。
   - done：发 `content_block_stop { index }`，`openBlocks.delete(blockIndex)`。
6. **`response.refusal.delta`** / **`response.refusal.done`**：
   - 与文本 delta/done 同样处理（输出为 `text_delta`），用于把 refusal 文本
     转给 Claude Code。
7. **`response.reasoning_text.delta`** / **`response.reasoning_text.done`**：
   - 默认**忽略**，不输出 Anthropic 事件；如开启 debug，写入 Debug。
8. **`response.output_text.annotation.added`**：默认忽略，仅写 Debug。
9. **`response.function_call_arguments.delta`** / **`response.function_call_arguments.done`**：
   - 通过 `event.output_index` 或 `event.item_id` 找回 `PendingFunctionCall`：
     - 优先 `functionCalls.get(Number(event.output_index))`；
     - 缺失则尝试 `itemIdToBlock.get(event.item_id)` 反查。
   - delta：累积 `argumentsJson += event.delta`，发
     `content_block_delta { index:blockIndex, delta:{ type:'input_json_delta',
     partial_json:<event.delta> } }`。
   - done：发 `content_block_stop { index }`，`closed=true`，
     `openBlocks.delete(blockIndex)`。
10. **`response.output_item.done`**：
    - 仅兜底关闭该 output item 下**尚未关闭**的 block：
      - 通过 `outputItemToBlock` 找 blockIndex；
      - 若 `openBlocks.has(blockIndex)` 才发 `content_block_stop`，
        **绝不**重复关闭已关闭 block。
11. **`response.completed`**：
    - 提取 `usage.input_tokens` / `usage.output_tokens`（**不要**整体复用 usage 对象）；
      `status`、`incomplete_details.reason`。
    - 关闭所有 `openBlocks`（按 index 升序发 `content_block_stop`，做最终兜底）。
    - 计算 `stop_reason`：
      - `sawFunctionCall` → `tool_use`；
      - `incomplete_details.reason==='max_output_tokens'` → `max_tokens`；
      - `incomplete_details.reason==='content_filter'` → `end_turn`；
      - `status==='completed'` → `end_turn`；
      - 其他 → `end_turn` + warning。
    - 发 `message_delta { delta:{ stop_reason:<map>, stop_sequence:null },
      usage:{ output_tokens:<completion> } }`，再发 `message_stop`。
12. **`response.incomplete`**：
    - 与 `response.completed` 相同流程，但 `stop_reason` 优先按
      `incomplete_details.reason` 推导。
13. **`response.failed`** / **`response.error`** / 顶层 `error`：见 §6.3。

### 6.3 错误处理

非 SSE / HTTP 错误：按状态码映射 Anthropic `error.type`：

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

流式事件类错误：

| 上游事件 / 情形 | 处理 |
| --- | --- |
| `response.failed` | 未发 `message_start` → 返回 Anthropic JSON error；已发 → 关闭所有 `openBlocks`，发 `message_delta { stop_reason:'end_turn', ... }`，再发 `event: error` + `message_stop`。 |
| `response.incomplete` | 走 §6.2 规则 12，按 `incomplete_details.reason` 映射 stop_reason。 |
| `response.error` | 与 `response.failed` 类似：未开始 → JSON error；已开始 → 兜底关闭 + `event: error` + `message_stop`。 |
| 顶层 `error`（非 `response.*`） | 同上。 |
| 上游中途断流 | 关闭所有 `openBlocks` 与 pending function_call；发 `message_delta { stop_reason:'end_turn', ... }` + `event: error` + `message_stop`，避免 Claude Code SSE 状态机停在"block 仍打开"。 |

所有错误均不阻止 `interceptAnthropicResponse` 后续判定（是否需要触发自动续推
或清理 workflow 状态）。

## 7. 任务流注入与本地拦截（与 Chat 方案一致）

- **请求注入**：在协议转换**之前**按 Anthropic 协议调用
  `injectLlsTaskRequestBody`（详见 §10.x：该函数当前为
  `anthropicProxy.ts` 私有函数，必须先抽到 `src/relay/taskRequestInjection.ts`）。
- **响应拦截**：详见 §7.x。

### 7.x 流式拦截与实时性约束

现有 `interceptAnthropicResponse` 是整段响应**后处理**函数，**不能**在已经
写出 SSE chunk 后再改写 workflow tool_use。因此 Responses adapter 必须区分：

#### 场景 A：普通无任务流命中（默认实时流式）

1. Responses SSE 事件到达后立即由 `OpenAIResponsesToAnthropicStreamConverter`
   转换为 Anthropic SSE 并**实时**写给客户端。
2. 同时 tee 一份完整 Anthropic SSE 文本到内存 buffer，仅用于 Debug 与可能的
   fallback。
3. 上游流结束后，把 buffered Anthropic SSE 文本传入
   `interceptAnthropicResponse`：
   - 未识别到本地 workflow tool（最常见路径）：直接 `DebugRecorder.record`。
   - 识别到 workflow tool（理论上不应在此场景出现）：SSE 已发完无法回滚，
     记录 warning，依赖下一轮自动续推补偿。

#### 场景 B：任务流可能命中（增量式拦截，推荐实现）

触发条件与 Chat 方案完全一致：

- `LlsTaskService.hasActiveWorkflow()` 为真；
- 或 `LlsTaskService.hasPendingWorkflowCreation()` 为真；
- 或 `LlsTaskService.shouldForceWorkflowUpdateTool()` 为真。

实现方式（**优先级 1：增量式 Anthropic SSE Transform**）：

- 共用 Chat 方案的 `LlsTaskStreamingInterceptor`：因为输入侧已经是 Anthropic
  SSE 文本，与上游协议无关。
- 串联管道：
  ```
  上游 Responses SSE
    → OpenAIResponsesToAnthropicStreamConverter
      → LlsTaskStreamingInterceptor
        → Claude Code (Anthropic SSE)
  ```
- 在 `content_block_stop` 时本地执行 `create_llsccai_task_workflow` /
  `update_llsccai_task_workflow`，并把该 block 改写成 `text`。

实现方式（**优先级 2：缓冲降级**，可作为临时实现）：

- 把上游 SSE 完全缓冲为 Anthropic SSE 文本后整段交给
  `interceptAnthropicResponse`，再一次性写给客户端。

#### 验收必须分别覆盖

- 场景 A：普通流式文本逐字输出，无卡顿。
- 场景 A：普通流式 `function_call` 能被 Claude Code 正常接收并执行。
- 场景 B：`create_llsccai_task_workflow` 命中时不向 Claude Code 暴露原始
  workflow tool_use。
- 场景 B：`update_llsccai_task_workflow` 命中时本地回写，下一轮自动续推正常触发。
- 场景 B：`workflowUpdateMissing` 强制 `tool_choice` 在下一轮 Responses
  `function_call` 中命中并被本地拦截。

## 8. Debug 日志（必须保持 Anthropic messages 去重语义）

现有 `DebugRecorder.extractRequestMessages` 只读取 `requestBody.messages`。
Responses 转换后请求体顶层字段是 `input`，**没有** `messages`。如果把
`requestBody` 写为 Responses 格式，会导致：

- `messages.length === 0`
- 日志直接跳过写入
- 违反"`.LLSOAI/YYYY-MM-DD.json` 按天去重 messages"的既有语义

因此约定（与 Chat 方案完全一致）：

- `DebugRecorder.record(entry).requestBody` 必须传入**已重写 model、已完成
  任务流注入、但尚未转换为 Responses** 的 Anthropic 请求体。
- 上游实际载荷保存到新增字段 `upstreamRequestBody`：
  ```ts
  /**
   * Debug 落盘所需的一条记录。
   */
  interface DebugRecordEntry {
      /** 已注入任务流、未做协议转换的 Anthropic 请求体（用于 messages 去重）。 */
      requestBody: string;
      /** 实际发送给上游的 Responses 请求体（仅排查用，不参与去重）。 */
      upstreamRequestBody?: string;
      /** 转换回 Anthropic 形态后的最终响应体。 */
      responseBody: string;
      /** 上游原始 Responses 响应体（仅排查用）。 */
      upstreamResponseBody?: string;
      // ...其余既有字段
  }
  ```
- 验收标准：`.LLSOAI/YYYY-MM-DD.json` 始终能看到 Anthropic messages；
  Responses input payload 仅在新增 debug 字段中可见。

## 9. 配置层改动

- `ProviderConfig.apiType === 'v1-response'` 由本方案承接。
- `src/relay/router.ts` 已通过 `adapters: UpstreamAdapter[]` 注入 `adapterMap`，
  **不需要**在 router 内硬编码 if/switch。接入方式是在创建 router/server 处
  注册：
  ```ts
  const adapters: UpstreamAdapter[] = [
      anthropicProxyAdapter,
      openaiChatProxyAdapter,        // Chat 方案
      openaiResponsesProxyAdapter,   // 本方案
  ];
  ```
- 配置联动需要检查：
  - `package.json` 中 `apiType` 枚举或默认 provider 示例。
  - `ConfigView` / `SettingsView` 中 `apiType` 显示与校验。
  - `src/modelFetcher.ts` 对 `v1-response` 的模型列表端点是否仍追加
    `/v1/models`，需与"转发路径不追加 `/v1`"的文案区分清楚（转发与模型列表
    共用同一 `baseUrl`，由用户决定是否含 `/v1`）。

## 10. 关键边界条件

| 场景 | 处理 |
| --- | --- |
| `instructions` 为空 | 不传该字段。 |
| `input` 中混排 `function_call` 与 `function_call_output` | 严格按 Anthropic 原始顺序追加，保证 tool_use ↔ tool_result 配对；`call_id` 取 Anthropic `tool_use.id`。 |
| 同一 assistant 消息有多 `tool_use` | 拆成多条 `function_call`，`call_id` 等于 Anthropic `tool_use.id`。 |
| `tool_result` 含图像 | Responses 的 `function_call_output.output` 是字符串；图像降级为 `[image omitted in tool result: <media_type>]` 占位文本并记录 warning。 |
| 任务流强制 `tool_choice` | 转换为 Responses 风格 `{ type:'function', name:'update_llsccai_task_workflow' }`（**无** `function:{name}` 嵌套）。 |
| 上游不发 `usage` | `message_delta.usage.output_tokens` 设为 `0`，**不**用 delta 字符长度估算。 |
| Anthropic `thinking` / `redacted_thinking` | 默认忽略，仅写 Debug。 |
| Anthropic `server_tool_use` / `web_search_tool_result` / `computer_use` | 转 `input_text:'[unsupported block: <type>]'` + warning，不转 Responses tool。 |
| Responses `reasoning_text` / `annotation` 事件 | 默认忽略，仅写 Debug；如需展示由 provider 配置控制。 |
| Responses `refusal.delta` | 转为 Anthropic `text_delta`（拒绝信息直接呈现给用户）。 |
| `output_index` 来源 | 必须使用事件**顶层** `event.output_index`，禁止用 `item.output_index`。 |
| 同一 output item 多 content part | 必须按 `${output_index}:${content_index}` 维护映射，避免互相覆盖。 |
| `function_call.id` vs `call_id` | `tool_use.id = call_id`；`id` 仅作 Responses output item id，缺 `call_id` 才 fallback 到 `id`。 |
| `baseUrl` 末尾带 `/` 或含 query | 用 `joinUpstreamUrl` 安全拼接。 |
| `baseUrl` 包含 `/v1` | 直接拼，扩展不再自行追加 `/v1`，最终上游路径形如 `<baseUrl>/responses`。 |
| 未知 Responses 字段 | 默认不生成；provider 配置启用的才白名单透传。 |

### 10.x 与现有代码的落地改造（前置）

与 Chat 方案共用同一组前置改造（仅做一次）：

- `src/relay/taskRequestInjection.ts`：
  - 导出 `injectLlsTaskRequestBody`、`appendSystemRule`、`mergeAnthropicTools`、
    `filterAnthropicToolsByName`、`stripLlsTaskControlMessages`、
    `forceLlsTaskUpdateToolChoice` 等任务流注入函数。
  - 保留 `workflowCreationPending`、`workflowUpdateMissing`、强制
    `tool_choice={ type:'tool', name:'update_llsccai_task_workflow' }` 等逻辑。
- `src/relay/openAIHeaders.ts`：
  - `buildOpenAIForwardHeaders(provider, incomingHeaders)`。
  - `applyOpenAIAuthHeaders` 仅生成 `Authorization: Bearer <key>`，**绝不**
    自动添加 `anthropic-version` 或 `x-api-key`。
- `joinUpstreamUrl(baseUrl, path)`：用 `new URL()` 实现，正确处理末尾 `/`、
  含 `/v1`、含 query / hash、`baseUrl` 已含目标 path（回退记录 warning）。
- `AnthropicProxyAdapter` 同步切换到这些公共模块，单独跑一次
  `npm run typecheck && npm run compile` 验证回归。

### 10.y 协议转换单测矩阵（建议）

- system / instructions：string / `[{type:'text'}]` / 含 `cache_control` 忽略 / 空。
- user input：string / text + image(base64) / text + image(url) /
  多 tool_result 混排（多个 function_call_output）/ 含图像降级。
- assistant：text / 仅 tool_use / text + multi tool_use 顺序保证 /
  含 `thinking` 应忽略 / 含 `server_tool_use` 应降级。
- tools：含 / 不含 `input_schema` / `input_schema` 非对象。
- tool_choice：auto / any / tool(name) / none / 未设置 / 强制
  `update_llsccai_task_workflow`（`{type:'function', name}`，无 `function:{}` 嵌套）。
- id / call_id：
  - assistant tool_use 历史 → `call_id` 等于 `tool_use.id`、`id` 省略。
  - user tool_result → `function_call_output.call_id` 等于 `tool_use_id`。
  - Responses 响应 function_call → Anthropic `tool_use.id` 取 `call_id`；
    `call_id` 缺失时 fallback `id` 并 warning。
- 流式：
  - 仅文本：一个 message item，多个 content part 交错文本 delta。
  - 多 function_call 并发：`function_call_arguments.delta` 按 `output_index`
    或 `item_id` 找回；arguments 分片到达。
  - `refusal.delta` 转 Anthropic text。
  - `reasoning_text.delta` 默认忽略。
  - `response.incomplete` 与 `response.failed` 已开始 / 未开始两种状态机。
  - 上游中途断流。
- 非流式：
  - usage details 不能整体复用；只取 input_tokens/output_tokens。
  - `output[]` 顺序保留：text → tool_use → text 混排。
  - `function_call.arguments` 非法 JSON。
- 错误：401 / 429 / 500 / 自定义 4xx；message 已脱敏。
- 任务流：场景 A 普通流；场景 B 命中 workflow 工具被本地拦截；
  `workflowUpdateMissing` 强制 tool_choice 下一轮命中。

## 11. 实施步骤（建议顺序）

0. **前置抽取（必须先做）**：按 §10.x 把 `injectLlsTaskRequestBody` 等任务流
  注入函数和 OpenAI 鉴权 header 构建抽到 `src/relay/taskRequestInjection.ts`
  与 `src/relay/openAIHeaders.ts`；`AnthropicProxyAdapter` 同步切换到这些
  公共模块；先跑一次 `npm run typecheck && npm run compile` 确认无回归。
1. 新增 `src/relay/converters/anthropicToOpenAIResponses.ts`：纯函数，配单测
  覆盖 §10.y 列出的 text / image / tool_use / tool_result / tool_choice /
  instructions / id-call_id / usage details / unknown block 等场景。
2. 新增 `src/relay/converters/openAIResponsesToAnthropic.ts`：
   - `convertResponsesJsonToAnthropic(json)`
   - `OpenAIResponsesToAnthropicStreamConverter`：`feed(rawSseChunk)` 输出
    Anthropic SSE 文本；严格按 §6.2 状态机实现 `output_index`、
    `content_index`、`call_id`、`openBlocks`、`functionCalls` 等映射。
3. 新增 `src/relay/openaiResponsesProxy.ts`：`UpstreamAdapter` 实现，
  从公共模块 import `injectLlsTaskRequestBody`、`buildOpenAIForwardHeaders`、
  `joinUpstreamUrl` 等；请求先完成 Anthropic 形态任务流注入，再转换为
  Responses 请求；Debug 的 `requestBody` 保持 Anthropic 形态，
  `upstreamRequestBody` 记录 Responses 实际载荷。
4. 响应链路按 §7.x 区分场景 A / B：
  - 场景 A：实时流式转换 + tee Debug。
  - 场景 B：共用 `LlsTaskStreamingInterceptor`，或临时降级为缓冲完整 SSE
    后调用 `interceptAnthropicResponse`。
5. 扩展启动处注册 `openaiResponsesProxyAdapter` 到 router 的 `adapters` 数组；
  router 本身无需新增硬编码 switch 分支（除非现有启动结构没有 adapter 注入点）。
6. 检查配置/UI/modelFetcher 联动：`package.json` apiType 枚举、ConfigView /
  SettingsView 展示、模型列表路径与“转发路径不追加 `/v1`”文案是否一致。
7. 运行 `npm run typecheck && npm run compile`。
8. 用本地伪上游或真实 Responses 兼容服务按 §10.y 矩阵验证：
   - 非流式文本应答。
   - 流式文本应答。
  - 流式 function_call 应答（含多 function_call、arguments 分片、`call_id`
    fallback、多个 content part）。
  - `response.incomplete` / `response.failed` / 顶层 `error` / 上游断流。
  - `@llsccai-task` 创建/更新 workflow 全链路（场景 B 增量拦截或缓冲降级）。

## 12. 验收清单

- [ ] `apiType=v1-response` 的 provider 能完成 Claude Code 一次普通对话。
- [ ] **场景 A**：普通无任务流命中时，流式响应在 Claude Code 中逐字输出，
  无吞字、无卡顿。
- [ ] **场景 A**：普通流式 `function_call`（含 arguments 分片、多个
  function_call、多 content part）能被 Claude Code 正常接收并执行。
- [ ] **场景 B**：`@llsccai-task` 触发后能通过 OpenAI Responses 的
  `function_call` 完成 workflow 创建，**不**向 Claude Code 暴露原始
  `create_llsccai_task_workflow` tool_use，状态栏正常更新，自动续推工作。
- [ ] **场景 B**：`update_llsccai_task_workflow` 在 Responses 协议下被本地
  拦截，状态栏进度同步更新；`workflowUpdateMissing` 缺失补偿轮强制
  `tool_choice={ type:'function', name:'update_llsccai_task_workflow' }` 后
  下一轮正常命中。
- [ ] `.LLSOAI/YYYY-MM-DD.json` 中能看到去重后的**Anthropic 形态** messages，
  不是 Responses `input` 形态。
- [ ] Debug 扩展字段中能按需查看 `upstreamRequestBody` / `upstreamResponseBody`，
  且不影响现有 messages 去重。
- [ ] 上游 URL 始终是 `{baseUrl}/responses`，**扩展不会自行追加 `/v1`**。
- [ ] 鉴权头使用 `Authorization: Bearer <key>`，**不**自动添加 `x-api-key` 或
  `anthropic-version`。
- [ ] Responses `function_call.call_id` 与 Anthropic `tool_use.id` 配对正确；
  `function_call.id` 仅作 output item id，缺 `call_id` 时才 fallback 并记录 warning。
- [ ] Responses SSE 使用事件顶层 `event.output_index`，文本 part 使用
  `${output_index}:${content_index}` 映射，不会重复关闭 block。
- [ ] `response.incomplete` / `response.failed` / `response.error` / 顶层 `error` /
  上游断流都能按 §6.3 返回完整 Anthropic SSE 或 JSON error，message 已脱敏。
- [ ] usage 只映射 `input_tokens` / `output_tokens`；不整体复用 Responses
  usage details；缺失 usage 时 `output_tokens=0`，不伪造估值。
