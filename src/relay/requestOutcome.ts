/** @file 独立于用量统计的请求故障证据与单次终态报告。 */
import type { RequestUsageContext } from './requestUsage';

/** 原始状态与本地映射状态分别保存；未知不得当作成功。 */
export interface RelayRequestOutcome {
    context?: RequestUsageContext;
    status: 'completed' | 'error' | 'aborted' | 'unknown';
    stage?: 'upstream_connect' | 'upstream_first_byte' | 'upstream_stream' | 'upstream_http' | 'upstream_inline_error';
    upstreamStatus?: number;
    mappedStatus?: number;
    code?: string;
    retryAfter?: string;
}

/** 请求内共享证据；适配器结束后只发布一次。 */
export class RequestOutcomeReporter {
    private value: RelayRequestOutcome;
    private reported = false;
    private buffer = '';
    /** 冻结请求身份，不接触用户正文。 */
    public constructor(context?: RequestUsageContext, private readonly sink?: (result: RelayRequestOutcome) => void) {
        this.value = { context, status: 'unknown' };
    }
    /** 保存上游响应头，不把 HTTP 200 当作模型回合成功。 */
    public headers(status: number | undefined, retryAfter?: string | string[]): void {
        if (this.reported) return;
        this.value.upstreamStatus = status;
        this.value.retryAfter = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
        if (status && status >= 400) this.fail('upstream_http');
    }
    /** 保存结构化错误，首个故障阶段不被随后断流覆盖。 */
    public fail(stage: RelayRequestOutcome['stage'], code?: string, aborted = false): void {
        if (this.reported) return;
        if (!this.value.stage) this.value.stage = stage;
        if (code && !this.value.code) this.value.code = code;
        this.value.status = aborted && this.value.status !== 'error' ? 'aborted' : 'error';
    }
    /** 提取真实错误对象，error:null 不算错误。 */
    public json(payload: unknown): void {
        if (this.reported || !payload || typeof payload !== 'object') return;
        const p = payload as Record<string, unknown>;
        const response = p.response && typeof p.response === 'object' ? p.response as Record<string, unknown> : p;
        const error = response.error;
        if ((error !== undefined && error !== null) || p.type === 'error' || response.status === 'failed') {
            const e = error && typeof error === 'object' ? error as Record<string, unknown> : {};
            this.fail('upstream_inline_error', typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : undefined);
        }
    }
    /** 分片 SSE 只解析完整事件；避免无限缓存异常行。 */
    public feed(chunk: string): void {
        if (this.reported) return;
        this.buffer += chunk;
        let marker: RegExpExecArray | null;
        while ((marker = /\r?\n\r?\n/.exec(this.buffer)) !== null) {
            const event = this.buffer.slice(0, marker.index);
            this.buffer = this.buffer.slice(marker.index + marker[0].length);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            try { this.json(JSON.parse(data)); } catch { /* 非 JSON 心跳不构成故障。 */ }
        }
        if (this.buffer.length > 1024 * 1024) this.buffer = '';
    }
    /** 发布一次终态；设置标记后才调用外部 sink。 */
    public end(mappedStatus?: number): void {
        if (this.reported) return;
        this.reported = true;
        this.value.mappedStatus = mappedStatus;
        if (this.value.status === 'unknown') {
            this.value.status = mappedStatus && mappedStatus >= 400 ? 'error' : this.value.upstreamStatus ? 'completed' : 'unknown';
        }
        this.sink?.({ ...this.value });
    }
}

