# 内置浏览器登录态持久化落地方案

> 目标：让 VS Code 内置浏览器（agent 侧）在页面关闭 / 扩展重启后仍保留登录态。
> 本文只描述落地设计，不含实施。所有 CDP 能力均已在 2026-08-01 实测验证。

## 1. 问题与实测依据

### 1.1 为什么会丢

VS Code 1.110 起给 agent 用的内置浏览器页面运行在**私有、内存态会话**中（见
`VSCODE_INTEGRATED_BROWSER_NOTES.md` 第 93 行），页面关闭即全部丢弃。
本项目侧也无任何持久化：`browserToolHost.ts:92` 的 `currentPageId` 仅存内存。

### 1.2 实测结论（决定技术选型）

| 能力 | 结果 |
| --- | --- |
| `context.storageState()` | ❌ `Protocol error (Storage.getCookies): Method not found` |
| `context.addCookies()` | ❌ `Protocol error (Storage.setCookies): Method not found` |
| CDP `Network.getAllCookies` | ✅ 可读，**含 HttpOnly** |
| CDP `Network.setCookies` | ✅ 可写，`httpOnly` / `secure` / `expires` 均保留 |
| `page.evaluate` 读写 localStorage / sessionStorage | ✅ |

**结论：Playwright 高层 storageState API 被 VS Code 阉割，必须走裸 CDP。**

### 1.3 端到端验证（console.xingchiyun.com）

1. 登录成功 → 导出得到 cookie `gtxi_auth_token`（`.xingchiyun.com`，JWT）
   + localStorage `token`，sessionStorage 为空。
2. 关闭页面 → 重开，cookie 与 localStorage 全空，被重定向至 `/login`。
3. 灌回 cookie + localStorage 后 `goto('/dashboard')` → **直接进入服务总览，未走登录页**，
   账号 / 余额 / 账单数据均正确。

> 观察到的副作用：注入后若不 reload，首屏接口会抢跑在 token 生效前，
> 导致「我的资源」显示 0。**故恢复流程必须「先注入、后导航」。**

## 2. 前置缺陷（阻塞项，必须先修）

这两个 bug 在验证过程中直接卡死流程，且会阻塞自动恢复。

### 2.1 pageId 正则无法识别「已有相似页面」响应

`src/browserTools/browserToolHost.ts:14`

```ts
const PAGE_ID_RE = /Page ID:\s*([0-9a-fA-F-]{36})/;
```

底层 `open_browser_page` 在检测到同源页面已存在时，返回的不是 `Page ID: <uuid>`，而是：

```
At least one similar page is already open:
  - [301e1dd0-4636-4341-af6a-864738f9fc54] about:blank (about:blank) (active)
Use an existing page or pass `forceNew: true` to open a new one.
```

`runOpen` 解析不到 id，`currentPageId` 保持为上一个**已销毁**的页面 id，
后续所有工具调用一律 `Page "<old-id>" not found`，且无法自愈。

**改动点**：`browserToolHost.ts` 增加第二条正则 `/^\s*-\s*\[([0-9a-fA-F-]{36})\]/m`，
`runOpen` 在主正则未命中时回退匹配，取第一个 id 写入 `currentPageId`。

### 2.2 `browser_open` 未暴露 `forceNew`

`src/browserTools/tools.ts:47-56` 的 inputSchema 只有 `url`，
而底层工具支持 `forceNew: true`。页面被占用时无法强制新开。

**改动点**：
- `tools.ts`：`browser_open` 的 `properties` 增加 `forceNew: { type: 'boolean' }`（非必填）。
- `browserToolHost.ts` 的 `runOpen`：透传 `forceNew` 给 `LM_BROWSER_TOOLS.open`。

## 3. 总体设计

### 3.1 触发策略

| 行为 | 策略 |
| --- | --- |
| 恢复 | **全自动**。`browser_open` 拿到 pageId 后，按 origin 查存储并注入，然后再导航。 |
| 保存 | **全自动搭车**。每次浏览器工具调用完成后尝试快照当前 origin。 |
| 清除 | **不提供独立工具**。用户在站点内登出后，下一次搭车快照如实存入空态，即等于清除。 |

> 设计说明：早期考虑过「非空守卫」（快照为空时拒绝覆盖），已否决。
> 用户主动登出时空 cookie 就是正确状态，守卫会导致下次打开又被灌回旧 token，
> 违背用户意图��极难排查。**空即是空，如实覆盖。**

### 3.2 脏数据防护：判据是「状态是否落定」，不是「内容是否为空」

搭车快照仅在**同时满足**下列条件时才写入：

1. 当前页 URL 的 origin 为 `http(s)` 协议（排除 `about:blank`、`chrome-error://` 等）。
2. 页面已加载完成（`document.readyState === 'complete'`），排除导航中途抓拍。
3. 当前 origin 与本次待写 origin 一致（防止 OAuth 跳到 `sso.xxx.com` 时存错格子）。

任一不满足则**跳过本次快照（不写入，不清除）**，保留上一次结果。

### 3.3 存储

采用 **`vscode.ExtensionContext.secrets`（SecretStorage）**，走系统钥匙串加密。
cookie 等价于密码，明文落盘风险过高。

- key 格式：`llsccai.browserSession.<origin>`，例如 `llsccai.browserSession.https://console.xingchiyun.com`
- value：`JSON.stringify(BrowserSessionSnapshot)`
- 另存一个索引 key `llsccai.browserSession.__index`，值为 origin 字符串数组，
  用于枚举与清理（SecretStorage 无 list API）。

## 4. 文件与方法清单

### 4.1 新增 `src/browserTools/sessionStore.ts`

负责快照的序列化与 SecretStorage 读写，**不含任何 CDP 逻辑**（便于单测）。

```ts
/** 单个 origin 的浏览器会话快照。 */
export interface BrowserSessionSnapshot {
    /** 快照所属 origin，如 https://console.xingchiyun.com。 */
    origin: string;
    /** 保存时间 ISO 字符串。 */
    savedAt: string;
    /** CDP Network.getAllCookies 原样返回的 cookie 数组。 */
    cookies: BrowserCookie[];
    /** localStorage 键值对。 */
    localStorage: [string, string][];
    /** sessionStorage 键值对。 */
    sessionStorage: [string, string][];
}

/** CDP cookie 结构中需要持久化并可回灌的字段子集。 */
export interface BrowserCookie {
    name: string; value: string; domain: string; path: string;
    secure: boolean; httpOnly: boolean; expires?: number;
    sameSite?: 'Strict' | 'Lax' | 'None';
}
```

| 方法 | 签名 | 职责 |
| --- | --- | --- |
| `constructor` | `(secrets: vscode.SecretStorage)` | 注入 SecretStorage，便于单测替身。 |
| `load` | `(origin: string): Promise<BrowserSessionSnapshot \| undefined>` | 读取并 JSON 反序列化；解析失败返回 undefined 并记 warn。 |
| `save` | `(snapshot: BrowserSessionSnapshot): Promise<void>` | 写入快照并更新索引。 |
| `delete` | `(origin: string): Promise<void>` | 删除快照并从索引移除。 |
| `listOrigins` | `(): Promise<string[]>` | 读索引，供后续清理 UI 使用。 |
| `private readIndex` / `writeIndex` | — | 索引 key 的读写。 |

模块级纯函数（便于单测，不依赖 vscode）：

| 函数 | 签名 | 职责 |
| --- | --- | --- |
| `toOrigin` | `(url: string): string \| undefined` | 提取 origin；非 http(s) 返回 undefined。**3.2 条件 1 的实现**。 |
| `sanitizeCookies` | `(raw: unknown[]): BrowserCookie[]` | 裁剪 CDP cookie 到可回灌字段，丢弃 `size`/`priority`/`sourcePort` 等只读字段。 |
| `isExpired` | `(c: BrowserCookie, now: number): boolean` | 过滤已过期 cookie，避免灌回无效凭证。 |

### 4.2 新增 `src/browserTools/sessionBridge.ts`

负责通过 `run_playwright_code` 在页面里执行导出 / 注入脚本。
之所以独立成文件：脚本是字符串常量，与宿主分派逻辑关注点不同。

| 导出项 | 签名 | 职责 |
| --- | --- | --- |
| `EXPORT_SCRIPT` | `const string` | 见 4.2.1。返回 JSON 字符串。 |
| `buildImportScript` | `(snapshot: BrowserSessionSnapshot): string` | 见 4.2.2。把快照内联进脚本。 |
| `parseExportResult` | `(text: string): BrowserSessionSnapshot \| undefined` | 解析 `run_playwright_code` 返回文本中的 JSON 负载；失败返回 undefined。 |

> 注意：`run_playwright_code` 的返回文本形如 `Result: "<json>"` 且后面跟着 Snapshot 段，
> `parseExportResult` 需按 `Result:` 前缀截取并做两层反序列化（外层字符串、内层对象）。

#### 4.2.1 导出脚本要点

```js
// readyState 判定即 3.2 条件 2
if (document.readyState !== 'complete') return JSON.stringify({ skip: 'not-complete' });
const s = await page.context().newCDPSession(page);
// 必须用 CDP：context.storageState() 在 VS Code 内置浏览器不可用
const cookies = (await s.send('Network.getAllCookies')).cookies;
const ls = await page.evaluate(() => Object.entries(localStorage));
const ss = await page.evaluate(() => Object.entries(sessionStorage));
```

#### 4.2.2 注入脚本要点

```js
const s = await page.context().newCDPSession(page);
await s.send('Network.setCookies', { cookies: <inlined> });
await page.evaluate((e) => { for (const [k,v] of e) localStorage.setItem(k,v); }, <inlined>);
// sessionStorage 同理
```

**不在注入脚本内导航**，导航由宿主在注入完成后单独发起（见 4.3）。

### 4.3 改造 `src/browserTools/browserToolHost.ts`

新增字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionStore?` | `BrowserSessionStore` | 可选注入；缺省时整套持久化静默禁用（子进程 / 单测场景）。 |
| `currentOrigin?` | `string` | 当前页 origin，供搭车快照做 3.2 条件 3 校验。 |

新增私有方法：

| 方法 | 签名 | 职责 |
| --- | --- | --- |
| `restoreSession` | `(url: string): Promise<void>` | 按 origin 查快照 → `buildImportScript` → 经 `run_playwright_code` 注入。无快照则直接返回。 |
| `captureSession` | `(): Promise<void>` | 执行 `EXPORT_SCRIPT` → `parseExportResult` → 校验 3.2 三条件 → `sessionStore.save()`。 |
| `safeCapture` | `(): Promise<void>` | 包裹 `captureSession`，吞掉所有异常并记 warn。**持久化失败绝不能影响主工具返回值。** |

改造 `runOpen`（`browserToolHost.ts:132`），新流程：

1. 调 `open_browser_page`，透传 `forceNew`（§2.2）。
2. 解析 pageId，主正则失败则回退「相似页面」正则（§2.1）。
3. **若命中已存快照**：先 `restoreSession(url)` 注入，再 `navigate_page` 跳到目标 url。
   顺序不可颠倒，否则首屏接口抢跑（§1.3）。
4. 返回导航后的页面文本。

改造 `execute`（`browserToolHost.ts:102`）：
在 `switch` 得到结果后、`return` 之前，对**除 `browser_open` 外**的所有工具
追加 `await this.safeCapture()`。
（`browser_open` 自身在步骤 3 已处理，且此刻页面刚导航完，交由下次调用搭车更稳。）

### 4.4 改造 `src/browserTools/httpBridge.ts`

`createBrowserToolRelayHandler`（`httpBridge.ts:39`）当前默认 `new BrowserToolHost()`，
无法拿到 SecretStorage。

**改动点**：签名增加可选第二参 `sessionStore?: BrowserSessionStore`，
用于构造带持久化能力的 `BrowserToolHost`。
子进程侧 `BrowserHttpForwardingHost` **无需改动**——它只转发，持久化统一在宿主侧发生。

### 4.5 改造 `src/extension.ts`

`activate` 中已有 `context`（`extension.ts:4656`），`context.secrets` 可直接用。

**改动点**：`extension.ts:4787`

```ts
// 现状
const browserToolRelayHandler = createBrowserToolRelayHandler();
// 改为
const browserSessionStore = new BrowserSessionStore(context.secrets);
const browserToolRelayHandler = createBrowserToolRelayHandler(undefined, browserSessionStore);
```

### 4.6 补充测试 `src/browserTools/__tests__/browserTools.test.ts`

现有测试已用 `installVscodeStub` + `lm.invokeTool` 桩，沿用该模式。新增用例：

| 用例 | 断言 |
| --- | --- |
| 「相似页面」响应解析 | 喂入 §2.1 的多行文本，`currentPageId` 被正确更新为 `301e1dd0-...`。 |
| `forceNew` 透传 | `browser_open({url, forceNew:true})` 时底层 input 含 `forceNew: true`。 |
| 有快照时先注入后导航 | 断言 `run_playwright_code`（注入）调用序号 < `navigate_page`。 |
| `readyState` 未完成时跳过 | 导出脚本返回 `{skip:'not-complete'}` 时 `sessionStore.save` 零调用。 |
| origin 不匹配时跳过 | 当前页 origin 与待写 origin 不同，`save` 零调用。 |
| 登出即清除 | 导出结果 cookie 为空数组时，`save` **被调用**且写入空数组（验证无守卫）。 |
| 持久化异常不影响主流程 | `sessionStore.save` 抛错时，工具仍返回正常 content 且 `isError` 不��� true。 |

> `package.json:648` 的 `test` 脚本目前只扫 `out/chat/__tests__/*.test.js`，
> **需一并扩展为覆盖 `out/browserTools/__tests__/*.test.js`**，否则新用例不会被执行。

## 5. 实施顺序

1. 修复 §2.1 / §2.2 两个前置缺陷 + 对应测试（可独立验证、独立提交）。
2. 新增 `sessionStore.ts` + 纯函数单测。
3. 新增 `sessionBridge.ts` + 解析函数单测。
4. 改造 `browserToolHost.ts` 接入恢复与搭车保存。
5. 打通 `httpBridge.ts` / `extension.ts` 注入链路。
6. 扩展 `package.json` test glob，跑全量测试。
7. 端到端复测：console.xingchiyun.com 登录 → 关页 → 重开验证免登录 → 站内登出 → 重开验证不再自动登录。

## 6. 风险与取舍

| 风险 | 处置 |
| --- | --- |
| 每次工具调用都搭车快照，增加一次 `run_playwright_code` 往返 | 导出脚本轻量；且 `readyState` 未完成时提前返回。若实测有感知延迟，再考虑按 origin 做节流。 |
| SecretStorage 无 list API | 自维护 `__index` key（§3.3）。 |
| 凭证长期驻留钥匙串 | `isExpired` 在灌回时过滤过期 cookie；后续可加「清除全部浏览器会话」命令。 |
| IndexedDB 型登录态（如 Firebase Auth）不被覆盖 | 本期不做。实现复杂度显著更高，待有实际站点需求再评估。 |
