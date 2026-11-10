/** @file Public Images tool schemas; arguments cannot override global credentials or task ownership. */
import type { McpToolSchema } from '../mcpKit/types';
import { createToolNameGuard } from '../mcpKit/types';
import type { ImageFormatCapabilities } from './types';
import { defaultImageFormat, enabledImageFormats } from './formats';

export const IMAGE_MCP_SERVER_NAME = 'llsccaiImage';
export type ImageToolName = 'openapi_generate_image' | 'openapi_edit_image' | 'openapi_get_image_task' | 'openapi_list_images' | 'openapi_search_images' | 'openapi_image_generation_info';
const prompt = { type: 'string', minLength: 1, maxLength: 10000 };
const size = { type: 'string', pattern: '^[1-9][0-9]*x[1-9][0-9]*$', description: 'Required widthxheight chosen for this request, e.g. 1024x1024 or 1536x1024. Choose a size supported by the provider; no global size is configured.' };
const imagePath = { type: 'string', minLength: 1, description: 'Existing local file path on the extension-host machine. Prefer an absolute path; relative paths resolve against this conversation workspace. Paths outside the workspace and symlinks are accepted. A local file:// URI or ~/ path is also accepted. Do not submit HTTP URLs, Base64 or Data URIs.' };
const paging = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
/** Closed schemas and read-only annotations are additional metadata supported by MCP clients. */
type ImageSchema = McpToolSchema<ImageToolName> & { annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }; inputSchema: { additionalProperties: false } };
/** Build a schema without importing the host into the stdio process. */
function tool(name: ImageToolName, description: string, properties: Record<string, unknown>, required: string[], readOnly: boolean): ImageSchema {
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly } };
}
const BASE_IMAGE_TOOL_SCHEMAS: readonly ImageSchema[] = [
    tool('openapi_generate_image', 'Submit one billable image task using global connection settings and an explicit size chosen for this request. Tasks and images are saved under workspace .LLSOAI/openapi-image-generation. Returns taskId immediately. Completion is automatically sent to this conversation as a user message; no polling is required. Wait for that notification and continue other work or finish the turn. Do not poll the task or resubmit it merely to wait. Timeout does not prove the provider did not charge.', { prompt, size }, ['prompt', 'size'], false),
    tool('openapi_edit_image', 'Edit or transform existing local images in one billable JSON request (not multipart). Put only an existing local file path in image, or an array of 1–16 paths for multiple reference images. Example: image="/tmp/reference.png" or image=["assets/logo.png", "/tmp/reference.jpg"]. Absolute paths outside the workspace are supported without an extra path-authorization dialog. Relative paths use this conversation workspace; remote sessions read paths on the remote extension host. Do NOT read/encode the image yourself and do NOT submit Base64, Data URIs or HTTP URLs. The host checks and reads each file, encodes its bytes internally, then sends the originals to the configured image provider. A missing path returns IMAGE_SOURCE_NOT_FOUND before submission; correct the path instead of retrying the same input. File/total size limits still apply. Submit prompt and size describing the requested edit. Completion is automatically sent to this conversation as a user message; no polling is required. Do not repeat a submitted task to wait for completion.',
        { prompt, size, image: { description: 'Path-only source input. Single image: a path string. Multiple images: an array of local paths, not image bytes.', anyOf: [imagePath, { type: 'array', minItems: 1, maxItems: 16, items: imagePath }] } }, ['prompt', 'image', 'size'], false),
    tool('openapi_get_image_task', 'Read an owned image task and saved relative paths for an explicit user request or diagnostics only. Completion is automatically notified; do not use this tool for routine polling. Does not submit or retry generation.', { taskId: { type: 'string' } }, ['taskId'], true),
    tool('openapi_list_images', 'List only this conversation’s tasks, including queued, failed and interrupted tasks.', paging, [], true),
    tool('openapi_search_images', 'Literal case-insensitive search of original prompts in this conversation. Does not call the provider.', { ...paging, query: { type: 'string', minLength: 1, maxLength: 1000 } }, ['query'], true),
    tool('openapi_image_generation_info', 'Read non-sensitive global model, enablement, defaults and limits. Never returns URLs or credentials.', {}, [], true)
];

/**
 * Build only enabled output choices with static-first guidance; capability is never a request for animation.
 * @param capabilities Four current output flags, or the legacy GIF boolean during old bridge compatibility.
 * @returns Fresh schemas with enabled format enums and GIF fields only when permitted.
 */
export function imageToolSchemas(capabilities: ImageFormatCapabilities | boolean): readonly ImageSchema[] {
    const formats = enabledImageFormats(capabilities);
    const fallback = defaultImageFormat(capabilities);
    const gif = formats.includes('gif');
    const guidance = ` Enabled output formats: ${formats.join(', ')}. `
        + (fallback ? `Default to a single static ${fallback.toUpperCase()} image (output_format="${fallback}") when the user does not request another format. `
            : 'No static format is enabled. Ask the user to enable PNG/JPG/SVG for a static request; do not substitute GIF. ')
        + 'Enabling a format only declares provider capability; it does NOT select that format for every request. Never choose a disabled format. '
        + (gif ? 'Use output_format="gif" ONLY when the user explicitly asks for GIF or animation. Never use a two-frame GIF as a substitute for PNG, JPG, SVG, a static image or a no-animation request. For animated GIF output, choose dimensions divisible by 16; frame_count is 2–64 (default 9), frame_duration_ms is 20–2000 (default 200). ' : 'GIF and animation fields are disabled. ')
        + 'For png, jpg or svg omit frame_count and frame_duration_ms entirely. If a requested format is disabled, explain that instead of submitting a different paid request.'
        + (formats.includes('jpg') ? ' JPG is a static JPEG image, never an animation. ' : '')
        + (formats.includes('svg') ? ' SVG must be a self-contained static vector using basic SVG shapes/text/gradients, without scripts, event handlers, stylesheets, embedded HTML, DTDs or external resources. ' : '');
    return BASE_IMAGE_TOOL_SCHEMAS.map(schema => {
        if (schema.name !== 'openapi_generate_image' && schema.name !== 'openapi_edit_image') return schema;
        return { ...schema, description: schema.description + guidance,
            inputSchema: { ...schema.inputSchema, properties: { ...schema.inputSchema.properties,
                size: { ...size, description: size.description + (gif ? ' GIF dimensions only must be multiples of 16.' : '') },
                output_format: { type: 'string', enum: formats, ...(fallback ? { default: fallback } : {}), description: 'Choose only an enabled format matching the user request. PNG is the preferred static default when enabled. JPG means JPEG. GIF is animation-only by explicit user request, not because its switch is enabled.' },
                ...(gif ? {
                    frame_count: { type: 'integer', minimum: 2, maximum: 64, default: 9, description: 'GIF ONLY. Omit for PNG/JPG/SVG. 2–64 frames; requires explicit output_format="gif".' },
                    frame_duration_ms: { type: 'integer', minimum: 20, maximum: 2000, default: 200, description: 'GIF ONLY. Omit for PNG/JPG/SVG. 20–2000 milliseconds per frame; requires explicit output_format="gif".' }
                } : {})
            } } };
    });
}

/** Default descriptor uses explicit PNG output even before a configured bridge environment is available. */
export const IMAGE_TOOL_SCHEMAS: readonly ImageSchema[] = imageToolSchemas(false);
export const isImageToolName = createToolNameGuard(IMAGE_TOOL_SCHEMAS);
