/** @file Shared image configuration, task records and safe public protocol types. No host imports. */
export const IMAGE_BODY_LIMIT = 4 * 1024 * 1024;
export const IMAGE_TOTAL_LIMIT = 100 * 1024 * 1024;

/** Global persisted settings; credentials are referenced, never serialized here. */
export interface ImageGenerationConfig {
    version: 1; revision: number; enabled: boolean; source: 'provider' | 'custom';
    providerId: string; modelId: string; baseUrl: string; authMode: 'bearer' | 'none'; secretRef?: string;
    allowLocalHttp: boolean; generationEndpointOverride: string;
    editEnabled: boolean; editEndpointOverride: string; editModelId: string;
    timeoutMs: number; maxConcurrent: number; maxQueue: number; maxResponseBytes: number; maxFileBytes: number;
}
/** Host-only immutable request snapshot, including resolved authentication. */
export interface ImageGenerationExecutionSnapshot {
    config: ImageGenerationConfig; generationUrl: string; editUrl: string;
    headers: Record<string, string>; providerName: string;
}
/** Explicit password operation; an empty input never silently deletes a credential. */
export interface ImageConfigInput {
    expectedRevision: number; config: Record<string, unknown>; keyAction: 'keep' | 'replace' | 'delete'; apiKey?: string;
}
/** Safe selectable provider summary, excluding headers and stored secrets. */
export interface ImageProviderOption {
    id: string; name: string; baseUrl: string; models: { modelId: string; displayName: string }[];
}
/** Public configuration state shared by all chat views. */
export interface ImageGenerationPublicState {
    config: Omit<ImageGenerationConfig, 'secretRef'>; hasApiKey: boolean;
    providers: ImageProviderOption[]; error?: string; generationUrl?: string; editUrl?: string;
}
/** Task ownership originates in the host, never in model arguments. */
export interface ImageScope { cwd: string; id: string; title: string }
/** Published file metadata contains no source URL or inline bytes. */
export interface ImageFile { id: string; relativePath: string; mimeType: string; bytes: number }
/** Per-task durable record; source images and request credentials are deliberately absent. */
export interface ImageTask {
    version: 1; taskId: string; scopeId: string; operation: 'generate' | 'edit'; prompt: string;
    model: string; configRevision: number; size: string;
    status: 'queued' | 'running' | 'succeeded' | 'partially_failed' | 'failed' | 'interrupted';
    createdAt: number; startedAt?: number; finishedAt?: number; images: ImageFile[]; error?: string;
}
/** Validated, transient submission data; image exists only until execution finishes. */
export interface ImageSubmission { prompt: string; size: string; operation: 'generate' | 'edit'; image?: string | string[] }
/** Configuration requests and task actions accepted from the shared chat UI. */
export type ImageWebviewRequest =
    | { type: 'imageGeneration/configGet'; requestId: string }
    | { type: 'imageGeneration/configCheck' | 'imageGeneration/configSave'; requestId: string; input: ImageConfigInput }
    | { type: 'imageGeneration/tasksList'; requestId: string }
    | { type: 'imageGeneration/imageOpen'; requestId: string; taskId: string; imageId: string; scopeId?: string };
/** Host-to-view messages never include credential references, headers, or source images. */
export type ImageWebviewMessage =
    | { type: 'imageGeneration/state'; state: ImageGenerationPublicState; requestId?: string }
    | { type: 'imageGeneration/saveResult'; requestId: string; ok: boolean; checked?: boolean; error?: string }
    | { type: 'imageGeneration/taskUpdate'; scopeId: string; tasks: ImageTask[]; requestId?: string };
/** Stable, non-sensitive error used across disk, network and Webview boundaries. */
export class ImageError extends Error {
    /** Construct an error code without upstream response bodies or credentials. */
    public constructor(public readonly code: string) { super(code); this.name = 'ImageError'; }
}
/** Convert unexpected errors to a safe code rather than exposing URLs, keys or file contents. */
export function imageErrorCode(error: unknown): string {
    return error instanceof ImageError ? error.code : 'IMAGE_STORAGE_FAILED';
}
/** Fresh disabled defaults; no commercial endpoint or model is preselected. */
export function defaultImageConfig(): ImageGenerationConfig {
    return { version: 1, revision: 0, enabled: false, source: 'custom', providerId: '', modelId: '', baseUrl: '', authMode: 'bearer',
        allowLocalHttp: false, generationEndpointOverride: '', editEnabled: true,
        editEndpointOverride: '', editModelId: '', timeoutMs: 180000, maxConcurrent: 1, maxQueue: 100,
        maxResponseBytes: 20 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024 };
}
