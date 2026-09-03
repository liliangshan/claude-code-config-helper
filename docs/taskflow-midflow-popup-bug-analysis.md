# 任务流中途停止并弹窗「是否继续」问题原因分析

> 现象：任务流跑到中间会停止，并弹出要求用户确认「是否继续」的弹窗。
> 预期：该类恢复弹窗只应在应用（VS Code 窗口）新启动时出现一次；
> 任务流运行过程中即使出错也应自动继续，不应弹任何需要人工确认的窗。

## 一、排查范围：任务流期间可能出现的全部弹窗

| # | 弹窗 | 位置 | 触发条件 | 是否会中断任务流 |
|---|------|------|----------|------------------|
| 1 | 任务流恢复对话框（继续/清除/稍后） | webview `taskFlow/restorePrompt`，扩展端 `taskFlowCommands.ts:155` | 仅当 `pendingRestorePrompt=true` 且 webview 发出 `ready` | 会（等待三选一） |
| 2 | AskUserQuestion 确认弹窗「助手需要您的确认，必须回复后才能继续」 | `cliEventHandlers.ts:220-232` → webview `askUser/request` | 模型调用 AskUserQuestion 工具 | 会（CLI 阻塞等回答） |
| 3 | 熔断警告「自动续推已暂停，请手动发送新的提示词」 | `autoContinue.ts:262-268` `tripCircuitBreaker` | 连续 4 次「本轮未调用任何工具」 | 会（自动续推停止） |
| 4 | CLI 异常退出弹窗「异常退出：…（重启 CLI）」 | `cliLifecycle.ts:434` | CLI 非零退出且不在预期退出名单 | 会（等待点重启） |

其中 #1 是设计上「只在启动时弹一次」的对话框：标志位仅在
`extension.ts:85`（activate 期）由 `llsTaskService.restore()` 置位，
`maybePostTaskFlowRestorePrompt` 下发一次后立即清零。全仓 grep 确认没有
其它写入点，**#1 本身不会在任务流中途凭空再弹**——除非 Chat webview 在
任务流已经跑起来之后才第一次完成初始化（`webview/ready` 每次 webview 重建
都会触发，`webviewMessages.ts:132` 无条件调用 `maybePostTaskFlowRestorePrompt`）。

## 二、已排除项（经用户确认）

| 候选 | 结论 | 排除理由 |
|------|------|----------|
| A. 模型调用 AskUserQuestion 问「是否继续」 | **排除** | 任务流中间该 MCP 工具已被过滤，不会走到弹窗链路 |
| B. 连续缺失工具调用熔断（`autoContinue.ts:262`） | **排除（非弹窗）** | `showWarningMessage` 只是右下角通知，不阻塞、不要求确认；但它仍会**静默停掉自动续推**，可能是「任务流停止」的贡献因素 |
| C. 普通工具授权模态框（`cliEventHandlers.ts:252`） | **排除** | 用户运行在 bypassPermissions 模式，该分支自动放行 |
| D. CLI 异常退出弹窗（`cliLifecycle.ts:434`，带「重启 CLI」按钮） | **保留待查** | 弹窗样式不符（是错误弹窗不是「继续」对话框），但可能是「任务流停止」的原因之一 |

已确认用户看到的就是 **VS Code 刚打开时那个「任务流恢复」对话框**
（webview 内 继续/清除/稍后 三选一，`media/chat/index.html:133`，由
`taskFlow/restorePrompt` 消息触发）。

## 三、确认目标后的根因：pendingRestorePrompt 标志滞留 + webview 首次 ready 迟到

恢复对话框的完整触发链：

1. activate 期 `extension.ts:85`：`setPendingRestorePrompt(await llsTaskService.restore())`
   ——磁盘上有未完成任务流就把标志置 true；
2. 标志的**唯一消费点**是 webview 发来第一条 `webview/ready`
   （`webviewMessages.ts:132` → `maybePostTaskFlowRestorePrompt`，
   `taskFlowCommands.ts:155`：弹一次后清标志）。

问题在于：**`webview/ready` 不一定发生在启动时**。Chat webview 是懒加载的
（`resolveWebviewView` 只在视图真正可见时才被 VS Code 调用），如果启动时
Chat 面板没展开 / 被折叠 / `autoOpenBuiltInChatIfCliConfigured` 拉起失败，
标志就一直挂着，等的是「第一次真正 resolve」的那一刻。

而任务流这边**并不需要 webview 就能继续跑**：

- 用户从状态栏「CC任务流」菜单点「继续推进」（`taskFlowCommands.ts:111`），
  或恢复后由其它路径续推——这些路径**都不清 pendingRestorePrompt**；
- 更关键的是每一轮自动续推 `appendUserMessageAndSend`
  （`chatMessaging.ts:519`）第一行就是 `openBuiltInChat()` → `host.open()` →
  `revealSidebarView()`——**它会主动把之前从没 resolve 过的 webview 拉起来**。

于是出现精确匹配用户描述的时序：

```
启动：恢复出未完成任务流，标志=true，但 Chat 面板未展开 → ready 没来，弹窗没弹
  ↓ 用户继续/自动续推任务流（不经过 webview，标志仍=true）
中途某轮续推：appendUserMessageAndSend → openBuiltInChat 首次 resolve webview
  ↓ main.js 加载完成 → post webview/ready
  ↓ maybePostTaskFlowRestorePrompt：标志=true 且 workflow 活跃 → 下发 restorePrompt
任务流跑到一半，「启动时那个继续弹窗」凭空弹出（showModal 模态，盖住整个 Chat 面板）
```

弹窗与「任务流停止」的关系：

- 该 `<dialog>.showModal()` 会阻塞整个 Chat webview 交互（输入框、按钮全部
  不可点），用户视角就是任务流卡住 + 弹窗问是否继续；
- 若用户在弹窗里点「清除」，`handleTaskFlowRestoreChoice('clear')` 直接
  `clearLlsCcaiTask()`，正在跑的任务流被整个清掉——中途误点破坏性极强；
- 另外两条独立的「停止」来源仍并存：B 的熔断静默停续推、D 的 CLI 异常退出。

补充一条同源变体：若启动时弹窗确实弹了但用户没处理（面板随即被切走，
`retainContextWhenHidden: true` 让 DOM 里的模态框一直开着），之后中途回到
Chat 面板也会「看到」这个弹窗——表现相同，根因相同（弹窗生命周期没有和
任务流运行状态联动）。

## 四、修复方向建议（待确认后再动代码）

核心原则：恢复弹窗只服务「启动时任务流处于闲置等待」的场景，任务流一旦
被任何路径继续，就不该再弹。

1. **maybePostTaskFlowRestorePrompt 增加运行态判断**（主修复）：
   下发 restorePrompt 前检查任务流是否已经在推进中——自动续推调度器有
   定时器/看门狗在挂、或 normal 路由 busy、或最近一次续推提交时间在阈值内
   ——满足任一条件则直接清标志、不弹窗；
2. **所有「继续任务流」路径主动清标志**：状态栏菜单「继续推进」、
   `continueLlsCcaiTask`、自动续推首次提交时都调 `setPendingRestorePrompt(false)`，
   让标志的语义收敛为「恢复后尚未有人碰过这个任务流」；
3. **（配套）D 项去弹窗**：任务流活跃时 CLI 异常退出不弹「重启 CLI」确认，
   自动重启并续推，只在 Chat 区留一条提示；
4. **（配套）B 项联动**：`applyTaskFlowModelForContinue` 切换成功后
   `resetMissingToolCounter`，避免主模型阶段计数带进任务流模型阶段过早熔断。

1+2 是必改；3、4 建议一并做，保证「任务流过程中即使有错误也自动继续」。



