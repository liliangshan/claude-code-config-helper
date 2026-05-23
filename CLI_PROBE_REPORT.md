# CLI 通信探针结论

> 日期：2026-05-23
> 工作区：`/Users/lls/wwwroot/liliangshan/vcode/liliangshan-anthropic.claude-code`

## 1. 本次探针范围

本次探针用于验证 `CHAT_WEBVIEW_PLAN.md` 第 4 节要求的硬性前提：目标 Claude 兼容 CLI 是否可通过 VS Code 扩展直接启动，并通过 **stdio 长连接 + 双向 `stream-json`** 完成多轮聊天通信。`-p/--print` 只作为单次请求探针/降级路径，PTY 只作为实验兜底。

## 2. 环境检测结果

已执行环境检测：

```sh
command -v claude || true
command -v claude-code || true
command -v node || true
node --version
```

初始结果：

- `claude`：未在当前 PATH 中发现。
- `claude-code`：未在当前 PATH 中发现。
- `node`：`/opt/homebrew/bin/node`
- `node --version`：`v25.8.1`

随后按用户要求使用本地代理安装：

```sh
HTTP_PROXY=http://127.0.0.1:3080 \
HTTPS_PROXY=http://127.0.0.1:3080 \
ALL_PROXY=http://127.0.0.1:3080 \
http_proxy=http://127.0.0.1:3080 \
https_proxy=http://127.0.0.1:3080 \
all_proxy=http://127.0.0.1:3080 \
HOMEBREW_NO_AUTO_UPDATE=1 \
brew install --cask --verbose claude-code
```

安装结果：

- Homebrew cask：`claude-code (Claude Code): 2.1.141`
- 安装状态：成功。
- 链接产物：`/opt/homebrew/bin/claude`
- `claude-code` 命令：未提供独立命令名，Homebrew cask artifact 为 `claude (Binary)`。
- `claude --version`：`2.1.141 (Claude Code)`

## 2.1 CLI 帮助与参数能力

已执行：

```sh
claude --help
```

确认以下能力：

- 默认启动交互会话。
- 支持 `-p, --print` 非交互输出。
- 支持 `--output-format text|json|stream-json`。
- 支持 `--input-format text|stream-json`，官方帮助说明其适用于 `--print`；官方 VS Code 扩展包 2.1.144 也使用 `--output-format stream-json --verbose --input-format stream-json` 作为原生 UI 的 stdio 双向流入口。
- 支持 `--include-partial-messages`，仅适用于 `--print --output-format=stream-json`。
- 支持 `--permission-mode acceptEdits|auto|bypassPermissions|default|dontAsk|plan`。
- 支持 `--replay-user-messages`，仅适用于 `--input-format=stream-json --output-format=stream-json`。

## 2.2 官方扩展启动方式对照

已分析官方 Claude Code VS Code 扩展包 `2.1.144`：

- 原生 UI 路径使用内置 binary 启动 Claude CLI，而不是通过 HTTP Relay 或外部 Webview API。
- 子进程以 stdio pipe 方式启动，核心参数为：

```sh
claude --output-format stream-json --verbose --input-format stream-json
```

- 启动环境包含 `MCP_CONNECTION_NONBLOCKING=true`、`CLAUDE_CODE_ENABLE_TASKS=0`、`CLAUDE_CODE_ENTRYPOINT=claude-vscode`。
- 该结果证明 Chat Webview 的主通信路径应改为长生命周期 stdio 双向 JSON Lines，而不是旧的泛化通道设计或单次 `-p` 主路径。
- 按当前实现决策，长连接 stdin `stream-json` schema 不再作为必须继续执行的本机探针；实现阶段直接参考该官方扩展包的 SDK-style stdio 流设计，并用 fake CLI / 集成测试验证本扩展封装。

## 3. 探针结论

当前已确认：

- 目标 CLI 已可执行，命令为 `/opt/homebrew/bin/claude`。
- 当前版本为 `2.1.141 (Claude Code)`。
- CLI 明确支持 `--output-format=stream-json` 与 `--input-format=stream-json`，且官方扩展也使用同类参数作为原生 UI 通信入口；因此本项目主路径改为 stdio 长连接 / 双向 JSON Lines，并直接按官方扩展包实现对齐。
- CLI 明确支持 `-p/--print` 非交互模式；该模式继续用于探针、单次请求和降级适配，不再作为 Chat Webview 主会话架构。
- 用户完成本机 Claude CLI 认证后，真实模型输出探针已可执行。

已执行认证后的最小非交互调用：

```sh
claude -p \
	--output-format text \
	--permission-mode dontAsk \
	--max-budget-usd 0.02 \
	'Reply with exactly: CLI_PROBE_OK'
```

结果：

- 退出码：`0`
- stdout：`CLI_PROBE_OK`
- stderr：空

已执行认证后的 JSON 输出调用：

```sh
claude -p \
	--output-format json \
	--permission-mode dontAsk \
	--max-budget-usd 0.02 \
	'Reply with exactly: CLI_PROBE_JSON_OK'
```

结果：

- 退出码：`0`
- stdout：合法 JSON 对象。
- 关键字段：`type`、`subtype`、`is_error`、`duration_ms`、`num_turns`、`result`、`session_id`、`total_cost_usd`、`usage`、`modelUsage`、`permission_denials`、`uuid`。
- `result`：`CLI_PROBE_JSON_OK`

已执行认证后的 `stream-json` 输出调用：

```sh
claude -p \
	--verbose \
	--output-format stream-json \
	--include-partial-messages \
	--permission-mode dontAsk \
	--max-budget-usd 0.03 \
	'Reply with exactly: CLI_PROBE_STREAM_OK'
```

结果：

- 退出码：`0`
- 输出形态：JSON Lines，一行一个事件。
- 事件数量：`5`。
- 事件概要：`system`、`system`、`stream_event`、`assistant message.type=message content=text`、`result`。
- assistant 文本：`CLI_PROBE_STREAM_OK`

已执行认证后的 stdin 文本输入调用：

```sh
printf 'Reply with exactly: CLI_PROBE_STDIN_TEXT_OK\n' | \
	claude -p \
		--output-format text \
		--permission-mode dontAsk \
		--max-budget-usd 0.02
```

结果：

- 退出码：`0`
- stdout：`CLI_PROBE_STDIN_TEXT_OK`
- stderr：空

因此，安装、版本、帮助参数、认证后真实模型输出、非交互 text/json/stream-json 输出，以及 stdin 文本输入均已验证可用。长连接 `stream-json` 方向直接参考官方扩展包实现，不再作为本机阻塞探针；取消机制和结构化权限事件仍需继续探针确认。

## 3.1 当前可放行与不可放行项

可放行的设计假设：

- `cliPath` 默认可候选为 `/opt/homebrew/bin/claude`。
- `--version` 输出可解析为 `2.1.141`。
- 首版 `transport` 默认方向调整为 `streamJsonStdio`，即长生命周期 stdio + 双向 `stream-json`。
- `CliAdapter` 主实现应围绕官方扩展包使用的 `--output-format stream-json --verbose --input-format stream-json` 设计；不再单独阻塞于本机 stdin schema 探针。
- `claude -p --verbose --output-format=stream-json` 和 `text/json` 输出模式可作为探针、回归测试和降级路径保留。

不可放行的实现项：

- 权限卡片不能实现为结构化协议，直到登录后采集到真实 permission/tool 事件。
- 取消机制不能定稿，直到登录后验证 `SIGINT` 或 CLI 专用机制。
- 不得把 `-p` 单次请求误写成正式主链路；正式主链路按官方扩展包的长连接 `stream-json` 设计对齐。

## 4. 已建立的 fixture 目录

已创建 `fixtures/cli-output/`，用于后续保存真实 CLI 输出样例：

- `plain-text.txt`
- `markdown-stream.txt`
- `ansi-progress.txt`
- `permission-prompt.txt`
- `error-exit.txt`

当前这些文件已写入安装、帮助、认证后真实输出，以及未登录错误边界样例；权限提示和取消行为仍需继续采集。长连接 stdin JSON 方向改为参考官方扩展包，不再作为阻塞 fixture。

## 5. 后续动作

1. 按官方扩展包 `2.1.144` 的 SDK-style stdio 流设计落地 `StreamJsonCliAdapter`，用 fake CLI / 集成测试验证封装行为。
2. 继续验证取消方式：优先用 Node `child_process.spawn` 直接启动 `/opt/homebrew/bin/claude`，再向真实 child process 发送 `SIGINT`；必要时记录只能重启进程。
3. 继续采集真实 permission/tool 事件；如果 CLI 只给 TTY 文本提示，MVP 不实现结构化权限卡片。
4. 采集更复杂 Markdown / code block / file reference 样例，补强解析器 fixture。

## 6. 当前状态

- CLI 通信探针：**in progress（安装、认证后 text/json/stream-json 输出与 stdin 文本输入已验证；长连接主路径已改为参考官方扩展包实现；取消机制、权限事件仍待确认）**
- Chat MVP 编码：**可先进入长连接适配器设计与 fake CLI 骨架；取消机制和权限事件在对应功能实现前继续补探针**
