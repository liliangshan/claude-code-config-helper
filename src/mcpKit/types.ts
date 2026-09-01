/**
 * @file MCP 桥的公共类型与工具名守卫工厂。
 *
 * 四套 MCP 桥（browser / vscode / wakeup / askExpert）此前各自维护一份同构的
 * schema 接口与手写的 isXxxToolName，这里收敛为一份定义。
 *
 * 约束：本目录下的文件会被 MCP 子进程加载，禁止静态 import 宿主模块
 * （尤其是 `vscode`），只允许 Node 内置模块与 `import type`。
 */

/** MCP tools/list 返回的单个工具 schema。 */
export interface McpToolSchema<TName extends string = string> {
    /** 工具裸名（未加 mcp__<server>__ 前缀）。 */
    name: TName;
    /** 工具描述，直接展示给模型。 */
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

/** MCP tools/call 返回的单个内容块。 */
export type McpToolContent = { type: 'text'; text: string } | Record<string, unknown>;

/** 工具执行结果（MCP tools/call 的返回形态）。 */
export interface McpToolResult {
    /** 为 true 时表示工具层执行失败，模型侧仍能读到 content 里的说明。 */
    isError?: boolean;
    /** 返回给模型的内容块列表。 */
    content: McpToolContent[];
}

/**
 * 工具执行器：宿主侧真实实现与子进程侧 HTTP 转发共用此接口。
 *
 * TResult 保留为类型参数，是为了让各套桥沿用自己更窄的结果类型
 * （如 BrowserToolResult 的 image 内容块），不必在薄封装处做类型断言。
 */
export interface McpToolExecutor<TName extends string = string, TResult = McpToolResult> {
    /**
     * 执行指定工具。
     *
     * @param name 工具裸名。
     * @param args 工具入参。
     */
    execute(name: TName, args?: Record<string, unknown>): Promise<TResult>;
}

/**
 * 由 schema 列表生成工具名守卫，替代各套桥手写的 isXxxToolName。
 *
 * @param schemas 该套桥 tools/list 返回的工具全集。
 * @returns 判定入参是否为该套桥支持的工具名的类型守卫。
 */
export function createToolNameGuard<TName extends string>(
    schemas: readonly McpToolSchema<TName>[]
): (value: unknown) => value is TName {
    const names = new Set<string>(schemas.map((schema) => schema.name));
    return (value: unknown): value is TName => typeof value === 'string' && names.has(value);
}
