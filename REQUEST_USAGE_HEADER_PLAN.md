# 每次请求用量与缓存命中率直接展示实施方案

## 1. 目标与范围

在聊天内容区 `[NORMAL][模型名]` 所在标题区域直接显示本次请求全部用量，不使用鼠标悬停，不新增独立统计卡片。

展示示例：

> [NORMAL][qwen3.8-max] 未缓存输入 3,000 · 缓存读取 22,000 · 缓存写入 1,000 · 输出 842 · 缓存命中率 84.62%

窄面板允许统计内容自然换行，但仍属于同一个请求标题。使用完整整数，不采用 K/M 缩写。正常请求不折叠任何统计字段。

本文件是待实施方案，不代表界面功能已经实现。

## 2. 统计口径和生命周期

- 单位是一次 Relay 上游请求，不是一次用户消息、CLI 整轮 result 或整个会话。工具调用之后的新 HTTP 请求必须有独立记录。
- 同一请求的文字和多个工具块只共享一份标题统计。不能在每个工具块重复计费，也不能只覆盖最后一条 assistant 消息。
- 请求开始显示全部字段为 `—`；请求结束更新最终 usage。无 usage 仍显示 `—`；中断时显示“请求中断 / 用量可能不完整”，不冒充成功最终值。
- `未缓存输入`、`缓存读取`、`缓存写入`分别取归一化 Anthropic usage 的三个输入字段；`总输入 = 未缓存输入 + 缓存读取 + 缓存写入`仅作为内部计算量，不在界面展示；`缓存命中率 = 缓存读取 / 总输入 × 100%`，保留两位小数。
- 缺失字段不得默认伪装成 0。只有协议或提供商明确该字段不适用时才可按 0 参与计算；无法确认完整输入组成时，命中率显示 `—`。总输入为 0 时命中率显示 `—`。
- OpenAI 原始输入通常已包含 cached tokens，须先通过现有转换层拆分，再计算总输入，不能再次累加造成重复计算。
- CLI result 的累计 usage 仅保留原有用途，禁止写入请求级标题。估算值不能冒充真实 API 用量。
- 压缩请求只进入压缩记录及日志，不挂到普通回复标题；旁路、子智能体请求找不到归属时不猜测归属，更不能更新当前最后一条消息。

## 3. 现状及必须解决的问题

### 已有能力

- `src/relay/usageReporter.ts`：`UsageReporter.collectUsage()` 收集 usage，`flushReport()` 聚合后上报；近期增加了 `[usage]` 日志。
- 三个 proxy 为每个响应创建 `UsageReporter`，已有流式及 JSON 响应采集路径。
- `src/activation/relayWiring.ts`：`createUsageSink()` 将数据交给 `TokenBudgetService.afterRecv()`。
- `media/chat/main.js`：`assistantSourcePrefixText()`、`assistantSourcePrefixTextFromItem()`、`appendSegmentWithInlinePrefix()`、`appendSegmentWithPatchPrefix()` 控制截图中的模型来源标签。

### 当前不能直接复用的行为

1. `createUsageSink()` 在响应结束时读取当前 CLI session，并反查当前模型快照；并发、切换会话和压缩路由时可能错配。请求身份必须在请求入口固定。
2. `chatSessionState.activeAssistantMessageId` 会在流式输出及收尾期间变化，不能在 usage 到达时直接取它作为统计归属。
3. `ChatMessage` 目前没有可靠的请求级绑定。单个请求可能产生多个消息区域；同一消息区域也可能含多次请求的输出，不能假定一请求一消息。
4. 标题可能在流式 patch 中被重建；只操作 DOM 而不保存数据会导致用量消失。

## 4. 文件、类型与方法改动清单

以下“新增”名称为实施时建议使用的名称，并非当前已存在的方法。

### 4.1 `src/relay/router.ts`

修改 `UpstreamRequestContext`、`RelayUpstreamRequestInfo`、`createRelayRouter()`：

- 每个实际转发请求生成唯一 `requestId`，固定 `sessionId`、route、providerId、modelId、是否压缩及请求开始时间。
- 将这些身份信息同时传给 adapter 和请求生命周期回调。sessionId 使用实际请求可验证的身份；无法确定时显式留空，不在结束时套用别的当前会话。
- 原有 on-start/on-end 路径保持用途不变；增加请求绑定所需信息，不改变自动续推、压缩时序。

### 4.2 `src/relay/usageReporter.ts`

修改 `UsageReport`、`UsageSink`、`UsageReporter.constructor()`、`flushReport()`：

- 引入请求上下文类型 `RequestUsageContext`，保存请求开始时的身份；report 增加结束状态和字段完整性信息。
- 同一 requestId 最终报告至多一次，覆盖 JSON、正常流结束、错误、超时以及无 usage 的情况。
- 用量报告与 CLI result 完全独立；不因缺少 UI 或没有当前会话而丢失日志。
- 统一日志与 UI 的数字计算，建议新增纯函数 `normalizeRequestUsage()`，返回原始字段、总输入、命中率及完整性，不在两个位置各写一套公式。
- 保留原有 sink 调用兼容性，逐一更新调用方和 mock。

### 4.3 三种代理入口

- `src/relay/anthropicProxy.ts`：`AnthropicProxyAdapter.handle()` 内创建 `UsageReporter` 的位置。
- `src/relay/openaiChatProxy.ts`：`handleJsonResponse()`、`handleStreamResponse()`。
- `src/relay/openaiResponsesProxy.ts`：`handleJsonResponse()`、`handleStreamResponse()`。

全部传入同一份请求上下文；正常结束、超时、error、提前关闭都明确报告结束原因。已有流式 usage 提前到达时可以缓存，但最终标题状态以响应终止为准。

### 4.4 `src/activation/relayWiring.ts`

修改 `createUsageSink()` 和 `setupRelayPipeline()` 的相关装配位置：

- 不再从“当前 session + 当前模型快照”推断本次报告身份，改用 report 内固定的请求上下文。
- 一路继续调用 `TokenBudgetService.afterRecv()`，另一路调用新增的请求级 UI 存储入口。
- 缺少可信会话绑定时只记日志，不写入其他会话；压缩请求跳过普通消息标题回填。

### 4.5 `src/chat/protocol.ts`

新增 `RequestUsageSummary`（请求身份、五项 token 数、命中率、结束状态、完整性），扩展 `ChatSegment` 的请求归属信息。新增独立通知 `request/usage`，按 requestId 更新，而非复用会话级 `tokenBudget/usage`。

消息缓存需同时保存 requestId 和统计内容；旧历史缺少这些字段时照常渲染，不能根据模型名猜配。一个 ChatMessage 可含多个请求，因此不能仅添加一个会被后续覆盖的 message.usage。

### 4.6 请求与输出关联（必须先于 UI 上线）

新增 `src/chatRuntime/requestUsage.ts`：

- `registerRequest()`：登记请求身份、开始时间及 generation（当前 UI 会话代次）。
- `bindResponseMessage()`：将上游响应 message.id 关联到 requestId。
- `resolveRequestForSegment()`：按响应 ID 或工具 callId 查找归属，禁止按“最后一个请求”匹配。
- `recordRequestUsage()`：保存请求最终统计，已有 DOM 归属则推送；否则缓存等待输出到达。
- `clearRequestUsageBindings()`：切换/清空会话时清理映射，丢弃旧 generation 的迟到报告。

需要配套修改：

- `UsageReporter.collectFromAnthropicMessage()` 提取转换后下行 message.id，并通过可选身份回调登记绑定，不能只在请求结束才建立关联。
- `src/chat/cli/cliAdapter.ts` 的 `parseAnthropicStreamEvent()`、`parseSdkWrapperEvent()` 保留响应 message.id 与工具 callId 到解析事件；CLI 不保留的未知自定义字段不能作为唯一关联手段。
- `src/chatRuntime/cliEventHandlers.ts` 的 `handleParsedCliEvent()` 将响应身份附给 segments，再交给 ChatSession。
- 三类协议分别验证：Relay 下行 message.id 能否在 CLI stdout 中原样获得。若某种路径不能关联，先只保留日志；不得以时间近似绑定后宣称支持。

### 4.7 `src/chatRuntime/chatSession.ts`

修改 `appendAssistantSegments()`、`createActiveAssistantMessage()` 及消息持久化整理路径：

- 保存每个 segment 的 requestId，合并 patch 时不跨 requestId 合并内容。
- 请求统计可以先于或晚于正文到达；已有统计需在正文入库时回填，不能因活动 assistant ID 被清空丢失。
- `schedulePersistChatSession()` 持久化统计与归属；同时检查现有恢复/sanitize 是否丢弃新增字段。
- `finishActiveAssistantMessage()` 不制造请求级用量，也不重复输出请求报告。
- 内存裁剪、重发截断、会话清空/切换同步回收无引用请求映射，防止长会话无限增长。

### 4.8 `media/chat/main.js`

修改以下已有方法：

- `appendMessage()`：渲染历史/新消息时按 requestId 建立请求标题，仅第一处可见输出显示用量行。
- `appendSegmentWithInlinePrefix()`、`appendSegmentWithPatchPrefix()`：将纯模型标签扩展为请求标题容器；同一次请求的后续工具块不重复插入用量。
- `assistantSourcePrefixText()`、`assistantSourcePrefixTextFromItem()`：仍负责来源文本，不在字符串内拼未经转义的 HTML。
- `patchMessage()`：替换节点后恢复请求标题统计，保留已展开工具状态及滚动意图。
- `cachePatchedMessage()`、`handleExtensionMessage()`：处理 `request/usage` 并更新本地缓存；即使标题尚未挂载，也缓存待用。
- `rerenderMessagesFromDom()`、`session/init` 回放：从持久化请求数据恢复统计，避免语言切换或重载后消失。

建议新增方法：

- `buildRequestUsageHeader(requestId, sourceText)`：创建来源 + 五项明细容器。
- `updateRequestUsageHeader(requestId, summary)`：按 requestId 定点更新，不清空消息列表、不强制滚到底部。
- `formatRequestUsage(summary)`：按当前语言格式化完整整数，返回五项显示文案，所有动态文本使用 textContent。

固定展示顺序：未缓存输入 → 缓存读取 → 缓存写入 → 输出 → 缓存命中率。中断状态紧跟字段显示。五项都直接可见，不使用 title/tooltip 承载必要信息。

在 `chatTranslations` 的全部现有语言分支加入字段标签、未知值和中断文案，不仅支持中文。

### 4.9 `media/chat/style.css`

新增 `.requestUsageHeader`、`.requestUsageFields` 等样式：flex-wrap、合适的字段间隔、字段内部不拆开数字与名称；使用 VS Code 主题变量。窄面板自然换行，不隐藏字段，不创建横向滚动，不放大工具卡片内部滚动区。

## 5. 测试与验收

### 自动化测试

1. `src/relay/__tests__/` 新增 `requestUsageSummary.test.ts`：普通输入、缓存读取/写入、全零、缺失字段、非有限值、命中率公式、重复结束。
2. 对现有 UsageReporter 测试补充：多段 usage 合并、SSE 分片、JSON 响应、无 usage、连接错误、超时，一次请求最多一份最终报告。
3. `src/chatRuntime/__tests__/` 新增 `requestUsageBinding.test.ts`：两个并发请求倒序结束、模型切换、统计早于正文、切换会话后的迟到报告、裁剪清理。
4. `src/chat/__tests__/` 补充 CLI adapter 身份透传：message_start、SDK assistant、tool_use、tool_result 路径保持 request 归属。
5. 为三个 proxy 增加请求上下文传递和缓存归一化回归测试，确认不会重复计算 OpenAI cached tokens。

### 浏览器/实际扩展验收

- 一轮连续调用三次工具并产生四次模型请求，应有四份独立统计，不是最后一份覆盖前三份。
- 单次请求包含文字和多个工具卡片时只显示一份明细；同一消息容器内多请求仍各自有标题。
- 显示五项完整数字；窄面板全部可见，不需要鼠标悬停。
- 请求中断、无 usage、正常 0 token 可区分；压缩请求不污染普通消息统计。
- 用户上翻历史时更新用量不拉回底部、不造成消息区清空重建。
- 历史恢复、语言切换、重发截断后统计仍正确。
- 修改完成先调用 VS Code MCP 诊断，再跑 `node --check media/chat/main.js`、编译及全量测试。真实协议关联验证未完成时明确标记未验证，不仅凭单测宣布可用。

## 6. 实施批次

1. 请求身份、统计类型及统一公式，先补测试。
2. 三个 proxy 和 UsageReporter 的请求上下文、结束状态上报。
3. CLI 响应 ID 透传、requestUsage 映射与 ChatSession 持久化。
4. 前端请求标题、五项直接展示、缓存恢复及样式。
5. 并发/异常/历史验收；按用户要求再改版本、文档、打包安装。

本次仅新增方案文档，不实施以上 UI 和协议改造，不变更现有日志策略。
