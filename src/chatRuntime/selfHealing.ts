/** @file 通用恢复装配桥；旧自愈接口不再拥有重试额度或重发计时器。 */
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { Logger } from '../logger';
import { getRelayServer, getChatViewHost } from '../runtime';
import { RequestRecoveryController, type RecoveryContext, type RecoveryIdentity } from './requestRecovery';
import type { RelayUpstreamRequestInfo } from '../relay/router';
import type { RelayRequestOutcome } from '../relay/requestOutcome';

/** 生命周期层提供安全中断/恢复和保留会话的发送动作。 */
export interface RecoveryRuntimeActions {
    /** 最终成功通知，用于合并任务流续推。 */
    onSucceeded?(): void;
    submit(context: Readonly<RecoveryContext>, signal: AbortSignal): Promise<void>;
    recoverCli(context: Readonly<RecoveryContext>, signal: AbortSignal, restartRelay: boolean): Promise<void>;
}
let actions: RecoveryRuntimeActions | undefined;
let expectation: ReturnType<typeof setTimeout> | undefined;
const requestIdentities = new Map<string, RecoveryIdentity>();
/** 每次提交绑定到具体适配器，事件到达时立即捕获身份。 */
const adapterIdentities = new WeakMap<object, RecoveryIdentity>();

/** 为新提交或恢复提交登记事件归属。 */
export function bindRecoveryAdapter(adapter: object, identity: RecoveryIdentity): void {
    adapterIdentities.set(adapter, { ...identity });
}

/** 返回事件订阅对应的身份副本；未登记不得猜配。 */
export function getRecoveryAdapterIdentity(adapter: object): RecoveryIdentity | undefined {
    const identity = adapterIdentities.get(adapter);
    return identity ? { ...identity } : undefined;
}

/** 单例控制器；所有恢复统一消耗五档额度。 */
export const requestRecoveryController = new RequestRecoveryController({
    now: () => Date.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    recover: async (context, signal) => {
        if (!actions) throw new Error('Recovery runtime not configured');
        if (context.lastFailure?.stage === 'cli_to_relay') {
            const healthy = await probeRelayHealth();
            signal.throwIfAborted();
            await actions.recoverCli(context, signal, !healthy);
            signal.throwIfAborted();
        }
        await actions.submit(context, signal);
        signal.throwIfAborted();
    },
    notify: state => {
        Logger.info(`[request-recovery] state=${state.state} turn=${state.turnId} generation=${state.generation} attempt=${state.attemptsUsed} next=${state.nextRetryAt ?? '-'}`);
        if (state.state === 'awaiting_request') {
            clearHttpExpectation('awaiting_request');
            const identity = { ...state };
            expectation = setTimeout(() => { expectation = undefined; void onHttpExpectationTimeout(identity); }, 120000);
        } else clearHttpExpectation(`state:${state.state}`);
        void postRecoveryState();
        if (state.state === 'succeeded') actions?.onSucceeded?.();
    }
});

/** 推送当前内存状态，排除原始提交和错误正文。 */
export async function postRecoveryState(): Promise<void> {
    const snapshot = requestRecoveryController.getSnapshot();
    if (!snapshot) { await getChatViewHost()?.postMessage({ type: 'request/recovery', state: null }); return; }
    const { originalPrompt: _prompt, lastFailure: _failure, ...state } = snapshot;
    await getChatViewHost()?.postMessage({ type: 'request/recovery', state });
}

/** 装配动作，不在模块导入时启动进程或模型请求。 */
export function configureRecoveryRuntime(value: RecoveryRuntimeActions): void { actions = value; }

/** 提交入口统一登记，内部恢复不得重新登记回合。 */
export function beginRecoveryTurn(input: Pick<RecoveryContext, 'sessionId' | 'cliInstanceId' | 'route' | 'originalPrompt' | 'deliveryState'>): RecoveryIdentity {
    clearHttpExpectation('new_turn');
    requestIdentities.clear();
    const identity = requestRecoveryController.beginTurn({ ...input, turnId: randomUUID() });
    return identity;
}

/** 兼容旧调用；计时统一移至实际发送入口，不能重复登记 prompt。 */
export function armHttpExpectation(_prompt: string): void {}

/** 清除观测计时，不清除逻辑回合与恢复额度。 */
export function clearHttpExpectation(_reason: string): void {
    if (expectation !== undefined) clearTimeout(expectation);
    expectation = undefined;
}

/** 取消计时和所有迟到恢复，保留聊天历史。 */
export function cancelPendingResend(reason: string): void {
    clearHttpExpectation(reason);
    requestIdentities.clear();
    requestRecoveryController.cancelRecovery(reason);
}

/** 只读健康探测，不调用模型接口，不产生 relay hit。 */
export async function probeRelayHealth(): Promise<boolean> {
    const port = getRelayServer()?.getActualPort();
    if (!port) return false;
    return new Promise(resolve => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/_lls/health', timeout: 3000 }, res => {
            res.resume();
            resolve(res.statusCode === 204);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

/** 未命中不等于 CLI 已终止；未完成安全中断装配前仅记录停滞证据。 */
export async function onHttpExpectationTimeout(identity?: RecoveryIdentity): Promise<void> {
    const current = requestRecoveryController.getSnapshot();
    if (!identity || !current || current.generation !== identity.generation || current.cycle !== identity.cycle) return;
    if (current.state !== 'awaiting_request') return;
    const healthy = await probeRelayHealth();
    const latest = requestRecoveryController.getSnapshot();
    if (latest?.generation !== identity.generation || latest.state !== 'awaiting_request') return;
    Logger.warn(`[request-recovery] CLI 未命中网关，恢复时先终止旧进程：healthy=${healthy}`);
    requestRecoveryController.onExpectedRequestTimeout(identity);
}

/** 只有同一会话的请求才解除等待；未知身份拒绝猜配。 */
export function observeRecoveryRequestStart(info: RelayUpstreamRequestInfo): void {
    const c = requestRecoveryController.getSnapshot();
    const usage = info.usageContext;
    if (!c || !usage?.sessionId || c.sessionId !== usage.sessionId || usage.compactCommandTriggered) return;
    clearHttpExpectation('matched_relay_request');
    requestIdentities.set(usage.requestId, c);
    requestRecoveryController.onRelayRequestStarted(c, usage.requestId);
}

/** 按请求入口保存的身份上报结果，而非结束时活动会话。 */
export function observeRecoveryRequestOutcome(result: RelayRequestOutcome): void {
    const requestId = result.context?.requestId;
    const identity = requestId && requestIdentities.get(requestId);
    if (!requestId || !identity) return;
    requestIdentities.delete(requestId);
    requestRecoveryController.onRelayRequestFinished(identity, requestId, result.status === 'error' ? {
        stage: result.stage, status: result.upstreamStatus && result.upstreamStatus >= 400 ? result.upstreamStatus : result.mappedStatus,
        code: result.code, retryAfter: result.retryAfter
    } : undefined);
}
