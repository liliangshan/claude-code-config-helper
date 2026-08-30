/** @file 定时唤醒 MCP 工具常量与 schema。 */

/** 定时唤醒 MCP server 在 Claude CLI mcpServers 注册时使用的 server 名。 */
export const WAKEUP_MCP_SERVER_NAME = 'llsccaiWakeup' as const;

/** Claude CLI 暴露给主模型时看到的完整工具名前缀。 */
export const WAKEUP_FULL_TOOL_PREFIX = `mcp__${WAKEUP_MCP_SERVER_NAME}__` as const;

/** 工具裸名（未加 mcp__<server>__ 前缀）。 */
export type WakeupToolName =
    | 'lls-ccai-schedule-wakeup'
    | 'lls-ccai-list-wakeups'
    | 'lls-ccai-cancel-wakeup';

/** MCP tools/list 返回的单个工具 schema。 */
export interface WakeupToolSchema {
    /** 工具裸名。 */
    name: WakeupToolName;
    /** 工具描述。 */
    description: string;
    /** JSON Schema 输入描述。 */
    inputSchema: {
        /** schema 根类型。 */
        type: 'object';
        /** 输入字段定义。 */
        properties: Record<string, unknown>;
        /** 必填字段列表。 */
        required: string[];
    };
}

/**
 * tools/list 返回的工具定义全集。
 *
 * schedule 工具的时间字段 `delaySeconds` / `at` 是二选一关系，但 schema 层
 * 只把 `prompt` 写进 required：JSON Schema 的 oneOf / anyOf 在不同 provider
 * 的工具转换里支持程度不一，统一放到 WakeupHost 做运行时校验更稳。
 */
export const WAKEUP_TOOL_SCHEMAS: readonly WakeupToolSchema[] = [
    {
        name: 'lls-ccai-schedule-wakeup',
        description:
            'Schedule a wake-up. At the specified time the extension sends `prompt` ' +
            'into the chat as a user message, exactly as if the user had typed and sent it. ' +
            'Provide either `delaySeconds` (relative) or `at` (absolute ISO 8601 time). ' +
            'For a repeating wake-up set `repeatCount` (> 1) together with `intervalSeconds`.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The message to send into the chat when the wake-up fires.'
                },
                delaySeconds: {
                    type: 'number',
                    description: 'Fire this many seconds from now. Mutually exclusive with `at`.'
                },
                at: {
                    type: 'string',
                    description: 'Absolute ISO 8601 time to fire at. Mutually exclusive with `delaySeconds`.'
                },
                repeatCount: {
                    type: 'number',
                    description: 'Total number of times to fire. Defaults to 1 (one-shot). Requires `intervalSeconds` when greater than 1.'
                },
                intervalSeconds: {
                    type: 'number',
                    description: 'Seconds between repeats. Required when `repeatCount` is greater than 1.'
                },
                reason: {
                    type: 'string',
                    description: 'Optional one-line note about why this wake-up exists; shown when listing.'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'lls-ccai-list-wakeups',
        description: 'List all scheduled wake-ups that have not fired yet.',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'lls-ccai-cancel-wakeup',
        description: 'Cancel a scheduled wake-up by the id returned from lls-ccai-schedule-wakeup.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'The wake-up id to cancel.' }
            },
            required: ['id']
        }
    }
] as const;

/** 定时唤醒工具名集合，用于校验 tools/call 入参。 */
const WAKEUP_TOOL_NAMES = new Set<WakeupToolName>(WAKEUP_TOOL_SCHEMAS.map((tool) => tool.name));

/**
 * 判断输入是否为受支持的定时唤醒工具名。
 *
 * @param value 待校验值（通常来自 tools/call 或 HTTP bridge 的入参）。
 * @returns 是合法工具名时返回 true 并收窄类型。
 */
export function isWakeupToolName(value: unknown): value is WakeupToolName {
    return typeof value === 'string' && WAKEUP_TOOL_NAMES.has(value as WakeupToolName);
}
