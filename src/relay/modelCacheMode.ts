/**
 * @file 模型级策略查表工具（缓存 `cacheMode`、思考 `reasoningMode`）。
 *
 * OpenAI Chat 与 Responses 两个代理都需要在转换请求体前取到目标模型的
 * 策略字段，故独立成模块共享；本文件不访问 VS Code API，便于单测。
 */

import type { ModelCacheMode, ModelReasoningMode, ProviderConfig } from '../types';

/**
 * 读取指定模型的缓存策略。
 *
 * @param provider 目标提供商配置。
 * @param modelId 已剥离前缀的模型 ID。
 * @returns 模型上配置的缓存策略；模型不存在或未配置时回落 `'auto'`。
 */
export function resolveModelCacheMode(provider: ProviderConfig, modelId: string): ModelCacheMode {
    return provider.models.find((item) => item.modelId === modelId)?.cacheMode ?? 'auto';
}

/**
 * 读取指定模型是否启用网关显式 Prompt Cache。
 *
 * @param provider 目标提供商配置。
 * @param modelId 已剥离前缀的模型 ID。
 * @returns 仅模型字段严格为 true 时返回 true。
 */
export function resolveModelExplicitCache(provider: ProviderConfig, modelId: string): boolean {
    return provider.models.find((item) => item.modelId === modelId)?.explicitCache === true;
}

/**
 * 读取指定模型的思考内容策略。
 *
 * 未配置时默认 `'passthrough'`：思考内容对用户有价值，应开箱即用；
 * 只有用户在配置页显式选择「关闭」才会得到 `'off'`。
 *
 * @param provider 目标提供商配置。
 * @param modelId 已剥离前缀的模型 ID。
 * @returns 模型上配置的思考策略；模型不存在或未配置时回落 `'passthrough'`。
 */
export function resolveReasoningMode(provider: ProviderConfig, modelId: string): ModelReasoningMode {
    return provider.models.find((item) => item.modelId === modelId)?.reasoningMode ?? 'passthrough';
}
