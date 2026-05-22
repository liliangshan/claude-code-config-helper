/**
 * @file 从上游服务拉取可用模型列表。
 *
 * 根据 Provider 的 `apiType` 调用不同的端点：
 *
 * - `anthropic`        → `GET {baseUrl}/models`（Anthropic 官方格式：`{ data: [{id, ...}] }`）
 * - `openai-compatible` → `GET {baseUrl}/models`（OpenAI 兼容格式：`{ data: [{id, ...}] }`）
 * - `v1-response`       → `GET {baseUrl}/models`（同上）
 *
 * 鉴权头按 `authMode` 自动附加：
 *
 * - `auth_token` → `Authorization: Bearer <token>`
 * - `api_key`    → `x-api-key: <apiKey>`  +  `anthropic-version: 2023-06-01`（Anthropic 协议）
 * - `none`       → 不附加任何鉴权头
 *
 * 自定义 Header 也会原样附加。
 *
 * 仅用于"设置页拉取模型"，不参与 Claude Code 运行时请求。
 */

import { Logger } from './logger';
import type { ApiType, AuthMode, CustomHeader, ModelConfig } from './types';

/**
 * 拉取参数。
 */
export interface FetchModelsInput {
    /** 上游 BaseURL，例如 `https://api.example.com` 或 `https://api.example.com/anthropic` */
    baseUrl: string;
    /** 协议类型 */
    apiType: ApiType;
    /** 鉴权模式 */
    authMode: AuthMode;
    /** 当 authMode === 'auth_token' 时使用 */
    token?: string;
    /** 当 authMode === 'api_key' 时使用 */
    apiKey?: string;
    /** 用户自定义 Header */
    customHeaders?: CustomHeader[];
    /** 请求超时毫秒数；默认 15s */
    timeoutMs?: number;
}

/**
 * 拉取结果。
 */
export interface FetchModelsResult {
    /** 解析出的模型列表（按 id 去重、按 id 升序排序） */
    models: ModelConfig[];
    /** 实际请求的 URL（用于调试） */
    requestedUrl: string;
}

/**
 * 把可能带末尾斜杠的 BaseURL 与 path 安全拼接。
 *
 * 例：`joinUrl('https://api.x.com/v1/', '/models') => 'https://api.x.com/v1/models'`
 */
function joinUrl(baseUrl: string, path: string): string {
    const b = baseUrl.replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${b}${p}`;
}

/**
 * 根据 apiType 决定模型列表端点。
 *
 * 当前三种协议都只追加 `/models`，不自动追加 `/v1`。
 * 是否包含 `/v1` 完全由用户填写的 BaseURL 决定。
 */
function modelsEndpoint(apiType: ApiType): string {
    switch (apiType) {
        case 'anthropic':
            return '/models';
        case 'openai-compatible':
        case 'v1-response':
            return '/models';
        default:
            return '/models';
    }
}

/**
 * 构造请求头。
 *
 * 严格按照 apiType 与 authMode 的组合附加最小鉴权头，避免泄露用户私有头到不期望的协议。
 */
function buildHeaders(input: FetchModelsInput): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'claude-code-config-helper/0.1'
    };

    if (input.authMode === 'auth_token' && input.token && input.token.trim()) {
        headers['Authorization'] = `Bearer ${input.token.trim()}`;
    } else if (input.authMode === 'api_key' && input.apiKey && input.apiKey.trim()) {
        headers['x-api-key'] = input.apiKey.trim();
        if (input.apiType === 'anthropic') {
            // Anthropic 要求带版本头
            headers['anthropic-version'] = '2023-06-01';
        }
    }

    if (Array.isArray(input.customHeaders)) {
        for (const h of input.customHeaders) {
            if (h && h.key && h.key.trim()) {
                headers[h.key.trim()] = h.value ?? '';
            }
        }
    }
    return headers;
}

/**
 * 把上游返回的 JSON 规范化为 `ModelConfig[]`。
 *
 * 兼容以下常见结构：
 * - `{ data: [{ id, display_name? }, ...] }`（OpenAI / Anthropic 现行格式）
 * - `{ models: [{ id, name? }, ...] }`（部分自建网关）
 * - `[{ id, ... }, ...]`（裸数组）
 */
function parseModels(json: unknown): ModelConfig[] {
    const arr: unknown[] = Array.isArray(json)
        ? json
        : Array.isArray((json as { data?: unknown[] })?.data)
        ? (json as { data: unknown[] }).data
        : Array.isArray((json as { models?: unknown[] })?.models)
        ? (json as { models: unknown[] }).models
        : [];

    const map = new Map<string, ModelConfig>();
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const id =
            typeof obj.id === 'string'
                ? obj.id
                : typeof obj.name === 'string'
                ? (obj.name as string)
                : '';
        if (!id) continue;
        const label =
            typeof obj.display_name === 'string'
                ? (obj.display_name as string)
                : typeof obj.name === 'string' && obj.name !== id
                ? (obj.name as string)
                : undefined;
        if (!map.has(id)) {
            map.set(id, createDefaultModelConfig(id, label));
        }
    }
    return [...map.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * 根据模型 id 与显示名生成默认模型配置。
 *
 * 拉取模型列表时上游通常只返回 id，本函数负责补齐页面所需的高级字段默认值。
 */
function createDefaultModelConfig(modelId: string, label?: string): ModelConfig {
    return {
        modelId,
        displayName: label || modelId,
        contextLength: 0,
        maxTokens: 0,
        vision: false,
        toolCalling: true,
        temperature: 1,
        topP: 1,
        samplingMode: 'temperature',
        isUserSelectable: true,
        transformThink: false,
        preserveReasoningContent: false
    };
}

/**
 * 拉取模型列表。
 *
 * 任何网络错误 / 非 2xx / JSON 解析失败都会抛出 `Error`，由调用方决定如何提示用户。
 */
export async function fetchModels(
    input: FetchModelsInput
): Promise<FetchModelsResult> {
    if (!input.baseUrl || !input.baseUrl.trim()) {
        throw new Error('BaseURL 未填写');
    }
    const url = joinUrl(input.baseUrl.trim(), modelsEndpoint(input.apiType));
    const headers = buildHeaders(input);

    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        Math.max(1000, input.timeoutMs ?? 15000)
    );

    Logger.info(`[modelFetcher] GET ${url} (apiType=${input.apiType})`);

    let res: Response;
    try {
        res = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(timer);
        if ((err as { name?: string })?.name === 'AbortError') {
            throw new Error(`请求超时（>${input.timeoutMs ?? 15000}ms）`);
        }
        throw new Error(
            `网络错误：${err instanceof Error ? err.message : String(err)}`
        );
    }
    clearTimeout(timer);

    if (!res.ok) {
        let body = '';
        try {
            body = (await res.text()).slice(0, 300);
        } catch {
            /* ignore */
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }

    let json: unknown;
    try {
        json = await res.json();
    } catch (err) {
        throw new Error(
            `响应不是合法 JSON：${err instanceof Error ? err.message : String(err)}`
        );
    }

    const models = parseModels(json);
    if (models.length === 0) {
        throw new Error('解析成功但模型列表为空（请检查 BaseURL / 鉴权 / 协议类型）');
    }
    return { models, requestedUrl: url };
}
