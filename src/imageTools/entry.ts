/** @file Extension-owned image service and stable history-to-task scope mapping. */
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import type { ConfigManager } from '../configManager';
import { ImageToolHost, type ImageViewBinding } from './imageToolHost';
import { ImageError, type ImageScope, type ImageWebviewRequest } from './types';

let service: ImageToolHost | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let identityQueue: Promise<unknown> = Promise.resolve();
const pending = new Map<string, string>();
const capabilities = new Map<string, { owner: string; cwd: string }>();
const views = new Map<string, ImageViewBinding>();
/** Initialize globally once; failures remain visible when users open image configuration. */
export async function configureImages(context: vscode.ExtensionContext, manager: ConfigManager): Promise<void> {
    extensionContext = context; service = new ImageToolHost(context, manager); await service.initialize();
}
/** Obtain the host service without exposing it to MCP subprocesses. */
export function getImageService(): ImageToolHost | undefined { return service; }
/** Hash stable identity fields, never accepting model-supplied filesystem keys. */
function scopeHash(cwd: string, owner: string, identity: string): string { return createHash('sha256').update(JSON.stringify([cwd, owner, identity])).digest('hex'); }
/** Resolve/persist an image identity before a CLI session exists and bind it when native history appears. */
export function imageScope(cwd: string, owner: string, sessionId: string | undefined, title: string): Promise<ImageScope> {
    const operation = identityQueue.then(async () => {
        if (!extensionContext || !cwd) throw new ImageError('IMAGE_WORKSPACE_REQUIRED');
        const key = scopeHash(cwd, owner, 'pending');
        const records = { ...extensionContext.workspaceState.get<Record<string, string>>('llsccai.imageGeneration.scopes.v1', {}) };
        const historyKey = sessionId ? scopeHash(cwd, owner, sessionId) : key;
        let identity = records[historyKey];
        if (sessionId && !identity && records[key] && !pending.has(key)) pending.set(key, records[key]);
        if (!identity) {
            identity = sessionId ? pending.get(key) || scopeHash(cwd, owner, sessionId) : records[key] || scopeHash(cwd, owner, randomUUID());
            records[historyKey] = identity;
            if (!sessionId) { records[key] = identity; pending.set(key, identity); }
            else { delete records[key]; pending.delete(key); }
            await extensionContext.workspaceState.update('llsccai.imageGeneration.scopes.v1', records);
        }
        if (!sessionId) pending.set(key, identity);
        return { cwd, id: identity, title };
    });
    identityQueue = operation.catch(() => {}); return operation;
}
/** Reset only a pending identity/capability when explicitly starting or selecting another history. */
export async function resetImageIdentity(cwd: string, owner: string): Promise<void> {
    for (const [token, value] of capabilities) if (value.owner === owner) capabilities.delete(token);
    const operation = identityQueue.then(async () => {
        if (!extensionContext) return;
        const key = scopeHash(cwd, owner, 'pending'); pending.delete(key);
        const records = { ...extensionContext.workspaceState.get<Record<string, string>>('llsccai.imageGeneration.scopes.v1', {}) };
        delete records[key]; await extensionContext.workspaceState.update('llsccai.imageGeneration.scopes.v1', records);
    });
    identityQueue = operation.catch(() => {}); await operation;
}
/** Reuse the active capability during configuration comparisons; only actual process starts rotate it. */
export function currentImageCapability(owner: string, cwd: string): string {
    for (const [token, value] of capabilities) if (value.owner === owner) return token;
    return issueImageCapability(owner, cwd);
}
/** Issue a fresh main CLI capability; previous process generations cannot submit under a new history. */
export function issueImageCapability(owner: string, cwd: string): string {
    for (const [token, value] of capabilities) if (value.owner === owner) capabilities.delete(token);
    const token = randomUUID(); capabilities.set(token, { owner, cwd }); return token;
}
/** Bind a presentation for config broadcasts and task ownership; disposal revokes its UI only. */
export function attachImageView(owner: string, view: ImageViewBinding): vscode.Disposable {
    views.set(owner, view); const subscription = service?.attach(view);
    return { dispose: () => { if (views.get(owner) === view) views.delete(owner); subscription?.dispose(); } };
}
/** Resolve the bound main view for authenticated tools, never whichever view currently has focus. */
export function imageCapability(token: string): { binding: ImageViewBinding; cwd: string; current: () => boolean } | undefined {
    const value = capabilities.get(token); const binding = value && views.get(value.owner);
    if (!value || !binding) return undefined;
    return { binding, cwd: value.cwd, current: () => capabilities.get(token) === value && views.get(value.owner) === binding };
}
/** Dispatch only the image protocol to its already-bound view. */
export async function receiveImageMessage(owner: string, message: ImageWebviewRequest): Promise<void> {
    const view = views.get(owner); if (view && service) await service.receive(message, view);
}
/** Stop image work before conversation shutdown and release no other extension state. */
export async function shutdownImages(): Promise<void> {
    capabilities.clear(); views.clear(); const current = service; service = undefined;
    await current?.close(); extensionContext = undefined; pending.clear();
}
