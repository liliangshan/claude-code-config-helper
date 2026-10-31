/** @file Persistent one-shot image-result delivery receipts, separate from queryable task metadata. */
import type * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { ImageScope, ImageTask } from './types';

/** Store receipts before transport, preventing unknown-delivery retries across remounts and reloads. */
export class ImageResultReceipts {
    private readonly pending = new Set<string>();
    /** Bind extension workspace state, not global model settings or source image data. */
    public constructor(private readonly state: Pick<vscode.Memento, 'get' | 'update'>) {}
    /** Hash trusted ownership and task identity into an opaque receipt key. */
    private key(scope: ImageScope, task: ImageTask): string {
        return `llsccai.imageGeneration.delivered.${createHash('sha256').update(JSON.stringify([scope.cwd, scope.id, task.taskId])).digest('hex')}`;
    }
    /** Check whether a prior host already attempted this result delivery. */
    public has(scope: ImageScope, task: ImageTask): boolean {
        const key = this.key(scope, task); return this.pending.has(key) || this.state.get<boolean>(key, false);
    }
    /** Persist admission once; failure releases the in-memory reservation and does not send anything. */
    public async claim(scope: ImageScope, task: ImageTask): Promise<boolean> {
        if (this.has(scope, task)) return false;
        const key = this.key(scope, task); this.pending.add(key);
        try { await this.state.update(key, true); return true; }
        finally { this.pending.delete(key); }
    }
}
