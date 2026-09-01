/**
 * @file 模型级缓存策略查表工具。
 *
 * OpenAI Chat 与 Responses 两个代理都需要在转换请求体前取到目标模型的
 * `cacheMode`，故独立成模块共享；本文件不访问 VS Code API，便于单测。
 */

import type { ModelCacheMode, ProviderConfig } from '../types';

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
