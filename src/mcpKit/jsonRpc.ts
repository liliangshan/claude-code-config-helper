/**
 * @file MCP stdio 传输层的 JSON-RPC 2.0 报文类型与错误码常量。
 *
 * 四套 stdio server 各自复制了同一份 JsonRpcRequest / JsonRpcResponse 定义与
 * 裸写的 -32700 / -32603 字面量，这里统一为一处。
 *
 * 约束：只允许 Node 内置模块与 `import type`，见 types.ts 文件头说明。
 */

/** JSON-RPC 2.0 请求结构。 */
export interface JsonRpcRequest {
    /** JSON-RPC 版本。 */
    jsonrpc: '2.0';
    /** 请求 id；通知类消息可缺省。 */
    id?: number | string | null;
    /** 方法名。 */
    method: string;
    /** 方法参数。 */
    params?: unknown;
}

/** JSON-RPC 2.0 错误对象。 */
export interface JsonRpcError {
    /** 错误码，取值见 JSON_RPC_ERROR。 */
    code: number;
    /** 错误说明。 */
    message: string;
    /** 附加数据。 */
    data?: unknown;
}

/** JSON-RPC 2.0 响应结构。 */
export interface JsonRpcResponse {
    /** JSON-RPC 版本。 */
    jsonrpc: '2.0';
    /** 对应请求的 id；解析失败时为 null。 */
    id: number | string | null;
    /** 成功结果。 */
    result?: unknown;
    /** 错误对象。 */
    error?: JsonRpcError;
}

/** JSON-RPC 2.0 标准错误码。 */
export const JSON_RPC_ERROR = {
    /** 报文不是合法 JSON。 */
    PARSE_ERROR: -32700,
    /** 请求对象结构非法。 */
    INVALID_REQUEST: -32600,
    /** 方法不存在。 */
    METHOD_NOT_FOUND: -32601,
    /** 方法参数非法。 */
    INVALID_PARAMS: -32602,
    /** 服务端内部错误。 */
    INTERNAL_ERROR: -32603
} as const;
