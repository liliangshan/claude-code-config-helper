# 专家模式按需启动方案设计

> 目标：把当前「常规 CLI + 专家 CLI 双常驻 + `@llsExpert` 文本路由」的高负担实现，简化为「单 CLI 默认处理一切；仅当用户显式说『专家』或主模型自判无法决策时，按需启动专家会话；专家会话不载入历史上下文」。
> 参考实现模式：`/Users/lls/wwwroot/liliangshan/vcode/liliangshan.openapi-compatible-copilot` 的 `ask_llsoai` 工具调用模式（主模型默认处理，显式需要专家时才调用，专家以独立 messages 启动，不继承主对话历史）。

---

## 1. 现状分析

### 1.1 当前实现：双 CLI 常驻 + 文本路由

源代码索引：

- `src/extension.ts:88-126`：模块级两条 CLI 单例 `normalCliProcess` / `expertCliProcess`，启动期同时孵化。
- `src/extension.ts:1046`：`let activeRoute: ChatRoute = 'normal'`，全局路由变量；按 sessionId 还存一份 `chatSessionRouteById`。
- `src/extension.ts:1118-1182`：normal CLI 输出文本如果出现 `@llsExpert`，把 `activeRoute` 切到 `'expert'`，把剩余指令文本发给 expert CLI；用户消息开头 `@llsExpert` 时直接强制路由。
- `src/extension.ts:1462-1479`：扩展启动时 ensure 阶段会 `expertCliProcess.start(expertLaunchConfig)`，无论用户当前是否需要专家。
- `src/chat/routing/expertHandoff.ts`：`@llsExpert` 标记的识别 / 剥除纯函数。
- `src/chat/cli/cliConfig.ts:86-194`：`DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT` + `DEFAULT_EXPERT_APPEND_SYSTEM_PROMPT`，dispatcher 提示词里硬编码「源码改动必须 `@llsExpert` 移交」，约 50+ 行强约束。
- `src/chat/cli/cliConfig.ts:280-374`：`getDualConfigsWithRelayEnv()` 派生 normal / expert / plan / review 四组 CLI 启动参数，每组都注入独立 system prompt。
- `src/expertMode/expertConfig.ts`：项目级 + 全局级 `chat.expertMode.*` 配置三层合并。已经只剩配置读取。
- `src/expertMode/expertConstants.ts`：保留 `EXPERT_NATIVE_AGENT_TOOL_NAME = 'Agent'`（Relay 注入时永久剔除 Claude CLI 自带 `Agent` 工具，避免与 `@llsExpert` 互相打架）。
- `src/chat/cli/sessionStore.ts:32`：session 维度的 `route: 'normal' | 'expert'` 字段。
- `src/relay/*`：当前 Relay 不感知 normal/expert，只按 `model` 字段路由，本方案下保持不变。

### 1.2 痛点

1. **常驻代价高**：即使用户整天都在做轻量问答，专家 CLI 也始终 `--print --output-format=stream-json` 起着、占内存、占 token quota（部分上游会按活跃 session 计费/限流）。
2. **`@llsExpert` 误触发面广**：dispatcher 默认 prompt 把「任何源码修改」都强制要求 `@llsExpert`，导致简单的注释修正、单行 bugfix 都触发模型切换，链路长、首字时间慢。
3. **历史上下文叠加**：expert CLI 是常驻 session，第 N 次 `@llsExpert` 会带上 expert 自己之前 N-1 轮的全部上下文，token 涨幅难控；且 expert 偶尔会把上一次任务的残留细节混到本次回答里。
4. **协议复杂**：webview 顶部要常驻显示 expert 名字、`route badge`、`route/changed` 事件、session-route 映射；状态机比单 CLI 多三倍。
5. **调试困难**：路由切换发生在「assistant 流式输出文本里的标记」上，标记前缀正则一旦在用户消息体里命中（例如粘贴日志中刚好有 `@llsExpert`）就会误切。

### 1.3 参考项目 `ask_llsoai` 的本质

```
用户提问
  ↓
主模型（唯一在线模型）正常处理
  ↓
主模型在 tool list 中看到 `ask_llsoai`
  ↓
- 简单任务：不调用，直接答完
- 难任务：主模型主动 emit tool_call(ask_llsoai, { question })
  ↓
扩展宿主拦截 ask_llsoai tool_call，开启一段「专家 sub-turn」
  ↓
专家 messages 只有：
  [ system(expert prompt), user(question) ]
明确丢弃主对话历史（参考 provider.ts:2615 `_buildExpertInitialMessages`）
  ↓
专家可调用同一批 VS Code 工具（read_file、grep、get_errors 等）
  ↓
专家输出 → 以 tool_result 形式回写给主模型 → 主模型续写最终答复
```

关键性质：
- **专家是工具，不是路由**：tool_call 比 `@llsExpert` 文本标记更稳健，永远不会被用户消息误命中。
- **专家不带历史**：`_buildExpertInitialMessages` 显式只放 `system + user(question)`，"Previous conversation history and record-only context are intentionally not included"。
- **专家可见**：工具调用、tool_result 仍走 progress.report 给 webview，用户能看到专家在做什么。
- **频次受控**：参考项目里有 `MAX_AUTO_EXECUTED_TOOL_ROUNDS` / `MAX_SOLUTION_EXPERT_REVIEW_COUNT` 等上限。

---

## 2. 需求与目标行为

### 2.1 用户视角

| 场景 | 期望行为 |
|------|----------|
| 用户问"现在几点" | 普通 CLI 直接答，不出现"专家启动"卡片 |
| 用户让"修个变量名" | 普通 CLI 直接改、commit；不再被强制走专家 |
| 用户让"帮我重构整个 X 模块" | 主模型自判难度高 → 调用 `ask_expert` → 用户看到「🧠 专家模式已启动」卡片 → 专家给出方案 → 主模型续写应用方案 |
| 用户明确说"用专家分析一下 …" / "/expert …" / "@llsExpert …" | 不经主模型判断，直接强制 ask_expert 一次 |
| 专家未配置时用户说"用专家分析" | 主模型礼貌降级：「未配置专家模型，按普通模式继续」并直接答 |
| 同一回合连续两次复杂问题 | 每次都独立启动专家 sub-turn，但**专家自身不携带上次专家 turn 的上下文**（无状态 sub-agent） |

### 2.2 系统不变量

1. **单 CLI 常驻**：扩展启动只起 1 条 stream-json CLI（沿用现有 `normalCliProcess`，去掉 `expertCliProcess`）。
2. **专家无常驻进程**：专家每次以一段「子请求」形式启动；可以是 fresh CLI（`--print` 一次性），也可以是直接经 Relay 发一次 `/v1/messages`。本方案选择后者，详见 §4.4。
3. **专家无历史上下文**：专家 messages 严格只含 `[ system(expert prompt), user(question) ]`；不附带 normal CLI 的任何用户/assistant turn。
4. **专家结果回写主模型**：以 `tool_result(tool_use_id=ask_expert)` 形式返回，由主模型续写最终答复。webview 同步看到专家卡片与结论。
5. **协议向后兼容**：保留 `chat.expertMode.*` 配置 key、保留 `expert/event` webview 消息（只是路径变了）；移除 `route` / `route/changed` 类协议。
6. **轻量识别**：用户级别"专家"触发支持三种写法：`@llsExpert …`（兼容老 muscle-memory）、`/expert …`、中文"用专家分析"自然语言模式（可选，靠主模型自己判定）。

---

## 3. 架构总览

```
┌───────────── Webview ─────────────┐
│ header: Normal: <name> · Expert: <name>?[未配置] │
│ composer (无 route badge)          │
└──────────────┬────────────────────┘
               │ user/send (text)
               ▼
┌──────── 扩展宿主 extension.ts ────────┐
│ 单条 cliProcess (== 旧 normalCliProcess) │
│   ├── StreamJsonCliAdapter           │
│   │   └── 拦截 tool_use(name=ask_expert)
│   │        ↓
│   │     ExpertSubturnService.run({ question, sessionId })
│   │        ↓
│   │      a) emit expert/event (started) → webview
│   │      b) 经 Relay 直发一段独立 messages：
│   │         POST /v1/messages
│   │         model = expertModel
│   │         messages = [ {role:user, content: question} ]
│   │         system  = expert system prompt
│   │         tools   = sub-agent 可用工具（read_file/grep/get_errors 等）
│   │      c) 流式 progress 回灌 webview
│   │      d) 拿到 final answer → 包成 tool_result 写回主 CLI stdin
│   │            { type:"user", message:{ role:"user",
│   │              content:[ { type:"tool_result", tool_use_id, content:<expertText> } ] } }
│   └── 续写主模型回答
└──────────────┬────────────────────────┘
               ▼
       Relay (无改造，沿用)
```

要点：
- **专家不再是常驻 CLI 子进程**，而是宿主直连 Relay 的"一次性请求"，复用 Relay 的 anthropic/openai-chat/openai-responses 三套 adapter（已存在）。
- 主 CLI 仍以 Claude CLI 长连接 stream-json 方式运行；专家结果以 SDK 协议行 `tool_result` 注入回主 CLI stdin，让主 CLI 自行续写。
- `@llsExpert` 路由分支彻底退役；`/expert` 与 `ask_expert` tool_call 是唯一两条入口。

---

## 4. 涉及模块清单（保留 / 删除 / 改造）

### 4.1 保留（无需改动 / 仅做小幅适配）

| 模块 | 说明 |
|------|------|
| `src/expertMode/expertConfig.ts` | 配置三层合并函数继续使用，无变化。 |
| `src/constants.ts` 内 `CHAT_EXPERT_MODE_*` 系列 key | 配置 key 不变，迁移成本为零。 |
| `src/expertMode/expertConstants.ts` 内 `EXPERT_NATIVE_AGENT_TOOL_NAME` | Relay 注入时剔除 Claude CLI 原生 `Agent` 工具仍然有用——避免主模型自行 spawn 子 agent 绕过我们的 `ask_expert`。 |
| `src/chat/cli/cliProcess.ts` | 仍负责长连接，无须为本方案改造（仅适配新的 stdin 写入工具结果，封装方法已存在）。 |
| `src/relay/*` | 不需要新路径；专家请求复用现有 `/v1/messages`（Anthropic 路径，主模型上游若是 OpenAI 系也同样适用 Relay 已有转换器）。 |
| Webview `expertPanel` 渲染逻辑 | 旧 `expert/event` 事件保留：`started` / `tool_use` / `tool_result` / `assistant_text` / `done`。事件来源从「expert CLI adapter」改为「ExpertSubturnService」。 |

### 4.2 删除

| 模块 / 字段 | 删除原因 |
|--------------|----------|
| `src/extension.ts` 内 `expertCliProcess` 单例、`expertStreamJsonAdapter`、`expertCliStatusSubscription`、`expertCliExitSubscription` | 不再启动第二条 CLI。 |
| `src/extension.ts` 内 `activeRoute` / `chatSessionRouteById` / `setActiveRoute` / `getActiveRouteFor` / `route/changed` post | 不再有路由概念。 |
| `src/chat/routing/expertHandoff.ts` | `@llsExpert` 文本路由整体退役；保留一个**轻量函数 `startsWithExpertPrefix`** 迁移到 `src/expertMode/expertTriggers.ts`（仅用于把用户输入开头的 `@llsExpert` 当作"强制专家"信号，等价于 `/expert`）。 |
| `src/chat/cli/cliConfig.ts` 内 `DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT` 中"必须 `@llsExpert` 移交"段落、`DEFAULT_EXPERT_APPEND_SYSTEM_PROMPT` 整段 | 改写为「主模型自由处理 + ask_expert 工具说明」的简短描述，详见 §5.1。 |
| `src/chat/cli/cliConfig.ts` 内 `getDualConfigsWithRelayEnv` 派生 expert CLI 的分支 | 改为只派生 `{ normal, plan?, review? }`；expert 不再是 CLI。 |
| `src/chat/cli/sessionStore.ts:32` 里的 `route` 字段及读写处 | 单 CLI 不需要 session 路由。 |
| webview 顶部 `route badge` | UI 移除；保留「专家模型名 / 未配置」展示，但仅作显示用。 |

### 4.3 改造

| 模块 | 改动概要 |
|------|----------|
| `src/extension.ts` ensure / restart 链路 | 只起一条 CLI；移除 `expertLaunchConfig` 派生与启动。 |
| `src/chat/cli/cliAdapter.ts` | 在 `parseSdkWrapperEvent` / `handleStandaloneToolBlock` 的 `tool_use` 分支增加拦截：当 `name === 'ask_expert'` 且 input 解析成功，立即触发新建的 `ExpertSubturnService.run()`；该工具调用本身**不**作为普通工具卡片渲染（沿用现有 `HIDDEN_CHAT_TOOL_NAMES` 集合扩展）。改为发出新事件 `expert/subturn/started`。 |
| `src/chat/cli/cliConfig.ts` | dispatcher prompt 仅保留「源码可改 + 必要时调用 ask_expert」的极简描述（§5.1）；新增把 `ask_expert` 注入 Claude CLI 的工具表（通过 MCP server 或 `--append-system-prompt` 描述 + Relay 工具列表注入两种方案，详见 §4.4）。 |
| `src/relay/router.ts` | 新增 `/__expert/subturn` 内部端点（可选，仅当采用方案 B/§4.4 时），用于宿主→专家上游的隔离调用通道；默认走方案 A，不需要新端点。 |
| Webview `media/chat/main.js` | 移除 `route/changed` 监听、移除 expert 下拉切换"激活态"逻辑；保留专家事件 panel；新增对"专家未配置"提示的占位渲染。 |
| `src/types.ts` / `src/chat/protocol.ts` | 删除 `route` 协议；新增 `expert/subturn/*` 协议族（started / progress / done / failed）。 |

### 4.4 专家子请求的执行通道：方案对比

| 方案 | 描述 | 优劣 |
|------|------|------|
| **A. 宿主 → Relay HTTP**（推荐） | `ExpertSubturnService` 用 `node-fetch` 直发 `POST http://127.0.0.1:<relayPort>/v1/messages`，body 形如 `{ model: expertModel, system, messages:[user], stream:true, tools }`。复用 Relay 已有 anthropic/openai-chat/openai-responses 三套 adapter。 | + 复用 Relay 全部上游兼容、token budget、debugRecorder；+ 不引入新进程；+ 易做 mock 单测。<br>− 工具调用需要宿主自己跑一次 mini-agent loop（while tool_use → 执行 → tool_result → 续问）。 |
| **B. 一次性 `claude-code --print`** | 宿主 spawn 一条 `claude-code --print --model expertModel "<question>"` 子进程；跑完即退。 | + 完全复用 Claude CLI 的 agent loop。<br>− 每次启动~300-800ms 冷启动；− 难以中断；− 无法精细控制工具白名单；− 进程数失控时容易耗尽 FD。 |
| **C. 复用一条 expert CLI 但每次 `/clear`** | 保留 expert CLI 常驻，但每次专家 sub-turn 前先发 `/clear` 命令清空上下文。 | + 启动快。<br>− 仍有常驻代价；− Claude CLI 的 `/clear` 历史上对 stream-json 模式不一定 100% 清干净，存在残留风险；− 与"按需启动"目标违背。 |

**结论**：采用方案 A。`ExpertSubturnService` 实现一个**极简 mini-agent loop**（read_file / grep / get_errors 三件套作为只读工具），最多 N 步（默认 6 步）。

---

## 5. 协议与提示词调整

### 5.1 dispatcher（主 CLI）system prompt 改写

新 prompt（追加到 `--append-system-prompt`，替换 §1.1 中冗长的 `DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT`）：

```
You are the primary engineering assistant. Handle requests directly whenever you
can — including writing, editing, refactoring code, running shell/git commands,
inspecting diffs, etc. You are NOT restricted to docs-only edits.

An optional `ask_expert` tool may appear in your tool list. Use it ONLY when:
  1. the user explicitly asks for the expert ("用专家", "ask the expert", /expert), OR
  2. you genuinely cannot make a confident decision after a reasonable look at
     the context — e.g. a non-trivial architecture trade-off, an unfamiliar
     subsystem with high blast radius, or a step where a wrong choice would
     waste significant work.

Do NOT call `ask_expert` for:
  - simple, local edits;
  - questions you can answer from the files you can already read;
  - speculative "let me double-check" calls.

When calling `ask_expert`, pass `{ "question": "<one self-contained paragraph>" }`.
The expert receives NO conversation history — your question must be self-contained.
Treat the returned `tool_result` as advisory and integrate it into your final reply.

If `ask_expert` is not in your tool list, expert mode is disabled — just answer
directly and never mention the expert.
```

（写入位置：`src/chat/cli/cliConfig.ts` 替换 `DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT`；继续允许用户用 `chat.dispatcher.appendSystemPrompt` 自定义覆盖。）

### 5.2 `ask_expert` 工具定义

注入入口（两条路径之一，选一个）：

- **路径 P1 — MCP server**：参照旧 `llsExpert` MCP server 模式，新建一个轻量 MCP server 只暴露一个工具 `ask_expert`，由扩展宿主进程自身提供（用 stdio transport in-process 实现）。tool schema：

  ```json
  {
    "name": "ask_expert",
    "description": "Delegate a single, self-contained engineering question to a stronger expert model. The expert receives ONLY the question text — no chat history. Use only when truly needed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "A self-contained question / task description for the expert."
        }
      },
      "required": ["question"]
    }
  }
  ```

- **路径 P2 — Relay 工具列表注入**：在 Relay 的 `anthropicProxy.ts` / `openaiChatProxy.ts` / `openaiResponsesProxy.ts` 三处的 request body 注入阶段，把 `ask_expert` 追加到 tools 数组；模型 emit 该 tool_call 后，Relay 在响应流里把 tool_use 透传给 CLI（不执行），由 CLI stdout 流出，被 `cliAdapter` 拦截后转交给 `ExpertSubturnService`。

推荐路径 P1：MCP 路径在 stdin/stdout 上有成熟的工具协议，Claude CLI 的 permission flow 也自动覆盖 MCP 工具，无需碰 Relay。代价是要写一个最小 in-process MCP server，但比改三套 Relay adapter 简单很多。

### 5.3 `ExpertSubturnService` 内部 messages 构造

参考 `provider.ts:2615` 的 `_buildExpertInitialMessages`：

```ts
function buildExpertMessages(question: string, expertModelId: string) {
    return {
        system: [
            'You are the expert model. Independently handle the delegated task ',
            'from the question only. Previous conversation history and any ',
            'project-wide context are intentionally NOT included.',
            '',
            'You may use the provided read-only tools (read_file, grep_search, ',
            'get_errors) to gather evidence. Make intermediate reasoning visible. ',
            'When you have enough information, return ONE concise final ',
            'recommendation for the dispatcher to apply.',
            '',
            'Do not call ask_expert recursively. Do not request planning ',
            'workflow tokens (@llsPlanTask etc.).'
        ].join('\n'),
        messages: [
            { role: 'user' as const, content: question }
        ]
    };
}
```

### 5.4 工具结果回灌主 CLI 的 SDK 协议行

参考 `cliAdapter.ts:357` `buildUserMessageLine`：

```ts
const toolResultLine = {
    type: 'user',
    message: {
        role: 'user',
        content: [{
            type: 'tool_result',
            tool_use_id: askExpertToolUseId,
            content: expertFinalText
        }]
    }
};
this.process.send(JSON.stringify(toolResultLine));
```

主 CLI 收到后会自动续写后续 assistant turn（Claude CLI 在 stream-json 模式下对 tool_result 是原生支持的）。

### 5.5 Webview 协议增量

| 旧协议 | 新协议 | 说明 |
|--------|--------|------|
| `route/changed { route }` | 删除 | UI 不再有 route 概念 |
| `expert/event` 系列 | 保留（事件源换成 ExpertSubturnService） | webview 仍按现状渲染 expertPanel |
| 新增 | `expert/availability { available, modelName? }` | 扩展启动后向 webview 报告专家是否配置好；用户改配置后再次广播 |

### 5.6 兼容用户 muscle-memory

- `@llsExpert <question>` 开头 → 扩展宿主在 `user/send` 入口侦测（沿用 `startsWithExpertPrefix`），剥前缀后包装为一次显式 `ask_expert` 调用；专家结果以 `tool_result` 形式给主模型，或直接展示给用户（可配置项 `chat.expert.userTriggerMode = "tool_result" | "direct"`，默认 `direct`）。
- 同义 trigger：`/expert <question>`。

---

## 6. 迁移步骤

按从下到上、可逐步落地的顺序执行：

1. **配置层（无破坏）**
   - 在 `package.json` / `package.nls.*.json` 中新增 `chat.expert.userTriggerMode`、`chat.expert.maxSteps`（默认 6）、`chat.expert.appendSystemPrompt`（已存在则沿用）；保留 `chat.expertMode.*` 全部 key。
   - `src/expertMode/expertConfig.ts` 增加 `readExpertSubturnOptions()` 读上述新键。

2. **新增 ExpertSubturnService**
   - 文件：`src/expertMode/expertSubturnService.ts`
   - 依赖：Relay base URL（从 `RelayServer` 拿 port）、当前 expert 模型配置、共享的 `Logger` / `Notification`。
   - 功能：实现 §3 流程图中 `b`/`c`/`d` 步骤；内部维护一个 `messages[]` 并跑 mini-agent loop。
   - 暴露事件：`onEvent({ type:'started'|'tool_use'|'tool_result'|'text'|'done'|'failed', ... })`。

3. **In-process MCP server**
   - 文件：`src/expertMode/askExpertMcpServer.ts`
   - 以 `@modelcontextprotocol/sdk` 的 `StdioServerTransport` 包一层（已经在依赖里）；只暴露一个 tool。
   - 工具 `ask_expert` 的实现 = 调 ExpertSubturnService.run() 并把最终文本返回给 Claude CLI（作为 MCP tool_result）。
   - 在 `getDualConfigsWithRelayEnv` 派生 normal CLI launch config 时，自动把这条 MCP server 加入 `mcpServers` map（仅当 expert 配置开启时）。

4. **改 dispatcher prompt**
   - 在 `src/chat/cli/cliConfig.ts` 替换 `DEFAULT_DISPATCHER_APPEND_SYSTEM_PROMPT` 为 §5.1 文案。
   - 删除 `DEFAULT_EXPERT_APPEND_SYSTEM_PROMPT`（仅当 plan/review 已自带各自 prompt 时；本方案 plan/review 不变）。
   - 删除 `DISPATCHER_PLAN_REVIEW_PROMPT` 里关于 `@llsExpert` 的引用，保留对 `@llsPlanTask` 的引用（plan/review 流程不动）。

5. **改 extension.ts**
   - 删除 expert CLI 单例与全部生命周期管理代码（about 200 LOC，集中在 `ensureChatCliStarted` / `restartChatCli` / `disposeExpertCli` 三块）。
   - 删除 `activeRoute` / `setActiveRoute` / `route/changed` post / `chatSessionRouteById`。
   - 在 `sendUserMessage` 入口加 §5.6 的"用户强制专家"分流：识别 `@llsExpert` / `/expert` 前缀 → 直接调 ExpertSubturnService → 按 userTriggerMode 决定是否回写 tool_result 给主 CLI。

6. **改 cliAdapter.ts**
   - 在 `HIDDEN_CHAT_TOOL_NAMES` 或新增 `EXPERT_DELEGATION_TOOL_NAMES` 集合中加入 `ask_expert`（MCP 工具实际工具名是 `mcp__askExpert__ask_expert`，需要按 Claude CLI 的命名规则加前缀）。
   - 在 tool_use 命中该名时，不发 segment（不渲染普通工具卡片），改 emit `expert/subturn/started` 事件 + 内部 `tool_use_id` 暂存，等待 MCP 工具结果回填后写回。

7. **改 sessionStore / 协议**
   - 删除 `route` 字段；调整测试。
   - `src/chat/protocol.ts` 移除 route 相关 message type；新增 expert 事件 type。

8. **改 webview**
   - `media/chat/main.js` 移除 route 切换处理；增加 `expert/availability` 监听并展示在 header。
   - `media/chat/index.html` 移除 route badge。
   - `media/chat/style.css` 清理 unused 类。

9. **删除 `src/chat/routing/expertHandoff.ts`**
   - 把 `startsWithExpertPrefix` / `stripExpertPrefix` 迁移到 `src/expertMode/expertTriggers.ts`；其它两个文本路由函数（`containsExpertHandoff` 等）直接删除。

10. **清理 plan/review**
    - plan/review 的双 CLI 暂不动；但 dispatcher prompt 中关于 plan 的描述需要重新校对，确保删掉 `@llsExpert` 相关诱导词后 plan 路径仍 self-contained。

11. **CHANGELOG / README / package.nls 文案同步**
    - README 与 PROMO 文档中"双 CLI 路由"段落改写为"按需专家"。
    - `package.json` 版本号 +0.1（参考现有 `2.0.21`，建议 `2.1.0` 标记破坏性 UI 变更）。

---

## 7. 测试验证

### 7.1 单元测试

| 测试目标 | 文件 | 关键 case |
|----------|------|-----------|
| `buildExpertMessages` 不包含历史 | `src/expertMode/__tests__/expertSubturnMessages.test.ts` | system + user 各 1 条；任何额外 messages 必须断言不存在 |
| `expertTriggers.startsWithExpertPrefix` | `src/expertMode/__tests__/expertTriggers.test.ts` | `@llsExpert foo` ✓；`text @llsExpert foo` ✗；`/expert foo` ✓ |
| ask_expert MCP server tool schema | `src/expertMode/__tests__/askExpertMcpServer.test.ts` | 注册的 tool 唯一、name 严格等于 `ask_expert`；调用即触发 ExpertSubturnService |
| dispatcher prompt 不再含 `@llsExpert` 字眼 | `src/chat/cli/__tests__/cliConfig.dispatcherPrompt.test.ts` | 断言 prompt 字符串不包含 `@llsExpert` 也不包含"MUST delegate" |
| cliAdapter 识别 `ask_expert` 并隐藏卡片 | `src/chat/__tests__/cliAdapter.askExpert.test.ts` | 给一段 `tool_use(name=mcp__askExpert__ask_expert)` 事件，断言不产生 ChatSegment 而是产生 expert/subturn/started 事件 |
| session route 字段已删除 | `src/chat/cli/__tests__/sessionStore.test.ts` | 旧字段不再出现；旧持久化数据迁移时被 ignore |
| `getDualConfigsWithRelayEnv` 不再派生 expert | `src/chat/cli/__tests__/cliConfig.dualConfigs.test.ts` | 返回结构里不再有 `expert: ChatCliConfig` 字段 |

### 7.2 集成测试

| 场景 | 验证点 |
|------|--------|
| 扩展激活 → 只有一条 CLI 子进程 | spawn mock 统计调用次数；只 spawn 1 次 |
| 主模型直接答 "git status" | 不触发 ExpertSubturnService.run；无 expert 事件 |
| 主模型主动 `ask_expert` | Relay mock 收到一条 expert 模型请求；messages 长度为 1；webview 收到 started + done |
| 用户输入 `@llsExpert refactor X` | 不经主模型 → 直接 expert 子请求 → tool_result 不回写主 CLI（direct 模式默认）；webview 显示专家面板 |
| 专家配置缺失时调用 `ask_expert` | MCP 工具返回 `"There is currently no available expert."`（参考 `_continueMainAfterUnavailableExpert`）；主模型自行降级 |
| 专家 sub-turn 中断（用户点 cancel） | AbortSignal 传递到 Relay 调用；expert/event done(reason=canceled)；主 CLI 仍然健康 |

### 7.3 回归测试

| 项 | 关注点 |
|----|--------|
| plan / review 工作流 | `@llsPlanTask` → plan CLI → review CLI 链路不受影响；dispatcher prompt 改写后仍能正确触发 plan |
| token budget 压缩 | 专家 sub-turn 自身不进入主 CLI 的 token budget，但 tool_result 注入回去后会被 budget service 计入；现有压缩测试 `tokenBudgetIntegration.test.ts` 需要新增一条「`tool_use(ask_expert) + tool_result` pair 不被中途截断」断言 |
| 权限提示 | MCP 注入的 `ask_expert` 应自动被 Claude CLI 视为内部 MCP 工具，不会触发 `--permission-prompt-tool stdio` 流；测试在 `permissionMode=plan/strict` 各种组合下 |
| 已有 `__tests__/cliAdapterSystemTaskEvent.test.ts` | 不应回归——`Agent` 仍在 HIDDEN_CHAT_TOOL_NAMES |
| webview 重启续推 `chat:reattach` | 单 CLI 续推路径不变；删除 route 字段后旧 session JSON 仍能加载（忽略未知字段） |

### 7.4 手动验收清单

- [ ] 冷启动扩展，VS Code Output 仅看到一条 CLI 启动日志
- [ ] 问 "你好" — 即时回答，无专家卡片
- [ ] 让模型修一个变量名 — 主模型直接 Edit，无专家卡片
- [ ] 让模型 "重构 src/chat/cli 全部模块" — 触发专家卡片，能看到 expert tool_use → tool_result → 主模型续写
- [ ] 输入 `@llsExpert 解释一下 Relay 路由逻辑` — 直接进专家面板
- [ ] 关闭 expert 配置后重复以上 — 专家入口消失，主模型 prompt 中 `ask_expert` 工具消失，dispatcher 也不再提
- [ ] webview header 显示 `Normal: <主模型名> · Expert: <专家名 / 未配置>`
- [ ] 路由 badge 不再出现

---

## 8. 风险与对策

### 8.1 触发词误判

| 风险 | 缓解 |
|------|------|
| 主模型对"复杂"判断过于保守 → 频繁 ask_expert，延迟与成本飙升 | dispatcher prompt 明确"Do NOT call for simple, local edits / questions you can already answer"；加 `chat.expert.maxCallsPerTurn`（默认 1）硬上限；超限后 MCP 工具直接返回 "expert quota exhausted, answer yourself" |
| 主模型对"复杂"判断过于激进 → 大改动也自己上 | 接受这个 trade-off，因为本方案目标就是"默认信任主模型"。如需更保守可�� prompt 末尾加 hint "When unsure, prefer ask_expert"，通过 `chat.expert.aggressiveness` 配置切换两段模板 |
| 用户消息体里出现 `@llsExpert`（粘贴日志、引用旧文档）误触发 | `startsWithExpertPrefix` 仅匹配开头；用户也无法在消息中间触发——这是相对旧 `containsExpertHandoff` 的纯收益 |
| 中文自然语言"用专家分析"识别只能靠主模型判断 → 不稳定 | 提示用户使用 `/expert` 或 `@llsExpert` 显式前缀；FAQ 文档化 |

### 8.2 历史配置兼容

| 风险 | 缓解 |
|------|------|
| 用户原 `chat.expertMode.project.*` 设置仍有效，但 `chat.dispatcher.appendSystemPrompt` 自定义文案里仍含老 `@llsExpert` 指令 | 启动检查：若用户自定义 dispatcher prompt 包含 `@llsExpert` 字眼，弹一次性 toast 提示"路由模式已退役，建议清空自定义 prompt 让默认值生效" |
| 项目 `.vscode/settings.json` 中可能残留 `mcpServers.llsExpert` | 沿用现有 `stripExpertServerFromMcp` 防御性剔除（已有，无须改） |
| 旧 session JSON 含 `route: 'expert'` 字段 | `sessionStore` 反序列化时忽略未知字段；写一次新版本就被覆盖 |
| `chat.planMode.*` / `chat.reviewMode.*` 暂未改，但 dispatcher prompt 改写后若意外影响 plan 触发 | 单测覆盖 plan/review prompt；prompt 改动仅 trim 与 `@llsExpert` 相关段落，对 `@llsPlanTask` 部分原文保留 |

### 8.3 协议 / UI 断裂

| 风险 | 缓解 |
|------|------|
| 老版本 webview 缓存仍订阅 `route/changed` 事件 → 控制台报 warn | webview 端做 `case 'route/changed': /* legacy noop */ break;` 显式吞掉；版本升级走标准的 cache-bust（已有 `?v=` query） |
| `expertPanel` 事件源切换后字段不一致 | ExpertSubturnService 输出事件严格按现有 `expert/event` schema；增加适配层把内部事件映射成 webview 协议 |
| 主 CLI 在 tool_result 注入后没有自动续写 | Claude CLI stream-json 模式对 SDK 协议行 `tool_result` 是 first-class 支持的（参考 `cliAdapter.ts:1264` 的 SDK wrapper 解析）；在 dev 阶段先用 `--verbose` 复核一次 |
| In-process MCP server 启动失败把整条 CLI 拖死 | MCP server 初始化失败时降级：不注入 mcpServers.askExpert，dispatcher prompt 中删去 ask_expert 段落（与"专家未配置"路径合流） |

### 8.4 成本与延迟

| 风险 | 缓解 |
|------|------|
| ask_expert 调用增加一次 round-trip：主 CLI → MCP → ExpertSubturnService → Relay → 上游 → 反向回 | 这是必要代价。但相对旧方案"两条 CLI 常驻"是净节省（去掉常驻进程 + 去掉常驻 token quota）。MCP server in-process 不走子进程开销 |
| 专家上游模型贵 → 用户没意识到主模型已经在背后调它 | 在 webview 专家卡片头部明显展示 `model: <providerId/modelId>`；usage segment 在专家结束时给出独立 token 统计 |
| 专家 sub-turn 跑工具迭代次数失控 | `chat.expert.maxSteps`（默认 6）+ 单步超时 `chat.expert.stepTimeoutMs`（默认 60s）+ 总超时 `chat.expert.totalTimeoutMs`（默认 5min） |
| Relay 同时被主 CLI 与专家 sub-turn 调用 → token budget 抢资源 | Relay 已有 token budget service 是按 model 维度的，不会互相干扰；写测试验证主/专家并发不会触发预算误判 |

### 8.5 其他

| 风险 | 缓解 |
|------|------|
| 专家工具白名单太小（只 read_file/grep/get_errors）解决不了"需要看 diagnostic 后改代码"的问题 | 专家天然只读 — 它输出建议，主模型负责落地。这是和参考项目一致的边界。后续可视情况开 `apply_patch` 类工具 |
| 主模型有时不传 question 字段（schema validation 失败） | MCP 工具 inputSchema 严格要求 question；失败时返回明确 error，让主模型自行修正参数 |
| 用户在专家 sub-turn 进行中再发新消息 | 第一版做最朴素处理：排队等专家结束；UI 显示"专家分析中…"。后续可加 cancel-and-restart |
| 多窗口/多 workspace 启动多份扩展 | 每份扩展自己起独立 MCP server（stdio in-process），互不影响；Relay 端口已是每实例独立 |

---

## 9. 代码改动量预估

| 模块 | LOC 变化 |
|------|----------|
| `src/extension.ts` | −250（删 expert CLI 单例 + 路由）/ +30（user prefix 分流） |
| `src/chat/cli/cliConfig.ts` | −150（删 expert / dispatcher 长 prompt）/ +30（新短 prompt + ask_expert MCP 注入） |
| `src/chat/cli/cliAdapter.ts` | +50（拦截 ask_expert tool_use） |
| `src/chat/routing/expertHandoff.ts` | 删除（−65） |
| `src/expertMode/expertSubturnService.ts` | 新增 +~300 |
| `src/expertMode/askExpertMcpServer.ts` | 新增 +~120 |
| `src/expertMode/expertTriggers.ts` | 新增 +~30 |
| webview (`media/chat/*`) | −60 / +30 |
| 测试 | +400 |
| **合计** | 净增约 +250 LOC，但移除了一整套"双 CLI 常驻 + 路由状态机" |

---

## 10. 取舍 / 备选

- **保留 `@llsExpert` 兼容**：第一版保留，1-2 个版本后通过 changelog 提示后再彻底删除。
- **不实现自然语言"用专家"识别**：避免又陷入"标记误判"的循环；用户要么显式前缀，要么靠主模型自判。
- **不在第一版给专家开 write 工具**：保持参考项目同样的"只读 sub-agent"边界，避免专家直接动文件让主模型失去整合控制权。
- **plan / review 工作流保持双 CLI 不变**：plan 模型通常用户主动 `/plan` 触发，频次低，常驻代价可接受；本次只动 expert。

---

## 11. 落地里程碑

| 阶段 | 范围 | 验收 |
|------|------|------|
| M1 | §6.1-§6.3：ExpertSubturnService + MCP server 单元可跑通；不接入主链路 | 单测全绿 |
| M2 | §6.4-§6.6：dispatcher prompt + cliAdapter 拦截 + 单 CLI 化 | 手动验收清单全通过；旧路由路径彻底死代码 |
| M3 | §6.7-§6.10：协议 / webview / 文档清理 | 旧 route badge 完全消失，文档自洽 |
| M4 | 灰度发布 +0.5 版本（如 2.1.0-beta）；收集真实使用数据 | 专家调用频次中位数 < 0.3 次/对话；用户报告"找不到专家"事件 = 0 |







