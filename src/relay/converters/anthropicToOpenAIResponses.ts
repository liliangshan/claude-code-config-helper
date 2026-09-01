/**
 * @file Anthropic Messages 请求体到 OpenAI Responses 请求体的转换器。
 *
 * 本模块只做纯协议转换，不访问 VS Code API、不发网络请求、不读写文件，便于单测。
 * 输入应当是已经完成 model 重写与 LLS 任务流注入的 Anthropic 请求体对象。
 */

import type { ModelCacheMode, ModelReasoningMode } from '../../types';
import { readThinkingEffort } from './reasoningEffort';
import type { ReasoningEffort } from './reasoningEffort';

/** Anthropic 消息角色。 */
type AnthropicRole = 'user' | 'assistant';

/** Responses 对话消息角色。 */
type OpenAIResponsesMessageRole = 'user' | 'assistant' | 'system';

/** Responses message content part。 */
type OpenAIResponsesContentPart =
    | { type: 'input_text'; text: string; cache_control?: unknown }
    | { type: 'output_text'; text: string; cache_control?: unknown }
    | { type: 'input_image'; image_url: string };

/** Responses input 顶层项。 */
export type OpenAIResponsesInputItem =
    | { role: OpenAIResponsesMessageRole; content: OpenAIResponsesContentPart[] }
    | { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
    | { type: 'function_call_output'; call_id: string; output: string };

/** Responses function 工具定义。 */
export interface OpenAIResponsesTool {
    /** Responses 固定工具类型。 */
    type: 'function';
    /** 工具名称。 */
    name: string;
    /** 工具描述。 */
    description?: string;
    /** JSON Schema 参数定义。 */
    parameters: unknown;
    /** passthrough 模式下透传的 Anthropic 缓存断点。 */
    cache_control?: unknown;
}

/** OpenAI Responses 请求体。 */
export interface OpenAIResponsesRequestBody {
    /** 上游模型 ID。 */
    model?: unknown;
    /** system/instructions 文本。 */
    instructions?: string;
    /** Responses input 列表。 */
    input: OpenAIResponsesInputItem[];
    /** Responses tools。 */
    tools?: OpenAIResponsesTool[];
    /** Responses tool_choice。 */
    tool_choice?: unknown;
    /** 采样 temperature。 */
    temperature?: unknown;
    /** 采样 top_p。 */
    top_p?: unknown;
    /** 最大输出 token。 */
    max_output_tokens?: unknown;
    /** 是否流式。 */
    stream?: unknown;
    /** Anthropic metadata plain object 透传。 */
    metadata?: Record<string, unknown>;
    /** OpenAI user 字段，由 metadata.user_id 映射而来。 */
    user?: string;
    /** Responses reasoning 参数；passthrough 模式下由 Anthropic thinking 预算映射而来。 */
    reasoning?: { effort: ReasoningEffort };
}

/** 转换 warning，用于记录不兼容内容的降级。 */
export interface ResponsesConversionWarning {
    /** 发生降级的 JSON 路径。 */
    path: string;
    /** 机器可读 warning code。 */
    code: string;
    /** 人类可读说明。 */
    message: string;
}

/** Anthropic → OpenAI Responses 转换结果。 */
export interface AnthropicToOpenAIResponsesResult {
    /** 转换后的 OpenAI Responses 请求体。 */
    body: OpenAIResponsesRequestBody;
    /** 协议不兼容内容的降级记录。 */
    warnings: ResponsesConversionWarning[];
}

/** Anthropic → OpenAI Responses 转换的可选行为开关。 */
export interface AnthropicConversionOptions {
    /** 模型级缓存策略；缺省按 `'auto'` 处理，即丢弃 `cache_control` 断点。 */
    cacheMode?: ModelCacheMode;
    /** 模型级思考策略；缺省按 `'off'` 处理，即不下发任何 reasoning 参数。 */
    reasoningMode?: ModelReasoningMode;
}

/**
 * 将 Anthropic Messages 请求体转换为 OpenAI Responses 请求体。
 *
 * @param anthropicBody 已完成任务流注入的 Anthropic 请求体。
 * @param options 可选行为开关；省略时全部走默认行为。
 * @returns OpenAI Responses 请求体与降级 warning 列表。
 */
export function convertAnthropicToOpenAIResponses(
    anthropicBody: unknown,
    options?: AnthropicConversionOptions
): AnthropicToOpenAIResponsesResult {
    const cacheMode: ModelCacheMode = options?.cacheMode ?? 'auto';
    const source = isRecord(anthropicBody) ? anthropicBody : {};
    const warnings: ResponsesConversionWarning[] = [];
    const input: OpenAIResponsesInputItem[] = [];
    if (Array.isArray(source.messages)) {
        source.messages.forEach((message, index) => {
            input.push(...convertAnthropicMessage(message, `messages[${index}]`, warnings, cacheMode));
        });
    }
    const body: OpenAIResponsesRequestBody = {
        model: source.model,
        input
    };
    if (cacheMode === 'passthrough') {
        const systemItem = convertSystemToInputItem(source.system, warnings);
        if (systemItem) input.unshift(systemItem);
    } else {
        const instructions = convertSystemToInstructions(source.system, warnings);
        if (instructions.trim()) body.instructions = instructions;
    }
    if (source.temperature !== undefined) body.temperature = source.temperature;
    if (source.top_p !== undefined) body.top_p = source.top_p;
    if (source.max_tokens !== undefined) body.max_output_tokens = source.max_tokens;
    if (source.stream !== undefined) body.stream = source.stream;
    // passthrough 时把 Anthropic 顶层 thinking.budget_tokens 映射为 Responses
    // reasoning.effort；off 模式下该分支整体短路，输出不变。
    if (options?.reasoningMode === 'passthrough') {
        const effort = readThinkingEffort(source.thinking);
        if (effort) body.reasoning = { effort };
    }
    const metadata = convertMetadata(source.metadata, warnings);
    if (metadata) {
        body.metadata = metadata;
        if (typeof metadata.user_id === 'string' && metadata.user_id) body.user = metadata.user_id;
    }
    const tools = convertTools(source.tools, warnings, cacheMode);
    if (tools.length > 0) body.tools = tools;
    const toolChoice = convertToolChoice(source.tool_choice, warnings);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    return { body, warnings };
}

/**
 * 把 Anthropic system 字段转换为 Responses instructions 文本。
 *
 * @param system Anthropic system 字段。
 * @param warnings warning 收集器。
 * @returns 合并后的 instructions 文本。
 */
function convertSystemToInstructions(system: unknown, warnings: ResponsesConversionWarning[]): string {
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return '';
    const parts: string[] = [];
    system.forEach((block, index) => {
        if (!isRecord(block)) return;
        if (block.cache_control !== undefined) {
            warnings.push({
                path: `system[${index}].cache_control`,
                code: 'unsupported_cache_control',
                message: 'OpenAI Responses 不支持 Anthropic cache_control，已忽略。'
            });
        }
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        } else {
            warnings.push({
                path: `system[${index}]`,
                code: 'unsupported_system_block',
                message: `OpenAI Responses instructions 仅支持 text，已忽略 type=${String(block.type)}。`
            });
        }
    });
    return parts.join('\n');
}

/**
 * 把 Anthropic system 字段转换为 input 数组首项。
 *
 * Responses 的 `instructions` 只接受字符串，无处挂 `cache_control`；`passthrough`
 * 模式改用一条 system input item 承载 system 文本，使断点有容器可挂。
 *
 * @param system Anthropic system 字段。
 * @param warnings warning 收集器。
 * @returns system input item；system 为空时返回 undefined。
 */
function convertSystemToInputItem(
    system: unknown,
    warnings: ResponsesConversionWarning[]
): OpenAIResponsesInputItem | undefined {
    if (typeof system === 'string') {
        return system.trim() ? { role: 'system', content: [{ type: 'input_text', text: system }] } : undefined;
    }
    if (!Array.isArray(system)) return undefined;
    const parts: OpenAIResponsesContentPart[] = [];
    system.forEach((block, index) => {
        if (!isRecord(block)) return;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(
                block.cache_control !== undefined
                    ? { type: 'input_text', text: block.text, cache_control: block.cache_control }
                    : { type: 'input_text', text: block.text }
            );
        } else {
            warnings.push({
                path: `system[${index}]`,
                code: 'unsupported_system_block',
                message: `OpenAI Responses instructions 仅支持 text，已忽略 type=${String(block.type)}。`
            });
        }
    });
    return parts.length > 0 ? { role: 'system', content: parts } : undefined;
}

/**
 * 转换单条 Anthropic message 为一条或多条 Responses input item。
 *
 * @param message Anthropic message。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns Responses input item 列表。
 */
function convertAnthropicMessage(
    message: unknown,
    path: string,
    warnings: ResponsesConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIResponsesInputItem[] {
    if (!isRecord(message)) return [];
    const role = readAnthropicRole(message.role);
    if (!role) {
        warnings.push({ path: `${path}.role`, code: 'unsupported_role', message: '已跳过未知 role 消息。' });
        return [];
    }
    const content = message.content;
    if (typeof content === 'string') {
        const type = role === 'assistant' ? 'output_text' : 'input_text';
        return content ? [{ role, content: [{ type, text: content }] }] : [];
    }
    if (!Array.isArray(content)) return [];
    return role === 'assistant'
        ? convertAssistantContent(content, path, warnings, cacheMode)
        : convertUserContent(content, path, warnings, cacheMode);
}

/**
 * 读取并校验 Anthropic role。
 *
 * @param role 原始 role 字段。
 * @returns 合法 Anthropic role；未知时返回 undefined。
 */
function readAnthropicRole(role: unknown): AnthropicRole | undefined {
    return role === 'assistant' || role === 'user' ? role : undefined;
}

/**
 * 转换 Anthropic user content blocks。
 *
 * @param content content block 数组。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns Responses input item 列表。
 */
function convertUserContent(
    content: unknown[],
    path: string,
    warnings: ResponsesConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIResponsesInputItem[] {
    const out: OpenAIResponsesInputItem[] = [];
    const userParts: OpenAIResponsesContentPart[] = [];
    const flushUserParts = (): void => {
        if (userParts.length > 0) {
            out.push({ role: 'user', content: [...userParts] });
            userParts.length = 0;
        }
    };
    content.forEach((block, index) => {
        const blockPath = `${path}.content[${index}]`;
        if (!isRecord(block)) return;
        switch (block.type) {
            case 'text':
                if (typeof block.text === 'string' && block.text) {
                    userParts.push(
                        cacheMode === 'passthrough' && block.cache_control !== undefined
                            ? { type: 'input_text', text: block.text, cache_control: block.cache_control }
                            : { type: 'input_text', text: block.text }
                    );
                }
                break;
            case 'image':
                appendImagePart(userParts, block, blockPath, warnings);
                break;
            case 'tool_result':
                flushUserParts();
                out.push({
                    type: 'function_call_output',
                    call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
                    output: toolResultContentToText(block.content, blockPath, warnings)
                });
                break;
            default:
                appendUnsupportedBlockText(userParts, block, blockPath, warnings);
                break;
        }
    });
    flushUserParts();
    return out;
}

/**
 * 转换 Anthropic assistant content blocks。
 *
 * @param content content block 数组。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns Responses input item 列表。
 */
function convertAssistantContent(
    content: unknown[],
    path: string,
    warnings: ResponsesConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIResponsesInputItem[] {
    const out: OpenAIResponsesInputItem[] = [];
    const assistantParts: OpenAIResponsesContentPart[] = [];
    const flushAssistantParts = (): void => {
        if (assistantParts.length > 0) {
            out.push({ role: 'assistant', content: [...assistantParts] });
            assistantParts.length = 0;
        }
    };
    content.forEach((block, index) => {
        const blockPath = `${path}.content[${index}]`;
        if (!isRecord(block)) return;
        switch (block.type) {
            case 'text':
                if (typeof block.text === 'string' && block.text) {
                    assistantParts.push(
                        cacheMode === 'passthrough' && block.cache_control !== undefined
                            ? { type: 'output_text', text: block.text, cache_control: block.cache_control }
                            : { type: 'output_text', text: block.text }
                    );
                }
                break;
            case 'tool_use':
                flushAssistantParts();
                appendFunctionCall(out, block, blockPath, warnings);
                break;
            case 'thinking':
            case 'redacted_thinking':
                warnings.push({ path: blockPath, code: 'ignored_thinking', message: 'thinking 块不转发给 OpenAI Responses。' });
                break;
            default:
                assistantParts.push({ type: 'output_text', text: `[unsupported block: ${String(block.type)}]` });
                warnings.push({ path: blockPath, code: 'unsupported_block', message: `已降级未知 assistant block：${String(block.type)}。` });
                break;
        }
    });
    flushAssistantParts();
    return out;
}

/**
 * 追加 Responses function_call input item。
 *
 * Anthropic `tool_use.id` 必须映射为 Responses `call_id`，用于后续
 * `function_call_output.call_id` 配对；Responses output item `id` 默认不生成。
 *
 * @param out 输出 input item 列表。
 * @param block Anthropic tool_use block。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 */
function appendFunctionCall(
    out: OpenAIResponsesInputItem[],
    block: Record<string, unknown>,
    path: string,
    warnings: ResponsesConversionWarning[]
): void {
    if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        warnings.push({ path, code: 'invalid_tool_use', message: 'tool_use 缺少 id 或 name，已跳过。' });
        return;
    }
    out.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {})
    });
}

/**
 * 向 Responses user content parts 追加图片块。
 *
 * @param parts user content parts。
 * @param block Anthropic image block。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 */
function appendImagePart(
    parts: OpenAIResponsesContentPart[],
    block: Record<string, unknown>,
    path: string,
    warnings: ResponsesConversionWarning[]
): void {
    const source = isRecord(block.source) ? block.source : undefined;
    if (!source) return;
    if (source.type === 'base64' && typeof source.data === 'string') {
        const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream';
        parts.push({ type: 'input_image', image_url: `data:${mediaType};base64,${source.data}` });
        return;
    }
    if (source.type === 'url' && typeof source.url === 'string') {
        parts.push({ type: 'input_image', image_url: source.url });
        return;
    }
    warnings.push({ path, code: 'unsupported_image_source', message: '不支持的 image source 已忽略。' });
}

/**
 * 把 Anthropic tool_result content 转换为 Responses function_call_output.output 文本。
 *
 * @param content Anthropic tool_result.content。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @returns 纯文本工具结果。
 */
function toolResultContentToText(content: unknown, path: string, warnings: ResponsesConversionWarning[]): string {
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
                message: 'Responses function_call_output 不支持图片，已降级为文本占位。'
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
    parts: OpenAIResponsesContentPart[],
    block: Record<string, unknown>,
    path: string,
    warnings: ResponsesConversionWarning[]
): void {
    const type = String(block.type);
    if (type === 'thinking' || type === 'redacted_thinking') {
        warnings.push({ path, code: 'ignored_thinking', message: 'thinking 块不转发给 OpenAI Responses。' });
        return;
    }
    parts.push({ type: 'input_text', text: `[unsupported block: ${type}]` });
    warnings.push({ path, code: 'unsupported_block', message: `已降级未知 block：${type}。` });
}

/**
 * 转换 Anthropic tools 为 Responses function tools。
 *
 * @param tools Anthropic tools 字段。
 * @param warnings warning 收集器。
 * @param cacheMode 模型级缓存策略。
 * @returns Responses tools。
 */
function convertTools(
    tools: unknown,
    warnings: ResponsesConversionWarning[],
    cacheMode: ModelCacheMode
): OpenAIResponsesTool[] {
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool, index): OpenAIResponsesTool[] => {
        if (!isRecord(tool) || typeof tool.name !== 'string') return [];
        const parameters = normalizeToolParameters(
            tool.name,
            isRecord(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} }
        );
        if (!isRecord(tool.input_schema)) {
            warnings.push({ path: `tools[${index}].input_schema`, code: 'invalid_input_schema', message: 'input_schema 缺失或非对象，已使用空 object schema。' });
        }
        const converted: OpenAIResponsesTool = {
            type: 'function',
            name: tool.name,
            parameters
        };
        if (typeof tool.description === 'string') converted.description = tool.description;
        if (cacheMode === 'passthrough' && tool.cache_control !== undefined) {
            converted.cache_control = tool.cache_control;
        }
        return [converted];
    });
}

/**
 * 转换 Anthropic tool_choice 为 Responses tool_choice。
 *
 * @param toolChoice Anthropic tool_choice 字段。
 * @param warnings warning 收集器。
 * @returns Responses tool_choice；未设置时返回 undefined。
 */
function convertToolChoice(toolChoice: unknown, warnings: ResponsesConversionWarning[]): unknown {
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
                return { type: 'function', name: toolChoice.name };
            }
            warnings.push({ path: 'tool_choice.name', code: 'invalid_tool_choice', message: 'tool_choice.tool 缺少 name，已忽略。' });
            return undefined;
        default:
            warnings.push({ path: 'tool_choice.type', code: 'unsupported_tool_choice', message: `未知 tool_choice：${String(toolChoice.type)}。` });
            return undefined;
    }
}

/**
 * 转换 metadata 字段，仅 plain object 允许透传。
 *
 * @param metadata Anthropic metadata 字段。
 * @param warnings warning 收集器。
 * @returns 可透传 metadata 或 undefined。
 */
function convertMetadata(metadata: unknown, warnings: ResponsesConversionWarning[]): Record<string, unknown> | undefined {
    if (metadata === undefined) return undefined;
    if (isRecord(metadata)) return metadata;
    warnings.push({ path: 'metadata', code: 'invalid_metadata', message: 'metadata 非对象，已忽略。' });
    return undefined;
}

/**
 * 归一化 Claude Code 内置工具的参数 schema。
 *
 * @param toolName 工具名称。
 * @param parameters 原始 Anthropic input_schema。
 * @returns 适合 OpenAI Responses function parameters 的 schema。
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
