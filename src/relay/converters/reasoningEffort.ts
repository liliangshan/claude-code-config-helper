/**
 * @file Anthropic thinking 预算 → OpenAI reasoning effort 档位映射。
 *
 * Anthropic 的 budget_tokens 是连续值，OpenAI 的 effort 只有三档，故需人为
 * 切分阈值。Chat 与 Responses 两个请求转换器共用本模块，保证档位一致。
 */

/** OpenAI reasoning effort 档位。 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * 把 Anthropic thinking.budget_tokens 映射为 OpenAI reasoning effort 档位。
 *
 * 阈值取自 Anthropic 文档常用预算区间：4096 以下为轻量思考，4096～16383 为
 * 中等推理，16384 以上属深度推理。
 *
 * @param budgetTokens Anthropic thinking.budget_tokens 原始值。
 * @returns 对应 effort 档位；入参非有限正数时返回 undefined 表示不下发。
 */
export function mapBudgetToEffort(budgetTokens: unknown): ReasoningEffort | undefined {
    if (typeof budgetTokens !== 'number' || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return undefined;
    if (budgetTokens < 4096) return 'low';
    if (budgetTokens < 16384) return 'medium';
    return 'high';
}

/**
 * 从 Anthropic thinking 配置中读出 OpenAI reasoning effort 档位。
 *
 * 仅当 thinking.type === 'enabled' 时才认为用户真的开启了思考；'disabled'
 * 或缺失一律返回 undefined，避免误开上游推理。
 *
 * @param thinking Anthropic 请求体顶层 thinking 字段。
 * @returns effort 档位；不应下发时返回 undefined。
 */
export function readThinkingEffort(thinking: unknown): ReasoningEffort | undefined {
    if (typeof thinking !== 'object' || thinking === null || Array.isArray(thinking)) return undefined;
    const record = thinking as Record<string, unknown>;
    if (record.type !== 'enabled') return undefined;
    return mapBudgetToEffort(record.budget_tokens);
}
