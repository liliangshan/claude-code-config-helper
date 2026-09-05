# 项目全量审查报告（3.2.44 基线）

> 审查日期：2026-09-04　范围：`src/**`（约 3.0 万行 TS）、`media/chat/main.js`、`package.json` 打包与测试脚本。
> 方法：按「进程/网络生命周期 → 状态机与持久化 → 热路径性能 → 工程化」四条线做模式扫描，再逐条读源码确认。
> 只收录在代码中**核实到具体行号**的问题；纯风格问题不收录。本机桥无鉴权、cookie 明文等按既定威胁模型（只防外部机器）不视为问题。

## 一览

| # | 级别 | 位置 | 一句话 |
|---|---|---|---|
| B1 | 高 | `src/chat/cli/cliProcess.ts:647,656` | `child.killed` 语义误用，SIGKILL 兜底永远不会触发 |
| B2 | 高 | `src/chat/cli/cliProcess.ts:96-102` | stdin 无 `error` 监听，CLI 先死后写会抛未捕获 EPIPE |
| B3 | 高 | `src/relay/server.ts:198-212` | `server.close()` 不断 keep-alive/SSE 连接，`restart()` 可被挂住最长 240s |
| B4 | 高 | `src/relay/openaiChatProxy.ts` / `openaiResponsesProxy.ts` | 客户端断开不传递给上游，取消后上游继续流式计费 |
| B5 | 高 | `src/relay/debugRecorder.ts:129-158` | 每个请求全量读改写当日 JSON，无开关、O(n²) 增长 |
| B6 | 中 | `package.json` `scripts.test` | 5 个测试文件未纳入，其中 3 个已经是红的 |
| B7 | 中 | `src/activation/shutdown.ts:47-74` | 停用时看门狗定时器未清、会话落盘 fire-and-forget |
| B8 | 中 | `src/relay/debugRecorder.ts:100-121` | `error-*.json` 无上限、含完整请求体 |
| B9 | 中 | `src/relay/tokenBudget/store.ts:379-395` | `token-count.json` 会话只增不删 |
| B10 | 中 | `src/relay/anthropicProxy.ts:530` | 依赖已废弃的 `req 'aborted'` 事件 |
| O1 | 低 | `src/chatRuntime/cliLifecycle.ts:433-434` | 退出提示硬编码中文，未走 7 语言表 |
| O2 | 低 | `src/configManager.ts:119` 等 | 激活路径上的同步 fs |
| O3 | 低 | `media/chat/main.js`（5683 行）/ `cliAdapter.ts`（2367 行） | 单文件过大，无打包器、无 lint |
| O4 | 说明 | vsix 10.83 MB | 约 9 MB 是 js-tiktoken 重复分发（按当前 >10M 要求保留） |
| F1 | 已修 | `src/chat/cli/cliAdapter.ts:774,916` | 新版 CLI 的 `thinking_tokens` / `ping` 噪声事件刷进聊天区（本次已过滤） |

---

## 高优先级 Bug

### B1　`child.killed` 语义误用，SIGKILL 兜底形同虚设

- **位置**：`src/chat/cli/cliProcess.ts` `disposeRunningChild()` 第 647 行 `if (!child.killed)`，第 656 行 `if (!child.killed) child.kill('SIGTERM')`；`cancel()` 第 150 行同样用 `this.child.killed` 判断。
- **问题**：Node 的 `ChildProcess.killed` 表示「`kill()` 已成功**发送**信号」，与进程是否真的退出无关。第 656 行发完 SIGTERM 后 `killed` 立即为 `true`，1500ms 到点时第 647 行判断必然为假，注释里承诺的「追加 SIGKILL」永远不会执行。
- **失败场景**：CLI 卡在网络 IO / osascript 时收到 SIGTERM 不退出（注释里自己列的典型场景），扩展以为已清理，实际留下孤儿进程；重启 CLI 时旧进程仍占着 relay 端口对应的会话，出现「两个 CLI 同时回话」或 stdin 写到死进程（叠加 B2）。
- **修复**：在 `bindChildEvents` 的 `exit` 回调里置一个实例级 `exited` 标记（或用 `child.exitCode === null && child.signalCode === null` 判存活），把 647/656/150 三处的 `killed` 改为该标记。

### B2　stdin 没有 `error` 监听，写入已退出的 CLI 会抛未捕获异常

- **位置**：`src/chat/cli/cliProcess.ts:96-102` `send()`；`bindChildEvents()` 只挂了 `child.on('error')` / `child.on('exit')`，全文件没有 `stdin.on('error')`。
- **问题**：`send()` 前置检查只看 `killed` 和 `stdin.writable`。CLI 刚崩溃、`exit` 事件还没派发的窗口内两者都通过，`stdin.write` 异步抛出 `EPIPE`，走的是 stream 的 `'error'` 事件；没有监听器时 Node 会把它当未捕获异常抛到扩展宿主。
- **失败场景**：任务流自动续推恰好撞上 CLI 异常退出，扩展宿主报「Extension host terminated unexpectedly」或整个扩展进入 error 状态，比单纯「CLI 退出」严重得多。
- **修复**：`bindChildEvents` 里加 `child.stdin.on('error', err => Logger.warn(...))`；`send()` 用回调形式 `stdin.write(line, cb)` 把错误转成 Promise reject 交给上层（`sendUserMessage` 已是 async）。

### B3　`RelayServer.stop()` 不断活动连接，重启链路可被挂住

- **位置**：`src/relay/server.ts:198-212`，`dispose()` 236 行同样只 `server.close()`。
- **问题**：`http.Server.close()` 只停止 accept，会等所有 keep-alive 连接与进行中的响应自然结束。Relay 的典型负载就是长 SSE 流（空闲超时 240s，`upstreamTimeouts.ts:23`），`stop()` 的 Promise 要等这些流全部结束才 resolve。
- **失败场景**：`selfHealing` 的「重启 HTTP+CLI」正是在上游卡死时触发，此时恰好有挂着的 SSE 流，`restart()` 在 `await this.stop()` 处阻塞到 240s；用户看到状态栏一直 `starting`，CLI 也拿不到新端口。
- **修复**：`stop()` 里 `server.close(cb)` 之后立刻 `server.closeAllConnections()`（VS Code 1.94 内置 Node 20，API 可用）；`dispose()` 同样处理。

### B4　OpenAI 两个代理不把客户端断开传给上游

- **位置**：`src/relay/openaiChatProxy.ts:185-252`、`src/relay/openaiResponsesProxy.ts:182-250` 的 `transport.request(...)` 段；全仓只有 `anthropicProxy.ts:530` 挂了 `req.on('aborted')`。
- **问题**：用户点停止 → CLI 收 SIGINT 断开对 relay 的连接 → relay 侧 `res` 已不可写，但 `upstreamReq` 无人销毁，上游继续推流直到 `[DONE]` 或 240s 空闲超时。
- **失败场景**：长回答中途取消，上游仍按完整输出计费；同时 `routeState` 的 busy 计数要等上游结束才归零，Chat 面板「执行中」状态滞后数十秒，这段时间新消息会被判定为并发。
- **修复**：三个代理统一在拿到 `upstreamReq` 后挂 `ctx.res.on('close', () => { if (!ctx.res.writableFinished) upstreamReq.destroy(); })`，并抽到 `forwardHeadersCommon.ts` 旁边的公共 helper。

### B5　`DebugRecorder.record` 无条件对每个请求做全文件读改写

- **位置**：`src/relay/debugRecorder.ts:129-158`；`src/activation/relayWiring.ts:159` 无任何开关直接 `new DebugRecorder()`，三个代理每次转发后都 `await this.safeRecord(...)`。
- **问题**：每个请求：读当日 `.LLSOAI/yyyy-MM-dd.json` → `JSON.parse` → 对已有每条 message 做 `stableStringify`（递归排序）建去重集合 → 再整文件 `JSON.stringify(…, null, 2)` 写回。文件随当天累计 messages 线性增长，单次代价随之线性上涨，一天内总 IO 为 O(n²)；messages 里含 base64 图片时单文件轻松上百 MB。
- **失败场景**：任务流跑一下午后每次续推前多出数百毫秒到数秒的同步 CPU（stableStringify 是纯 CPU），Chat 首字延迟明显变长；`.LLSOAI` 目录膨胀且被 `.vscodeignore` 忽略，用户无感知。
- **修复**：(1) 加配置开关，默认关闭；(2) 改为 append-only 的 JSONL 并在内存里维护当日去重 key 集合；(3) 对 `image` 类 block 只记录 hash/长度。

---

## 中优先级

### B6　5 个测试文件游离在 `npm test` 之外，其中 3 个已经失败

- **位置**：`package.json` `scripts.test` 用显式文件列表而非 glob；对照 `find src -name '*.test.ts'`，以下 5 个从未被跑：

| 文件 | 单独执行结果 |
|---|---|
| `relay/__tests__/taskRequestInjection.test.js` | 失败：`Cannot find module 'vscode'` |
| `relay/converters/__tests__/streamConverters.test.js` | 失败：`Cannot find module 'vscode'` |
| `relay/tokenBudget/__tests__/store.test.js` | 1/5 失败：`createEmptySession 生成符合 schema 的桶`，期望阈值 140000 实际 150000 |
| `relay/tokenBudget/__tests__/estimator.test.js` | 6/6 通过 |
| `relay/converters/__tests__/openAIHeaders.test.js` | 1/1 通过 |

- **问题**：「280 全绿」只是列表内的 280。前两个缺 `installVscodeStub()`，第三个是默认阈值改成 150000 后测试没跟着改，说明 store 的默认值变更没有任何回归保护。
- **修复**：`scripts.test` 改为 `node --test "out/**/*.test.js"`（Node 20 支持 glob）；给两个缺桩的测试补 `installVscodeStub()`；把 store 测试期望值更新到 150000 或改成引用常量。

### B7　`shutdownExtension()` 遗留空闲看门狗定时器，会话落盘不等待

- **位置**：`src/activation/shutdown.ts:48`（`void flushPersistedChatSession()`）、`:51`（`cancel()`）。
- **问题**：(1) `AutoContinueScheduler.cancel()` 只清 `timer`，不清 `idleWatchdogTimer`/`idleWatchdogPending`（`autoContinue.ts:312-321`）；停用后看门狗到点仍会 `this.schedule()` → `submitter` 已被 dispose 的 host 忽略，但 `consecutiveMissingCount` 会被污染，下次 activate 若复用扩展宿主（reload 不重启宿主进程时静态字段保留）会带着脏计数开始。(2) 会话落盘用 `void`，`deactivate` 同步返回后宿主可能在 `workspaceState.update` 完成前退出，最后几条消息丢失。
- **修复**：`cancel()` 或新增 `disposeAll()` 一并清看门狗与计数；`deactivate` 改为 `async` 并 `await flushPersistedChatSession()`（VS Code 允许返回 Promise）。

### B8　上游错误快照无上限且包含完整请求体

- **位置**：`src/relay/debugRecorder.ts:100-121` `recordUpstreamError()`；调用点 `anthropicProxy.ts:485` 对**每个** ≥400 响应触发。
- **问题**：文件名带时间戳与随机串，永不覆盖、永不清理；`request` 字段是完整出站 body（含全部历史 messages 与图片 base64）。上游持续 429/529 时每秒可落数个文件。
- **修复**：保留最近 N 个（如 20）并在写入前删除更早的；请求体只保留最后 2 条 message 与 `system`/`tools` 摘要。

### B9　`token-count.json` 会话桶只增不减

- **位置**：`src/relay/tokenBudget/store.ts:379-395` `mergeDiskInto()` 无条件吸纳磁盘上所有 session；全文件没有按时间/数量的清理，唯一删除路径是 `:244-245` 的显式按 id 删除。
- **问题**：每次新建 Chat 会话都会新增一个桶，多月使用后文件累积成千上万条，每次保存都整文件 `JSON.stringify` + `fsync`（`:358`）。
- **修复**：合并时丢弃 `updatedAt` 早于 30 天或超出最近 200 个的会话。

### B10　`req.on('aborted')` 已废弃，客户端断开检测不可靠

- **位置**：`src/relay/anthropicProxy.ts:530`。
- **问题**：`IncomingMessage` 的 `'aborted'` 事件自 Node 17 起标记废弃，正常 keep-alive 复用下客户端半关时不一定触发；推荐监听 `res.on('close')` 并配合 `res.writableFinished` 判断是否异常断开。
- **修复**：与 B4 一起抽成公共 helper，三个代理统一改用 `res 'close'`。

---

## 低优先级 / 优化项

### O1　CLI 异常退出提示硬编码中文

- **位置**：`src/chatRuntime/cliLifecycle.ts:433-434`：`'重启 CLI'`、`` `${source} Chat CLI 异常退出：${detail}` ``。
- **说明**：任务流文案已有 7 语言表（`llsTask/messages.ts`），这条用户可见的模态提示没走同一套，英文界面用户会看到中文弹窗。顺带：这是任务流中途少数会弹模态框的路径之一，建议任务流活跃时降级为 toast 并自动重启，与 3.2.44 的「中途不弹窗」原则一致。

### O2　激活路径上的同步 fs

- **位置**：`src/configManager.ts:119` `fs.existsSync(getClaudeSettingsPath())`（每次 `getSnapshot()` 都执行）；`src/chat/cli/mcpJsonLoader.ts:107-112` `existsSync + readFileSync`；`src/views/configView.ts:280`。
- **说明**：单次代价小，但 `getSnapshot()` 在配置面板每次刷新与 `onDidChange` 广播时都会调用，网络盘 / 杀毒软件环境下会卡 UI 线程。改为 `fs.promises.access` 并缓存结果，仅在文件监听器触发时刷新。

### O3　超大单文件与工程化缺口

| 文件 | 行数 | 建议 |
|---|---|---|
| `media/chat/main.js` | 5683 | 无打包器、无模块化、无 lint；至少按「消息渲染 / 输入框 / 对话框 / 协议」拆成 4 个 IIFE 文件顺序加载，或引入 esbuild 打成一个 bundle |
| `src/chat/cli/cliAdapter.ts` | 2367 | 解析路径 1（system 事件）、路径 2（stream-json 状态机）、内嵌 JSON 剥离三块可各自成文件 |
| `src/relay/converters/openAIResponsesToAnthropic.ts` | 1140 | 与 `openAIChatToAnthropic.ts` 的 usage / stop_reason 映射重复，可抽公共模块 |

- 仓库没有 eslint 配置（`ls eslint.config.* .eslintrc*` 为空），`main.js` 里 VS Code 报出的 9 条 hint（未用变量、`keyCode` / `execCommand` 废弃 API）没有任何自动化拦截。
- 三个 relay 代理（`anthropicProxy` / `openaiChatProxy` / `openaiResponsesProxy`）的「首字节超时 → 流空闲超时 → 错误映射 → safeRecord」骨架几乎逐行相同（各约 100 行），B4/B10 的修复会第四次复制这段逻辑，建议先抽 `UpstreamRequestRunner` 再修。

### O4　vsix 体积构成（仅说明，按当前 >10M 要求不改）

| 构成 | 大小 |
|---|---|
| `node_modules/js-tiktoken/**`（解压后） | 22.4 MB |
| 其中实际使用 | 仅 `cl100k_base`（`estimator.ts:41`） |
| 打包后 vsix 总大小 | 10.83 MB |

- `.vscodeignore` 放行了整个 `js-tiktoken`，`dist/index.js`+`index.cjs` 各 5.6 MB（含全部 7 种词表，ESM/CJS 双份），`ranks/*` 又单独再带一份。若将来体积要求变化，只保留 `dist/index.cjs` + `ranks/cl100k_base.cjs` 可把 vsix 压到 3 MB 以内。

---

## 已在本轮修复

### F1　新版 CLI 的 `thinking_tokens` 与 `ping` 噪声事件刷进聊天区

- **现象**：升级 CLI 后聊天区出现大量 `System · thinking_tokens` 折叠卡片；`{"type":"stream_event","event":{"type":"ping"}}` 则以原始 JSON 原文打进正文。
- **原因**：
  - `{"type":"system","subtype":"thinking_tokens",...}` 是 CLI 在流式思考期间高频推送的 token 估算计数，不在 `SYSTEM_TASK_EVENT_SUBTYPES` 静默白名单里，落到 `parseSystemGenericEvent()` 的「未知 subtype → 折叠 System 卡片」兜底，每轮几十张。
  - `ping` 是 Anthropic SSE 心跳，CLI 以 `stream_event` 形态透传；`parseAnthropicStreamEvent()` 的 `switch` 没有该分支，`default` 返回 `undefined` 后一路穿到调度器第 7 步「完全无法识别 → 原文降级」。
- **修复**（3.2.44 之后的工作树）：
  - `cliAdapter.ts:774`：`thinking_tokens` 加入 `SYSTEM_TASK_EVENT_SUBTYPES`，顶层与内嵌 JSON 剥离两条路径共用同一集合，一处改动全覆盖。
  - `cliAdapter.ts:916`：`parseAnthropicStreamEvent()` 新增 `case 'ping'` 返回空 segments。
  - `cliAdapterSystemTaskEvent.test.ts` 新增 2 个用例，全量 283/283 通过。
- **后续建议**：`parseAnthropicStreamEvent()` 的 `default` 分支对已确认是 `stream_event` 包装的未知子类型不该再返回 `undefined` 让它穿到原文降级，改为「记 debug 日志 + 空 segments」更稳，避免下一个新事件类型再刷屏。

---

## 建议的修复顺序

1. **B1 + B2**（同一文件，约 20 行）：进程存活判断与 stdin 错误兜底，直接影响任务流稳定性。
2. **B6**：先把测试全部跑起来，后面每一步都有回归保护。
3. **B3 + B4 + B10**：一次性抽公共 helper，三个代理同步修。
4. **B5 + B8 + B9**：`.LLSOAI` 目录膨胀三兄弟，加开关 + 上限。
5. **B7**、O1、O2 顺手修。
6. O3 作为独立重构任务排期。




