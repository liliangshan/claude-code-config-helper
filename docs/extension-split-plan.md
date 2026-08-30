# extension.ts 拆分落地方案

目标：把 `src/extension.ts`（5262 行，约 190 个顶层函数 + 60 个模块级可变状态）
按子系统拆成独立模块，`extension.ts` 最终只保留 `activate` / `deactivate`
编排（目标 < 400 行）。**纯搬移，不改任何行为**，每一步搬完必须
`npm run compile && npm test` 通过后再进行下一步。

## 核心难点：模块级可变状态的归属

extension.ts 里约 60 个 `let` 变量（:82-:350）被各函数共享读写，直接搬函数会
断引用。方案：**每个新模块自持有自己的状态**，跨模块访问一律通过导出的
getter/函数，禁止导出可变 `let`。少数真正全局的（`extensionContext`、
`configManager`）收敛到一个极小的 `runtime.ts`。

## 目标目录结构

```
src/
  runtime.ts                     全局单例访问器（新）
  chatRuntime/
    routeState.ts                四路由 CLI 进程/适配器/busy 状态（新）
    cliLifecycle.ts              CLI 启停/重启/恢复（新）
    cliEventHandlers.ts          CLI 事件与权限请求处理（新）
    chatSession.ts               消息列表与会话持久化（新）
    chatMessaging.ts             发消息/附件/续发（新）
    webviewMessages.ts           webview 消息分发与 post*（新）
    modelSelection.ts            expert/plan/review/compaction 模型选择（新）
    planReviewWorkflow.ts        plan→review 工作流（新）
    selfHealing.ts               HTTP 期望/自愈/重发（新）
  taskFlow/
    taskFlowCommands.ts          任务流命令与恢复提示（新）
    externalPaste.ts             外部粘贴与系统级回车模拟（新）
  wakeup/
    wakeupWiring.ts              唤醒装配与消息构造（新）
  activation/
    mcpInjectionLog.ts           三条 MCP 注入日志（新）
    browserToolsGate.ts          浏览器工具开关探测（新）
  extension.ts                   只剩 activate/deactivate（改）
```

## 第 1 步 `src/runtime.ts`（约 60 行）

搬入并封装最小全局：

- `extensionContext`（:85）→ `setExtensionContext()` / `getExtensionContext()`
- `configManager`（:82）→ `setConfigManager()` / `getConfigManager()`
- `chatViewHost`（:214）→ `setChatViewHost()` / `getChatViewHost()`
- `settingsWriter`（:350）、`relayServer`（:103）、`llsTaskService`（:91）同法。

`activate` 内创建实例后立即 `set*`；其余模块只 import `runtime.ts`，
杜绝循环依赖（runtime 不 import 任何业务模块）。

## 第 2 步 `src/chatRuntime/routeState.ts`（约 300 行）

搬入四路由的进程与状态。这是消解 `let` 最关键的一步：

- 状态：`normalCliProcess`/`expertCliProcess`/`planCliProcess`/`reviewCliProcess`
  （:120-:135）、四个 `StreamJsonCliAdapter`（:146-:160）、八组
  status/exit subscription（:163-:196）、`normalBusy`/`expertBusy`/
  `planBusy`/`reviewBusy`（:284-:289）、`*RelayActiveCount`（:290-:293）、
  `assistantTurnTextBySource`（:296）、`planLaunchConfigCache`/
  `reviewLaunchConfigCache`（:199-:202）、idle 定时器（:205-:208）与
  `PLAN_REVIEW_IDLE_DISPOSE_MS`（:211）。
  建议收进一个 `RouteRuntime` 对象：`Record<ChatRoute, {...}>`。
- 函数：`getCliProcessForRoute`（:1340）、`getStreamAdapterForRoute`（:1350）、
  `getSessionIdForRoute`（:1360）、`isRouteBusy`（:1370）、
  `resetRouteBusy`（:1380）、`resetAllRouteBusy`（:1397）、
  `cancelRouteProcess`（:1404）、`isAnyRouteBusy`（:1308）、
  `setRelayRouteBusy`（:1312）、`resolveRouteForSessionId`（:1761）。

## 第 3 步 `src/chatRuntime/cliLifecycle.ts`（约 700 行）

依赖第 2 步的 routeState。搬入：

- `selectChatCli`（:1155）、`restartChatCli`（:1168）、
  `restartChatRelayAndCli`（:1177）、`ensureChatCliStarted`（:1273）、
  `currentChatCliSessionIdSync`（:1292）、
  `startChatCliFromCurrentConfig`（:1778）、`startChatCliPair`（:1797）、
  `restartChatCliPair`（:2043）、`stopChatCliPair`（:2059）；
- plan/review 惰性生命周期：`ensurePlanCliStarted`（:1950）、
  `ensureReviewCliStarted`（:1977）、`disposePlanCli`（:1866）、
  `disposeReviewCli`（:1895）、`disposeExpertCli`（:2011）、
  `clearPlanIdleDisposeTimer`（:1920）、`clearReviewIdleDisposeTimer`（:1927）、
  `schedulePlanReviewIdleDispose`（:1934）;
- 适配器重建：`rebuildNormalAdapter`（:2082）、`rebuildExpertAdapter`（:2102）、
  `rebuildPlanAdapter`（:2117）、`rebuildReviewAdapter`（:2132）;
- 状态回调绑定：`registerChatCliStatusHandlers`（:4071）、
  `bindNormalCliStatusHandlers`（:4103）、`bindExpertCliStatusHandlers`（:4118）、
  `bindPlanCliStatusHandlers`（:4133）、`bindReviewCliStatusHandlers`（:4148）、
  `mapCliStatusForWebview`（:4166）、`handleChatCliExit`（:4180）;
- 关联状态：`cliResolver`（:112）、`chatCliConfigService`（:109）、
  `chatCliSessionStore`（:138）。

## 第 4 步 `src/chatRuntime/chatSession.ts`（约 450 行）

消息列表与持久化。搬入：

- 状态：`chatMessages`（:220）、`activeAssistantMessageId`（:273）、
  `chatSessionPersistTimer`（:270）、常量 `CHAT_SESSION_STATE_KEY`（:223）、
  `CHAT_SESSION_PRIVACY_NOTICE_KEY`（:226）、`MAX_PERSISTED_CHAT_MESSAGES`
  （:229）、`MAX_IN_MEMORY_CHAT_MESSAGES`（:242）、
  `PersistedChatSession` 接口（:340）。
- 函数：`trimInMemoryChatMessages`（:252）、
  `sanitizePersistedChatMessages`（:887）、`schedulePersistChatSession`（:1102）、
  `flushPersistedChatSession`（:1113）、`clearPersistedChatSession`（:1128）、
  `showChatSessionPrivacyNoticeIfNeeded`（:1139）、
  `appendLocalChatMessage`（:4209）、`appendAssistantSegments`（:4362）、
  `finishActiveAssistantMessage`（:4442）、`createActiveAssistantMessage`
  （:4463）、`getActiveAssistantMessageForPatch`（:4480）、
  `buildAssistantMessage`（:4494）、`extractPlainTextFromSegments`（:4337）、
  `isHiddenChatToolSegment`（:4393）;
- 历史会话解析：`parseSessionJsonl`（:908）、`resolveClaudeProjectDir`（:984）、
  `extractSessionTitle`（:999）、`pushSessionTitleToWebview`（:1039）、
  `writeSessionCustomTitle`（:1062）;
- token 计量挂钩：`syncTokenBudgetContextWindowFromUsage`（:4408）、
  `estimateAssistantOutputTokensForMeter`（:4428）、
  `tokenBudgetServiceRef`（:217）。

## 第 5 步 `src/chatRuntime/chatMessaging.ts`（约 500 行）

发消息与附件。搬入：

- 状态：`chatCliCancelRequested`（:276）、`lastChatEditorAttachment`（:299）、
  `chatEditorSelectionVersion`（:302）、`CHAT_UPLOAD_TEMP_DIR`（:264）、
  `MAX_CHAT_UPLOAD_BYTES`（:267）。
- 函数：`sendUserMessageToCli`（:3940）、`appendUserMessageAndSend`（:4003）、
  `sendHiddenUserMessageToCli`（:4044）、`fillBuiltInChatComposer`（:4061）、
  `handleUserResend`（:4262）、
  `handleUpstreamTimeoutAutoContinue`（:4230，连同
  `UPSTREAM_TIMEOUT_CONTINUE_PROMPT` :331 / `..._COOLDOWN_MS` :334 /
  `lastUpstreamTimeoutContinueAt` :337）;
- 附件链路：`pickChatContextFiles`（:3353）、`saveChatUploadedBlob`（:3373）、
  `sanitizeUploadFileName`（:3405）、`postActiveEditorAttachmentToChat`（:3429）、
  `serializeSelection`（:3465）、`buildEditorAttachment`（:3480）、
  `buildPromptWithAttachments`（:3503）、`buildUserDisplaySegments`（:3527）、
  `buildImageSegmentFromAttachment`（:3542）、
  `getImageMediaTypeFromPath`（:3568）、`formatAttachmentForPrompt`（:3595）、
  `formatPathForPrompt`（:3610）;
- 文件跳转：`openWorkspaceFileReference`（:3626）、
  `resolveWorkspaceFileUri`（:3646）、`buildWorkspaceFileCandidates`（:3690）、
  `isPathInside`（:3720）。

## 第 6 步 `src/chatRuntime/cliEventHandlers.ts`（约 400 行）

CLI 输出事件与权限。搬入：

- `handleParsedCliEvent`（:2327）、`handleCliCompactStatus`（:2390）、
  `handleToolPermissionRequest`（:2449）、
  `buildToolPermissionPromptMessage`（:2513）、
  `formatToolPermissionInput`（:2527）、`parseAskUserQuestions`（:2554）、
  `handleAskUserAnswers`（:2567）、`notifyPermissionDeniedToUser`（:2300）、
  `handleFinalAssistantText`（:1511）、`formatLogPreview`（:1443）、
  `getSegmentLogText`（:1448）。

## 第 7 步 `src/chatRuntime/modelSelection.ts`（约 450 行）

- 读取：`readEffectiveExpertModelSelection`（:522）、
  `readEffectiveCompactionModelSelection`（:541）、
  `readEffectivePlanModelSelection`（:557）、
  `readEffectiveReviewModelSelection`（:576）、
  `getInspectedWorkspaceValue`（:508）、`getInspectedGlobalValue`（:513）、
  `EffectiveExpertModelSelection` 接口（:500）;
- 保存：`saveExpertModelSelection`（:597）、`savePlanModelSelection`（:613）、
  `saveCompactionModelSelection`（:624）、`saveReviewModelSelection`（:640）;
- 选择与校验：`selectChatModel`（:3236）、`selectChatExpertModel`（:3256）、
  `selectChatPlanModel`（:3276）、`selectChatReviewModel`（:3296）、
  `isSelectableModel`（:2924）、`assertSelectableSubModel`（:2941）、
  `findModelDisplayName`（:1459）、`getModelLabelForRoute`（:1468）、
  `handleModelsApplyPair`（:3136）。

## 第 8 步 `src/chatRuntime/webviewMessages.ts`（约 700 行）

webview 双向协议。搬入：

- 入口：`handleChatWebviewMessage`（:2596，全文件最大函数，328 行 switch —
  搬移同时可按 message type 前缀拆成若干 `handleXxx` 小函数，但保持逐 case
  等价）；
- 出站 post：`postChatModelOptions`（:2960）、`postChatExpertModelOptions`
  （:2982）、`postChatPlanModelOptions`（:3004）、
  `postChatReviewModelOptions`（:3026）、`postModelsSnapshot`（:3051）、
  `postChatPermissionMode`（:3177）、`postChatCacheTtl`（:3185）、
  `postChatTaskFlowStatus`（:3196）、`postChatUiLanguage`（:3211）、
  `showChatToast`（:3346）;
- 路由/模式选择：`handleRouteSelect`（:3119）、`switchChatRoute`（:1487）、
  `switchRouteToExpert`（:1495）、`normalizeQuickPermissionMode`（:3226）、
  `selectChatPermissionMode`（:3316）、`selectChatCacheTtl`（:3333）。

## 第 9 步 `src/chatRuntime/planReviewWorkflow.ts`（约 300 行）

- `extractHandoffInstruction`（:1505）、`watchNormalForExpertHandoff`（:1531）、
  `watchNormalForPlanHandoff`（:1565）、`handleNormalPlanTask`（:1593）、
  `handleNormalPlanDone`（:1621）、`handleNormalPlanReview`（:1633）、
  `handleNormalPlanRevise`（:1658）、`handlePlanDone`（:1685）、
  `handleReviewDone`（:1704）、`buildReviewPrompt`（:1723）、
  `buildPlanRevisionPrompt`（:1734）、`sendPlanReviewCallbackToNormal`（:1749）、
  `finishPlanReviewWorkflow`（:1755）;
- expert 子回合：`getOrCreateExpertSubturnService`（:427）、
  `runUserTriggeredExpertSubturn`（:452）、`expertSubturnService`（:106）。

## 第 10 步 `src/chatRuntime/selfHealing.ts`（约 250 行）

- 状态：`pendingHttpExpectationTimer`（:310）、
  `pendingHttpExpectationPrompt`（:313）、
  `pendingHttpExpectationStartedAt`（:316）、`isHealingRelayAndCli`（:319）、
  `pendingResendTimer`（:322）、`HTTP_EXPECTATION_TIMEOUT_MS`（:325）、
  `HEAL_RESEND_DELAY_MS`（:328）。
- 函数：`armHttpExpectation`（:3740）、`clearHttpExpectation`（:3763）、
  `onHttpExpectationTimeout`（:3781）、`healRelayAndCli`（:3819）、
  `scheduleHealResend`（:3896）、`cancelPendingResend`（:3926）。

## 第 11 步 `src/taskFlow/taskFlowCommands.ts`（约 350 行）

- `buildTaskFlowPrompt`（:495）、`openLlsCcaiTaskMenu`（:660）、
  `showLlsCcaiTaskProgress`（:703）、`continueLlsCcaiTask`（:720）、
  `maybePostTaskFlowRestorePrompt`（:732）、
  `handleTaskFlowRestoreChoice`（:758）、`TaskFlowPromptSendOptions`（:779）、
  `sendTaskFlowPrompt`（:790）、`trySendTaskFlowPromptToBuiltInChat`（:809）、
  `clearLlsCcaiTask`（:826）、`getTaskStatusIcon`（:4512）、
  状态 `pendingRestorePrompt`（:100）、`autoContinueScheduler`（:94）。

## 第 12 步 `src/taskFlow/externalPaste.ts`（约 300 行）

- `pasteTaskFlowToClaude`（:4542）、`pasteTaskFlowToExternalClaudeCode`（:4553）、
  `simulateEnterKeyAtSystemLevel`（:4598）、`simulateEnterOnMac`（:4615）、
  `simulateEnterOnWindows`（:4643）、`runSimulateEnterTest`（:4680）、
  `getSimulateEnterHintTexts`（:4764）、`showSimulateEnterResultHint`（:4779）、
  `delay`（:4532）、`asMessage`（:4585）。

## 第 13 步 `src/wakeup/wakeupWiring.ts`（约 60 行）

- `fireWakeupJob`（:4017）、`buildWakeupMessage`（:4028）、
  状态 `wakeupScheduler`（:97）。依赖 chatMessaging 的
  `appendUserMessageAndSend`。

## 第 14 步 `src/activation/` 杂项（约 250 行）

- `mcpInjectionLog.ts`：`logBrowserMcpInjection`（:2146）、
  `logVscodeMcpInjection`（:2163）、`logWakeupMcpInjection`（:2185）、
  `logMcpToolsBeforeCliStart`（:2271）;
- `browserToolsGate.ts`：`promptEnableBrowserChatToolsIfNeeded`（:2202）、
  `isBrowserToolsSupported`（:2213）、`isBrowserFullyAutoApproved`（:2219）、
  `postBrowserAutoApproveState`（:2231）、`enableBrowserAutoApprove`（:2246）、
  `isVsCodeAtLeast`（:2254）;
- 开机杂项也一并归位：`applyClaudeCodeInitialPermissionMode`（:362）、
  `cleanupLegacyRelaySettingsSafely`（:378）、
  `syncClaudeCliModelSettingsSafely`（:394）、
  `ensureRelayServerStarted`（:412）→ 放 `activation/startup.ts`。

## 第 15 步 收尾 `extension.ts`

只保留：`activate`（:4809，改为按序调用各模块的装配函数）、
`deactivate`（:5214，改为调用各模块导出的 `dispose*`）、22 个
`registerCommand` 注册（回调全部指向新模块导出的函数）。

## 执行纪律

1. 每步一个模块：新建文件 → 剪切函数与其状态 → extension.ts 改成
   import → 编译 + 全量测试 + `get_errors` 检查，绿了才进下一步。
2. **禁止导出可变 `let`**；跨模块状态一律经函数访问。
3. 循环依赖处理：`webviewMessages` ↔ `cliLifecycle` 等互相调用处，统一
   依赖方向为「上层 import 下层」：routeState ← cliLifecycle ←
   cliEventHandlers / chatMessaging ← webviewMessages。反向调用（如
   lifecycle 完成后要 post 状态）用注册回调解决（`setOnStatusChanged(cb)`）。
4. 行为不变承诺：不重命名导出函数、不合并函数、不调整逻辑；
   `handleChatWebviewMessage` 的拆分（第 8 步）若有风险可放到最后单独做。
5. 全程共 15 步，可分多个版本渐进合入；每步独立可发布。
