# 高优先级 Bug 修复方案（2026-08-30）

针对 `docs/project-review-2026-08-30.md` 第一节的三个高优先级问题，给出具体到
文件与方法的改造方案。三项互相独立，可分批落地，建议按 1.1 → 1.2 → 1.3 的顺序。

每项包含：**问题定位** → **根因** → **改造清单**（逐文件逐方法）→ **验收标准**。

---

## 1.1 定时唤醒触发失败即丢失（先删盘后投递）

### 问题定位

| 位置 | 说明 |
| --- | --- |
| `src/wakeupTools/wakeupScheduler.ts` `fire()` :157 | 先 `store.remove` / `store.add(next)` 再 `await this.onFire(...)` |
| `src/wakeupTools/wakeupScheduler.ts` :172-179 | 一次性任务走 `await this.store.remove(job.id)` |
| `src/wakeupTools/wakeupScheduler.ts` :181-186 | `onFire` 抛错只 `Logger.warn`，无补偿 |
| `src/wakeupTools/wakeupScheduler.ts` `restore()` :66 | 过期任务直接 `await this.fire(job)` |
| `src/extension.ts` :156 | `getWakeupScheduler()?.restore()` 的调用时机 |
| `src/wakeup/wakeupWiring.ts` `fireWakeupJob()` | 投递实现：`appendUserMessageAndSend(...)` |

### 根因

`fire()` 的写盘先于回调是**有意为之**（注释：「保证发送过程崩溃时重启不会重复唤醒同一轮」），
但它只防住了「重复触发」，没防住「投递失败」。两者需要区分处理：

- 进程崩溃 → 任务已删，不重复唤醒（当前行为正确，需保留）；
- 投递抛错（Chat 未打开、webview 未 ready）→ 任务已删，唤醒**永久丢失**（当前行为错误）。

`restore()` 在 `extension.ts:156` 虽已排在 Chat 命令注册之后，但 webview 的
`ready` 消息是异步回传的，注册完成 ≠ 可接收消息，补发窗口期正好撞在这里。

### 改造清单

#### (1) `src/wakeup/wakeupWiring.ts` — 新增未就绪缓冲

新增模块级队列与两个函数，让「Chat 未就绪」从异常降级为排队：

- `const pendingWakeups: WakeupJob[] = []` — 等待 Chat 就绪的任务缓冲。
- `let chatReady = false` — 由 webview ready 事件置位。
- 改造 `fireWakeupJob(job)`：投递前判断 `chatReady`，未就绪则 `pendingWakeups.push(job)`
  并 `Logger.info` 记录「Chat 未就绪，唤醒已入队」，**直接返回不抛错**；就绪则照常
  `await appendUserMessageAndSend(buildWakeupMessage(job))`。
- 新增 `export function flushPendingWakeups(): Promise<void>` — 置 `chatReady = true`，
  依次投递并清空 `pendingWakeups`；单条失败只 warn 不中断后续。

#### (2) `src/extension.ts` :60 / `src/runtime.ts` `setChatViewHost()` :70 — 在 Chat 宿主就绪处冲刷

本项目的 Chat 侧没有 webview `ready` 回传消息（`media/configView.js:1493` 的
`post('ready')` 属于**设置页**，由 `src/views/configView.ts:179` 消费，与 Chat 无关）。
Chat 的可投递判据是 `runtime.getChatViewHost()` 已被赋值。

因此改在 `src/runtime.ts` 的 `setChatViewHost(value)` :70 中：赋值后若
`value !== undefined`，则 `void flushPendingWakeups()`。为避免 `runtime.ts`
反向依赖 `wakeup/`，采用与本仓既有风格一致的回调注入——在 `runtime.ts` 增加
`setChatViewHostReadyHook(fn)`，由 `activation/relayWiring.ts`
`createWakeupPipeline()` :127 注入 `flushPendingWakeups`。

#### (3) `src/wakeupTools/wakeupScheduler.ts` `fire()` :157 — 失败回滚 + 有限重试

在 `WakeupScheduler` 上新增私有字段 `private readonly retryCounts = new Map<string, number>()`
与常量 `const MAX_FIRE_RETRIES = 3`、`const FIRE_RETRY_BACKOFF_MS = [5_000, 30_000, 120_000]`。

`fire()` 的 catch 分支由「只 warn」改为：

1. 读取 `this.retryCounts.get(job.id) ?? 0`；
2. 未超过 `MAX_FIRE_RETRIES` 时，把原任务以推迟后的 `fireAt`
   （`Date.now() + FIRE_RETRY_BACKOFF_MS[n]`）重新 `await this.store.add(...)`，
   再 `this.arm(...)`，并 `this.retryCounts.set(job.id, n + 1)`；
3. 超过上限则 `Logger.warn` 记录最终放弃，并 `this.retryCounts.delete(job.id)`。

投递成功时 `this.retryCounts.delete(job.id)`，避免 Map 无限增长；
`dispose()` 中一并 `this.retryCounts.clear()`。

> 注意：循环任务在 `fire()` 里已 `store.add(next)` 了下一轮，重试写回的是**当前这一轮**，
> 两条记录 id 相同会互相覆盖。故重试写回时需给重试任务生成新 id
> （`crypto.randomUUID()`）并把 `intervalSeconds` 置为 `undefined`，
> 使其成为一条一次性的补发任务，不影响原循环节奏。

#### (4) `src/wakeupTools/wakeupScheduler.ts` `restore()` :66 — 过期任务串行补发

当前 `for` 循环里 `await this.fire(job)` 会在 Chat 未就绪时逐条失败。改造 (1)
落地后失败已转为入队，此处只需补一条说明注释，指明「补发依赖 wakeupWiring
的就绪缓冲，此处不再假设 Chat 已可接收消息」，并把 `extension.ts:156` 上方那句
「必须在 chatViewHost 与 Chat 命令注册完成之后」的注释同步更新为
「就绪与否由 wakeupWiring 缓冲兜底，此处不再强依赖调用时机」。

### 验收标准

- 新增 `src/wakeupTools/__tests__/wakeupFireRetry.test.ts`：
  - `onFire` 首次抛错时，任务被重新写回 store 且定时器已重新武装；
  - 连续失败 3 次后不再写回，且 store 中无残留；
  - `onFire` 成功时 store 中无残留、`retryCounts` 已清理。
- 新增 `src/wakeupTools/__tests__/wakeupPendingQueue.test.ts`：
  - `chatReady = false` 时 `fireWakeupJob` 不抛错且不调用发送函数；
  - `flushPendingWakeups()` 后按入队顺序全部投递。
- `npm test` 全绿。

---

## 1.2 多窗口共用同一 wakeups.json，同一任务重复触发

### 问题定位

| 位置 | 说明 |
| --- | --- |
| `src/wakeupTools/wakeupStore.ts` `resolveRoot()` :208 | 工作区根优先，无工作区回退 `os.homedir()` |
| `src/wakeupTools/wakeupStore.ts` `resolveFilePath()` :195 | 拼出 `.LLSOAI/wakeups.json` |
| `src/wakeupTools/wakeupScheduler.ts` `restore()` :66 | 每个窗口各自 `load()` 并武装全部任务 |
| `src/activation/relayWiring.ts` `createWakeupPipeline()` :127 | 每个窗口各 `new WakeupScheduler(new WakeupStore(), fireWakeupJob)` |

### 根因

`WakeupStore` 只按路径定位文件，没有「谁拥有这条任务」的概念。两个窗口打开同一
工作区（或都无工作区、都回退到 `~/.LLSOAI/`）时，两个 `WakeupScheduler` 实例
都会在 `restore()` 里认领全部任务，于是同一条唤醒被投递两次。原子写只保证了
文件不半截，没解决逻辑上的双发。

### 改造清单

采用**任务持有者标记 + 心跳续约**方案（比全局文件锁更容错：窗口崩溃后任务能被接管）。

#### (1) `src/wakeupTools/wakeupStore.ts` — `WakeupJob` 增加持有者字段

在 `WakeupJob` 接口（:33）追加两个可选字段并写好注释：

- `ownerId?: string` — 认领该任务的窗口会话 id。
- `ownerHeartbeatAt?: string` — 持有者最近一次续约时间（ISO 8601）。

反序列化的逐条校验函数中放行这两个字段（非字符串则丢弃该字段而非整条任务）。

新增两个方法：

- `public async claim(id: string, ownerId: string, staleMs: number): Promise<boolean>`
  — 读文件，若目标任务无主、或持有者心跳早于 `Date.now() - staleMs`，
  则写入 `ownerId`/`ownerHeartbeatAt` 并原子落盘，返回 `true`；否则返回 `false`。
- `public async heartbeat(ownerId: string): Promise<void>`
  — 把该 owner 名下所有任务的 `ownerHeartbeatAt` 刷新为当前时间。

> `claim` 的读-改-写不是原子的，两个窗口仍可能同时读到无主状态。由于 `saveAll`
> 走 tmp + rename，后写者会覆盖先写者，最终文件里 `ownerId` 唯一；因此 `claim`
> 成功后需**重新 `load()` 校验 `ownerId` 确实是自己**，不是才放弃认领。

#### (2) `src/wakeupTools/wakeupScheduler.ts` — 只武装自己认领到的任务

- 构造函数新增 `private readonly ownerId = crypto.randomUUID()`，并加注释说明
  「每个扩展宿主实例一个 id，用于多窗口下的任务归属判定」。
- 新增常量 `const OWNER_STALE_MS = 90_000`（心跳间隔的 3 倍）与
  `const HEARTBEAT_INTERVAL_MS = 30_000`。
- `restore()` :66 的循环体改为：先 `await this.store.claim(job.id, this.ownerId, OWNER_STALE_MS)`，
  返回 `false`（已被别的窗口持有且心跳新鲜）则 `continue`，跳过该任务。
- 新增私有字段 `private heartbeatTimer?: NodeJS.Timeout`，在 `restore()` 末尾用
  `setInterval` 每 `HEARTBEAT_INTERVAL_MS` 调一次 `this.store.heartbeat(this.ownerId)`。
- `schedule()` :84 创建任务时直接带上 `ownerId: this.ownerId` 与当前心跳时间
  （谁下单谁持有，无需再抢）。
- `dispose()` :124 中 `clearInterval(this.heartbeatTimer)`。

#### (3) `src/wakeupTools/wakeupScheduler.ts` `fire()` :157 — 触发前二次确认归属

`fire()` 开头（`this.disarm(job.id)` 之后）追加一次归属校验：`await this.store.load()`
找到同 id 任务，若其 `ownerId` 已不是 `this.ownerId`，说明该任务在定时器等待期间
被别的窗口接管，直接 `return` 不投递。这道校验用于兜住「窗口 A 挂起很久、心跳过期、
窗口 B 接管后 A 又恢复」的竞态。

### 验收标准

- 新增 `src/wakeupTools/__tests__/wakeupOwnership.test.ts`：
  - 两个 `WakeupScheduler` 共用一个临时目录的 store，同时 `restore()`，
    断言同一任务的 `onFire` 只被调用一次；
  - 持有者心跳过期后，另一实例能成功 `claim` 并触发；
  - `fire()` 在归属已易主时不投递。
- `npm test` 全绿。

---

## 1.3 设置页 Webview 渲染未做 HTML 转义

### 问题定位

| 位置 | 说明 |
| --- | --- |
| `media/configView.js` `text()` :849 | 仅 `String()` 转换，无任何转义 |
| `media/configView.js` `render()` :861 | 整树 `app.innerHTML = ...` 模板串拼接 |
| `media/configView.js` `renderProvider()` :1040 | `data-provider-id="${text(provider.id)}"` :1042、`<h3>${text(provider.name)}</h3>`、`provider-meta` 拼 `baseUrl`/`apiType` |
| `media/configView.js` `renderModels()` :1064 | `<tr data-model-id="${text(model.modelId)}">` :1076 |
| `src/views/configView.ts` `importConfig()` :342 | 第三方 JSON 经 `manager.importConfig` 进入同一渲染路径 |

全文件共 26 处 `text(` 调用，均为注入点；其中 2 处位于 HTML 属性值内（:1042、:1076），
风险高于文本节点位置——`"` 可直接逃出属性。

### 根因

`text()` 的函数注释写着「创建安全文本节点，避免 HTML 注入」，实现却只做了
`String()` 转换，名实不符。CSP 的 nonce script-src 能挡住 `<script>` 执行，
但挡不住 HTML 结构注入与属性逃逸（如把 `data-provider-id` 撑开后追加
`onclick` 属性——虽然内联事件同样被 CSP 拦，但布局破坏与钓鱼式伪造 UI 仍可达成）。

用户可编辑字段（provider 名称、baseUrl、模型 displayName）本就可能含 `&`、`<`；
「导入配置」引入的第三方 JSON 更不可信。

### 改造清单

#### (1) `media/configView.js` `text()` :849 — 补齐五连转义

改为对 `& < > " '` 五个字符做实体替换，`&` 必须最先替换以免二次转义：

```js
/** HTML 转义：把值安全嵌入 innerHTML 文本位置与属性值内。 */
function text(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
```

同步修正函数注释（当前写的是「创建安全文本节点」，实际返回的是转义后的字符串）。

#### (2) `media/configView.js` — 排查漏用 `text()` 的插值

对全文件 `${...}` 插值做一次清点，凡是**来源于 state 而非 i18n**的表达式都必须
过 `text()`。已核对的位置与结论：

- `renderProvider()` :1046 `provider-meta` 内的 `provider.baseUrl` / `provider.apiType`
  — 已过 `text()`，(1) 落地后自动修复；
- `renderProviderModal()` :1115-1116 的 `value="${text(provider.name)}"` /
  `value="${text(provider.baseUrl)}"` — 已过 `text()`，同上；
- `renderProviderModal()` :1119-1123 的 `<option value="${item}">` — `item` 取自
  代码内写死的字面量数组（`'openai-compatible'` 等），非用户输入，无需处理；
- `renderModels()` :1076 起表格内的 `model.displayName` / `model.modelId`
  与 `renderModelModal()` :1137 起的表单回填 — **需逐个核对是否漏用 `text()`**，
  漏用处补上。

i18n 返回值（`t()` / `tf()`）来自扩展自带的 `package.nls*.json`，属可信来源，不强制转义。

> 结论：绝大多数注入点已经调用了 `text()`，只是 `text()` 自身没做转义。
> 因此 (1) 是本项的**主修复**，(2) 只是补齐少数漏网插值。

#### (3) `media/configView.js` — 属性值加引号一致性

确认两处 `data-*` 属性（:1042、:1076）均使用双引号包裹；转义后 `"` 已变实体，
不再可逃逸。若存在无引号或单引号包裹的属性，一并统一为双引号。

#### (4) `src/views/configView.ts` `importConfig()` :342 — 导入前基本校验

`JSON.parse(text)` 的结果直接交给 `this.manager.importConfig`，缺少形状校验。
追加一次守卫：非对象或 `providers` 非数组时 `postToast('error', ...)` 并返回，
避免畸形结构在渲染层触发更难排查的问题。这一步是纵深防御，不替代 (1) 的转义。

### 验收标准

- 新增 `src/__tests__/configViewEscape.test.ts`：从 `media/configView.js` 中
  提取 `text()` 实现（或抽到可被 Node 引入的小模块）后断言：
  - `text('<img src=x>')` 输出不含裸 `<`；
  - `text('a" onclick="alert(1)')` 输出不含裸 `"`；
  - `text('&lt;')` 输出为 `&amp;lt;`（验证 `&` 先行替换，无二次转义歧义）。
- 手工验证：新建一个名为 `<b>x</b>"y` 的 provider，设置页应原样显示该字符串，
  卡片布局不破裂，`data-provider-id` 属性完整。
- `npm test` 全绿，`get_errors` 无诊断。

---

## 落地顺序与影响面

| 顺序 | 项 | 影响面 | 回归风险 |
| --- | --- | --- | --- |
| 1 | 1.1 唤醒丢失 | `wakeupScheduler` / `wakeupWiring` / `activation/wiring` | 中（改动触发链路，需测试覆盖） |
| 2 | 1.2 多窗口双发 | `wakeupStore` / `wakeupScheduler` / 磁盘 schema | 中（新增字段需向后兼容旧文件） |
| 3 | 1.3 转义 | `media/configView.js` / `views/configView.ts` | 低（纯输出侧加固） |

1.2 引入的 `ownerId` / `ownerHeartbeatAt` 是可选字段，旧 `wakeups.json` 读入后
两字段为 `undefined`，会被视为无主任务由首个窗口认领，无需迁移脚本。
