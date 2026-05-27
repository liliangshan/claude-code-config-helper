/**
 * @file 上游转发统一超时配置。
 *
 * 三个上游适配器（Anthropic 透传、OpenAI Chat 兼容、OpenAI Responses）共享超时常量，
 * 避免上游卡死时本地 HTTP Relay 永远挂起。
 */

/** 上游超时类型。 */
export type UpstreamTimeoutKind = 'first_byte' | 'stream_idle';

/**
 * 上游首字节超时（毫秒）。
 *
 * 请求发出后 120 秒内如果连响应头都没有回来，视为上游卡死。
 */
export const UPSTREAM_FIRST_BYTE_TIMEOUT_MS = 120_000;

/**
 * 上游流式响应空闲超时（毫秒）。
 *
 * 响应开始后 240 秒内如果没有任何响应体数据到达，视为流卡死。
 */
export const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 240_000;
