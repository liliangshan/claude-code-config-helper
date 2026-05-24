/**
 * @file 专家模式（ask_expert）相关的代码内常量。
 *
 * 设计原则：用户可调的只有 `enabled` 与 `model`（见 `chat.expertMode.*` 配置），
 * 所有「护栏」类参数全部下沉到本文件，避免给用户暴露过多易误配的旋钮。
 *
 * 详见 `EXPERT_MODE_DESIGN.md` §8 与 §11。
 */

/**
 * 专家进程总壁钟超时（毫秒）。
 *
 * 超过该时长无论是否完成都会强制 SIGTERM；与具体步数无关，是最外层的硬上限。
 * 默认 30 分钟，足够覆盖大多数 refactor / 多文件调查任务。
 */
export const EXPERT_TIMEOUT_MS = 1_800_000;

/**
 * 专家进程空闲超时（毫秒）。
 *
 * 连续 N 毫秒未收到任何 stream 事件视为 CLI 卡死，立即 SIGTERM。
 * 默认 5 分钟——网络层 / 上游模型最长合理沉默时间的兜底。
 */
export const EXPERT_IDLE_TIMEOUT_MS = 300_000;

/**
 * 专家循环最大步数（按 `tool_use` 内容块计数）。
 *
 * 选择按 `tool_use` 计数而非按 assistant 消息计数，更贴近用户对「工具轮数」的
 * 直觉。Claude Code 复杂 refactor 任务实测常达 100+ 次工具调用，设为 200 留足余量。
 */
export const EXPERT_MAX_STEPS = 200;

/**
 * 专家产生的 assistant 消息条数软上限。
 *
 * 触达即强制收尾，防止陷入「短消息 + 工具调用」死循环（罕见但需有兜底）。
 */
export const EXPERT_MAX_ASSISTANT_MESSAGES = 80;

/**
 * 单个主对话 turn 内允许调用 `ask_expert` 的最大次数。
 *
 * 防止主模型把专家当成 RPC 反复调（参考 openapi-compatible-copilot 的
 * `maxCallsPerTurn` 设计）。
 */
export const EXPERT_MAX_CALLS_PER_TURN = 1;

/**
 * SIGTERM 后等待优雅退出的时长（毫秒），超时则升级到 SIGKILL。
 *
 * 给 Claude CLI 5 秒做最后清理（关闭 MCP server 连接、flush 日志等）。
 */
export const EXPERT_KILL_GRACE_MS = 5_000;

/**
 * 专家 CLI 的权限模式。
 *
 * 与主进程对齐使用 `acceptEdits`，避免非交互 `--bare --print` 模式下
 * Edit/Write/Read 类工具被默认策略拦截。
 *
 * 注意：本字段**不暴露**为用户 setting，专家进程永远使用此值；
 * 如未来需要放宽到 `bypassPermissions`，再单独评估。
 */
export const EXPERT_PERMISSION_MODE = 'acceptEdits' as const;

/**
 * 专家执行过程是否对前端可见。
 *
 * - `true`（默认）：webview 显示 ExpertPanel 折叠面板，展示中间事件流；
 * - `false`：只显示最终结论，不显示中间事件（适合面向终端用户的精简模式）。
 */
export const EXPERT_VISIBLE_PROCESS = true;

/**
 * 写回主对话 `tool_result` 的 finalAnswer 上限（字节）。
 *
 * 超过后会被截断并在末尾标注 `[truncated, original=NN bytes]`。
 * 64 KB 对应约 16k tokens，已远超绝大部分合理结论需要的体量。
 */
export const EXPERT_FINAL_ANSWER_MAX_BYTES = 64 * 1024;

/**
 * 单条 `ExpertEvent` 推送给 webview 的文本上限（字节）。
 *
 * 主要用于截断超长的 tool_result 摘要 / assistant 文本，避免 webview 卡顿。
 */
export const EXPERT_EVENT_TEXT_MAX_BYTES = 4 * 1024;

/**
 * 内置专家 MCP server 在 `--mcp-config` 中使用的 server 名。
 *
 * 该名字会出现在 Claude CLI 的工具命名空间中（`mcp__llsExpert__ask_expert`），
 * 也用于 `buildExpertConfig()` 中从 mcpServers 字典里反向移除该 server。
 */
export const EXPERT_MCP_SERVER_NAME = 'llsExpert' as const;

/**
 * 内置专家工具在 MCP 协议中暴露的工具名。
 *
 * 主模型 system prompt 引导文案、防递归过滤、`maxCallsPerTurn` 计数等
 * 都按此名匹配，禁止散落字面量。
 */
export const EXPERT_TOOL_NAME = 'ask_expert' as const;

/**
 * 专家 CLI 子进程的环境变量名，用于 relay 区分主/专家流量。
 *
 * 专家进程 spawn 时会注入 `LLS_CHAT_ROLE=expert`，relay 可读取此 env
 * 把对应请求归类到「专家通道」日志或拒绝某些敏感路由。
 */
export const EXPERT_ROLE_ENV_KEY = 'LLS_CHAT_ROLE' as const;

/**
 * `EXPERT_ROLE_ENV_KEY` 的取值，固定为 `expert`。
 */
export const EXPERT_ROLE_ENV_VALUE = 'expert' as const;

/**
 * Claude Code CLI 自带的「原生 sub-agent 工具」名称。
 *
 * Claude CLI 自带了一个 `Agent` 工具（也叫 Task / sub-agent），可以让主模型
 * 一次性 spawn 一个子 agent 跑任务。这个能力与我们设计的「专家模式」高度重叠：
 *
 * - 原生 `Agent` 工具不在我们 relay 的控制范围内，无法做 `ask_expert` 那样的
 *   单 turn 调用上限、可见性面板、防递归保护；
 * - 主模型如果同时看到 `Agent` 和 `ask_expert`，会随机选择，导致专家模式
 *   配置形同虚设；
 *
 * 因此我们在三个 relay 转发器（anthropic / openai-chat / openai-responses）
 * 共用的 `injectLlsTaskRequestBody` 中**永久剔除** `Agent` 工具，强制所有
 * 「派生子任务」需求都走我们的 `ask_expert` 工具。
 */
export const EXPERT_NATIVE_AGENT_TOOL_NAME = 'Agent' as const;
