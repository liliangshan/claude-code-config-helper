/**
 * @file Anthropic Messages 请求体到 OpenAI Chat Completions 请求体的转换器。
 *
 * 本模块只做纯协议转换，不访问 VS Code API、不发网络请求、不读写文件，便于单测。
 * 输入应当是已经完成 model 重写与 LLS 任务流注入的 Anthropic 请求体对象。
 */

/** Anthropic 消息角色。 */
type AnthropicRole = 'user' | 'assistant';

/** OpenAI Chat 消息角色。 */
type OpenAIChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** OpenAI Chat content part。 */
type OpenAIChatContentPart =
    | { type: 'text'; text: string }
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
    /** 停止序列。 */
    stop?: unknown;
    /** OpenAI user 字段。 */
    user?: string;
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

/**
 * 将 Anthropic Messages 请求体转换为 OpenAI Chat Completions 请求体。
 *
 * @param anthropicBody 已完成任务流注入的 Anthropic 请求体。
 * @returns OpenAI Chat 请求体与降级 warning 列表。
 */
export function convertAnthropicToOpenAIChat(anthropicBody: unknown): AnthropicToOpenAIChatResult {
    const source = isRecord(anthropicBody) ? anthropicBody : {};
    const warnings: ConversionWarning[] = [];
    const messages: OpenAIChatMessage[] = [];
    const systemText = convertSystemToText(source.system, warnings);
    if (systemText.trim()) {
        messages.push({ role: 'system', content: systemText });
    }
    if (Array.isArray(source.messages)) {
        source.messages.forEach((message, index) => {
            messages.push(...convertAnthropicMessage(message, `messages[${index}]`, warnings));
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
    if (source.stop_sequences !== undefined) body.stop = source.stop_sequences;
    const userId = readMetadataUserId(source.metadata);
    if (userId) body.user = userId;
    const tools = convertTools(source.tools, warnings);
    if (tools.length > 0) body.tools = tools;
    const toolChoice = convertToolChoice(source.tool_choice, warnings);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
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
 * 转换单条 Anthropic message 为一条或多条 OpenAI Chat message。
 *
 * @param message Anthropic message。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @returns OpenAI Chat message 列表。
 */
function convertAnthropicMessage(
    message: unknown,
    path: string,
    warnings: ConversionWarning[]
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
        ? convertAssistantContent(content, path, warnings)
        : convertUserContent(content, path, warnings);
}

/**
 * 转换 Anthropic user content blocks。
 *
 * @param content content block 数组。
 * @param path JSON 路径。
 * @param warnings warning 收集器。
 * @returns OpenAI Chat message 列表。
 */
function convertUserContent(
    content: unknown[],
    path: string,
    warnings: ConversionWarning[]
): OpenAIChatMessage[] {
    const toolMessages: OpenAIChatMessage[] = [];
    const userParts: OpenAIChatContentPart[] = [];
    content.forEach((block, index) => {
        const blockPath = `${path}.content[${index}]`;
        if (!isRecord(block)) return;
        switch (block.type) {
            case 'text':
                if (typeof block.text === 'string' && block.text) userParts.push({ type: 'text', text: block.text });
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
    if (userParts.length === 1 && userParts[0].type === 'text') {
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
 * @returns OpenAI Chat assistant message 列表。
 */
function convertAssistantContent(
    content: unknown[],
    path: string,
    warnings: ConversionWarning[]
): OpenAIChatMessage[] {
    const textParts: string[] = [];
    const toolCalls: OpenAIChatToolCall[] = [];
    content.forEach((block, index) => {
        const blockPath = `${path}.content[${index}]`;
        if (!isRecord(block)) return;
        switch (block.type) {
            case 'text':
                if (typeof block.text === 'string' && block.text) textParts.push(block.text);
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
                textParts.push('[assistant image omitted]');
                warnings.push({ path: blockPath, code: 'assistant_image_omitted', message: 'assistant image 已降级为文本占位。' });
                break;
            default:
                textParts.push(`[unsupported block: ${String(block.type)}]`);
                warnings.push({ path: blockPath, code: 'unsupported_block', message: `已降级未知 block：${String(block.type)}。` });
                break;
        }
    });
    if (textParts.length === 0 && toolCalls.length === 0) return [];
    const message: OpenAIChatMessage = { role: 'assistant' };
    if (textParts.length > 0) message.content = textParts.join('\n');
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
 * @returns OpenAI Chat tools。
 */
function convertTools(tools: unknown, warnings: ConversionWarning[]): OpenAIChatTool[] {
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool, index): OpenAIChatTool[] => {
        if (!isRecord(tool) || typeof tool.name !== 'string') return [];
        const parameters = isRecord(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} };
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
 * 判断未知值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 是否为非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
