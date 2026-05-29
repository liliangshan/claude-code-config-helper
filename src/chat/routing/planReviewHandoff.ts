/** @file plan/review 编排 token 的识别与正文提取辅助函数。 */

/** plan/review 编排 token。 */
export type PlanReviewToken = '@llsPlanTask' | '@llsPlanReview' | '@llsPlanRevise' | '@llsPlanDone' | '@llsPlanApproved';

/** plan/review 编排 token 解析结果。 */
export interface PlanReviewTokenMatch {
    /** 命中的编排 token。 */
    token: PlanReviewToken;
    /** token 后面的正文，已 trim。 */
    tail: string;
}

/** 所有支持的 plan/review 编排 token，按 normal dispatcher 优先级排列。 */
const PLAN_REVIEW_TOKENS: PlanReviewToken[] = [
    '@llsPlanTask',
    '@llsPlanReview',
    '@llsPlanRevise',
    '@llsPlanDone',
    '@llsPlanApproved'
];

/** 判断文本是否包含指定 plan/review 编排 token。 */
export function containsPlanReviewToken(text: string, token: PlanReviewToken): boolean {
    return new RegExp(`${escapeRegExp(token)}\\b`, 'i').test(text);
}

/** 提取指定 plan/review token 后面的正文。 */
export function extractPlanReviewTokenTail(text: string, token: PlanReviewToken): string {
    const match = text.match(new RegExp(`${escapeRegExp(token)}\\b\\s*`, 'i'));
    if (!match || match.index === undefined) return '';
    return text.slice(match.index + match[0].length).trim();
}

/** 解析文本中的第一个 plan/review 编排 token。 */
export function parsePlanReviewToken(text: string): PlanReviewTokenMatch | undefined {
    if (!text) return undefined;
    for (const token of PLAN_REVIEW_TOKENS) {
        if (containsPlanReviewToken(text, token)) {
            return { token, tail: extractPlanReviewTokenTail(text, token) };
        }
    }
    return undefined;
}

/** 转义正则字面量。 */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
