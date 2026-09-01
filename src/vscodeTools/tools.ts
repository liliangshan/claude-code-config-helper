/** @file VS Code MCP 工具常量與 schema。 */

import { createToolNameGuard, type McpToolSchema } from '../mcpKit/types';

/** VS Code MCP server 在 Claude CLI mcpServers 注册时使用的 server 名。 */
export const VSCODE_MCP_SERVER_NAME = 'llsccaiVscode' as const;

/** Claude CLI 暴露给主模型时看到的完整工具名前缀。 */
export const VSCODE_FULL_TOOL_PREFIX = `mcp__${VSCODE_MCP_SERVER_NAME}__` as const;

/** 工具裸名（未加 mcp__<server>__ 前缀）。 */
export type VscodeToolName = 'get_errors';

/** tools/list 返回的工具定义全集。 */
export const VSCODE_TOOL_SCHEMAS: readonly McpToolSchema<VscodeToolName>[] = [
    {
        name: 'get_errors',
        description: 'Read current VS Code diagnostics errors and warnings for the workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                filePaths: {
                    type: 'array',
                    description: 'Optional file paths to filter diagnostics by absolute path or workspace-relative path.',
                    items: { type: 'string' }
                }
            },
            required: []
        }
    }
] as const;

/** 判断输入是否为受支持的 VS Code 工具名。 */
export const isVscodeToolName = createToolNameGuard(VSCODE_TOOL_SCHEMAS);
