/**
 * plan / review 自动编排与按需专家子回合。
 *
 * 拆分自 extension.ts：把 normal 最终回复中的交棒标记识别、plan/review 多轮
 * 修订编排，以及用户级 `@llsExpert` 前缀触发的专家 sub-turn 收敛到一个模块。
 *
 * 依赖方向：本模块位于 chatRuntime 上层，可直接 import 会话、消息与路由模块；
 * Relay 端口启动等仍留在 extension.ts 的函数通过
 * {@link configurePlanReviewWorkflow} 注入，避免反向 import 造成循环依赖。
 */
import { parsePlanReviewToken } from '../chat/routing/planReviewHandoff';
import { resolvePlanDoneRoutingAction } from '../chat/routing/planReviewWorkflow';
import { readExpertSubturnOptions } from '../expertMode/expertConfig';
import { ExpertSubturnService } from '../expertMode/expertSubturnService';
import { Logger } from '../logger';
import { getRelayServer } from '../runtime';
import { appendAssistantSegments } from './chatSession';
import { sendUserMessageToCli } from './chatMessaging';
import { ensurePlanCliStarted, ensureReviewCliStarted, schedulePlanReviewIdleDispose } from './cliLifecycle';
import { readEffectiveExpertModelSelection, readEffectiveReviewModelSelection } from './modelSelection';
import { cancelRouteProcess, getStreamAdapterForRoute, routes } from './routeState';
import { showChatToast, switchChatRoute, switchRouteToExpert } from './webviewMessages';

/** planReviewWorkflow 需要但仍留在 extension.ts 的协作函数集合。 */
export interface PlanReviewWorkflowDeps {
    /** 确保本地 Relay 已监听并返回实际端口。 */
    ensureRelayServerStarted: () => Promise<number>;
}

/** 已注入的协作函数集合，未装配前访问会抛错。 */
let deps: PlanReviewWorkflowDeps | undefined;

/** 装配 planReviewWorkflow 依赖，必须在 activate 早期调用一次。 */
export function configurePlanReviewWorkflow(value: PlanReviewWorkflowDeps): void {
    deps = value;
}

/** 读取已装配的依赖，未装配时抛出明确错误便于定位装配顺序问题。 */
function requireDeps(): PlanReviewWorkflowDeps {
    if (!deps) throw new Error('planReviewWorkflow 尚未装配');
    return deps;
}

/** 模块级 ExpertSubturnService 实例（按需专家方案）。 */
let expertSubturnService: ExpertSubturnService | undefined;

/** 释放专家子回合服务实例，供 deactivate 兜底调用。 */
export function disposeExpertSubturnService(): void {
    expertSubturnService = undefined;
}

/**
 * 获取（或惰性创建）模块级 ExpertSubturnService 单例。
 *
 * 该服务在第一次需要时按需创建，并把 Relay 端口、专家模型 id 与 sub-turn 配置
 * 作为闭包依赖项注入。后续 dispose 在 deactivate 中统一处理。
 */
export function getOrCreateExpertSubturnService(): ExpertSubturnService {
    if (!expertSubturnService) {
        expertSubturnService = new ExpertSubturnService({
            getRelayPort: () => getRelayServer()?.getActualPort(),
            getExpertModel: () => readEffectiveExpertModelSelection().modelId,
            getOptions: () => readExpertSubturnOptions(),
            getAuthToken: () => 'claude-code-relay'
        });
    }
    return expertSubturnService;
}

/**
 * 处理用户级 @llsExpert / /expert 前缀触发的专家 sub-turn。
 *
 * 按需专家方案下，用户主动触发的专家请求不再走常驻 expert CLI，而是直接调用
 * {@link ExpertSubturnService.run}：
 *
 * - 失败 / 专家未配置：渲染一段错误说明，并提示用户回到 normal 路由继续。
 * - 成功：根据 `chat.expert.userTriggerMode` 决定是否回写主 CLI（tool_result 模式）
 *   或直接以 assistant segments 展示给用户（direct 模式）。
 *
 * @param question 已剥除前缀的纯净问题文本。
 * @param options.hidden 是否抑制 assistant 区域创建（保持沉默执行）。
 */
export async function runUserTriggeredExpertSubturn(
    question: string,
    options: { hidden?: boolean }
): Promise<void> {
    await requireDeps().ensureRelayServerStarted();
    const service = getOrCreateExpertSubturnService();
    const triggerMode = readExpertSubturnOptions().userTriggerMode;
    const result = await service.run({ question });

    if (!result.ok) {
        if (!options.hidden) {
            await appendAssistantSegments(
                [{ kind: 'error', text: `\n专家请求失败（${result.failureReason ?? 'error'}）：${result.text}\n` }],
                true
            );
        }
        return;
    }

    if (triggerMode === 'tool_result' && routes.normal.adapter) {
        // tool_result 模式：把专家回答以 user role 的 tool_result 注入主 CLI，
        // 让主模型自行整合并续写最终答复。
        const toolUseId = `expert-user-${Date.now()}`;
        await routes.normal.adapter.sendUserMessage(
            `[expert advisory] ${result.text}`
        );
        void toolUseId;
        return;
    }

    if (!options.hidden) {
        await appendAssistantSegments(
            [{ kind: 'markdown', text: result.text }],
            true
        );
    }
}

/** plan/review 自动编排状态。 */
export interface PlanReviewWorkflowState {
    /** 当前是否存在正在进行的 plan/review workflow。 */
    active: boolean;
    /** 用户最初要求规划/设计的任务。 */
    originalUserTask: string;
    /** 最近一次 plan CLI 输出。 */
    latestPlanText: string;
    /** 最近一次 review CLI 输出。 */
    latestReviewText: string;
    /** 已执行的修订次数。 */
    revisionCount: number;
    /** 自动修订最大次数。 */
    maxRevisions: number;
}

/** 当前 plan/review 自动编排状态。 */
let planReviewWorkflowState: PlanReviewWorkflowState | undefined;

/** plan/review 自动修订最大轮次。 */
const PLAN_REVIEW_MAX_REVISIONS = 3;

// 按需专家方案下，用户级 @llsExpert / /expert 触发前缀的识别 / 剥除函数集中在
// src/expertMode/expertTriggers.ts；这里仅复用导入。

/**
 * 从 dispatcher 文本中提取 `@llsExpert` 标记后面的正文。
 *
 * 取标记后的剩余字符串，trim 后作为要交棒给专家的指令；标记前的内容（normal 模型
 * 自己的铺垫语）一并丢弃，避免把 dispatcher 的解释作为专家输入。
 */
export function extractHandoffInstruction(text: string): string {
    const match = text.match(/@llsExpert\b\s*/i);
    if (!match || match.index === undefined) return '';
    return text.slice(match.index + match[0].length).trim();
}

/** 从 normal CLI 最终回复文本中检测专家移交标记，命中则自动交棒到 expert CLI。 */
export async function watchNormalForExpertHandoff(text: string): Promise<boolean> {
    // 按需专家方案下 dispatcher 输出的文本标记已废弃，专家完全由 ask_expert MCP 工具触发。
    // 该函数保留为 no-op，仅为减小本次改造的爆炸半径；后续可在删除 watchNormalForExpertHandoff 调用点后移除。
    void text;
    return false;

    const instruction = extractHandoffInstruction(text);
    cancelRouteProcess('normal');

    await switchRouteToExpert('normal-replied-handoff');

    if (!instruction) {
        await showChatToast('warn', '检测到 @llsExpert 移交标记，但未抓取到指令文本，已切换路由，等待你的下一条消息。');
        return true;
    }
    if (!getStreamAdapterForRoute('expert')) {
        await appendAssistantSegments([
            { kind: 'error', text: '\n检测到 @llsExpert 移交标记，但未配置专家模型，无法继续。\n' }
        ], true);
        await switchChatRoute('normal', 'expert-not-configured');
        return true;
    }

    Logger.info(`检测到 @llsExpert，自动交棒给 expert Chat CLI：instructionLength=${instruction.length}`);
    await showChatToast('info', '已检测到 @llsExpert，正在把任务交给专家模型…');
    try {
        await sendUserMessageToCli(instruction, { hidden: true, forceRoute: 'expert' });
    } catch (err) {
        Logger.error('自动交棒到专家 CLI 失败', err);
    }
    return true;
}

/** 从 normal CLI 最终回复文本中检测 plan/review 编排标记。 */
export async function watchNormalForPlanHandoff(text: string): Promise<boolean> {
    const match = parsePlanReviewToken(text);
    if (!match) return false;
    if (match.token === '@llsPlanTask') {
        await handleNormalPlanTask(match.tail);
        return true;
    }
    if (match.token === '@llsPlanReview') {
        await handleNormalPlanReview();
        return true;
    }
    if (match.token === '@llsPlanRevise') {
        await handleNormalPlanRevise(match.tail);
        return true;
    }
    if (match.token === '@llsPlanDone') {
        await handleNormalPlanDone();
        return true;
    }
    if (match.token === '@llsPlanApproved') {
        finishPlanReviewWorkflow('normal-plan-approved');
        await switchChatRoute('normal', 'plan-approved');
        return false;
    }
    return false;
}

/** 处理 normal 发起的 plan 任务移交。 */
export async function handleNormalPlanTask(instruction: string): Promise<void> {
    cancelRouteProcess('normal');
    if (!instruction) {
        await showChatToast('warn', '检测到 @llsPlanTask，但未抓取到方案任务描述。');
        return;
    }
    planReviewWorkflowState = {
        active: true,
        originalUserTask: instruction,
        latestPlanText: '',
        latestReviewText: '',
        revisionCount: 0,
        maxRevisions: PLAN_REVIEW_MAX_REVISIONS
    };
    try {
        await ensurePlanCliStarted();
        await switchChatRoute('plan', 'normal-plan-handoff');
        await sendUserMessageToCli(instruction, { hidden: true, forceRoute: 'plan' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`启动 plan CLI 或发送方案任务失败：${message}`);
        finishPlanReviewWorkflow('plan-lazy-start-failed');
        await switchChatRoute('normal', 'plan-lazy-start-failed');
        await appendAssistantSegments([{ kind: 'error', text: `\n方案模型不可用：${message}\n` }], true);
    }
}

/** 处理 normal 认为方案已完成：审查模型存在时先强制进入 review。 */
export async function handleNormalPlanDone(): Promise<void> {
    const state = planReviewWorkflowState;
    if (resolvePlanDoneRoutingAction(state, readEffectiveReviewModelSelection().enabled) === 'review') {
        Logger.info('检测到 @llsPlanDone 且审查模型已配置，直接交给 review CLI 审查方案文档');
        await handleNormalPlanReview();
        return;
    }
    finishPlanReviewWorkflow('normal-plan-done');
    await switchChatRoute('normal', 'plan-done');
}

/** 处理 normal 要求 review 审查最近方案。 */
export async function handleNormalPlanReview(): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active || !state.latestPlanText) {
        await appendAssistantSegments([{ kind: 'error', text: '\n没有可审查的方案输出。\n' }], true);
        return;
    }
    try {
        await ensureReviewCliStarted();
        const prompt = buildReviewPrompt(state);
        await switchChatRoute('review', 'normal-review-handoff');
        await sendUserMessageToCli(prompt, { hidden: true, forceRoute: 'review' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.warn(`review CLI 不可用，结束方案流程：${message}`);
        await sendPlanReviewCallbackToNormal([
            'The review model is unavailable, so finish the plan workflow without review.',
            '',
            `<plan_output>\n${state.latestPlanText}\n</plan_output>`,
            '',
            'Reply with @llsPlanDone followed by a concise user-facing summary.'
        ].join('\n'));
    }
}

/** 处理 normal 要求 plan 根据 review 意见修订。 */
export async function handleNormalPlanRevise(feedback: string): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active || !state.latestPlanText) {
        await appendAssistantSegments([{ kind: 'error', text: '\n没有可修订的方案输出。\n' }], true);
        return;
    }
    if (state.revisionCount >= state.maxRevisions) {
        finishPlanReviewWorkflow('max-revisions');
        await switchChatRoute('normal', 'plan-max-revisions');
        await appendAssistantSegments([{ kind: 'markdown', text: '\n方案审查修订次数已达上限，请确认是否继续下一轮修订。\n' }], true);
        return;
    }
    state.revisionCount += 1;
    try {
        await ensurePlanCliStarted();
        await switchChatRoute('plan', 'normal-plan-revise');
        await sendUserMessageToCli(buildPlanRevisionPrompt(state, feedback), { hidden: true, forceRoute: 'plan' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`发送方案修订任务失败：${message}`);
        finishPlanReviewWorkflow('plan-revise-failed');
        await switchChatRoute('normal', 'plan-revise-failed');
        await appendAssistantSegments([{ kind: 'error', text: `\n方案模型修订不可用：${message}\n` }], true);
    }
}

/** 处理 plan CLI 完成本轮方案输出。 */
export async function handlePlanDone(finalText: string): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active) return;
    state.latestPlanText = finalText;
    await sendPlanReviewCallbackToNormal([
        'The plan model has completed the following plan for the user\'s request.',
        '',
        `<original_user_task>\n${state.originalUserTask}\n</original_user_task>`,
        '',
        `<plan_output>\n${finalText}\n</plan_output>`,
        '',
        'Decide the next orchestration step:',
        '- If review is enabled, reply only with @llsPlanReview.',
        '- If review is disabled, reply with @llsPlanDone followed by a concise user-facing summary.',
        '- Do not implement the plan.'
    ].join('\n'));
}

/** 处理 review CLI 完成本轮审查输出。 */
export async function handleReviewDone(finalText: string): Promise<void> {
    const state = planReviewWorkflowState;
    if (!state?.active) return;
    state.latestReviewText = finalText;
    await sendPlanReviewCallbackToNormal([
        'The review model has reviewed the latest plan.',
        '',
        `<plan_output>\n${state.latestPlanText}\n</plan_output>`,
        '',
        `<review_output>\n${finalText}\n</review_output>`,
        '',
        'Decide the next orchestration step:',
        `- If the review verdict is CHANGES_REQUESTED and revisionCount (${state.revisionCount}) < maxRevisions (${state.maxRevisions}), reply only with @llsPlanRevise followed by the required changes.`,
        '- If the review verdict is APPROVED, reply with @llsPlanApproved followed by a concise user-facing summary.',
        '- If revisionCount has reached maxRevisions, stop the loop and ask the user whether to continue.'
    ].join('\n'));
}

/** 构造 review CLI 审查 prompt。 */
export function buildReviewPrompt(state: PlanReviewWorkflowState): string {
    return [
        'Review the following plan for the user\'s original request.',
        '',
        `<original_user_task>\n${state.originalUserTask}\n</original_user_task>`,
        '',
        `<plan_output>\n${state.latestPlanText}\n</plan_output>`
    ].join('\n');
}

/** 构造 plan CLI 修订 prompt。 */
export function buildPlanRevisionPrompt(state: PlanReviewWorkflowState, feedback: string): string {
    return [
        'Revise the previous plan according to the review feedback.',
        '',
        `<original_user_task>\n${state.originalUserTask}\n</original_user_task>`,
        '',
        `<previous_plan>\n${state.latestPlanText}\n</previous_plan>`,
        '',
        `<review_feedback>\n${feedback || state.latestReviewText}\n</review_feedback>`,
        '',
        'Return only the revised plan content.'
    ].join('\n');
}

/** 把 plan/review 完成结果回调给 normal 编排器。 */
export async function sendPlanReviewCallbackToNormal(prompt: string): Promise<void> {
    await switchChatRoute('normal', 'plan-review-callback');
    await sendUserMessageToCli(prompt, { hidden: true, suppressResponse: true, forceRoute: 'normal' });
}

/** 结束 plan/review workflow 并安排闲置回收。 */
export function finishPlanReviewWorkflow(reason: string): void {
    planReviewWorkflowState = undefined;
    schedulePlanReviewIdleDispose(reason);
}
