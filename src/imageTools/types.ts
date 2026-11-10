/** @file Shared image configuration, task records and safe public protocol types. No host imports. */
export const IMAGE_BODY_LIMIT = 4 * 1024 * 1024;
export const IMAGE_TOTAL_LIMIT = 100 * 1024 * 1024;

/** Global persisted settings; credentials are referenced, never serialized here. */
export interface ImageGenerationConfig {
    version: 1; revision: number; enabled: boolean; supportsPng: boolean; supportsJpg: boolean; supportsGif: boolean; supportsSvg: boolean; source: 'provider' | 'custom';
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
/** Redacted upstream response prefix, capped at 500 Unicode characters; never a complete response archive. */
export interface ImageResponsePreview { status: number; body: string; truncated: boolean }
/** Selectable output formats; JPG maps to the upstream Images API's jpeg spelling. */
export type ImageOutputFormat = 'png' | 'jpg' | 'gif' | 'svg';
/** Shared capability flags; only PNG is enabled for a new configuration. */
export type ImageFormatCapabilities = Pick<ImageGenerationConfig, 'supportsPng' | 'supportsJpg' | 'supportsGif' | 'supportsSvg'>;
/** Optional format and GIF parameters; only GIF requests contain frame settings. */
export interface ImageAnimationOptions { output_format?: ImageOutputFormat; frame_count?: number; frame_duration_ms?: number }
/** Per-task durable record; source images and request credentials are deliberately absent. */
export interface ImageTask extends ImageAnimationOptions {
    version: 1; taskId: string; scopeId: string; operation: 'generate' | 'edit'; prompt: string;
    model: string; configRevision: number; size: string;
    status: 'queued' | 'running' | 'succeeded' | 'partially_failed' | 'failed' | 'interrupted';
    createdAt: number; startedAt?: number; finishedAt?: number; images: ImageFile[]; error?: string; responsePreview?: ImageResponsePreview;
}
/** Host-prepared transient submission; image contains complete Base64 Data URLs, never model-supplied inline data. */
export interface ImageSubmission extends ImageAnimationOptions { prompt: string; size: string; operation: 'generate' | 'edit'; image?: string | string[] }
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
/** Stable error code with an optional already-redacted, bounded upstream response excerpt. */
export class ImageError extends Error {
    /**
     * Construct an error without putting provider bodies or credentials into its message or stack.
     * @param code A stable public error code.
     * @param responsePreview Optional sanitized diagnostic created by the image response reader.
     */
    public constructor(public readonly code: string, public readonly responsePreview?: ImageResponsePreview) { super(code); this.name = 'ImageError'; }
}
/** Convert unexpected errors to a safe code rather than exposing URLs, keys or file contents. */
export function imageErrorCode(error: unknown): string {
    return error instanceof ImageError ? error.code : 'IMAGE_STORAGE_FAILED';
}
/** Fresh disabled defaults: PNG output, opt-in JPG/GIF/SVG, 100 tasks in flight and a 20-minute deadline. */
export function defaultImageConfig(): ImageGenerationConfig {
    return { version: 1, revision: 0, enabled: false, supportsPng: true, supportsJpg: false, supportsGif: false, supportsSvg: false, source: 'custom', providerId: '', modelId: '', baseUrl: '', authMode: 'bearer',
        allowLocalHttp: false, generationEndpointOverride: '', editEnabled: true,
        editEndpointOverride: '', editModelId: '', timeoutMs: 1_200_000, maxConcurrent: 100, maxQueue: 100,
        maxResponseBytes: 20 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024 };
}
