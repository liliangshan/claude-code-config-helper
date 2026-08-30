# 定时唤醒 MCP 工具（llsccaiWakeup）落地方案

## 目标

新增一个内置 MCP server `llsccaiWakeup`，让模型可以「给自己定闹钟」：
提交一个触发时间与唤醒内容，扩展宿主在后台起定时器；到点后把唤醒内容作为
一条**可见的用户消息**追加进内置 Chat，并立即经 CLI 发往后端，等同用户亲手发送。

工具完整名（模型侧可见）：

- `mcp__llsccaiWakeup__lls-ccai-schedule-wakeup`
- `mcp__llsccaiWakeup__lls-ccai-list-wakeups`
- `mcp__llsccaiWakeup__lls-ccai-cancel-wakeup`

## 已确认的设计约束

| 决策点 | 结论 |
| --- | --- |
| 持久化 | 落盘 `.LLSOAI/wakeups.json`，复用 `llsTask/store.ts` 的原子写模式；扩展激活时重建定时器，错过的任务启动时补发 |
| 重复触发 | **仅一次性**。触发后自动删除，不支持 interval / cron |
| 触发形式 | 可见用户气泡 + 自动发送，即复用 `appendUserMessageAndSend` |

## 与现有内置 MCP 的关系

完全照搬 `llsccaiVscode`（`src/vscodeTools/`）的四件套结构，因为该模块是
最小、最新、且已解决「子进程无 vscode 运行时」问题的样板：

```
子进程（claude CLI 用 node -e 启动）          扩展宿主进程
wakeupMcpServer.ts  ──stdio JSON-RPC──┐
     └─ httpBridge.WakeupHttpForwardingHost
            └──HTTP POST /llsccai/wakeup-tool──▶ createWakeupToolRelayHandler
                                                      └─ WakeupHost（持 vscode API）
                                                            ├─ WakeupStore（.LLSOAI/wakeups.json）
                                                            └─ WakeupScheduler（setTimeout）
                                                                  └─ 到点回调 ──▶ extension.ts
                                                                                    └─ appendUserMessageAndSend()
```

关键约束（**必须遵守，否则整组工具会静默消失**）：
`wakeupMcpServer.ts` 与 `httpBridge.ts` 只能 `import type` 引用宿主侧模块，
真实依赖一律惰性 `require`。参考 3.2.23 修复的 browser 工具事故——
静态 import 链拉进 `logger` → `require('vscode')`，子进程直接崩。

---

## 第 1 步：工具常量与 schema — 新建 `src/wakeupTools/tools.ts`

对照 `src/vscodeTools/tools.ts` 编写。

```ts
export const WAKEUP_MCP_SERVER_NAME = 'llsccaiWakeup' as const;
export const WAKEUP_FULL_TOOL_PREFIX = `mcp__${WAKEUP_MCP_SERVER_NAME}__` as const;

export type WakeupToolName =
    | 'lls-ccai-schedule-wakeup'
    | 'lls-ccai-list-wakeups'
    | 'lls-ccai-cancel-wakeup';
```

- `WakeupToolSchema` 接口：与 `VscodeToolSchema` 同形（name / description / inputSchema）。
- `WAKEUP_TOOL_SCHEMAS`：三个工具定义。
  - `lls-ccai-schedule-wakeup`
    - `prompt: string`（必填）——到点要发送的唤醒内容。
    - `delaySeconds?: number`——相对延迟，与 `at` 二选一。
    - `at?: string`——绝对时间 ISO 8601，与 `delaySeconds` 二选一。
    - `reason?: string`——一句话说明，仅用于列表展示与日志。
    - `required: ['prompt']`（时间字段的二选一在 host 层校验，schema 层不做 oneOf，
      避免部分 provider 对 JSON Schema 组合关键字支持不一致）。
  - `lls-ccai-list-wakeups`：`properties: {}`, `required: []`。
  - `lls-ccai-cancel-wakeup`：`{ id: string }`, `required: ['id']`。
- `isWakeupToolName(value): value is WakeupToolName`——由 `WAKEUP_TOOL_SCHEMAS`
  派生的 Set 做校验，供 `tools/call` 与 HTTP bridge 复用。

## 第 2 步：数据类型与持久化 — 新建 `src/wakeupTools/wakeupStore.ts`

参考 `src/llsTask/store.ts`（定位工作区根 → `.LLSOAI/` → 原子写 → 异常只 warn）。

```ts
export interface WakeupJob {
    id: string;              // crypto.randomUUID()
    prompt: string;          // 到点发送的内容
    reason?: string;
    createdAt: string;       // ISO
    fireAt: string;          // ISO，绝对触发时间（delaySeconds 已在 host 层折算）
}
```

`WakeupStore` 类（构造参数：可选 `dirName`，默认 `.LLSOAI`）：

- `resolveFilePath(): Promise<string>`——`vscode.workspace.workspaceFolders?.[0]`
  优先，无工作区回退 `os.homedir()`；文件名 `wakeups.json`。
  **该方法用到 vscode，因此本文件只能被宿主侧引用。**
- `load(): Promise<WakeupJob[]>`——读文件 → JSON.parse → 逐条 `isValidJob` 过滤；
  文件缺失 / 损坏 / 版本不符一律返回 `[]`，不抛异常。
- `saveAll(jobs: WakeupJob[]): Promise<void>`——写 `{ version: 1, savedAt, jobs }`，
  tmp + rename 原子写。
- `add(job)` / `remove(id)`——读-改-写封装，内部串行化（用一个 `private queue: Promise<void>`
  链式 await，避免并发写互相覆盖）。
- `isValidJob(raw): raw is WakeupJob`——模块级私有函数，防御反序列化。

## 第 3 步：定时器与触发 — 新建 `src/wakeupTools/wakeupScheduler.ts`

```ts
export type WakeupFireHandler = (job: WakeupJob) => Promise<void>;

export class WakeupScheduler implements vscode.Disposable {
    constructor(store: WakeupStore, onFire: WakeupFireHandler)
}
```

方法：

- `restore(): Promise<void>`——扩展激活时调用一次。
  1. `store.load()`；
  2. `fireAt <= now` 的任务视为**错过**，立即依次触发并从存储移除
     （补发；这正是「持久化」选项的意义）；
  3. 其余用 `arm(job)` 重新武装。
- `schedule(input): Promise<WakeupJob>`——host 调用的下单入口。
  1. 折算 `fireAt`：给了 `at` 用 `at`，给了 `delaySeconds` 用 `Date.now() + delaySeconds*1000`；
  2. 生成 id、`store.add(job)`、`arm(job)`，返回 job。
- `cancel(id): Promise<boolean>`——`clearTimeout` + 从 map 删除 + `store.remove(id)`。
- `list(): Promise<WakeupJob[]>`——直接透传 `store.load()`（内存 map 只存 timer 句柄，
  以磁盘为准，避免两份状态漂移）。
- `private arm(job)`——核心。
  - `delay = new Date(job.fireAt).getTime() - Date.now()`，负值取 0；
  - **`setTimeout` 上限保护**：Node 的 `setTimeout` 超过 `2^31-1` ms（约 24.8 天）
    会立即触发。超过 `MAX_TIMEOUT_MS` 时先 `setTimeout(MAX_TIMEOUT_MS)` 再递归
    `arm` 续期。这是本模块唯一容易踩的坑，必须实现。
  - 回调里：先 `this.timers.delete(id)` + `store.remove(id)`（一次性语义，
    先落盘删除再触发，避免触发过程崩溃导致重启后重复发送），再 `await onFire(job)`，
    `onFire` 抛错只 `Logger.warn`。
- `dispose()`——`clearTimeout` 所有句柄并清空 map（不动磁盘，重启后 `restore` 接手）。

## 第 4 步：宿主执行器 — 新建 `src/wakeupTools/wakeupHost.ts`

对照 `src/vscodeTools/diagnosticsHost.ts`。

```ts
export interface WakeupToolResult { isError?: boolean; content: { type: 'text'; text: string }[] }
export interface WakeupToolExecutor {
    execute(name: WakeupToolName, args?: Record<string, unknown>): Promise<WakeupToolResult>;
}
export class WakeupHost implements WakeupToolExecutor {
    constructor(private readonly scheduler: WakeupScheduler)
}
```

- `execute(name, args)`——switch 分派到三个私有方法，统一 try/catch 转 `error()`。
- `private async runSchedule(args)`
  - 校验 `prompt` 为非空字符串，否则返回参数错误；
  - 校验时间：`delaySeconds`（正有限数）与 `at`（可被 `Date.parse` 解析且在未来）
    **至少给一个**；都没有或都非法 → 参数错误文本，明确写清两种用法；
  - `scheduler.schedule(...)`，返回文本形如
    `Wakeup scheduled: id=<id>, fireAt=<ISO>, in <n>s.`
- `private async runList()`——返回按 `fireAt` 升序的 `id / fireAt / reason / prompt 摘要`
  多行文本；空列表返回 `No scheduled wakeups.`。
- `private async runCancel(args)`——校验 `id`，调 `scheduler.cancel`，
  返回是否命中。
- `private error(text)`——`{ isError: true, content: [{ type: 'text', text }] }`。

## 第 5 步：HTTP bridge — 新建 `src/wakeupTools/httpBridge.ts`

几乎逐行照抄 `src/vscodeTools/httpBridge.ts`，只换常量：

- `export const WAKEUP_TOOL_HTTP_PATH = '/llsccai/wakeup-tool';`
- `export const WAKEUP_TOOL_RELAY_PORT_ENV = 'LLS_WAKEUP_TOOL_RELAY_PORT';`
- `class WakeupHttpForwardingHost implements WakeupToolExecutor`——子进程侧，
  `execute` 走 `postJson(port, { name, arguments })`。
- `createWakeupHttpHost(port)`——工厂。
- `createWakeupToolRelayHandler(host: WakeupToolExecutor)`——宿主侧 handler，
  签名 `(req, res) => Promise<boolean>`，路径不匹配返回 false。
  **注意与 vscodeTools 的差异**：这里 `host` 是**必填**参数，不能像
  `createVscodeToolRelayHandler` 那样惰性 new 一个默认宿主——WakeupHost 依赖
  `WakeupScheduler` 实例（持有 timer 与 store），必须由 `extension.ts` 注入同一个。
- `postJson` / `readRequestBody` / `writeJson`——与 vscodeTools 同名私有函数，
  直接复制（两个 bridge 各自独立，不抽公共模块，避免为三行重复引入跨模块耦合）。

## 第 6 步：MCP server 子进程入口 — 新建 `src/wakeupTools/wakeupMcpServer.ts`

对照 `src/vscodeTools/vscodeMcpServer.ts`，结构完全一致：

- `class WakeupMcpServer`——`start()` / `dispose()` / `flushLines()` /
  `handleLine()` / `dispatch()` / `handleToolCall()` / `write()`。
- `dispatch` 的 `initialize` 返回
  `serverInfo: { name: 'llsccai-wakeup', version: '1.0.0' }`；
  `tools/list` 返回 `WAKEUP_TOOL_SCHEMAS`。
- `startWakeupMcpServer(options)`——读 `process.env[WAKEUP_TOOL_RELAY_PORT_ENV]`，
  `port > 0` 时用 `createWakeupHttpHost(port)`。
  **与 vscodeTools 的差异**：没有进程内 fallback 宿主——定时器必须活在扩展宿主里，
  子进程内起的 timer 会随 MCP 进程退出而消失。因此 `port` 缺失时 host 为
  一个恒定返回错误文本的 stub（`Wakeup tools require the extension host relay.`）。
- 文件尾 `if (require.main === module) startWakeupMcpServer();`。

## 第 7 步：注入 CLI mcpServers — 改 `src/chat/cli/cliConfig.ts`

照 `injectVscodeMcpServer`（:1000）新增：

- 顶部 import：`WAKEUP_MCP_SERVER_NAME`（from `../../wakeupTools/tools`）、
  `WAKEUP_TOOL_RELAY_PORT_ENV`（from `../../wakeupTools/httpBridge`）。
- 新增 `function injectWakeupMcpServer(mcpServers, enabled, relayPort)`——
  与 `injectVscodeMcpServer` 同形：不存在则写入
  `{ type: 'stdio', command: process.execPath, args: ['-e', buildWakeupMcpEntrypointScript()], env: { [WAKEUP_TOOL_RELAY_PORT_ENV]: String(relayPort) } }`；
  已存在则只补 env 端口。
- 新增 `function buildWakeupMcpEntrypointScript()`——
  `require.resolve('../../wakeupTools/wakeupMcpServer')` + `.startWakeupMcpServer();`。
- 两处调用点（:306 `finalMcpServers` 与 :386 `normal` 配置）在
  `injectVscodeMcpServer(...)` 外层再包一层 `injectWakeupMcpServer(...)`。
- 开关来源：与 browser/vscode 一致，`baseConfig.mcpServers?.[WAKEUP_MCP_SERVER_NAME] !== undefined`
  决定是否启用（沿用「用户在 MCP 配置里保留该 server 即视为开启」的既有约定）。

## 第 8 步：扩展宿主装配与触发落地 — 改 `src/extension.ts`

1. **import**（约 :11 / :60 附近，与 browser/vscode 的 import 并列）：
   `WAKEUP_MCP_SERVER_NAME`、`createWakeupToolRelayHandler` +
   `WAKEUP_TOOL_RELAY_PORT_ENV`、`WakeupStore`、`WakeupScheduler`、`WakeupHost`。
2. **模块级变量**：`let wakeupScheduler: WakeupScheduler | undefined;`
3. **新增 `async function fireWakeupJob(job: WakeupJob): Promise<void>`**
   （放在 `appendUserMessageAndSend`（:3972）附近）：
   ```ts
   /** 定时唤醒到点回调：打开 Chat 并以用户消息形式发送唤醒内容。 */
   async function fireWakeupJob(job) {
       Logger.info(`定时唤醒触发：id=${job.id}, fireAt=${job.fireAt}`);
       await appendUserMessageAndSend(job.prompt);
   }
   ```
   `appendUserMessageAndSend` 已经做了 `openBuiltInChat()` +
   `appendLocalChatMessage('user', text)` + `sendUserMessageToCli(text)`，
   正好满足「窗口把内容发到聊天框，再由 CLI 发到后端」。
4. **`activate` 内装配**（在 :4880 那组 relay handler 旁）：
   ```ts
   const wakeupStore = new WakeupStore();
   wakeupScheduler = new WakeupScheduler(wakeupStore, fireWakeupJob);
   const wakeupToolRelayHandler = createWakeupToolRelayHandler(new WakeupHost(wakeupScheduler));
   ```
   并 `context.subscriptions.push(wakeupScheduler)`。
5. **relay 分发**（:4924 `relayServer.setHandler`）在 vscode handler 之后加一行：
   `if (await wakeupToolRelayHandler(req, res)) return;`
6. **恢复**：`activate` 末尾（Chat 视图就绪之后）`void wakeupScheduler.restore();`
   —— 必须在 `chatViewHost` 可用之后，否则补发的错过任务会因为 Chat 未初始化而失败。

## 第 9 步：测试 — 新建 `src/wakeupTools/__tests__/`

参考 `src/browserTools/__tests__/`（含 `installVscodeStub` 用法）。

- `wakeupScheduler.test.ts`
  - `schedule` + 假时钟：到点调用 `onFire` 且只调一次；
  - 触发后 store 中已无该 job（一次性语义）；
  - `cancel` 后不再触发；
  - `restore` 对 `fireAt` 已过期的 job 立即补发；
  - **超长延迟分段续期**：`fireAt` 在 30 天后时不会立即触发。
- `wakeupHost.test.ts`
  - `prompt` 缺失 / 时间字段全缺 / `at` 非法 → `isError: true`；
  - `delaySeconds` 与 `at` 都给时以 `at` 为准（或按实现约定断言）；
  - `list` 空集合文案、`cancel` 未命中返回值。
- `wakeupMcpServer.test.ts`
  - **回归**：在无 `vscode` 的真实子进程里启动 server，`tools/list`
    仍返回三个工具（照抄 browserMcpServer 的同类回归用例，防 3.2.23 事故重演）。

## 实施顺序与验证

1 → 2 → 3 → 4 → 5 → 6（自下而上，纯逻辑先行，每步 `npm run compile`）
→ 7 → 8（接线）→ 9（测试）。

每步结束跑 `npm run compile && npm test`，最后 mcp 工具查 VS Code 诊断，
再 `npx vsce package` + `code --install-extension ... --force`，
实测：让模型调用 `lls-ccai-schedule-wakeup` 定一个 60 秒后的唤醒，
确认到点后聊天区出现用户气泡且 CLI 真的发起了上游请求；重启 VS Code
验证未到点任务仍会触发、已错过任务会补发一次。

## 风险与注意事项

- **子进程 vscode 依赖**：第 5/6 步的两个文件只能 `import type`，
  违反即整组工具静默消失（3.2.23 同款事故）。
- **`setTimeout` 24.8 天上限**：不做分段续期会导致长延迟任务立即触发。
- **触发时 Chat 未就绪**：`restore()` 必须在 chatViewHost 初始化之后调用。
- **CLI 正忙时触发**：`sendUserMessageToCli` 会在上一轮未结束时插入消息。
  首版不做排队（保持简单）；若实测发现打断问题，再在 `fireWakeupJob` 里
  加一个「busy 则延后 30s 重试」的守卫。
- **任务流场景**：`taskRequestInjection.ts` 对某些工具做过屏蔽，
  需确认是否要把 wakeup 工具一并屏蔽（避免任务流自动续推与定时唤醒互相触发）。
