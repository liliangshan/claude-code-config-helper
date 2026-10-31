/** @file Public Images tool schemas; arguments cannot override global credentials or task ownership. */
import type { McpToolSchema } from '../mcpKit/types';
import { createToolNameGuard } from '../mcpKit/types';

export const IMAGE_MCP_SERVER_NAME = 'llsccaiImage';
export type ImageToolName = 'openapi_generate_image' | 'openapi_edit_image' | 'openapi_get_image_task' | 'openapi_list_images' | 'openapi_search_images' | 'openapi_image_generation_info';
const prompt = { type: 'string', minLength: 1, maxLength: 10000 };
const size = { type: 'string', pattern: '^[1-9][0-9]*x[1-9][0-9]*$', description: 'Required widthxheight chosen for this request, e.g. 1024x1024 or 1536x1024. Choose a size supported by the provider; no global size is configured.' };
const paging = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
/** Closed schemas and read-only annotations are additional metadata supported by MCP clients. */
type ImageSchema = McpToolSchema<ImageToolName> & { annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }; inputSchema: { additionalProperties: false } };
/** Build a schema without importing the host into the stdio process. */
function tool(name: ImageToolName, description: string, properties: Record<string, unknown>, required: string[], readOnly: boolean): ImageSchema {
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly } };
}
export const IMAGE_TOOL_SCHEMAS: readonly ImageSchema[] = [
    tool('openapi_generate_image', 'Submit one billable image task using global connection settings and an explicit size chosen for this request. Tasks and images are saved under workspace .LLSOAI/openapi-image-generation. Returns taskId immediately. Completion is automatically sent to this conversation as a user message; no polling is required. Wait for that notification and continue other work or finish the turn. Do not poll the task or resubmit it merely to wait. Timeout does not prove the provider did not charge.', { prompt, size }, ['prompt', 'size'], false),
    tool('openapi_edit_image', 'Submit one billable JSON image-edit task (not multipart). image accepts public URL, Base64, Data URI, or 1–16 sources. Obtain permission before sending originals. Sources may be recorded in CLI history. Total tool request is limited to 4 MiB. Completion is automatically sent to this conversation as a user message; no polling is required. Wait for that notification and finish the turn or continue other work. Do not retry automatically.',
        { prompt, size, image: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1 } }] } }, ['prompt', 'image', 'size'], false),
    tool('openapi_get_image_task', 'Read an owned image task and saved relative paths for an explicit user request or diagnostics only. Completion is automatically notified; do not use this tool for routine polling. Does not submit or retry generation.', { taskId: { type: 'string' } }, ['taskId'], true),
    tool('openapi_list_images', 'List only this conversation’s tasks, including queued, failed and interrupted tasks.', paging, [], true),
    tool('openapi_search_images', 'Literal case-insensitive search of original prompts in this conversation. Does not call the provider.', { ...paging, query: { type: 'string', minLength: 1, maxLength: 1000 } }, ['query'], true),
    tool('openapi_image_generation_info', 'Read non-sensitive global model, enablement, defaults and limits. Never returns URLs or credentials.', {}, [], true)
];
export const isImageToolName = createToolNameGuard(IMAGE_TOOL_SCHEMAS);
