/** @file VS Code MCP 工具常量與 schema。 */

/** VS Code MCP server 在 Claude CLI mcpServers 注册时使用的 server 名。 */
export const VSCODE_MCP_SERVER_NAME = 'llsccaiVscode' as const;

/** Claude CLI 暴露给主模型时看到的完整工具名前缀。 */
export const VSCODE_FULL_TOOL_PREFIX = `mcp__${VSCODE_MCP_SERVER_NAME}__` as const;

/** 工具裸名（未加 mcp__<server>__ 前缀）。 */
export type VscodeToolName = 'get_errors';

/** MCP tools/list 返回的单个工具 schema。 */
export interface VscodeToolSchema {
    /** 工具裸名。 */
    name: VscodeToolName;
    /** 工具描述。 */
    description: string;
    /** JSON Schema 输入描述。 */
    inputSchema: {
        /** schema 根类型。 */
        type: 'object';
        /** 输入字段定义。 */
        properties: Record<string, unknown>;
        /** 必填字段列表。 */
        required: string[];
    };
}

/** tools/list 返回的工具定义全集。 */
export const VSCODE_TOOL_SCHEMAS: readonly VscodeToolSchema[] = [
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

/** VS Code 工具名集合，用于校验 tools/call 入参。 */
const VSCODE_TOOL_NAMES = new Set<VscodeToolName>(VSCODE_TOOL_SCHEMAS.map((tool) => tool.name));

/** 判断输入是否为受支持的 VS Code 工具名。 */
export function isVscodeToolName(value: unknown): value is VscodeToolName {
    return typeof value === 'string' && VSCODE_TOOL_NAMES.has(value as VscodeToolName);
}
