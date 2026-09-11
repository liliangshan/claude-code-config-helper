# CLI 请求失败与通用自动恢复实施方案

## 1. 目标与范围

无论普通聊天还是任务流，都由同一恢复机制处理临时 API 错误、CLI 重试耗尽，以及明确的 CLI 到内部网关请求停滞。

本文仅为待实施方案，本次不修改功能代码。下文标注“新增”的接口和方法均为规划名称，不代表已经存在。

- `System · api_retry` 表示 CLI 正在重试，不代表成功，也不是立即发送 Continue 的指令。
- CLI 原生重试优先；扩展仅在最终失败或确认重试卡死后接管。
- 保留已执行工具及历史记录，不回退整轮，不假设超时意味着上游未收到请求。
- 不以任务流是否存在作为恢复条件。

## 2. 已确认的恢复策略

### 2.1 次数和退避

扩展最多额外恢复 **5 次**，不包含 CLI 自身重试次数。

| 扩展恢复次数 | 本次失败后等待 |
|---|---|
| 1 | 120 秒（2 分钟） |
| 2 | 300 秒（5 分钟） |
| 3 | 600 秒（10 分钟） |
| 4 | 900 秒（15 分钟） |
| 5 | 1,200 秒（20 分钟） |

- 每次从上一轮明确失败后开始等待，不是相对首次失败的绝对时刻。
- 若服务器提供有效 `Retry-After`，实际等待取上述间隔与服务器等待时间的较大值。
- 同一逻辑回合及其恢复请求共用一个计数。收到 `api_retry`、网关命中、HTTP 200、零散文本或工具事件均不清零；只有 CLI 最终成功结束才清零，防止反复部分成功造成无限恢复。
- 第 5 次恢复仍失败后进入耗尽状态，不再自动发送；展示手动重试入口。
- 失败信息不足以安全分类时，不自动重试，保留错误并提供手动操作。

### 2.2 可恢复与不可恢复

| 错误或状态 | 自动行为 |
|---|---|
| CLI 明确报告正在重试 | 等待原生重试，不额外提交 |
| 408、500、502、503、504、529 等临时服务故障 | CLI 最终失败后按退避恢复 |
| 连接拒绝、连接重置、连接超时、首字节超时、流空闲超时 | 根据失败位置分类，原生重试结束后恢复 |
| DNS 临时失败（例如 EAI_AGAIN） | 可恢复；永久域名配置错误不盲目重试 |
| 429 请求限速 | 遵守 Retry-After；额度不足、余额不足、配额耗尽不自动恢复 |
| 401、403、无效参数、模型不存在、上下文超限、证书配置错误 | 不自动恢复，提示处理配置或输入 |
| 用户停止、切换/清空会话、发送新消息、手动重启、扩展退出 | 取消旧恢复任务 |
| 压缩、权限确认、AskUserQuestion、本地工具执行中 | 不因没有 HTTP 请求判为卡死；等待或暂停计时 |

`attempt`、`max_retries` 只用于展示与辅助判断，不能仅凭最后一个 attempt 提前发送；最后一次原生重试可能还在执行。错误分类优先使用结构化状态、错误码及来源，不仅匹配 UI 文案。

### 2.3 区分两段故障

1. **CLI → 内部网关**：仅在明确等待模型请求时观察网关命中。若 CLI 提供重试等待时长，应在该时长结束后再计算 120 秒未命中窗口；字段缺失时不能猜测 CLI 已耗尽重试，应等待终止事件，或以网关健康检查和进程状态进一步确认故障。
2. **内部网关 → 上游**：网关已接收请求后，使用现有首字节/流空闲超时机制。上游超时不是本地网关损坏，不重启网关。
3. 网关健康而 CLI 确认停滞：优先恢复 CLI；网关监听异常：重启网关，再使 CLI 使用新端口。
4. 停滞时如原 CLI 回合尚未结束，必须先中断旧回合并确认结束；无法确认时终止旧进程并恢复原会话，禁止新旧回合并发。
5. 超时不能证明上游没有收到请求；恢复可能产生额外模型费用，不能承诺外部副作用 exactly-once。

## 3. 当前代码与缺口

- `src/chat/cli/cliAdapter.ts`：`parseSystemGenericEvent()` 将 api_retry 仅转换为卡片；`buildSystemEventSegment()` 固定标为 success，容易误解；`parseResultEvent()` 没有向上层保留完整失败标记。
- `src/chatRuntime/selfHealing.ts`：`armHttpExpectation()` 建立 120 秒网关未命中计时，`clearHttpExpectation()` 命中即删除 prompt；`healRelayAndCli()` 默认重启两者，不区分上游故障和本地故障，也没有统一的五次上限。
- `src/chatRuntime/chatMessaging.ts`：`handleUpstreamTimeoutAutoContinue()` 在上游超时时直接发送 Continue，没有等待 CLI 原生重试终止。
- `src/activation/relayWiring.ts`：`setupRelayPipeline()` 将网关命中、上游超时分别接入上述独立机制。
- `src/llsTask/autoContinue.ts`：任务流定时器独立运行，需要与通用恢复互斥。
- `src/relay/openaiResponsesProxy.ts`：`buildInlineResponsesJsonError()` 使用 `source.error !== undefined` 判断错误，`error: null` 可能被误判为本地 502。此问题需要单独修正，但不能据此断言截图一定是假 502。

## 4. 状态与身份设计

新增 `RecoveryContext`：保存 generation、turnId、sessionId、cliInstanceId、route、关联 requestIds、在途请求集合、originalPrompt、deliveryState、attemptsUsed、nextRetryAt、lastFailure、原生重试次数和等待截止时间、工具/权限/压缩状态。

- 会话和 CLI 身份在提交时冻结；normal 与 taskFlow 共享进程，也共享恢复互斥域。
- 原始发送内容仅存内存；有附件时保存原始发送表示，不只保存展示文本。
- 状态：idle → awaiting_request → running/native_retry → waiting_recovery → recovering → running。
- 终止状态：succeeded、exhausted、cancelled、non_retryable。
- Relay 错误先作为证据记录，CLI 最终失败再安排恢复；同一故障的多个事件只计一次。
- 每次异步操作返回后检查 generation；旧结果不能改变新回合状态。
- 用户新消息建立新 generation；内部恢复沿用原 turnId 和额度，不重置计数。
- 取得恢复执行权时消耗一次额度；健康检查、重启或提交阶段失败也计入本次，避免准备阶段无限循环。
- 本期不持久化重试计时器；扩展停用或窗口重载后不自动恢复旧队列。

## 5. 文件和方法级实施清单

### 5.1 新增 `src/chatRuntime/requestRecovery.ts`

新增 `RequestRecoveryController`，注入时钟、发送器、进程操作、网关探测和状态通知，便于单元测试。

| 新增方法 | 职责 |
|---|---|
| `beginTurn(context)` | 保存逻辑回合和完整提交内容，取消旧恢复 |
| `onCliApiRetry(event)` | 记录原生重试，不立即提交 |
| `onRelayRequestStarted(info)` | 按身份绑定请求，解除对应未命中观察 |
| `onRelayRequestFinished(result)` | 记录故障阶段、状态码、错误码、Retry-After 和在途请求 |
| `onCliTurnFinished(result)` | 成功则结束；可恢复失败则排队；不可恢复则停止 |
| `onExpectedRequestTimeout(identity)` | 排除退避、工具、权限和压缩后判断本地停滞 |
| `classifyFailure(failure)` | 纯函数分类临时、永久、未知故障 |
| `scheduleRecovery(failure)` | 五档退避、去重、上限控制 |
| `runRecovery(generation)` | 复核归属和资格，执行健康检查、必要重启及发送 |
| `cancelRecovery(reason)` | 清理计时器、递增代数、阻止迟到发送 |
| `hasPendingRecovery()` | 提供给任务流等调度器进行互斥判断 |
| `retryManually(identity)` | 仅对当前失败回合开启新恢复周期 |
| `dispose()` | 清理全部资源 |

### 5.2 `src/chat/cli/cliAdapter.ts`

- `ParsedCliEvent`：新增结构化 `api/retry` 事件；终止事件增加 isError、subtype、errors、sessionId 等可验证信息，保留 turnFinished。
- 新增 `parseApiRetryEvent(record)`：在 `parseSystemGenericEvent()` 之前解析 api_retry；校验 attempt、max_retries、error_status、error，并保留原始诊断对象。实际等待字段名和单位须以当前 CLI 的真实 JSONL 为准，不猜造协议。
- `parseResultEvent(record)`：保留 result 的失败标记，即使正文为空也必须上报终止；不能将 error 结果当作正常成功。
- `buildSystemEventSegment(record)`：api_retry 显示为“重试中”，不再固定显示“成功”；普通系统卡片兼容原行为。

### 5.3 `src/chatRuntime/cliEventHandlers.ts`

- `handleParsedCliEvent()`：转发 api/retry 和明确的回合终止结果到恢复控制器；先完成旧回合 UI 收尾，再安排恢复。
- `case 'error'`：提供结构化错误证据；不把任意解析/工具错误当作 API 回合终止。
- `handleCliCompactStatus()`：同步压缩开始、成功和失败，恢复不得与压缩并发。
- `handleToolPermissionRequest()`：同步授权等待状态；答案处理和工具结果事件解除阻塞。
- 普通 `message_stop`、工具响应结束以及局部 done 不是整轮结束，不得单独启动恢复。

### 5.4 `src/chatRuntime/selfHealing.ts`

保留现有导出用于逐步迁移，但恢复资格、次数及定时器最终只由控制器管理。

- `armHttpExpectation()` / `clearHttpExpectation()`：改为按回合/请求身份登记和解除，不再用任意网关命中清空全局状态。
- `onHttpExpectationTimeout()`：转给控制器判断，不直接重启。
- `healRelayAndCli()`：拆分故障定位与动作，新增 `probeRelayHealth()`、`recoverCliOnly()`、`recoverRelayAndCli()`；只做批准的恢复动作，不维护第二份重试额度。
- `scheduleHealResend()`：移除独立的重发调度，改由 `runRecovery()` 统一发送；内部就绪等待不等于重新增加一次恢复机会。
- `cancelPendingResend()`：接入统一取消，异步重启后也必须再次验证 generation。
- 网关探测只访问本地健康路径，不能提交真实模型请求，也不能影响请求命中计时。健康接口若不存在，在 `src/relay/server.ts` 增加只读健康响应并覆盖测试。

### 5.5 `src/chatRuntime/chatMessaging.ts`

- `sendUserMessageToCli()`：接入所有发送入口的逻辑回合登记；新增内部 origin/turnId 参数区分用户、任务流和 recovery，恢复发送不得取消自己或重置计数。
- `appendUserMessageAndSend()` / `sendHiddenUserMessageToCli()`：传递发送来源，不创建另一套恢复计时。
- `handleUpstreamTimeoutAutoContinue()`：取消立即发送 Continue 的行为，改为只记录超时证据，等待 CLI 最终状态。
- `handleUserResend()`：先取消旧恢复；保持用户主动重发的既有行为，自动恢复不得复用其历史截断逻辑。
- 新增 `submitRecoveryMessage(context)`：确认未送达 CLI 才重发原始消息；已接收或送达不确定时，在原会话提交继续指令，并要求基于现有工具结果继续，避免重复已完成操作。
- 无法恢复原会话时停止并提示，不悄悄新建会话重放整个任务。

### 5.6 Relay 请求观测

- `src/relay/router.ts`：扩展 `RelayUpstreamRequestInfo` 与 `UpstreamRequestContext`，新增请求结果契约和上报回调；`createRelayRouter()` 传递冻结身份。`onUpstreamRequestEnd` 目前只代表 adapter 返回，不可直接视为成功。
- `src/relay/server.ts`：`setOnHit()` 的无参数全局命中不足以做归属判断。保留其日志用途，恢复改用 router 完成身份解析后的请求事件；非法请求、健康检查和其他会话不能解除当前计时。
- `src/relay/openaiResponsesProxy.ts`：请求主处理、`handleJsonResponse()`、`handleStreamResponse()` 上报连接、首字节、流空闲、HTTP、JSON 内嵌错误与中断。每个请求终态只上报一次。
- 同步 `src/relay/openaiChatProxy.ts`、`src/relay/anthropicProxy.ts` 的对应请求主处理和 JSON/SSE 分支，不能只支持 Responses。
- `buildInlineResponsesJsonError()`：排除 `error: null`，保留真实 error 或 status=failed 的转换；本地映射 502 和上游原始 HTTP 状态分别记录。
- `src/relay/usageReporter.ts` 的 usage summary 可继续承担统计，不替代故障契约：其状态不能表达全部错误码、故障位置和 Retry-After。

### 5.7 激活与生命周期

- `src/activation/relayWiring.ts` → `setupRelayPipeline()`：接入开始、结束和超时证据；删除超时立即 Continue 的接线；不得凭任意请求命中取消其他回合恢复。
- `src/activation/wiring.ts` → `configureStatelessModules()` / `configureRuntimeModules()`：注入唯一控制器和恢复动作，避免循环依赖。
- `src/chatRuntime/cliLifecycle.ts` → `handleChatCliExit()`：区分用户停止、恢复内部重启和异常退出。用户停止取消恢复；内部重启保持恢复上下文；异常退出按故障类型处理。
- `restartChatCli()` / `restartChatRelayAndCli()`：增加内部调用原因和身份参数；区分用户手动操作与控制器执行动作，防止内部重启取消自己。
- `src/activation/shutdown.ts`：在现有关闭流程调用控制器 `dispose()`，停止后不得再发送。

### 5.8 任务流互斥

`src/llsTask/autoContinue.ts`：

- `schedule()` / `scheduleAfterWorkflowTool()` / `armIdleWatchdog()`：当共享 CLI 正处于原生重试、等待恢复或恢复执行中，不提交重复续推；保留需要继续的意图。
- `runIfCurrent()`：提交前和 beforeSubmit 异步返回后都检查版本、工作流有效性及恢复互斥。
- 新增 `resumeAfterRecovery()`：恢复成功后重新判断是否有未完成任务；已有正常续推事件则合并，不能补发重复提示。
- 恢复耗尽或不可恢复时，任务流不能绕开上限继续自动发送。用户新操作才解除该暂停。
- 任务流工具缺失熔断与 API 恢复次数独立计数；API 错误不能冒充“模型未调用工具”。

### 5.9 Webview 协议和界面

- `src/chat/protocol.ts`：新增 `request/recovery` 状态消息及 `request/retry` 手动操作；携带 turnId、generation、状态、次数、nextRetryAt、简短原因，不携带原始 prompt。
- `src/chatRuntime/webviewMessages.ts` → `handleChatWebviewMessage()`：处理手动重试并验证身份。user/send、user/cancel、session/clear、session/resume 取消旧恢复；所有实际会话切换入口同样处理。
- `media/chat/main.js` → `handleExtensionMessage()`：接收恢复状态；新增 `updateRequestRecoveryStatus()`、`renderRequestRecoveryStatus()`，按回合原地更新，不清空聊天列表，不强制滚动。
- 展示：“CLI 正在重试”“请求失败，2 分钟后自动恢复（1/5）”“正在恢复”“自动恢复已达 5 次”，耗尽后提供“重试”操作。
- 倒计时仅在前端按 nextRetryAt 更新展示，不驱动发送。语言切换保留状态；扩展重载后旧历史提示不恢复倒计时或队列。
- `media/chat/style.css`：添加紧凑状态行和按钮，支持窄侧栏；七种现有语言同步文案。

## 6. 日志与排查依据

使用统一 `[request-recovery]` 前缀，只记录状态变化，不逐秒输出倒计时。

关键字段：sessionId、turnId、cliInstanceId、requestId、generation、failureStage、upstreamStatus、mappedStatus、errorCode、nativeAttempt、extensionAttempt、delayMs、nextRetryAt、cancelReason。

故障阶段至少区分：cli_to_relay、upstream_connect、upstream_first_byte、upstream_stream、upstream_http、upstream_inline_error。不能仅凭 `127.0.0.1` 地址或“502”文案认定故障发生位置。

实施前采集真实 api_retry 和最终 result JSONL，确认等待字段、错误字段及单位；记录关联 Relay 请求的上游原始响应，验证是否为超时或 error:null 误判。测试夹具只使用合成数据，不把实际用户内容纳入仓库。

## 7. 测试和验收

### 7.1 单元测试

新增 `src/chatRuntime/__tests__/requestRecovery.test.ts`，使用虚拟时钟和注入动作，覆盖：

1. 严格按 120/300/600/900/1200 秒恢复，第五次失败后无第六次；不真实等待 52 分钟。
2. CLI api_retry 只登记状态；最后一次 attempt 尚未终止不能提前发送。
3. 同一错误的 Relay 超时、CLI error、最终 result 不造成重复恢复。
4. 401/403/额度耗尽/上下文超限不恢复；429 临时限速遵守 Retry-After。
5. 有效服务器等待时间覆盖较短退避；非法等待值不导致立即循环。
6. 上游故障不重启本地网关；网关健康时本地停滞只恢复 CLI。
7. 新消息、停止、会话切换和卸载取消计时；健康检查或重启 await 中取消后也不发送。
8. 工具、权限、压缩或其他关联请求在途时不误判空闲，不双重提交。
9. 已执行工具的回合保留历史，只继续，不截断重跑。
10. 部分输出、HTTP 200 不清零额度；最终成功清零；内部发送不重建额度。
11. 同一 CLI 的任务流续推与恢复互斥；耗尽后任务流不得绕过上限。
12. 旧进程退出与迟到请求结果不污染新 generation。

扩展 `src/chat/__tests__/cliAdapterSystemTaskEvent.test.ts`：实际 api_retry 结构、字段缺失/非法、重试卡片状态、最终失败标记和空正文终止。

新增 `src/chatRuntime/__tests__/requestRecoveryUi.test.ts`：状态原地更新、手动重试身份校验、七语言、历史回放不复活计时器。

扩展 `src/llsTask/__tests__/autoContinueScheduling.test.ts`：恢复期间暂停、异步 beforeSubmit 后二次守卫、恢复成功后合并续推。

### 7.2 本地协议集成验证

使用本地假上游和假 CLI，分别覆盖 Anthropic、Chat Completions、Responses 的 JSON/SSE：连接失败、HTTP 502、首字节超时、流中断、429 Retry-After、最终重试耗尽与恢复成功。验证每个请求仅一次终态报告。

Responses 专项：HTTP 200 + error:null 正常响应不得转为 502；status=failed 和真实 error 保持错误行为；保留上游状态与本地映射状态的区别。

另测 CLI 没有请求到 Relay、原生退避未结束、普通聊天无任务流、任务流运行中、压缩中，以及恢复重启时保持原会话。真实 CLI E2E 尚未执行时应明确列为未验证，不能用假 CLI 测试代替声称完成。

### 7.3 执行顺序与验收要求

1. 先确认真实 CLI 事件结构并补夹具。
2. 实现纯错误分类、身份契约和五档恢复状态机。
3. 接通 CLI 与三种 Relay 协议的生命周期证据。
4. 收敛现有 selfHealing、超时 Continue、任务流续推的互斥。
5. 接通取消、进程重启和会话恢复。
6. 增加状态 UI、手动重试、多语言和回归测试。
7. 每轮只修改 2–3 个方法或代码块；新增和修改方法补齐标准注释。
8. 代码修改后先检查 VS Code MCP 诊断，再执行 TypeScript 编译、前端语法检查和 npm test。失败如实记录并修正。
9. 版本号、README、CHANGELOG、打包安装仅在用户提出发布要求时执行；本文不代表已授权实施或发布。

最终验收：普通聊天和任务流使用相同恢复条件；CLI 重试中不抢跑；扩展五次上限有效；取消后绝不迟到发送；不因上游错误重启健康网关；不删除已完成历史；UI 和日志能明确说明正在等待、恢复、暂停或耗尽。
