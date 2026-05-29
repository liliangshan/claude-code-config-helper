/**
 * @file 专家模式（双 CLI 路由）相关的代码内常量。
 *
 * 自双 CLI 路由方案落地后，专家执行不再走「主 CLI 通过 MCP 工具临时 spawn 专家子进程」
 * 的旧链路，而是由扩展宿主常驻一条 expert CLI、由 `activeRoute` 状态机 + `@llsExpert`
 * 文本标记控制路由。Relay 侧请求来源归因由本地 HTTP path 前缀承担，不再依赖
 * `LLS_CHAT_ROLE` 环境变量。
 */

/**
 * Claude Code CLI 自带的「原生 sub-agent 工具」名称。
 *
 * Claude CLI 自带了一个 `Agent` 工具（也叫 Task / sub-agent），可以让主模型
 * 一次性 spawn 一个子 agent 跑任务。这个能力与我们设计的「双 CLI 路由」高度重叠：
 *
 * - 原生 `Agent` 工具不在我们 relay 的控制范围内，无法做单 turn 调用上限、
 *   可见性面板、防递归保护；
 * - 主模型如果同时看到 `Agent` 与「`@llsExpert` 文本切路由」两种派生子任务的方式，
 *   会随机选择，导致路由策略形同虚设。
 *
 * 因此我们在三个 relay 转发器（anthropic / openai-chat / openai-responses）
 * 共用的 `injectLlsTaskRequestBody` 中**永久剔除** `Agent` 工具，强制所有
 * 「派生子任务」需求都走新的 `@llsExpert` 路由分流。
 */
export const EXPERT_NATIVE_AGENT_TOOL_NAME = 'Agent' as const;
