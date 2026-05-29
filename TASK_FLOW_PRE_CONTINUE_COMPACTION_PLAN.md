# 任务流续推前压缩方案

## 背景

当前任务流自动续推由 `AutoContinueScheduler` 负责：

- `src/llsTask/autoContinue.ts`
  - `schedule()`：模型没有调用任务流工具时，4 秒后续推。
  - `scheduleAfterWorkflowTool()`：任务流工具执行后，4 秒后续推。
  - `runIfCurrent()`：最终调用注入的 `submitter(prompt)`。
- `src/extension.ts`
  - `AutoContinueScheduler.setSubmitter(async (text) => appendUserMessageAndSend(text))`。
  - 续推提示词会作为普通 user 消息进入当前 Claude CLI session。
- `src/relay/tokenBudget/service.ts`
  - `compactNow(sessionId)` 通过隐藏 user 消息向 CLI 发送 `/compact`。
- `src/relay/summCommand.ts`
  - 当前已能识别两类压缩请求：
    1. 裸 `/compact`。
    2. Claude CLI 内部 summary 请求：最后一条 user 是 `CRITICAL: Respond with TEXT ONLY...`，历史 user content 中含 `<command-name>/compact</command-name>`。
- `src/relay/router.ts`
  - 命中压缩请求后，可使用 `chat.compactionMode.*` 指定的压缩模型。
  - 当前仍会把请求交给上游 adapter，由真实模型生成压缩摘要并以流式响应回 CLI。

用户目标：任务流每次续推前先压缩上下文，并且压缩请求要求**流式回到 CLI**；在特定任务流场景下，不希望 Relay 直接请求模型，而是由 Relay 自己把“当前任务流全量压缩结果”以流式协议返回给 CLI。

## 目标

1. 任务流自动续推前先触发一次压缩。
2. 压缩必须对 CLI 表现为正常流式响应，不能直接吞掉或返回非流式 JSON。
3. 对任务流压缩请求，Relay 可以不请求上游模型，而是用当前 `LlsTaskService` 快照生成确定性的摘要。
4. 摘要应包含任务流全量状态，保证压缩后后续续推仍能知道：
   - workflow 标题和摘要；
   - 每个任务的 id/title/description/status；
   - planningDocumentPath；
   - originalUserPrompt；
   - 最近错误和更新时间；
   - 当前执行约束：继续执行未完成任务，完成后调用任务流更新工具。
5. 普通手动压缩、非任务流压缩仍保持现有路径：走压缩模型或普通模型。

## 可行性结论

可行，但建议分两阶段实现。

关键点是：Claude CLI 的 `/compact` 会发起一个 summary 请求，Relay 只要返回符合 Anthropic Messages stream 的 SSE，就能让 CLI 认为压缩完成。也就是说，任务流场景下 Relay 不一定需要请求上游模型；可以直接构造一个 deterministic summary，然后按 Anthropic stream 格式返回。

这条路径的主要风险不是技术上无法返回，而是要确保：

- SSE 事件格式完全被 Claude CLI 接受；
- 返回内容足够像“压缩后的会话摘要”；
- 不破坏 token budget 状态机的 `compacting -> success/failed` 事件识别；
- 不让普通对话误命中任务流本地压缩。

## 推荐方案

### 阶段一：续推前压缩，但仍走现有压缩模型

这是低风险版本。

流程：

1. `AutoContinueScheduler.runIfCurrent()` 准备提交续推 prompt。
2. 如果当前存在 active workflow，并且 normal CLI 有 sessionId：
   - 调用 `TokenBudgetService.compactNow(sessionId)` 或新增更适合自动路径的方法。
   - 等待压缩完成事件，或设置一个最大等待时间。
3. 压缩成功或超时后，再提交续推 prompt。

需要改动：

- `TokenBudgetService` 增加 Promise 化 API，例如：

```ts
public compactNowAndWait(sessionId: string, options: { timeoutMs: number }): Promise<'success' | 'failed' | 'timeout' | 'skipped'>
```

- `extension.ts` 将 compact capability 注入到 `AutoContinueScheduler`：

```ts
AutoContinueScheduler.setBeforeSubmit(async () => {
  const sessionId = currentChatCliSessionIdSync();
  if (!sessionId) return;
  await tokenBudgetServiceRef?.compactNowAndWait(sessionId, { timeoutMs: 60_000 });
});
```

- `AutoContinueScheduler.runIfCurrent()`：

```ts
if (beforeSubmit) {
  await beforeSubmit({ reason: 'task-flow-auto-continue' });
}
await submitter(prompt);
```

优点：

- 复用 Claude CLI 原生 `/compact`。
- 压缩仍由模型生成，格式最接近官方行为。
- 风险低，便于先验证“每次续推前压缩”是否改善任务流上下文。

缺点：

- 每次续推都会多一次模型调用，慢且贵。
- 如果上游压缩模型慢，任务流会明显变慢。
- 摘要不一定严格包含任务流全量状态。

### 阶段二：任务流压缩走 Relay 本地流式摘要

这是用户提出的核心优化。

流程：

1. 自动续推前仍发送 `/compact` 给 CLI。
2. Claude CLI 发出 summary 请求到 Relay。
3. Relay 识别：
   - 这是 compact summary 请求；
   - 当前 `llsTaskService.hasActiveWorkflow()` 为 true；
   - 请求来源是任务流续推前压缩，而不是用户手动压缩。
4. Relay 不调用上游 adapter。
5. Relay 构造任务流全量摘要，并用 Anthropic SSE 流式写回 CLI。
6. CLI 完成压缩后，AutoContinueScheduler 再提交续推 prompt。

## 如何区分“任务流续推前压缩”与普通压缩

不能只靠请求体，因为 Claude CLI 的 summary prompt 形态很通用。建议增加一个短生命周期标志：

```ts
class LlsTaskService {
  private pendingPreContinueCompactionUntil = 0;

  public markPreContinueCompactionPending(ttlMs = 120_000): void {
    this.pendingPreContinueCompactionUntil = Date.now() + ttlMs;
  }

  public consumePreContinueCompactionPending(): boolean {
    if (Date.now() > this.pendingPreContinueCompactionUntil) return false;
    this.pendingPreContinueCompactionUntil = 0;
    return true;
  }
}
```

触发位置：

- `AutoContinueScheduler` 运行 beforeSubmit 时：
  - 标记 `llsTaskService.markPreContinueCompactionPending()`；
  - 再发送 `/compact`。

Relay 判断：

```ts
const compactCommandTriggered = isClaudeCompactCommandRequest(parsedBody);
const taskFlowLocalCompact = compactCommandTriggered
  && llsTaskService?.hasActiveWorkflow()
  && llsTaskService.consumePreContinueCompactionPending();

if (taskFlowLocalCompact) {
  await writeTaskFlowCompactionStream(res, llsTaskService.getSnapshot());
  return;
}
```

这样不会影响用户手动点击压缩，也不会影响非任务流压缩。

## 本地任务流摘要内容

建议生成纯文本摘要，格式尽量接近 Claude compact summary：

```text
<summary>
Task-flow context summary for continuing work.

Active workflow:
Title: ...
Summary: ...
Progress: 2/5 completed

Original request:
...

Planning document:
...

Tasks:
- [completed] task-id-1 — title
  Description: ...
- [in_progress] task-id-2 — title
  Description: ...
- [pending] task-id-3 — title
  Description: ...

Continuation rules:
- Continue from the first in_progress task; if none, start the first pending task.
- After real progress, call update_llsccai_task_status.
- Do not mark a task completed unless it is actually done.
- If blocked, mark the task blocked and include the blocker.
</summary>
```

注意：

- 不要把历史对话完整塞回 summary，否则压缩没有意义。
- 重点保存任务流状态和继续执行规则。
- 可以保留最近一次用户原始请求和方案文档路径。

## SSE 响应格式

需要新增一个小工具函数，例如 `src/relay/anthropicStreamWriter.ts`：

```ts
export function writeAnthropicTextStream(
  res: http.ServerResponse,
  text: string,
  model: string
): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  writeEvent('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  writeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  writeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
  writeEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: estimate } });
  writeEvent('message_stop', { type: 'message_stop' });
  res.end();
}
```

要点：

- content-type 必须是 `text/event-stream`。
- 事件名和 data JSON 尽量沿用 Anthropic Messages stream。
- 可以一次性写一个大 delta，也可以分块写多个 delta。
- 对 CLI 来说这是“模型流式返回了 summary”。

## 状态机与等待机制

每次续推前压缩需要避免“压缩还没结束就提交续推”。建议：

1. `TokenBudgetService.compactNowAndWait()` 注册 `onCompactionStateChanged`。
2. 调用 `compactNow(sessionId)`。
3. 等待 matching sessionId 的 finished/failed。
4. timeout 后继续提交续推，但记录 warn。

伪代码：

```ts
public compactNowAndWait(sessionId: string, timeoutMs: number): Promise<CompactionWaitResult> {
  if (!this.compactNow(sessionId)) return Promise.resolve('skipped');
  return new Promise((resolve) => {
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const sub = this.onCompactionStateChanged((state) => {
      if (state.sessionId !== sessionId) return;
      if (state.kind === 'finished') done('success');
      if (state.kind === 'failed') done('failed');
    });
  });
}
```

需要注意：`handleCliCompactStatus()` 当前收到 CLI compact success 时会调用 `finishNativeCompaction()`。本地 Relay 直接返回 SSE 后，CLI 仍应发出 compact status success；如果不发，需要增加 fallback：当本地 stream 写完时由 Router/Service 主动标记成功。但优先依赖 CLI 原生事件。

## 与“每完成一项就压缩”的关系

用户最初提到“每完成一项都发起一次压缩”，后来 уточ正为“每次续推前”。建议最终采用“每次续推前”，原因：

- 任务状态从 in_progress 到 completed 后，本来就会触发 `scheduleAfterWorkflowTool()`；续推前压缩等价于“每完成一项后、下一项开始前压缩”。
- 如果某一项内部需要多轮工具调用，过早按每个工具结果压缩会打断上下文，风险更高。
- 续推前压缩的边界更稳定：上一轮模型已经结束，CLI 可以安全执行 `/compact`。

## 配置建议

新增配置，默认关闭：

```json
{
  "claudeCodeConfigHelper.chat.taskFlow.preContinueCompaction.enabled": false,
  "claudeCodeConfigHelper.chat.taskFlow.preContinueCompaction.mode": "native",
  "claudeCodeConfigHelper.chat.taskFlow.preContinueCompaction.timeoutMs": 60000
}
```

`mode`：

- `native`：发送 `/compact`，请求仍走压缩模型。
- `localTaskFlowSummary`：发送 `/compact`，Relay 命中任务流续推前压缩后直接返回本地任务流摘要 SSE。
- `off`：关闭。

也可以先不暴露 UI，只写 settings 配置。

## 实施步骤

### Step 1：抽象 compaction wait API

- 修改 `TokenBudgetService`：
  - 新增 `compactNowAndWait()`。
  - 手动压缩仍复用 `compactNow()`。
- 添加测试：
  - success event resolve success。
  - failed event resolve failed。
  - timeout resolve timeout。

### Step 2：AutoContinueScheduler 支持 beforeSubmit hook

- 新增静态 hook：

```ts
export type AutoContinueBeforeSubmit = () => Promise<void>;
public static setBeforeSubmit(hook: AutoContinueBeforeSubmit | undefined): void
```

- `runIfCurrent()` 在提交续推 prompt 前调用。
- extension 注入 hook。

### Step 3：先实现 native 模式

- beforeSubmit 中：
  - 检查 active workflow。
  - 调 `compactNowAndWait(sessionId, timeoutMs)`。
  - 无论结果如何，最后继续提交续推。
- 记录日志：success/failed/timeout/skipped。

### Step 4：实现 localTaskFlowSummary 模式

- `LlsTaskService` 增加 pending marker。
- `router.ts` 在 adapter.handle 前拦截：
  - 如果 compact request + active workflow + pending marker：
    - 构造 summary。
    - 写 Anthropic SSE。
    - return。
- 添加 `.LLSOAI/compact-request-*.json` 里标记：
  - `taskFlowLocalSummary: true`。

### Step 5：测试

必须覆盖：

- 普通 `/compact` 不受影响，仍走压缩模型。
- 任务流续推前 native 模式会先 compact 再 submit。
- localTaskFlowSummary 模式下 adapter 不被调用。
- localTaskFlowSummary 返回 SSE 包含 `message_start/content_block_delta/message_stop`。
- 任务流 summary 包含所有任务状态。
- marker 只消费一次，避免后续普通 compact 误拦截。

## 风险与缓解

1. **CLI 不接受自构造 SSE**
   - 缓解：先在测试环境用真实 Claude CLI 验证 event 格式；保留 native 模式作为 fallback。

2. **本地 summary 信息不足**
   - 缓解：summary 明确包含 workflow 全量任务、原始请求、方案路径和继续规则。

3. **每次续推前压缩导致速度慢**
   - 缓解：native 模式提供 timeout；localTaskFlowSummary 模式基本无模型耗时。

4. **误把普通 summary 请求当任务流压缩**
   - 缓解：必须同时满足 pending marker + active workflow + compact request。

5. **压缩状态卡住**
   - 现有已修：手动压缩会复位 inProgress；自动路径还需 timeout 后可继续续推。

## 推荐落地顺序

建议先实现：

1. `compactNowAndWait()`。
2. `AutoContinueScheduler.setBeforeSubmit()`。
3. native pre-continue compaction，默认关闭。
4. 验证任务流续推稳定后，再实现 `localTaskFlowSummary`。

不要一开始就默认开启本地 summary 模式。先通过配置开关灰度，确认 Claude CLI 能稳定接受本地 SSE 后再考虑作为默认。

## 最终建议

可以做，而且架构上应放在“续推提交前 hook + Relay compact 请求拦截”这两个位置。

最稳妥的 MVP 是：任务流续推前发送 `/compact`，等待 compact 完成，再提交续推；压缩请求继续走压缩模型。

进阶优化才是：任务流续推前的 compact 请求由 Relay 本地生成任务流全量摘要，并以 Anthropic SSE 流式返回给 CLI，不请求上游模型。
