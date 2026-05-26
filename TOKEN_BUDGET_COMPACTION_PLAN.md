# @llsccai-summ 上下文压缩方案

## 背景

当前 tokenBudget 自动压缩由扩展端直接把历史 `messages/system` 发给上游做一次独立非流式摘要请求，再重置 CLI session 并把摘要作为用户消息注入。部分 provider/model 会返回过短内容，触发 `压缩响应过短或为空`。

新的目标是让压缩走 CLI 当前上下文路径：通过特殊指令 `@llsccai-summ` 触发 relay 拦截，relay 立即给当前 CLI 一个合法响应，再异步整理当前请求中的上下文并发起非流式摘要请求。摘要成功后清掉 `.LLSOAI/chat-session.json`，重启 CLI，并把摘要隐藏注入新会话，不在聊天区显示内部摘要消息。

## 触发流程

1. 手动点击“压缩对话”或自动触达阈值时，扩展向 CLI 发送 `@llsccai-summ`。
2. CLI 会把当前会话上下文与最后一条 `@llsccai-summ` user 消息发送到 relay。
3. relay 在三类 provider adapter 转发前识别最后一条 user 文本是否为 `@llsccai-summ`。
4. 命中后 relay 不把该请求当普通对话转发，而是立即返回一个非流式 Anthropic JSON 响应，提示压缩已开始。
5. tokenBudget 服务异步执行压缩：抽取当前请求体上下文、去除工具调用和工具回复、封装成单条 user 消息，请求当前 provider/model 生成摘要。
6. 摘要成功后延时约 1 秒，删除 `.LLSOAI/chat-session.json` 并重启 CLI。
7. 新 session 启动后，通过内部隐藏消息注入 `<CONTEXT><summ>...</summ></CONTEXT>`，聊天区不展示这条内部注入。

## 上下文封装规则

- 保留 `user` 和 `assistant` 的纯文本内容。
- 去掉 `tool_use` block。
- 去掉 `tool_result` block。
- 非文本 block 只在确有必要时转为简短文本，避免把工具 JSON 大量塞进摘要请求。
- 最终摘要请求只包含一条 user message，内容是整理后的对话文本。
- system 使用固定压缩提示词，原始 system 仅作为附加参考。

## Session 与 UI 行为

- `.LLSOAI/chat-session.json` 是 CLI resume 旧会话的关键文件，只删除该 session 文件，不删除 provider/model 配置。
- 压缩期间 webview 保持现有 started/finished/failed 状态事件。
- 内部摘要注入不追加用户聊天气泡。
- 内部注入后的“上下文已就绪”类 assistant 回复也应尽量不展示，只保留压缩完成卡片。

## 验证

- `npm run compile`
- tokenBudget service/integration tests
- compactor flatten 单测
- 手动验证：点击 token 百分比 → 压缩对话，确认只显示压缩状态/完成卡片，不显示内部摘要消息。
