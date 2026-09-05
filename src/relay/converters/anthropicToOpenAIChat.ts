/**
 * @file Anthropic Messages 请求体到 OpenAI Chat Completions 请求体的转换器。
 *
 * 本模块只做纯协议转换，不访问 VS Code API、不发网络请求、不读写文件，便于单测。
 * 输入应当是已经完成 model 重写与 LLS 任务流注入的 Anthropic 请求体对象。
 */

import type { ModelCacheMode, ModelReasoningMode } from '../../types';
import { applyChatExplicitPromptCache } from '../explicitPromptCache';
import { readThinkingEffort } from './reasoningEffort';
import type { ReasoningEffort } from './reasoningEffort';

/** Anthropic 消息角色。 */
type AnthropicRole = 'user' | 'assistant';

/** OpenAI Chat 消息角色。 */
type OpenAIChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** OpenAI Chat content part。 */
type OpenAIChatContentPart =
    | { type: 'text'; text: string; cache_control?: unknown }
    | { type: 'image_url'; image_url: { url: string } };

/** OpenAI Chat tool call。 */
interface OpenAIChatToolCall {
    /** 工具调用 ID。 */
    id: string;
    /** OpenAI Chat 固定工具调用类型。 */
    type: 'function';
    /** function tool 调用详情。 */
    function: {
        /** 工具名称。 */
        name: string;
        /** JSON 字符串形式的参数。 */
        arguments: string;
    };
}

/** OpenAI Chat message。 */
interface OpenAIChatMessage {
    /** 消息角色。 */
    role: OpenAIChatRole;
    /** 文本、富 content parts 或 null。 */
    content?: string | OpenAIChatContentPart[] | null;
    /** 网关显式缓存断点，仅由显式缓存处理函数附加到 system 消息。 */
    cache_control?: unknown;
    /** assistant tool calls。 */
    tool_calls?: OpenAIChatToolCall[];
    /** tool role 对应的 tool_call_id。 */
    tool_call_id?: string;
}

/** OpenAI Chat tool 定义。 */
interface OpenAIChatTool {
    /** OpenAI Chat 固定工具类型。 */
    type: 'function';
    /** function 工具定义。 */
    function: {
        /** 工具名称。 */
        name: string;
        /** 工具描述。 */
        description?: string;
        /** JSON Schema 参数定义。 */
        parameters: unknown;
    };
    /** passthrough 模式下透传的 Anthropic 缓存断点。 */
    cache_control?: unknown;
}

/** OpenAI Chat 请求体。 */
export interface OpenAIChatRequestBody {
    /** 上游模型 ID。 */
    model?: unknown;
    /** OpenAI Chat 消息列表。 */
    messages: OpenAIChatMessage[];
    /** OpenAI Chat tools。 */
    tools?: OpenAIChatTool[];
    /** OpenAI Chat tool_choice。 */
    tool_choice?: unknown;
    /** 采样 temperature。 */
    temperature?: unknown;
    /** 采样 top_p。 */
    top_p?: unknown;
    /** 最大输出 token。 */
    max_tokens?: unknown;
    /** 是否流式。 */
    stream?: unknown;
    /**
     * OpenAI Chat stream 模式下的可选配置。
     *
     * 主要用于强制 `include_usage: true`，让上游在最后一个 chunk 中返回
     * `usage`（prompt_tokens / completion_tokens），便于 Relay 把 token 统计
     * 转换为 Anthropic `message_delta.usage` 并展示到 Chat UI。
     */
    stream_options?: {
        include_usage?: boolean;
        [key: string]: unknown;
    };
    /** 停止序列。 */
    stop?: unknown;
    /** OpenAI user 字段。 */
    user?: string;
    /** OpenAI reasoning effort 档位；passthrough 模式下由 Anthropic thinking 预算映射而来。 */
    reasoning_effort?: ReasoningEffort;
    /** 会话级显式缓存分组键。 */
    prompt_cache_key?: string;
    /** 网关显式缓存参数。 */
    prompt_cache_options?: { mode: 'explicit'; ttl: '30m' };
}

/** 转换 warning，用于记录不兼容内容的降级。 */
export interface ConversionWarning {
    /** 发生降级的 JSON 路径。 */
    path: string;
    /** 机器可读 warning code。 */
    code: string;
    /** 人类可读说明。 */
    message: string;
}

/** Anthropic → OpenAI Chat 转换结果。 */
export interface AnthropicToOpenAIChatResult {
    /** 转换后的 OpenAI Chat 请求体。 */
    body: OpenAIChatRequestBody;
    /** 协议不兼容内容的降级记录。 */
    warnings: ConversionWarning[];
}

/** Anthropic → OpenAI Chat 转换的可选行为开关。 */
export interface AnthropicConversionOptions {
    /** 模型级缓存策略；缺省按 `'auto'` 处理，即丢弃 `cache_control` 断点。 */
    cacheMode?: ModelCacheMode;
    /** 模型级思考策略；缺省按 `'off'` 处理，即不下发任何 reasoning 参数。 */
    reasoningMode?: ModelReasoningMode;
    /** 是否生成网关显式缓存字段。 */
    explicitCache?: boolean;
    /** 显式缓存使用的严格 CLI session_id。 */
    cacheSessionId?: string;
}

/**
 * 将 Anthropic Messages 请求体转换为 OpenAI Chat Completions 请求体。
 *
 * @param anthropicBody 已完成任务流注入的 Anthropic 请求体。
 * @param options 可选行为开关；省略时全部走默认行为。
 * @returns OpenAI Chat 请求体与降级 warning 列表。
 */
export function convertAnthropicToOpenAIChat(
    anthropicBody: unknown,
    options?: AnthropicConversionOptions
): AnthropicToOpenAIChatResult {
    const cacheMode: ModelCacheMode = options?.explicitCache === true ? 'auto' : options?.cacheMode ?? 'auto';
    const source = isRecord(anthropicBody) ? anthropicBody : {};
    const warnings: ConversionWarning[] = [];
    const messages: OpenAIChatMessage[] = [];
    const systemMessage = convertSystemToMessage(source.system, warnings, cacheMode);
    if (systemMessage) messages.push(systemMessage);
    if (Array.isArray(source.messages)) {
        source.messages.forEach((message, index) => {
            messages.push(...convertAnthropicMessage(message, `messages[${index}]`, warnings, cacheMode));
        });
    }

    const body: OpenAIChatRequestBody = {
        model: source.model,
        messages
    };
    if (source.temperature !== undefined) body.temperature = source.temperature;
    if (source.top_p !== undefined) body.top_p = source.top_p;
    if (source.max_tokens !== undefined) body.max_tokens = source.max_tokens;
    if (source.stream !== undefined) body.stream = source.stream;
    // 主动要求 OpenAI Chat 在流式模式下回传 usage（最后一个 chunk 的
    // `usage` 字段）。这是把 token 使用量传回 Anthropic message_delta.usage、
    // 进而在 Chat UI 底部显示的前提。非流式响应本身就会带 usage，无需注入。
    if (source.stream === true) {
        const existingOptions = isRecord(source.stream_options) ? source.stream_options : {};
        body.stream_options = { ...existingOptions, include_usage: true };
    }
    // passthrough 时把 Anthropic 顶层 thinking.budget_tokens 映射为 OpenAI
    // reasoning_effort，让上游真正开启思考；off 模式下该分支整体短路，输出不变。
    if (options?.reasoningMode === 'passthrough') {
        const effort = readThinkingEffort(source.thinking);
        if (effort) body.reasoning_effort = effort;
    }
    if (source.stop_sequences !== undefined) body.stop = source.stop_sequences;
    const userId = readMetadataUserId(source.metadata);
    if (userId) body.user = userId;
    const tools = convertTools(source.tools, warnings, cacheMode);
    if (tools.length > 0) body.tools = tools;
    const toolChoice = convertToolChoice(source.tool_choice, warnings);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (options?.explicitCache === true) {
        const result = applyChatExplicitPromptCache(body, options.cacheSessionId ?? '');
        if (!result.applied) {
            warnings.push({
                path: '$.prompt_cache_key',
                code: 'explicit_cache_not_applied',
                message: result.reason === 'missing_session_id'
                    ? '显式缓存缺少有效 session_id，未生成缓存字段。'
                    : '显式缓存缺少非空 system 前缀，未生成缓存字段。'
            });
        }
    }
    return { body, warnings };
}

/**
 * 把 Anthropic system 字段转换为 OpenAI system message 文本。
 *
 * @param system Anthropic system 字段。
 * @param warnings warning 收集器。
 * @returns 合并后的 system 文本。
 */
function convertSystemToText(system: unknown, warnings: ConversionWarning[]): string {
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return '';
    const parts: string[] = [];
    system.forEach((block, index) => {
        if (!isRecord(block)) return;
        if (block.cache_control !== undefined) {
            warnings.push({
                path: `system[${index}].cache_control`,
                code: 'unsupported_cache_control',
                message: 'OpenAI Chat 不支持 Anthropic cache_control，已忽略。'
            });
        }
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        } else {
            warnings.push({
                path: `system[${index}]`,
                code: 'unsupported_system_block',
                message: `OpenAI Chat 仅支持 system text，已忽略 type=${String(block.type)}。`
            });
        }
    });
    return parts.join('\n\n');
}

/**
 * 把 Anthropic system 字段转换为一条 OpenAI Chat system 消息。
 *
 * `passthrough` 模式下输出结构化 content 数组，使 `cache_control` 断点有容器可挂；
 * 其余模式沿用拍平成纯文本的既有行为，输出与改动前完全一致。
 *
 * @param system Anthropic system 字段。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns system 消息；system 为空时返回 undefined。
 */
function convertSystemToMessage(
    system: unknown,
    warnings: ConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIChatMessage | undefined {
    if (cacheMode !== 'passthrough') {
        const systemText = convertSystemToText(system, warnings);
        return systemText.trim() ? { role: 'system', content: systemText } : undefined;
    }
    if (typeof system === 'string') {
        return system.trim() ? { role: 'system', content: system } : undefined;
    }
    if (!Array.isArray(system)) return undefined;
    const parts: OpenAIChatContentPart[] = [];
    system.forEach((block, index) => {
        if (!isRecord(block)) return;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(
                block.cache_control !== undefined
                    ? { type: 'text', text: block.text, cache_control: block.cache_control }
                    : { type: 'text', text: block.text }
            );
        } else {
            warnings.push({
                path: `system[${index}]`,
                code: 'unsupported_system_block',
                message: `OpenAI Chat 仅支持 system text，已忽略 type=${String(block.type)}。`
            });
        }
    });
    return parts.length > 0 ? { role: 'system', content: parts } : undefined;
}

/**
 * 转换单条 Anthropic message 为一条或多条 OpenAI Chat message。
 *
 * @param message Anthropic message。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns OpenAI Chat message 列表。
 */
function convertAnthropicMessage(
    message: unknown,
    path: string,
    warnings: ConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIChatMessage[] {
    if (!isRecord(message)) return [];
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : undefined;
    if (!role) {
        warnings.push({ path: `${path}.role`, code: 'unsupported_role', message: '已跳过未知 role 消息。' });
        return [];
    }
    const content = message.content;
    if (typeof content === 'string') {
        return content ? [{ role, content }] : [];
    }
    if (!Array.isArray(content)) return [];
    return role === 'assistant'
        ? convertAssistantContent(content, path, warnings, cacheMode)
        : convertUserContent(content, path, warnings, cacheMode);
}

/**
 * 转换 Anthropic user content blocks。
 *
 * @param content content block 数组。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns OpenAI Chat message 列表。
 */
function convertUserContent(
    content: unknown[],
    path: string,
    warnings: ConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIChatMessage[] {
    const toolMessages: OpenAIChatMessage[] = [];
    const userParts: OpenAIChatContentPart[] = [];
    content.forEach((block, index) => {
        const blockPath = `${path}.content[${index}]`;
        if (!isRecord(block)) return;
        switch (block.type) {
            case 'text':
                if (typeof block.text === 'string' && block.text) {
                    userParts.push(
                        cacheMode === 'passthrough' && block.cache_control !== undefined
                            ? { type: 'text', text: block.text, cache_control: block.cache_control }
                            : { type: 'text', text: block.text }
                    );
                }
                break;
            case 'image':
                appendImagePart(userParts, block, blockPath, warnings);
                break;
            case 'tool_result':
                toolMessages.push({
                    role: 'tool',
                    tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
                    content: toolResultContentToText(block.content, blockPath, warnings)
                });
                break;
            default:
                appendUnsupportedBlockText(userParts, block, blockPath, warnings);
                break;
        }
    });
    const out = [...toolMessages];
    // passthrough 下不能压平成字符串，否则 cache_control 无处附着。
    if (cacheMode !== 'passthrough' && userParts.length === 1 && userParts[0].type === 'text') {
        out.push({ role: 'user', content: userParts[0].text });
    } else if (userParts.length > 0) {
        out.push({ role: 'user', content: userParts });
    }
    return out;
}

/**
 * 转换 Anthropic assistant content blocks。
 *
 * @param content content block 数组。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns OpenAI Chat assistant message 列表。
 */
function convertAssistantContent(
    content: unknown[],
    path: string,
    warnings: ConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIChatMessage[] {
    const textParts: string[] = [];
    /** passthrough 下的结构化镜像，与 textParts 一一对应，额外携带 cache_control。 */
    const cacheParts: OpenAIChatContentPart[] = [];
    const toolCalls: OpenAIChatToolCall[] = [];
    /** 同时写入纯文本与结构化两份文本，保证默认路径输出不变。 */
    const pushText = (text: string, cacheControl?: unknown): void => {
        textParts.push(text);
        cacheParts.push(
            cacheControl !== undefined ? { type: 'text', text, cache_control: cacheControl } : { type: 'text', text }
        );
    };
    content.forEach((block, index) => {
        const blockPath = `${path}.content[${index}]`;
        if (!isRecord(block)) return;
        switch (block.type) {
            case 'text':
                if (typeof block.text === 'string' && block.text) pushText(block.text, block.cache_control);
                break;
            case 'tool_use':
                if (typeof block.id === 'string' && typeof block.name === 'string') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: {
                            name: block.name,
                            arguments: JSON.stringify(block.input ?? {})
                        }
                    });
                } else {
                    warnings.push({ path: blockPath, code: 'invalid_tool_use', message: 'tool_use 缺少 id 或 name，已跳过。' });
                }
                break;
            case 'thinking':
            case 'redacted_thinking':
                warnings.push({ path: blockPath, code: 'ignored_thinking', message: 'thinking 块不转发给 OpenAI Chat。' });
                break;
            case 'image':
                pushText('[assistant image omitted]');
                warnings.push({ path: blockPath, code: 'assistant_image_omitted', message: 'assistant image 已降级为文本占位。' });
                break;
            default:
                pushText(`[unsupported block: ${String(block.type)}]`);
                warnings.push({ path: blockPath, code: 'unsupported_block', message: `已降级未知 block：${String(block.type)}。` });
                break;
        }
    });
    if (textParts.length === 0 && toolCalls.length === 0) return [];
    const message: OpenAIChatMessage = { role: 'assistant' };
    if (textParts.length > 0) {
        message.content = cacheMode === 'passthrough' ? cacheParts : textParts.join('\n');
    }
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        if (message.content === undefined) message.content = null;
    }
    return [message];
}

/**
 * 向 OpenAI user content parts 追加图片块。
 *
 * @param parts user content parts。
 * @param block Anthropic image block。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 */
function appendImagePart(
    parts: OpenAIChatContentPart[],
    block: Record<string, unknown>,
    path: string,
    warnings: ConversionWarning[]
): void {
    const source = isRecord(block.source) ? block.source : undefined;
    if (!source) return;
    if (source.type === 'base64' && typeof source.data === 'string') {
        const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream';
        parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } });
        return;
    }
    if (source.type === 'url' && typeof source.url === 'string') {
        parts.push({ type: 'image_url', image_url: { url: source.url } });
        return;
    }
    warnings.push({ path, code: 'unsupported_image_source', message: '不支持的 image source 已忽略。' });
}

/**
 * 把 Anthropic tool_result content 转换为 OpenAI tool message 文本。
 *
 * @param content Anthropic tool_result.content。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @returns 纯文本工具结果。
 */
function toolResultContentToText(content: unknown, path: string, warnings: ConversionWarning[]): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((block, index) => {
        if (!isRecord(block)) return '';
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'image') {
            const source = isRecord(block.source) ? block.source : {};
            const mediaType = typeof source.media_type === 'string' ? source.media_type : 'unknown';
            warnings.push({
                path: `${path}.content[${index}]`,
                code: 'tool_result_image_omitted',
                message: 'OpenAI tool message 不支持图片，已降级为文本占位。'
            });
            return `[image omitted in tool result: ${mediaType}]`;
        }
        warnings.push({ path: `${path}.content[${index}]`, code: 'unsupported_tool_result_block', message: '已忽略未知 tool_result block。' });
        return '';
    }).filter(Boolean).join('\n');
}

/**
 * 向 user parts 追加不支持 block 的文本占位。
 *
 * @param parts user content parts。
 * @param block 原始 block。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 */
function appendUnsupportedBlockText(
    parts: OpenAIChatContentPart[],
    block: Record<string, unknown>,
    path: string,
    warnings: ConversionWarning[]
): void {
    const type = String(block.type);
    if (type === 'thinking' || type === 'redacted_thinking') {
        warnings.push({ path, code: 'ignored_thinking', message: 'thinking 块不转发给 OpenAI Chat。' });
        return;
    }
    parts.push({ type: 'text', text: `[unsupported block: ${type}]` });
    warnings.push({ path, code: 'unsupported_block', message: `已降级未知 block：${type}。` });
}

/**
 * 转换 Anthropic tools 为 OpenAI Chat tools。
 *
 * @param tools Anthropic tools 字段。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns OpenAI Chat tools。
 */
function convertTools(
    tools: unknown,
    warnings: ConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIChatTool[] {
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool, index): OpenAIChatTool[] => {
        if (!isRecord(tool) || typeof tool.name !== 'string') return [];
        const parameters = normalizeToolParameters(
            tool.name,
            isRecord(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} }
        );
        if (!isRecord(tool.input_schema)) {
            warnings.push({ path: `tools[${index}].input_schema`, code: 'invalid_input_schema', message: 'input_schema 缺失或非对象，已使用空 object schema。' });
        }
        const converted: OpenAIChatTool = {
            type: 'function',
            function: {
                name: tool.name,
                parameters
            }
        };
        if (typeof tool.description === 'string') converted.function.description = tool.description;
        if (cacheMode === 'passthrough' && tool.cache_control !== undefined) {
            converted.cache_control = tool.cache_control;
        }
        return [converted];
    });
}

/**
 * 转换 Anthropic tool_choice 为 OpenAI Chat tool_choice。
 *
 * @param toolChoice Anthropic tool_choice 字段。
 * @param warnings warning 收集器。
 * @returns OpenAI Chat tool_choice；未设置时返回 undefined。
 */
function convertToolChoice(toolChoice: unknown, warnings: ConversionWarning[]): unknown {
    if (!isRecord(toolChoice)) return undefined;
    switch (toolChoice.type) {
        case 'auto':
            return 'auto';
        case 'any':
            return 'required';
        case 'none':
            return 'none';
        case 'tool':
            if (typeof toolChoice.name === 'string') {
                return { type: 'function', function: { name: toolChoice.name } };
            }
            warnings.push({ path: 'tool_choice.name', code: 'invalid_tool_choice', message: 'tool_choice.tool 缺少 name，已忽略。' });
            return undefined;
        default:
            warnings.push({ path: 'tool_choice.type', code: 'unsupported_tool_choice', message: `未知 tool_choice：${String(toolChoice.type)}。` });
            return undefined;
    }
}

/**
 * 读取 Anthropic metadata.user_id。
 *
 * @param metadata metadata 字段。
 * @returns user_id 字符串或 undefined。
 */
function readMetadataUserId(metadata: unknown): string | undefined {
    if (!isRecord(metadata)) return undefined;
    return typeof metadata.user_id === 'string' ? metadata.user_id : undefined;
}

/**
 * 归一化 Claude Code 内置工具的参数 schema。
 *
 * @param toolName 工具名称。
 * @param parameters 原始 Anthropic input_schema。
 * @returns 适合 OpenAI Chat function parameters 的 schema。
 */
function normalizeToolParameters(toolName: string, parameters: Record<string, unknown>): Record<string, unknown> {
    if (toolName !== 'Read' && toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'Agent') return parameters;
    const normalized = { ...parameters };
    const properties = isRecord(normalized.properties) ? { ...normalized.properties } : {};
    normalized.properties = properties;
    const required = new Set(Array.isArray(normalized.required)
        ? normalized.required.filter((item): item is string => typeof item === 'string')
        : []);
    if (toolName === 'Read') {
        required.add('file_path');
        required.add('pages');
        const pages: Record<string, unknown> = isRecord(properties.pages) ? { ...properties.pages } : { type: 'string' };
        pages.type = 'string';
        pages.minLength = 1;
        pages.default = '1';
        pages.pattern = '^\\d+(?:-\\d+)?$';
        pages.description = typeof pages.description === 'string'
            ? `${pages.description} Invalid or empty values must be replaced with "1".`
            : 'PDF page range. Use "1", "3", or "10-20". Invalid or empty values must be replaced with "1".';
        properties.pages = pages;
    }
    if (toolName === 'Write') {
        normalized.type = 'object';
        if (!isRecord(properties.file_path)) {
            properties.file_path = {
                type: 'string',
                description: 'The absolute path to the file to write (must be absolute, not relative)'
            };
        }
        if (!isRecord(properties.content)) {
            properties.content = {
                type: 'string',
                description: 'The content to write to the file'
            };
        }
        if (normalized.additionalProperties === undefined) normalized.additionalProperties = false;
        required.add('file_path');
        required.add('content');
    }
    if (toolName === 'Edit') {
        normalized.type = 'object';
        if (!isRecord(properties.file_path)) properties.file_path = { type: 'string' };
        if (!isRecord(properties.old_string)) properties.old_string = { type: 'string' };
        if (!isRecord(properties.new_string)) properties.new_string = { type: 'string' };
        if (!isRecord(properties.replace_all)) properties.replace_all = { type: 'boolean', default: false };
        if (normalized.additionalProperties === undefined) normalized.additionalProperties = false;
        required.add('file_path');
        required.add('old_string');
        required.add('new_string');
    }
    if (toolName === 'Agent') {
        delete properties.isolation;
        required.delete('isolation');
    }
    normalized.required = Array.from(required);
    return normalized;
}

/**
 * 判断未知值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 是否为非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
