/** @file plan/review 路由决策纯函数。 */

/** plan/review 自动编排状态中做路由判断所需的最小字段。 */
export interface PlanReviewRoutingState {
    active: boolean;
    latestPlanText: string;
    latestReviewText: string;
}

/** @llsPlanDone 的下一步动作。 */
export type PlanDoneRoutingAction = 'review' | 'finish';

/** 判断 @llsPlanDone 是否应被审查模型拦截。 */
export function resolvePlanDoneRoutingAction(
    state: PlanReviewRoutingState | undefined,
    reviewModelEnabled: boolean
): PlanDoneRoutingAction {
    if (state?.active && state.latestPlanText && !state.latestReviewText && reviewModelEnabled) {
        return 'review';
    }
    return 'finish';
}
