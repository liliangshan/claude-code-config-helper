# Claude CLI 终端消息发送使用方式

本文只说明“自己写扩展时，指定 Claude CLI 地址并向 CLI 发送消息”的使用方式。

> 结论：可以启动一个独立的 Claude CLI 会话，并通过 `stdin/stdout` 与它通信；这不是向已经打开的 Claude Code Webview 会话发送消息。

## 1. 适用场景

适合以下需求：

- 你有一个 Claude CLI 可执行文件路径；
- 你想在自己的 VS Code 扩展里启动 Claude CLI；
- 你想通过程序发送 prompt；
- 你想读取 Claude CLI 返回的流式结果；
- 你不要求复用官方 Claude Code Webview 中已经打开的会话。

不适合以下需求：

- 向官方 Claude Code Webview 当前聊天框直接注入消息；
- 向已经打开的 Claude Code 面板发送 prompt；
- 复用官方 Claude Code Webview 内部的当前会话状态。

## 2. 基本方式

自己扩展中启动 Claude CLI，并指定 JSON 流输入输出：

```bash
/path/to/claude \
  --output-format stream-json \
  --input-format stream-json \
  --verbose
```

核心点：

- `--input-format stream-json`：表示从 stdin 接收 JSON 流输入；
- `--output-format stream-json`：表示 stdout 输出 JSON 流结果；
- `--verbose`：输出更完整的事件信息，便于扩展解析。

## 3. 常用启动参数

可根据需要附加以下参数：

```bash
--permission-mode acceptEdits
```

设置初始权限模式。

```bash
--continue
```

继续最近会话。

```bash
--resume <session-id>
```

恢复指定会话。

```bash
--mcp-config '<json>'
```

传入 MCP 配置。

```bash
--allowedTools '<tool1,tool2>'
```

限制允许使用的工具。

```bash
--disallowedTools '<tool1,tool2>'
```

限制禁止使用的工具。

```bash
--model '<model-name>'
```

指定模型。

## 4. 在扩展中指定 CLI 路径

你可以在自己的扩展配置里保存一个 Claude CLI 路径，例如：

```json
{
  "myExtension.claudeCliPath": "/usr/local/bin/claude"
}
```

然后启动时读取该路径。

## 5. Node.js 启动示例

```ts
import { spawn } from 'child_process';

const cliPath = '/usr/local/bin/claude';
const cwd = '/path/to/workspace';

const child = spawn(cliPath, [
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'acceptEdits'
], {
  cwd,
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:17783',
    ANTHROPIC_AUTH_TOKEN: 'your-token',
    CLAUDE_CODE_SKIP_AUTH_LOGIN: '1'
  },
  stdio: ['pipe', 'pipe', 'pipe']
});
```

## 6. 发送消息

启动后，向 `stdin` 写入一条 JSON 消息。

示例形式：

```ts
child.stdin.write(JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '请帮我创建一个 555.txt 文件'
      }
    ]
  }
}) + '\n');
```

> 注意：Claude CLI 的 stream-json 输入协议可能随版本变化。建议以当前安装版本实际行为为准。

## 7. 读取返回结果

监听 stdout：

```ts
child.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      console.log('Claude event:', event);
    } catch {
      console.log('Claude raw:', line);
    }
  }
});
```

监听 stderr：

```ts
child.stderr.on('data', (chunk) => {
  console.error(chunk.toString('utf8'));
});
```

监听退出：

```ts
child.on('exit', (code, signal) => {
  console.log('Claude exited:', { code, signal });
});
```

## 8. 与本地 Relay 配合

如果要让 Claude CLI 走本扩展的本地 Relay，可以设置环境变量：

```ts
env: {
  ...process.env,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:17783',
  ANTHROPIC_AUTH_TOKEN: 'your-token',
  CLAUDE_CODE_SKIP_AUTH_LOGIN: '1'
}
```

其中：

- `ANTHROPIC_BASE_URL` 指向本地 relay；
- `ANTHROPIC_AUTH_TOKEN` 是给本地 relay 的 token；
- `CLAUDE_CODE_SKIP_AUTH_LOGIN=1` 用于跳过登录提示。

## 9. 会话恢复

如果想继续最近会话：

```bash
/path/to/claude \
  --output-format stream-json \
  --input-format stream-json \
  --verbose \
  --continue
```

如果想恢复指定会话：

```bash
/path/to/claude \
  --output-format stream-json \
  --input-format stream-json \
  --verbose \
  --resume <session-id>
```

## 10. 重要限制

这种方式启动的是你自己的 Claude CLI 进程：

- 不会把消息发送到官方 Claude Code Webview；
- 不会复用官方 Claude Code 面板当前输入框；
- 不会自动复用官方 Webview 当前会话 UI；
- 需要你自己解析 stdout 事件；
- 如果需要权限确认、工具回调、diff 展示，需要自己处理对应事件。

## 11. 推荐使用方式

如果目标是稳定自动执行任务，推荐：

1. 用户配置 Claude CLI 路径；
2. 扩展启动独立 Claude CLI；
3. 使用 `--input-format stream-json` 和 `--output-format stream-json`；
4. 通过 stdin 发送任务提示；
5. 通过 stdout 解析执行结果；
6. 通过环境变量接入本地 Relay 和当前模型配置。

如果目标是控制官方 Claude Code Webview，则仍然只能使用 UI 层面的粘贴/回车模拟方式。
