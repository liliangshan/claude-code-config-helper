/**
 * @file 上游转发统一超时配置。
 *
 * 三个上游适配器（Anthropic 透传、OpenAI Chat 兼容、OpenAI Responses）共享一份
 * socket 空闲超时常量，避免上游卡死时本地 HTTP Relay 永远挂起，让上层「Relay
 * 命中看门狗 + 自愈重启」流程能拿到明确的 502 反馈。
 *
 * 超时语义：
 * - 这是 Node `http.RequestOptions.timeout`，表示 socket 上「连续多长时间没有
 *   任何字节往来」就触发 `timeout` 事件；
 * - 正常 SSE 流式响应只要持续有 chunk 到达（包括 keep-alive ping）就不会超时；
 * - 仅在上游 hang 死、TCP 卡住或网络中断时才会触发，触发后由各适配器自行
 *   销毁连接并回写 Anthropic 风格的 502 错误体。
 */

/**
 * 上游 socket 空闲超时（毫秒）。
 *
 * 默认 10 分钟：长推理（Claude / GPT-o 系列 reasoning）首字节可能 1~3 分钟，
 * 流式过程中也可能在工具调用阶段长时间没有 chunk。设置过小会误杀正常请求，
 * 设置过大会让用户在异常时等待过久。10 分钟是兼顾两者的折中值。
 */
export const UPSTREAM_SOCKET_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
