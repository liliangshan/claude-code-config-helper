# 任务流恢复弹窗中途误弹修复方案

> 关联分析文档：[taskflow-midflow-popup-bug-analysis.md](./taskflow-midflow-popup-bug-analysis.md)
> 目标：恢复弹窗只服务「启动时任务流闲置等待」的场景；即使误弹，也在倒计时
> 结束后自动选「继续推进」，绝不让任务流卡死或被误清。

## 修复一：恢复弹窗加 10 秒倒计时，超时自动「继续」（webview 端，核心兜底）

**文件：`media/chat/main.js`**

1. **`showTaskRestoreDialog(payload)`（约 1573 行）** —— 弹出后启动倒计时：
   - 新增模块级变量 `taskRestoreCountdownTimer`（`setInterval` 句柄）与剩余秒数；
   - `showModal()` 之后每秒刷新「继续」按钮文案为
     `t('restoreContinue') + ' (' + remain + 's)'`（按钮元素
     `taskRestoreContinueEl`，465 行已取得）；
   - 倒数到 0 时调用 `resolveTaskRestore('continue')`，行为与用户手动点
     「继续」完全一致（回传 `taskFlow/restoreChoice: continue`，扩展端走
     `handleTaskFlowRestoreChoice('continue')` → `appendUserMessageAndSend` 续推）。
2. **`resolveTaskRestore(choice)`（约 1587 行）** —— 关闭弹窗前清掉倒计时：
   - `clearInterval(taskRestoreCountdownTimer)` 并把「继续」按钮文案还原为
     `t('restoreContinue')`，防止用户手动选择后定时器残留再触发一次。

选 10 秒的理由：启动恢复场景用户来得及看清标题/进度并改选「清除/稍后」；
任务流中途误弹时 10 秒自动继续，等价于无人值守下自愈。

**文件：`media/chat/index.html`（不改结构）**

「继续」按钮（147 行 `data-role="task-restore-continue"`）文案由 JS 动态刷新，
HTML 无需改动。

## 修复二：任务流推进中不下发恢复弹窗（扩展端，堵住已确认的触发点）

**文件：`src/llsTask/autoContinue.ts`**

3. **新增静态方法 `AutoContinueScheduler.hasPendingWork(): boolean`** ——
   返回 `!!(AutoContinueScheduler.timer || AutoContinueScheduler.idleWatchdogTimer
   || AutoContinueScheduler.idleWatchdogPending)`，表示「调度器手里有活」：
   续推定时器在等、或空闲看门狗在观察期。静态字段本就是进程级单例，
   静态方法读取即可，无需实例。

**文件：`src/taskFlow/taskFlowCommands.ts`**

4. **`maybePostTaskFlowRestorePrompt()`（155 行）** —— 在
   `hasActiveWorkflow()` 判断之后、`postMessage` 之前加一道运行态守卫：

   ```
   if (AutoContinueScheduler.hasPendingWork()) {
       Logger.info('[LlsTask] 任务流正在自动推进，跳过恢复弹窗');
       return;   // 标志已在函数开头清掉，本会话不会再弹
   }
   ```

   这正是分析文档里确认的误弹链路：中途续推 `appendUserMessageAndSend` →
   `openBuiltInChat()` 首次 resolve webview → `webview/ready` → 本函数。
   此时调度器必然有定时器/看门狗在挂，守卫直接命中。

5. **`continueLlsCcaiTask()`（142 行）与 `openLlsCcaiTaskMenu()` 的
   「继续推进」分支（111 行）** —— 各加一行 `setPendingRestorePrompt(false)`：
   用户已主动继续任务流，「恢复弹窗」使命结束，之后 webview 无论何时首次
   ready 都不该再弹。

## 修复三：切换任务流模型成功后重置熔断计数（扩展端，防中途静默停摆）

**文件：`src/activation/wiring.ts`**

6. **`configureRuntimeModules()` 中的 `AutoContinueScheduler.setBeforeSubmit`
   回调（131-134 行）** —— `applyTaskFlowModelForContinue()` 返回
   `'switched'` 时调用 `getAutoContinueScheduler()?.resetMissingToolCounter('任务流模型已切换')`：
   主模型阶段攒下的「缺失工具」计数不应带进新模型阶段，避免刚切过去就
   熔断、续推静默停止（分析文档根因 B 的贡献因素）。

## 不改的部分（明确排除）

- `extension.ts:85` 的 `setPendingRestorePrompt(await llsTaskService.restore())`
  保持不变——启动时置标志的语义正确；
- `handleTaskFlowRestoreChoice` 三分支逻辑不变——倒计时超时走的就是现成的
  `'continue'` 分支；
- CLI 异常退出弹窗（`cliLifecycle.ts:434`）暂不动：样式与用户所见不符，
  且自动重启涉及崩溃循环风险，留待单独评估。

## 验证清单

1. `npm test`（node --test 全量）+ MCP `get_errors` 无诊断；
2. 手动场景 A（启动恢复）：留一个未完成任务流 → Reload Window → 打开 Chat
   面板 → 弹窗出现且「继续」按钮倒计时，10 秒不动自动续推；
3. 手动场景 B（中途误弹防御）：启动后不开 Chat 面板，从状态栏继续任务流 →
   自动续推拉起 webview → 不再出现恢复弹窗（日志有「跳过恢复弹窗」）；
4. 手动场景 C：倒计时期间点「清除」/「稍后」→ 倒计时停止、行为同旧版。

## 改动量估算

| 文件 | 方法 | 改动 |
|------|------|------|
| media/chat/main.js | showTaskRestoreDialog / resolveTaskRestore | +约 25 行 |
| src/llsTask/autoContinue.ts | 新增 hasPendingWork | +约 10 行 |
| src/taskFlow/taskFlowCommands.ts | maybePostTaskFlowRestorePrompt / continueLlsCcaiTask / openLlsCcaiTaskMenu | +约 8 行 |
| src/activation/wiring.ts | setBeforeSubmit 回调 | +约 3 行 |

