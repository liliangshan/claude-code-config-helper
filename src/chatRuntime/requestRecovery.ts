/** @file 请求恢复纯状态机；所有外部动作通过依赖注入执行。 */
export const RECOVERY_DELAYS_MS = [120000, 300000, 600000, 900000, 1200000] as const;

/** 冻结的逻辑回合身份；cycle 区分同一回合的多次恢复。 */
export interface RecoveryIdentity { generation: number; turnId: string; sessionId: string; cliInstanceId: string; cycle: number }
/** 结构化故障证据，不从显示文本猜测错误。 */
export interface RecoveryFailure {
    stage?: string;
    status?: number;
    code?: string;
    retryAfter?: string | number;
}
/** 可观察状态。 */
export type RecoveryState = 'awaiting_request' | 'running' | 'native_retry' | 'waiting_recovery' | 'recovering' | 'succeeded' | 'exhausted' | 'cancelled' | 'non_retryable';
/** 内存回合上下文；原始提交不发送至状态通知。 */
export interface RecoveryContext extends RecoveryIdentity {
    route: string;
    originalPrompt: string;
    deliveryState: 'not_sent' | 'accepted' | 'unknown';
    state: RecoveryState;
    attemptsUsed: number;
    nextRetryAt?: number;
    lastFailure?: RecoveryFailure;
}
/** 可替换时钟与恢复执行器。执行器每次 await 后必须检查 signal。 */
export interface RecoveryDependencies {
    now(): number;
    setTimer(callback: () => void, delay: number): unknown;
    clearTimer(timer: unknown): void;
    recover(context: Readonly<RecoveryContext>, signal: AbortSignal): Promise<void>;
    notify?(state: Readonly<Omit<RecoveryContext, 'originalPrompt'>>): void;
}

/** 根据状态码和结构化错误码分类；永久错误优先于 HTTP 状态。 */
export function classifyFailure(failure: RecoveryFailure): 'temporary' | 'permanent' | 'unknown' {
    const code = failure.code?.toLowerCase() || '';
    if (['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'authentication_failed', 'invalid_api_key', 'context_length_exceeded', 'model_not_found', 'enotfound', 'cert_has_expired', 'err_tls_cert_altname_invalid'].includes(code)) return 'permanent';
    if ([401, 403, 400, 404, 422].includes(failure.status || 0)) return 'permanent';
    if ([408, 429, 500, 502, 503, 504, 529].includes(failure.status || 0)) return 'temporary';
    if (['econnrefused', 'econnreset', 'etimedout', 'eai_again', 'first_byte_timeout', 'stream_idle_timeout', 'cli_request_stalled'].includes(code)) return 'temporary';
    return 'unknown';
}

/** Retry-After 数字以秒为单位，日期为绝对时间；非法值保持未知。 */
export function parseRetryAfter(value: string | number | undefined, now: number): number | undefined {
    if (value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
    const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(value.trim());
    if (typeof value === 'string' && !numeric && !/^[A-Za-z]{3}, /.test(value)) return undefined;
    const delay = numeric ? Number(value) * 1000 : typeof value === 'string' ? Date.parse(value) - now : NaN;
    return Number.isFinite(delay) && delay >= 0 && Number.isSafeInteger(Math.ceil(now + delay)) ? delay : undefined;
}

/** 一个实例对应共享 CLI 的互斥域。 */
export class RequestRecoveryController {
    private context?: RecoveryContext;
    private generation = 0;
    private timer?: unknown;
    private execution?: AbortController;
    private requests = new Set<string>();
    private finishedRequests = new Set<string>();
    private blockers = new Set<string>();
    private terminal = false;
    private disposed = false;

    /** 注入时钟和恢复动作。 */
    public constructor(private readonly deps: RecoveryDependencies) {}

    /** 新用户回合替换旧回合；内部恢复不得调用。 */
    public beginTurn(input: Pick<RecoveryContext, 'turnId' | 'sessionId' | 'cliInstanceId' | 'route' | 'originalPrompt' | 'deliveryState'>): Readonly<RecoveryContext> {
        if (this.disposed) throw new Error('Recovery controller disposed');
        this.cancelRecovery('new_turn');
        this.context = { ...input, generation: this.generation, cycle: 0, state: 'awaiting_request', attemptsUsed: 0 };
        this.terminal = false;
        this.publish();
        return this.getSnapshot()!;
    }

    /** 返回副本防止外部修改状态。 */
    public getSnapshot(): Readonly<RecoveryContext> | undefined {
        return this.context ? { ...this.context, lastFailure: this.context.lastFailure && { ...this.context.lastFailure } } : undefined;
    }

    /** 全身份与恢复周期匹配，丢弃迟到事件。 */
    private matches(id: RecoveryIdentity): boolean {
        const c = this.context;
        return !!c && !this.disposed && c.state !== 'cancelled' && c.generation === id.generation && c.turnId === id.turnId && c.sessionId === id.sessionId && c.cliInstanceId === id.cliInstanceId && c.cycle === id.cycle;
    }

    /** 同一提交的 session/init 可绑定首次会话，不允许改绑已知会话。 */
    public bindSession(id: RecoveryIdentity, sessionId: string): RecoveryIdentity | undefined {
        if (!this.matches(id) || this.context!.sessionId || !sessionId || this.terminal) return undefined;
        this.context!.sessionId = sessionId;
        this.publish();
        return { ...this.context! };
    }

    /** 原生重试仅更新状态，不推断最后一次已经完成。 */
    public onCliApiRetry(id: RecoveryIdentity, failure?: RecoveryFailure): void {
        if (!this.matches(id)) return;
        if (this.terminal && this.context!.state === 'waiting_recovery' && this.context!.lastFailure?.code === 'cli_request_stalled') {
            this.clearTimer();
            this.terminal = false;
            this.context!.nextRetryAt = undefined;
        }
        if (this.terminal) return;
        this.context!.state = 'native_retry';
        if (failure) this.context!.lastFailure = { ...failure };
        this.publish();
    }

    /** 网关请求命中只解除对应请求观察，不重置恢复额度。 */
    public onRelayRequestStarted(id: RecoveryIdentity, requestId: string): void {
        if (!this.matches(id)) return;
        if (this.terminal && this.context!.state === 'waiting_recovery' && this.context!.lastFailure?.code === 'cli_request_stalled') {
            this.clearTimer();
            this.terminal = false;
            this.context!.nextRetryAt = undefined;
        }
        if (this.terminal || !requestId || this.finishedRequests.has(requestId)) return;
        this.requests.add(requestId);
        this.context!.state = 'running';
        this.context!.deliveryState = 'accepted';
        this.publish();
    }

    /** 请求失败先保存证据；必须等待 CLI 最终失败。 */
    public onRelayRequestFinished(id: RecoveryIdentity, requestId: string, failure?: RecoveryFailure): void {
        if (!this.matches(id) || !this.requests.delete(requestId)) return;
        this.finishedRequests.add(requestId);
        if (failure) this.context!.lastFailure = { ...failure };
        if (this.terminal && this.context!.state === 'waiting_recovery') this.armTimer();
    }

    /** 只有明确的 CLI 回合终止才安排恢复，未知结果不当作成功。 */
    public onCliTurnFinished(id: RecoveryIdentity, isError: boolean | undefined, failure?: RecoveryFailure): void {
        if (!this.matches(id)) return;
        if (this.terminal && this.context!.state === 'waiting_recovery' && this.context!.lastFailure?.code === 'cli_request_stalled') {
            this.clearTimer();
            this.terminal = false;
        }
        if (this.terminal) return;
        this.terminal = true;
        if (isError === false) {
            this.clearTimer();
            this.context!.state = 'succeeded';
            this.context!.attemptsUsed = 0;
            this.context!.nextRetryAt = undefined;
            this.publish();
        } else if (isError === true) {
            this.scheduleRecovery(failure || this.context!.lastFailure || {});
        } else {
            this.context!.state = 'non_retryable';
            this.publish();
        }
    }

    /** 仅明确等待请求且无阻塞时安排停滞恢复；执行器须先终止旧进程。 */
    public onExpectedRequestTimeout(id: RecoveryIdentity): boolean {
        if (!this.matches(id) || this.terminal || this.context!.state !== 'awaiting_request' || this.blockers.size || this.requests.size) return false;
        this.terminal = true;
        this.scheduleRecovery({ stage: 'cli_to_relay', code: 'cli_request_stalled' });
        return true;
    }

    /** 排队一次额外恢复，服务器等待与本地退避取较大值。 */
    private scheduleRecovery(failure: RecoveryFailure): void {
        const c = this.context!;
        c.lastFailure = { ...failure };
        c.nextRetryAt = undefined;
        if (classifyFailure(failure) !== 'temporary') c.state = 'non_retryable';
        else if (c.attemptsUsed >= RECOVERY_DELAYS_MS.length) c.state = 'exhausted';
        else {
            c.state = 'waiting_recovery';
            c.nextRetryAt = this.deps.now() + Math.max(RECOVERY_DELAYS_MS[c.attemptsUsed], parseRetryAfter(failure.retryAfter, this.deps.now()) || 0);
            this.armTimer();
        }
        this.publish();
    }

    /** 权限、工具和压缩阻塞期间不启动恢复；解除后重新检查。 */
    public setBlocked(id: RecoveryIdentity, reason: string, blocked: boolean): void {
        if (!this.matches(id)) return;
        if (blocked) this.blockers.add(reason);
        else this.blockers.delete(reason);
        if (this.context!.state === 'waiting_recovery') this.armTimer();
    }

    /** 清理唯一计时器。 */
    private clearTimer(): void {
        if (this.timer !== undefined) this.deps.clearTimer(this.timer);
        this.timer = undefined;
    }

    /** 长 Retry-After 分段等待，避免 Node 超大延迟立即触发。 */
    private armTimer(): void {
        this.clearTimer();
        const c = this.context;
        if (!c || c.state !== 'waiting_recovery' || this.blockers.size || this.requests.size) return;
        const id = { ...c };
        const delay = Math.max(0, (c.nextRetryAt || 0) - this.deps.now());
        this.timer = this.deps.setTimer(() => {
            this.timer = undefined;
            if (!this.matches(id)) return;
            if (this.deps.now() < (this.context!.nextRetryAt || 0)) this.armTimer();
            else void this.runRecovery(id);
        }, Math.min(delay, 2147483647));
    }

    /** 执行一次恢复；执行器负责在每个副作用前复核取消信号。 */
    private async runRecovery(id: RecoveryIdentity): Promise<void> {
        if (!this.matches(id) || this.context!.state !== 'waiting_recovery' || this.blockers.size || this.requests.size) return;
        const c = this.context!;
        c.attemptsUsed++;
        c.cycle++;
        c.state = 'recovering';
        c.nextRetryAt = undefined;
        this.terminal = false;
        this.finishedRequests.clear();
        const attempt = { ...c };
        const execution = new AbortController();
        this.execution = execution;
        this.publish();
        try {
            await this.deps.recover(Object.freeze(attempt), execution.signal);
            if (!this.matches(attempt) || execution.signal.aborted || this.terminal) return;
            if (c.state === 'recovering') c.state = 'awaiting_request';
            this.publish();
        } catch (error) {
            if (!this.matches(attempt) || execution.signal.aborted || this.terminal) return;
            this.terminal = true;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
            this.scheduleRecovery({ code });
        } finally {
            if (this.execution === execution) this.execution = undefined;
        }
    }

    /** 取消后迟到计时器和异步结果不得恢复旧回合。 */
    public cancelRecovery(_reason: string): void {
        this.generation++;
        this.clearTimer();
        this.execution?.abort();
        this.execution = undefined;
        this.requests.clear();
        this.finishedRequests.clear();
        this.blockers.clear();
        this.terminal = true;
        if (this.context) {
            this.context.state = 'cancelled';
            this.context.nextRetryAt = undefined;
            this.publish();
        }
    }

    /** 终止失败也阻止任务流绕过恢复上限。 */
    public hasPendingRecovery(): boolean {
        return !!this.context && ['native_retry', 'waiting_recovery', 'recovering', 'exhausted', 'non_retryable'].includes(this.context.state);
    }

    /** 手动重试仅接受当前失败身份，开启新代数并保留原会话。 */
    public retryManually(id: RecoveryIdentity): boolean {
        if (!this.matches(id) || !['exhausted', 'non_retryable'].includes(this.context!.state)) return false;
        const previous = this.getSnapshot()!;
        this.beginTurn(previous);
        this.terminal = true;
        this.context!.state = 'waiting_recovery';
        this.context!.nextRetryAt = this.deps.now();
        this.armTimer();
        this.publish();
        return true;
    }

    /** 停用后不能创建新回合。 */
    public dispose(): void {
        this.cancelRecovery('dispose');
        this.disposed = true;
    }

    /** 状态通知不携带原始提交。 */
    private publish(): void {
        if (!this.context) return;
        const { originalPrompt: _prompt, ...state } = this.getSnapshot()!;
        this.deps.notify?.(state);
    }
}

