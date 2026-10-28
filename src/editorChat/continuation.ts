/** @file Per-editor continuation policy; deliberately avoids legacy static scheduler fields. */
import { AutoContinueScheduler } from '../llsTask/autoContinue';
import type { LlsTaskService } from '../llsTask/service';

/** Reuses interceptor interfaces but all state belongs to one editor conversation. */
export class EditorContinuation extends AutoContinueScheduler {
    private requested = false;
    private missing = 0;
    private closed = false;
    /** @param service This editor's workflow service only. */
    public constructor(service: LlsTaskService) { super(service); }
    /** Request a bounded continuation when a model stopped without updating workflow state. */
    public override schedule(): void { if (!this.closed && ++this.missing <= 3) this.requested = true; }
    /** Successful workflow updates reset the missing-tool circuit breaker. */
    public override scheduleAfterWorkflowTool(): void { if (!this.closed) { this.missing = 0; this.requested = true; } }
    /** Native tool loops own continuation until the final CLI result. */
    public override notifyRequestStarted(): void { this.requested = false; }
    /** Check actual CLI turn completion instead of a process-global timer. */
    public override armIdleWatchdog(): void { if (!this.closed) this.requested = true; }
    /** Reset this instance's circuit breaker without touching the sidebar. */
    public override resetMissingToolCounter(_reason: string): void { this.missing = 0; }
    /** Cancel only this instance's continuation request. */
    public override cancel(_reason = ''): void { this.requested = false; }
    /** Permanently disable continuation after the editor closes. */
    public override disposeAll(): void { this.closed = true; this.requested = false; }
    /** Consume one continuation only after the runtime has finished its CLI turn. */
    public consume(): boolean { const result = this.requested && !this.closed; this.requested = false; return result; }
}
