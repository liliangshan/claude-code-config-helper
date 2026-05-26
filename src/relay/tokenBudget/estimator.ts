/**
 * @file Anthropic 请求体 input token 估算器。
 *
 * 基于 js-tiktoken 的 cl100k_base 编码器对 Anthropic Messages 形态的请求体做
 * 本地估算。仅用于"上下文上限预警"用途，相对误差 ±15% 以内可接受。
 *
 * 估算口径：
 * 1. system（string 或 [{ type:'text', text }]）→ 累加文本；
 * 2. messages[*].content：
 *    - string → 直接累加；
 *    - [{type:'text'}]    → 累加 text；
 *    - [{type:'tool_use'}] → 累加 name + JSON.stringify(input)；
 *    - [{type:'tool_result'}] → 累加 content（递归同上）；
 *    - [{type:'image'}]   → 固定 + 1500 token（粗略，按 1024×1024 上限）；
 *    - 其他块             → JSON.stringify 后累加；
 * 3. tools[*]              → JSON.stringify(tool) 累加；
 * 4. 每条 message 额外 + 4 token（role / 分隔符开销）。
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken';

import { Logger } from '../../logger';

/** 每条 message 的 role / 分隔符额外开销。 */
const PER_MESSAGE_OVERHEAD = 4;

/** 单张图像块的近似 token 数（按 1024×1024 上限，参考 Anthropic 计费）。 */
const IMAGE_BLOCK_TOKENS = 1500;

/** 单例 Tiktoken 编码器；词表 ~1.5MB，避免重复加载。 */
let encoder: Tiktoken | undefined;

/**
 * 取（必要时加载）cl100k_base 编码器单例。
 *
 * @returns Tiktoken 编码器；加载失败时返回 undefined，调用方需走字符兜底。
 */
function getEncoder(): Tiktoken | undefined {
    if (encoder) return encoder;
    try {
        encoder = getEncoding('cl100k_base');
        return encoder;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.warn(`[tokenBudget.estimator] cl100k_base 加载失败：${message}`);
        return undefined;
    }
}

/**
 * 统计一段字符串的 token 数；编码器不可用时回退到 `字符数 / 3.5` 粗估。
 *
 * @param text 待计数文本。
 * @returns 估算 token 数。
 */
function countTextTokens(text: string): number {
    if (!text) return 0;
    const enc = getEncoder();
    if (!enc) return Math.ceil(text.length / 3.5);
    try {
        return enc.encode(text).length;
    } catch {
        return Math.ceil(text.length / 3.5);
    }
}

/**
 * 判断未知值是否为 plain object。
 *
 * @param value 待判断值。
 * @returns 是否为 Record。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 累加 Anthropic `system` 字段（string 或 ContentBlock 数组）。
 *
 * @param system Anthropic system 字段值。
 * @returns 累加的 token 数。
 */
function countSystem(system: unknown): number {
    if (typeof system === 'string') return countTextTokens(system);
    if (Array.isArray(system)) {
        let sum = 0;
        for (const block of system) {
            if (isRecord(block) && typeof block.text === 'string') {
                sum += countTextTokens(block.text);
            } else {
                sum += countTextTokens(JSON.stringify(block));
            }
        }
        return sum;
    }
    return 0;
}

/**
 * 累加一个内容块的 token 数。
 *
 * @param block Anthropic content block。
 * @returns 累加的 token 数。
 */
function countContentBlock(block: unknown): number {
    if (typeof block === 'string') return countTextTokens(block);
    if (!isRecord(block)) return countTextTokens(JSON.stringify(block));
    const type = typeof block.type === 'string' ? block.type : '';
    switch (type) {
        case 'text':
            return countTextTokens(typeof block.text === 'string' ? block.text : '');
        case 'tool_use': {
            let sum = 0;
            if (typeof block.name === 'string') sum += countTextTokens(block.name);
            if (block.input !== undefined) {
                sum += countTextTokens(JSON.stringify(block.input));
            }
            return sum;
        }
        case 'tool_result': {
            const content = block.content;
            if (typeof content === 'string') return countTextTokens(content);
            if (Array.isArray(content)) {
                let sum = 0;
                for (const sub of content) sum += countContentBlock(sub);
                return sum;
            }
            return countTextTokens(JSON.stringify(content ?? ''));
        }
        case 'image':
            return IMAGE_BLOCK_TOKENS;
        default:
            return countTextTokens(JSON.stringify(block));
    }
}

/**
 * 累加单条 message 的 token 数（含 role 分隔符开销）。
 *
 * @param message Anthropic message。
 * @returns 累加的 token 数。
 */
function countMessage(message: unknown): number {
    if (!isRecord(message)) return PER_MESSAGE_OVERHEAD;
    const content = message.content;
    let sum = PER_MESSAGE_OVERHEAD;
    if (typeof content === 'string') {
        sum += countTextTokens(content);
    } else if (Array.isArray(content)) {
        for (const block of content) sum += countContentBlock(block);
    } else if (content !== undefined) {
        sum += countTextTokens(JSON.stringify(content));
    }
    return sum;
}

/**
 * 累加 tools 列表的 token 数（按 JSON.stringify 粗估）。
 *
 * @param tools Anthropic tools 数组。
 * @returns 累加的 token 数。
 */
function countTools(tools: unknown): number {
    if (!Array.isArray(tools)) return 0;
    let sum = 0;
    for (const tool of tools) sum += countTextTokens(JSON.stringify(tool));
    return sum;
}

/**
 * 估算一份 Anthropic 请求体的 input token 数。
 *
 * @param anthropicBody Anthropic 请求体；可以是 JSON 字符串、已解析对象，
 *                      或任何无法识别的值（无法识别时返回 0）。
 * @returns 估算的 input token 总数。
 */
export function estimateAnthropicInputTokens(anthropicBody: unknown): number {
    let body: unknown = anthropicBody;
    if (typeof body === 'string') {
        const text = body;
        try {
            body = JSON.parse(text);
        } catch {
            return countTextTokens(text);
        }
    }
    if (!isRecord(body)) return 0;
    let total = 0;
    total += countSystem(body.system);
    if (Array.isArray(body.messages)) {
        for (const msg of body.messages) total += countMessage(msg);
    }
    total += countTools(body.tools);
    return total;
}
