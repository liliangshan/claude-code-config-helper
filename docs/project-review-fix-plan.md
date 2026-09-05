# 项目审查修复落地方案

> 对应审查报告：[project-review-2026-09.md](./project-review-2026-09.md)。
> 本文件只写「改哪个文件、哪个方法、改成什么样、怎么验证」，行号以 3.2.44 提交后的工作树为准（含 F1 已修改动）。
> 分 5 个阶段，每阶段可独立提交、独立回归；每阶段结束都跑 `npm test` 并用 MCP `get_errors` 检查诊断。

## 阶段总览

| 阶段 | 覆盖项 | 涉及文件 | 预估改动 |
|---|---|---|---|
| 1 | B6 测试基建 | `package.json`、2 个测试文件、`store.test.ts` | ~10 行 |
| 2 | B1 + B2 CLI 进程存活与 stdin | `src/chat/cli/cliProcess.ts` | ~35 行 |
| 3 | B3 + B4 + B10 Relay 连接生命周期 | `src/relay/server.ts`、新建 `src/relay/upstreamAbort.ts`、3 个代理 | ~60 行 |
| 4 | B5 + B8 + B9 `.LLSOAI` 膨胀 | `src/relay/debugRecorder.ts`、`src/activation/relayWiring.ts`、`src/configManager.ts`、`package.json`、`src/relay/tokenBudget/store.ts` | ~90 行 |
| 5 | B7 + O1 + O2 收尾 | `src/llsTask/autoContinue.ts`、`src/activation/shutdown.ts`、`src/extension.ts`、`src/chatRuntime/cliLifecycle.ts`、`src/llsTask/messages.ts`、`src/configManager.ts` | ~60 行 |

O3（大文件拆分 / 引入 lint 与打包器）、O4（tiktoken 体积）不在本方案内，另立重构任务。

---

## 阶段 1　B6：让所有测试真正跑起来

先做这一步，后面每阶段都有回归保护。

### 1.1　`package.json` → `scripts.test`

把显式文件列表改为 glob（Node 20+ 的 `--test` 支持）：

```json
"test": "npm run compile && node --test \"out/**/*.test.js\""
```

### 1.2　`src/relay/__tests__/taskRequestInjection.test.ts`、`src/relay/converters/__tests__/streamConverters.test.ts`

两个文件都缺 `vscode` 桩。参照同目录已通过的 `routerPath.test.ts:8-9`，在所有 `import` 之后、被测模块 `require` 之前加：

```ts
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
installVscodeStub();
```

若被测模块是用 `import` 静态引入的，需改成 `require` 延迟加载（同 `autoContinueScheduling.test.ts:16-17` 写法），否则桩装晚了。

### 1.3　`src/relay/tokenBudget/__tests__/store.test.ts:57`

`createEmptySession()`（`store.ts:137-150`）现在是 `threshold = contextLimit - 50000`，测试还按旧的 `- 60000` 断言：

```ts
assert.equal(session.threshold, 150000);
```

### 验证

`npm test` 应从 283 变为 297 左右且全绿；`node --test out/relay/tokenBudget/__tests__/store.test.js` 单跑 5/5。

---

## 阶段 2　B1 + B2：CLI 子进程存活判断与 stdin 错误兜底

全部在 `src/chat/cli/cliProcess.ts`。

### 2.1　新增实例字段（第 39 行 `expectedExitPids` 之后）

```ts
/**
 * 当前子进程是否已真正退出（由 exit 事件置位）。
 *
 * 不能用 `child.killed`：它只表示 kill() 已成功「发送」信号，发完 SIGTERM 立即为 true，
 * 与进程是否退出无关。
 */
private childExited = false;
```

### 2.2　`start()`（第 80 行 `spawn` 前后）

`spawn` 之前 `this.childExited = false;`。

### 2.3　`bindChildEvents(child)`（第 587 行）

- `child.on('exit', ...)` 回调（第 600 行）第一行加 `this.childExited = true;`。
- 新增 stdin 错误监听，放在 `child.on('error', ...)` 之前：

```ts
// stdin 是独立的 Writable，EPIPE 走它自己的 error 事件；不挂监听会变成未捕获异常打崩扩展宿主。
child.stdin.on('error', (err) => {
    Logger.warn(`Chat CLI stdin 写入错误（进程可能已退出）：${err.message}`);
});
```

### 2.4　`send(jsonLine)`（第 96-102 行）

改为返回 Promise 并用回调形式写入，把异步写错误交给上层：

```ts
public send(jsonLine: string): Promise<void> {
    const child = this.child;
    if (!child || this.childExited || !child.stdin.writable) {
        return Promise.reject(new Error('Chat CLI 进程未运行，无法写入 stdin'));
    }
    const line = jsonLine.endsWith('\n') ? jsonLine : `${jsonLine}\n`;
    return new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
}
```

调用方：`cliAdapter.ts:316` `sendUserMessage()` 已是 `async`，改为 `await this.process.send(jsonLine)`；用 `grep -rn "process.send(\|\.send(jsonLine" src` 找出其余调用点逐一 `await`。

### 2.5　`cancel()`（第 148-150 行）与 `disposeRunningChild()`（第 647、656 行）

三处 `child.killed` / `this.child.killed` 全部换成 `this.childExited`（`disposeRunningChild` 里用闭包捕获的局部 `exited` 亦可，因为 `this.child` 在第 634 行已被置 undefined）。

### 验证

- 新增 `src/chat/cli/__tests__/cliProcessLifecycle.test.ts`：用 `spawn('node', ['-e', 'setInterval(()=>{},1000)'])` 起一个忽略 SIGTERM 的子进程（脚本里 `process.on('SIGTERM', ()=>{})`），调 `stop()`，断言 1.6s 内子进程 `exitCode !== null`（证明 SIGKILL 生效）。
- 手工：Chat 中途 `kill -9` CLI 再发消息，输出面板应出现「stdin 写入错误」warn 而非扩展宿主崩溃。

---

## 阶段 3　B3 + B4 + B10：Relay 连接生命周期

### 3.1　`src/relay/server.ts` → `stop()`（第 198-212 行）与 `dispose()`（第 233 行）

`server.close(cb)` 之后立刻断开所有连接，否则挂着的 SSE 会让 Promise 等到 240s 空闲超时：

```ts
await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // close() 只停 accept，不断已有连接；relay 的常态负载是长 SSE，必须主动掐断。
    server.closeAllConnections();
});
```

`dispose()` 里 `this.server?.close()` 后同样补 `this.server?.closeAllConnections()`。

### 3.2　新建 `src/relay/upstreamAbort.ts`

三个代理共用的「客户端断开 → 销毁上游请求」helper，替代已废弃的 `req 'aborted'`：

```ts
/**
 * 客户端（Claude CLI）中途断开时销毁上游请求，避免上游继续流式输出与计费。
 *
 * 监听 `res 'close'` 而非 `req 'aborted'`：后者 Node 17 起废弃，keep-alive 复用下不可靠。
 * `writableFinished` 为 true 说明是正常写完关闭，不是异常断开。
 *
 * @param res 下行响应对象。
 * @param upstreamReq 已发出的上游请求。
 * @param label 日志标签。
 * @returns 解绑函数，上游正常结束后调用以免重复 destroy。
 */
export function bindClientAbortToUpstream(
    res: http.ServerResponse,
    upstreamReq: http.ClientRequest,
    label: string
): () => void {
    const onClose = () => {
        if (res.writableFinished) return;
        Logger.info(`${label}：客户端已断开，销毁上游请求`);
        try { upstreamReq.destroy(); } catch { /* ignore */ }
    };
    res.once('close', onClose);
    return () => res.off('close', onClose);
}
```

### 3.3　三个代理接入

| 文件 | `transport.request` 行 | `upstreamReq.end` 行 | 改动 |
|---|---|---|---|
| `src/relay/anthropicProxy.ts` | 412 | 538 | 删除第 530-536 行的 `req.on('aborted', ...)`，在 538 行前加 `const unbind = bindClientAbortToUpstream(res, upstreamReq, 'Anthropic 透传')`，`finish()` 内调用 `unbind()` |
| `src/relay/openaiChatProxy.ts` | 209 | 252 | 同上，`res` 取 `ctx.res`，标签 `'OpenAI Chat'` |
| `src/relay/openaiResponsesProxy.ts` | 206 | 249 | 同上，标签 `'OpenAI Responses'` |

### 验证

- `src/relay/__tests__/upstreamAbort.test.ts`：用 `http.createServer` 起假上游（只写 headers 不结束），relay 侧模拟客户端 `req.destroy()`，断言假上游收到 `close` 事件。
- 手工：长回答中途点停止，输出面板应立即出现「客户端已断开，销毁上游请求」，且 `chat/running` 状态在 1s 内回到空闲。

---

## 阶段 4　B5 + B8 + B9：`.LLSOAI` 目录膨胀

### 4.1　新增设置项（B5 开关）

`package.json` → `contributes.configuration.properties` 新增：

```json
"claudeCodeConfigHelper.relay.debugRecord": {
    "type": "boolean",
    "default": false,
    "description": "Write relay request messages to .LLSOAI/yyyy-MM-dd.json for debugging. Off by default; has a per-request cost."
}
```

`src/configManager.ts`：仿 `getTaskFlowBypassPermissions()`（第 169-173 行）新增：

```ts
/** 是否开启 Relay 请求 messages 调试落盘（默认关闭）。 */
public getRelayDebugRecordEnabled(): boolean {
    return vscode.workspace.getConfiguration(CCAI_NAMESPACE).get<boolean>('relay.debugRecord', false);
}
```

### 4.2　`src/relay/debugRecorder.ts` → 构造函数与 `record()`（第 130-158 行）

- 类目前无构造函数。新增 `constructor(private readonly isEnabled: () => boolean = () => false)`。
- `record()` 第一行加 `if (!this.isEnabled()) return;`。
- 去掉「读整文件 → 重建去重集合」：新增实例字段 `private dailyKeys = new Map<string, Set<string>>()`（按日期缓存当日已写 key），`readDailyMessagesRecord()`（第 240 行）只在该日期首次命中时调用一次填充缓存；之后每次只对新增 messages 算 `stableStringify`。
- 写入改为 append-only：文件改名 `yyyy-MM-dd.jsonl`，每条 message 一行 `fs.appendFile`，不再整文件 `JSON.stringify`。
- `extractRequestMessages()`（第 263 行）之后新增 `stripImageBlocks(messages)`：把 `type === 'image'` 的 block 替换为 `{ type: 'image', omitted: true, bytes: <source.data.length> }`。

### 4.3　`src/activation/relayWiring.ts:159`

```ts
const debugRecorder = new DebugRecorder(() => configManager.getRelayDebugRecordEnabled());
```

### 4.4　`recordUpstreamError()`（`debugRecorder.ts:100-121`，B8）

- 方法开头加常量 `MAX_ERROR_SNAPSHOTS = 20`；写入前 `fs.readdir(dir)` 过滤 `error-*.json`，按名称排序（前缀含时间戳，字典序即时间序），超过 19 个时删最早的。
- 请求体瘦身：`JSON.parse` 成功后只保留 `{ model, system, tools: tools?.map(t => t.name), messages: messages.slice(-2) }`，并同样走 `stripImageBlocks`。
- 该方法**不受** 4.1 开关控制（错误快照是排障必需），只受上限控制。

### 4.5　`src/relay/tokenBudget/store.ts` → `mergeDiskInto()`（第 379-395 行）与 `flushNow()`（第 340 行）

`SessionUsage` 已有 `lastUpdated: string`（ISO）。新增模块常量与裁剪方法：

```ts
/** 会话桶保留上限：超过按 lastUpdated 淘汰最旧的。 */
const MAX_SESSIONS = 200;
/** 会话桶最长保留天数。 */
const MAX_SESSION_AGE_DAYS = 30;

/** 淘汰过期与超量的会话桶，只在内存里做，随下一次 flushNow 落盘。 */
private pruneSessions(): void {
    const cutoff = Date.now() - MAX_SESSION_AGE_DAYS * 86_400_000;
    const entries = Object.entries(this.file.sessions)
        .filter(([, s]) => Date.parse(s.lastUpdated) >= cutoff)
        .sort((a, b) => Date.parse(b[1].lastUpdated) - Date.parse(a[1].lastUpdated))
        .slice(0, MAX_SESSIONS);
    this.file.sessions = Object.fromEntries(entries);
}
```

调用点：`mergeDiskInto()` 末尾、`load()` 解析完成后（第 297 行附近）、`flushNow()` 序列化前各调一次。

### 验证

- `store.test.ts` 新增：插入 201 个桶 / 插入 1 个 `lastUpdated` 为 31 天前的桶，`pruneSessions` 后分别剩 200 / 0。
- `debugRecorder.test.ts`（新建）：开关关闭时 `record()` 不产生文件；开启时写入 3 次同一 messages 只追加 1 行；`recordUpstreamError` 连写 25 次目录内只剩 20 个。
- 手工：`ls -la .LLSOAI/` 跑一天任务流后 `yyyy-MM-dd.jsonl` 不再出现（默认关闭）。

---

## 阶段 5　B7 + O1 + O2：停用清理、退出提示国际化、同步 fs

### 5.1　B7　`src/llsTask/autoContinue.ts` 新增 `disposeAll()`（放在 `cancel()` 第 312 行之后）

```ts
/**
 * 停用扩展时的一次性总清理：续推定时器、空闲看门狗、熔断计数全部归零。
 *
 * 三者都是静态字段；扩展宿主 reload 不一定重建模块实例，不清会把脏状态带进下一次 activate。
 */
public disposeAll(): void {
    this.cancel('扩展停用');
    this.notifyRequestStarted();
    AutoContinueScheduler.consecutiveMissingCount = 0;
}
```

`src/activation/shutdown.ts:51` 把 `getAutoContinueScheduler()?.cancel('扩展停用')` 改为 `?.disposeAll()`。

### 5.2　B7　`src/activation/shutdown.ts:47-48` 与 `src/extension.ts:180`

```ts
// shutdown.ts
export async function shutdownExtension(): Promise<void> {
    await flushPersistedChatSession().catch((err) => Logger.warn(`停用时会话落盘失败：${String(err)}`));
    ...其余不变
}
// extension.ts
export function deactivate(): Promise<void> {
    return shutdownExtension();
}
```

VS Code 会等待 `deactivate` 返回的 Promise（有上限，落盘是单次 `workspaceState.update`，足够）。

### 5.3　O1　`src/chatRuntime/cliLifecycle.ts:433-434`

- `src/llsTask/messages.ts` `LlsCcaiTaskTexts` 接口（第 6 行）新增两个键：`cliExitedTitle: string`（占位 `{source}` / `{detail}`）、`cliRestartAction: string`；7 个语言块（`en` 66、`zh-cn` 87、`zh-tw` 108、`ko` 129、`ja` 150、`fr` 171、`de` 192）各补一条。
- `cliLifecycle.ts` 引入 `getLlsCcaiTaskTexts` 与 `getConfigManager`，433-434 行改为：

```ts
const texts = getLlsCcaiTaskTexts(getConfigManager()?.getResolvedUiLanguage() ?? 'en');
const restart = texts.cliRestartAction;
const message = texts.cliExitedTitle.replace('{source}', source).replace('{detail}', detail);
```

- 任务流活跃时不再弹模态：在 `if (event.code === 0) return;`（第 432 行）之后加 `if (getLlsTaskService()?.hasActiveWorkflow()) { await requireDeps().showChatToast('error', message); await restartChatCli({ silent: true }); return; }`（`showChatToast` 由 `configureCliLifecycle` 注入，签名 `(level, text)`，见第 38 行；`restartChatCli` 在第 123 行），与 3.2.44「中途不弹窗」原则一致。

### 5.4　O2　`src/configManager.ts:119` `getSnapshot()`

`fs.existsSync(getClaudeSettingsPath())` 改为读缓存字段 `private claudeSettingsExists = false`，在构造函数里用 `fs.promises.access` 异步初始化一次，并用 `vscode.workspace.createFileSystemWatcher(getClaudeSettingsPath())` 的 create/delete 事件维护；watcher 推入 `context.subscriptions`。`mcpJsonLoader.ts:107-112` 与 `configView.ts:280` 的同步读改为 `fs.promises` 版本，调用方本就是 `async`。

### 验证

- `autoContinueScheduling.test.ts` 新增：`armIdleWatchdog()` + `schedule()` 3 次后调 `disposeAll()`，断言 `hasPendingWork() === false` 且再 `schedule()` 4 次才熔断。
- 手工：切英文界面后 `kill -9` CLI，弹窗文案为英文；任务流跑动中 `kill -9` CLI，不弹窗、toast 报错并自动重启。

---

## 提交切分建议

| 提交 | 内容 | 版本 |
|---|---|---|
| 1 | 阶段 1 + F1（已在工作树） | 3.2.45 |
| 2 | 阶段 2 | 3.2.46 |
| 3 | 阶段 3 | 3.2.47 |
| 4 | 阶段 4 | 3.2.48 |
| 5 | 阶段 5 | 3.2.49 |

每个提交都单独打包安装验证，避免多项行为改动叠在一个版本里难以回退。


