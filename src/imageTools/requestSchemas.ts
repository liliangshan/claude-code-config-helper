/** @file Replace stale CLI history snapshots only for existing extension-owned image generation/edit tools. */
import type { ImageFormatCapabilities } from './types';
import { IMAGE_MCP_SERVER_NAME, imageToolSchemas } from './tools';

/**
 * Refresh explicitly advertised built-in image schemas before any upstream protocol conversion.
 * @param body Parsed Anthropic request, including schemas replayed from an old CLI session.
 * @param capabilities Current host-validated format switches; undefined means configuration is unavailable.
 * @returns Original body when unchanged, otherwise a shallow copy preserving messages and tool metadata.
 */
export function refreshImageRequestSchemas(body: unknown, capabilities: ImageFormatCapabilities | boolean | undefined): unknown {
    if (capabilities === undefined || !body || typeof body !== 'object' || Array.isArray(body)) return body;
    const request = body as Record<string, unknown>;
    if (!Array.isArray(request.tools)) return body;
    const schemas = new Map(imageToolSchemas(capabilities)
        .filter(schema => schema.name === 'openapi_generate_image' || schema.name === 'openapi_edit_image')
        .map(schema => [`mcp__${IMAGE_MCP_SERVER_NAME}__${schema.name}`, schema]));
    let changed = false;
    const tools = request.tools.map(tool => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
        const schema = schemas.get(tool.name);
        if (!schema || (tool.type !== undefined && tool.type !== 'custom')) return tool;
        if (tool.description === schema.description && JSON.stringify(tool.input_schema) === JSON.stringify(schema.inputSchema)) return tool;
        changed = true;
        return { ...tool, description: schema.description, input_schema: schema.inputSchema };
    });
    return changed ? { ...request, tools } : body;
}
