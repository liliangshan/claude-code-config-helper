# CLI 请求恢复：事件证据与测试资料

## 核实范围

本记录对应 REQUEST_RECOVERY_PLAN.md 的任务 1，仅建立证据与合成夹具，不提前实现恢复控制器。

## 本地证据

扫描当前工作区对应的 Claude projects 目录顶层 JSONL，逐行解析对象，仅统计顶层事件，不把对话中引用的 JSON 误当事件。不复制消息正文、实际会话 ID、请求头或错误详情到仓库。

- 找到 30 条 `type=system, subtype=api_error`：其中事件版本 2.1.260 共 23 条，2.1.141 共 7 条。
- 这些持久化事件具有 `retryInMs`、`retryAttempt`、`maxRetries`。`retryInMs` 明确以毫秒命名，观察到整数和小数，例如 600 毫秒量级；不是秒，也不应要求其为整数。
- 2.1.260 的 error 对象键包括 message、status、formatted、connection、isNetworkDown、rateLimits；2.1.141 的形状不同，包括 status、headers、requestID、error、type。不能假设所有版本错误结构相同。
- 此次扫描未找到顶层 `api_retry` 或 `result`。持久化会话日志不是 stdout stream-json 完整录制，缺少这些事件不代表 CLI 不会输出它们。
- PATH 中执行 `claude --version` 得到 2.1.141；不能用它冒充扩展实际运行的 2.1.260。未启动付费模型请求，未人为中断当前会话制造失败。
- 本地另一份 2.1.144 扩展目录的 JS/TS 检索未得到可用于确认重试等待字段的定义，不作为新版本协议依据。

## 当前解析器与终止语义

- `src/chat/cli/cliAdapter.ts` 的 `parseSystemGenericEvent()` 将 api_retry 作为非终止 segments；`buildSystemEventSegment()` 固定 success 仅是卡片样式，不能证明重试成功。
- `src/chat/__tests__/cliAdapterSystemTaskEvent.test.ts` 的既有 api_retry 用例包含 attempt、max_retries、error_status、error。这是现有测试契约，不是此次捕获到的真实 stdout 样本。
- 当前 result 分支经 `parseResultEvent()` 后标记 turnFinished；message_stop/done 不带该标记。局部消息结束不能代表整轮终止。
- `parseResultEvent()` 当前读取 result 正文和用量，没有保留 is_error、subtype、errors；后续任务应补齐。缺少失败标记的 result 应保留分类未知，不能默认为最终成功以重置恢复额度。
- api_retry 的最后一个 attempt 仍不是终止事件；不推导“次数到上限等于最后一次重试已经完成”。

## 未核实项与后续约束

1. 真实 stdout api_retry 的等待字段名、单位，以及持久化 retryInMs 与 stdout 字段的转换关系尚未核实。不得直接假设 stdout 存在 retry_delay_ms，也不得把持久化 api_error 直接当作 stdout api_retry。
2. 未捕获当前扩展版本的失败 result；夹具中的 error_during_execution、errors、is_error 是待后续实现使用的合成边界输入，不宣称已在本次真实会话验证。
3. 无法仅靠已有数据核实截图的具体上游超时、CLI 未命中网关或本地错误映射原因；仍需该次关联请求证据。
4. 后续解析对未知等待值保持 undefined；不能用默认零等待认定原生重试结束。收到明确终止事件或取得独立进程/健康检查证据后才处理停滞。

## 合成夹具

文件：`fixtures/cli-output/request-recovery.json`。

每项包含 name、provenance、event、expected，所有值均为合成数据。expected 描述目标语义，不代表当前解析器全部已实现；JSON null 表示未知，后续测试映射为 undefined。

覆盖持久化 api_error、stdout 候选 api_retry、最后一次重试仍非终止、非法元数据、局部 message_stop、空正文失败 result、成功 result 和分类未知的 result。非法输入中的 retry_delay_ms 只用于确保未验证字段不能被盲信，不作为协议字段确认。

任务 3 应将这些夹具接入解析器回归测试；任务 2 可使用终止/未知语义作为状态机输入。真实端到端验证留待任务 9，缺少真实录制时继续如实列为未验证。
