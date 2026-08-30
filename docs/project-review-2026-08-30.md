# 项目体检报告（2026-08-30）

对 claude-code-config-helper（v3.2.29，src 83 个 TS 文件约 3.8 万行）做的一次
整体审查，覆盖正确性、安全、健壮性与可维护性四个维度。
问题按严重程度排序，均给出具体文件与方法定位。

## 一、疑似 Bug（高优先级）

### 1.1 定时唤醒触发失败即丢失（先删盘后投递）

- 位置：`src/wakeupTools/wakeupScheduler.ts` `fire()`（:157）。
- 现象：一次性任务先 `store.remove` 再 `await this.onFire(...)`；若投递失败
  （Chat 未打开、扩展刚激活 webview 未就绪），异常只记 warn，任务已从磁盘删除，
  这条唤醒**永久丢失**。`restore()`（:66）对过期任务立即补发，恰恰最容易撞上
  「激活早于 Chat 就绪」的窗口。
- 建议：投递失败时把任务写回磁盘并做有限次退避重试；或由 `extension.ts` 的
  `fireWakeupJob` 在 Chat 未就绪时排队缓冲，待 webview ready 后统一冲刷。

### 1.2 多窗口共用同一 wakeups.json，同一任务会重复触发

- 位置：`src/wakeupTools/wakeupStore.ts` `resolveBaseDir()`（:202）与
  `wakeupScheduler.ts` `restore()`/`arm()`。
- 现象：两个 VS Code 窗口打开同一工作区（或都无工作区、回退到 `~/.LLSOAI/`）时，
  各自的 `WakeupScheduler` 都会 `restore()` 并武装同一批任务——同一条唤醒在
  两个窗口各触发一次，且互相竞争写同一文件（尽管有 tmp+rename，逻辑上仍双发）。
- 建议：文件级互斥（如 `wakeups.lock` 记录 pid + 心跳），或在任务上记录
  持有者会话 id，restore 时只认领无主/过期持有者的任务。

### 1.3 设置页 Webview 渲染未做 HTML 转义

- 位置：`media/configView.js` `text()`（:849，仅 `String()` 转换不转义）、
  `renderProvider()`（:1040 起，模板串直接拼进 `innerHTML`，:869）。
- 现象：provider 名称、baseUrl、模型 displayName 等用户可编辑字段未经转义直接
  注入 `innerHTML` 与 HTML 属性。CSP（nonce script-src）能挡住脚本执行，但仍
  存在 HTML/属性注入：`"` 可逃出 `data-provider-id="…"` 属性、`<` 可破坏布局；
  通过「导入配置」（`src/views/configView.ts` `importConfig()` :349）引入的
  第三方 JSON 同样走这条渲染路径。
- 建议：`text()` 补上 `&<>"'` 五连转义；属性值单独用 `encodeURIComponent`
  或统一改为 `createElement` + `textContent` 渲染。

## 二、健壮性 / 安全（中优先级）

> 已评估、决定接受的风险（不处理）：
> - **本机 HTTP 桥无鉴权**（relay 与三条工具桥仅监听 127.0.0.1，无 token 校验）——
>   仅本机可达，威胁模型限定为「其它机器不侵入本机」，接受现状。
> - **浏览器登录态 cookie 明文落盘**（`.LLSOAI/` 下 JSON）——同上，
>   本机文件不设防，接受现状。

### 2.1 configView 消息分发对单条失败的兜底不均匀

- 位置：`src/views/configView.ts` 消息 switch（:210 前后，仅 :257/:265/:378
  三处 catch）。
- 现象：大部分 `case` 里的 `await this.manager.*` 若抛错，只落在外层统一
  catch（若有）或直接变成未处理拒绝，webview 侧按钮停在 loading 态没有 toast。
- 建议：在 dispatch 外层包一个统一 catch，把 `Error.message` 用
  `postToast('error', …)` 回传，并附带回滚 loading 状态的消息。

### 2.2 `fetchModels` 未设 `redirect` / 响应体大小限制

- 位置：`src/modelFetcher.ts` `fetchModels()`（:199 起）。
- 现象：`res.json()` 对任意大小响应全量读入；恶意/配置错误的 baseUrl
  返回超大 body 会撑内存。relay 侧已有 10 MiB 上限
  （`src/relay/router.ts` MAX_BODY_BYTES :40）可以对齐。
- 建议：读 `content-length` 预判 + 流式截断，超限直接报错。

## 三、可维护性 / 清理项（低优先级）

### 3.1 `src/extension.ts` 过大（5262 行）

`activate()`（:4809）承担 relay、chat、四套 MCP 注入、任务流、状态栏等
所有装配逻辑。建议按子系统拆分为 `activation/*.ts` 装配模块，
`extension.ts` 只保留编排顺序，可显著降低回归风险。

### 3.2 遗留文件与硬编码版本

- `media/chat/style copy.css`（375 KB）未被 `index.html` 引用，纯遗留，
  且会被打进 VSIX（`.vscodeignore` 未排除），白白增大安装包。
- 三个 MCP 子进程 serverInfo 版本硬编码 `1.0.0`
  （`vscodeMcpServer.ts:136`、`wakeupMcpServer.ts:155`、
  `browserMcpServer.ts:144`），与扩展版本脱节，排查线上问题时无法对应。

### 3.3 四套 MCP 桥结构高度重复

`browserTools` / `vscodeTools` / `wakeupTools`（以及 expertMode 的
askExpert）各自复制了「tools.ts + host + httpBridge + stdio server」四件套，
JSON-RPC 收发、行缓冲、UNAVAILABLE 兜底逻辑几乎逐字相同。可提炼一个
`mcpKit`（stdio framing + relay 转发 + 错误包装），新工具只声明 schema
与 executor。注意保持「子进程禁止静态 import 宿主模块」的既有约束。

### 3.4 测试覆盖缺口

- `src/relay/` 仅 tokenBudget 与集成测试有覆盖，`router.ts` 的模型路由
  解析（`<providerId>/<modelId>` 回退逻辑）与 `anthropicProxy.ts` 的头部
  清洗（forwardHeadersCommon）无单测。
- `media/` 两个 webview（合计 7500+ 行 JS）完全无测试，i18n 键遗漏、
  渲染回归只能靠人工点。
- `ConfigManager` 除本次新增的 `replaceProviderModels` 外，
  `importConfig` / `deleteProvider` 的密钥清理路径也值得补测。

## 四、总体评价

架构清晰（relay / chat / 工具桥 / 配置四层边界明确），中文注释覆盖率高，
危险路径（原子写、串行队列、子进程隔离）都有意识地处理过，且带回归测试。
最值得优先投入的是 **1.1 唤醒丢失**（功能可靠性）与 **1.2 多窗口双发**，
其次是 **1.3 转义**（安全加固），
其余为工程质量改进，可随版本迭代逐步消化。

> 备注：
> - 模型拉取（`GET /models`）按行业惯例一次性返回全量列表、不做分页，
>   因此「未返回即删除」的合并语义是安全的，不列为问题。
> - 本机桥鉴权与 cookie 明文落盘已评估为可接受风险（威胁模型限定为
>   本机不被其它机器侵入），见第二节备注。
