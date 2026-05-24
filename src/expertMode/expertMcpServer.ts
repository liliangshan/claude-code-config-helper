/**
 * @file 内置专家 MCP server（stdio + JSON-RPC 2.0）。
 *
 * 设计要点（详见 `EXPERT_MODE_DESIGN.md` §3 + §5 + §6）：
 *
 * 1. **协议**：完整实现 MCP 2024-11-05 协议的最小子集——
 *    `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`。
 * 2. **传输**：stdio + 换行分隔（line-delimited JSON），每条消息一行 UTF-8 JSON。
 *    详细规范见 https://modelcontextprotocol.io/specification/2024-11-05。
 * 3. **运行形态**：可被 Claude CLI 通过 `--mcp-config` 当 stdio 子进程 spawn，
 *    也可在单元测试中作为纯函数 `dispatch()` 直接调用。
 * 4. **Phase 3 范围**：完成 `tools/list` 返回 `ask_expert` schema；
 *    `tools/call` 当前返回固定占位结论，Phase 4 接入 `ExpertRunner` 后替换。
 *
 * 安全提醒：本文件**只**实现协议层，绝不直接执行任何 Claude CLI 命令；真正
 * 的子智能体启动逻辑必须经过 `ExpertRunner`，以便统一应用 §11 的所有护栏。
 */

import {
    EXPERT_MCP_SERVER_NAME,
    EXPERT_TOOL_NAME
} from './expertConstants';

/**
 * MCP 协议版本字符串。
 *
 * 与 Claude CLI 客户端协商时回传；选用 2024-11-05（首个稳定版），
 * 兼容性最好。后续如需升级到 2025-06-18，仅改此常量即可。
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * server 在 `initialize` 握手中回传给客户端的元信息。
 */
export const EXPERT_MCP_SERVER_INFO = {
    name: EXPERT_MCP_SERVER_NAME,
    version: '0.1.0'
} as const;

/**
 * server 在 `initialize` 中声明的能力集合。
 *
 * 当前只声明 `tools` 能力（不支持 resources / prompts / sampling），
 * 且 `listChanged=false`（工具列表静态不变）。
 */
export const EXPERT_MCP_SERVER_CAPABILITIES = {
    tools: { listChanged: false }
} as const;

/**
 * `tools/list` 返回的工具定义结构（MCP Tool 子集）。
 *
 * 字段命名严格遵循 MCP 规范：`inputSchema` 是 camelCase，`input_schema`
 * 是 Anthropic Messages API 风格——MCP 用前者。
 */
export interface McpToolDefinition {
    /** 工具唯一名称（在 server 命名空间内）。 */
    name: string;
    /** 给主模型看的简要描述；应当包含「何时该用」「不该用什么」。 */
    description: string;
    /** 入参 JSON Schema。 */
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}

/**
 * `ask_expert` 工具的完整定义。
 *
 * description 文案严格对齐 `EXPERT_MODE_DESIGN.md` §3.2：强调
 *   - 专家**不携带主对话历史**，question 必须自包含；
 *   - 适用场景（独立验证、深度多文件调查、风险评估）；
 *   - 不适用场景（琐碎问题）。
 *
 * 主模型 system prompt 中也会重复这些规则，形成「工具描述 + 系统提示」双重引导。
 */
export const ASK_EXPERT_TOOL_DEFINITION: McpToolDefinition = {
    name: EXPERT_TOOL_NAME,
    description:
        'Delegate a complex, uncertain, or cross-context investigation task to a visible expert agent ' +
        'running in a separate Claude CLI instance. The expert receives ONLY the self-contained question ' +
        '(no main conversation history), can use the same read-oriented tools as the main model, and ' +
        'returns a single final conclusion. Use for: independent verification, deep multi-file ' +
        'investigation, second opinion on risky changes, design/architecture review. ' +
        'Do NOT use for trivial questions or anything the main model can answer in one step.',
    inputSchema: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description:
                    'Self-contained task description. MUST include user requirement, file paths, ' +
                    'symbol names, error messages, attempted changes, and expected outcome — the ' +
                    'expert sees ONLY this field, not prior history.'
            },
            context: {
                type: 'string',
                description:
                    'Optional record-only context. NOT sent to the expert; shown in the UI for the user.'
            },
            goal: {
                type: 'string',
                description:
                    'What the expert should produce (e.g. analysis report, fix plan, risk list).'
            },
            constraints: {
                type: 'string',
                description: 'Constraints (e.g. read-only, no commands, no edits).'
            }
        },
        required: ['question'],
        additionalProperties: false
    }
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 类型
// ---------------------------------------------------------------------------

/**
 * JSON-RPC 请求消息（含 id，期望响应）。
 */
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    /** 请求 id；客户端用它匹配响应。可以是 number 或 string。 */
    id: number | string;
    /** 方法名，如 `tools/list`。 */
    method: string;
    /** 方法参数；不同 method 结构不同，由具体 handler 解析。 */
    params?: unknown;
}

/**
 * JSON-RPC 通知消息（无 id，无需响应）。
 */
export interface JsonRpcNotification {
    jsonrpc: '2.0';
    /** 通知方法名，如 `notifications/initialized`。 */
    method: string;
    /** 通知参数。 */
    params?: unknown;
}

/**
 * JSON-RPC 成功响应。
 */
export interface JsonRpcSuccessResponse {
    jsonrpc: '2.0';
    id: number | string;
    result: unknown;
}

/**
 * JSON-RPC 错误响应。
 */
export interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    error: {
        /** 标准错误码（见 JSON-RPC 2.0 规范第 5.1 节）。 */
        code: number;
        message: string;
        data?: unknown;
    };
}

/** server 给客户端的响应（成功或错误）。 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------
// 标准 JSON-RPC 错误码（节选自 https://www.jsonrpc.org/specification#error_object）
// ---------------------------------------------------------------------------

/** 入参无法解析为合法 JSON。 */
export const JSON_RPC_PARSE_ERROR = -32700;
/** 入参 JSON 合法但不是合法 Request 对象。 */
export const JSON_RPC_INVALID_REQUEST = -32600;
/** 方法未实现。 */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** 方法参数无效。 */
export const JSON_RPC_INVALID_PARAMS = -32602;
/** server 内部错误。 */
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// tools/call 的 handler 接口
// ---------------------------------------------------------------------------

/**
 * `ask_expert` 工具的入参类型（与 `ASK_EXPERT_TOOL_DEFINITION.inputSchema` 对齐）。
 */
export interface AskExpertArgs {
    /** 自包含问题（必填）。 */
    question: string;
    /** 仅供 UI 展示的上下文（专家不可见）。 */
    context?: string;
    /** 期望专家产出形态。 */
    goal?: string;
    /** 专家执行约束（如 read-only）。 */
    constraints?: string;
    /** 主聊天区 ask_expert 工具卡片 segment id，仅用于 UI 实时关联。 */
    toolSegmentId?: string;
}

/**
 * `tools/call` 的返回结构（MCP Tool Result）。
 */
export interface McpToolCallResult {
    /** 内容块数组，目前固定 `text` 类型一项。 */
    content: Array<{ type: 'text'; text: string }>;
    /** 工具执行错误（业务层错误，与协议层错误区分）；为 true 时主模型仍会看到内容但知道失败。 */
    isError?: boolean;
}

/**
 * `ask_expert` 工具的执行回调类型。
 *
 * Phase 3 留作 stub；Phase 4 由 `ExpertRunner` 提供具体实现，
 * 负责 spawn 专家 CLI、收集事件、返回 finalAnswer。
 *
 * @param args 已经过协议层校验的 ask_expert 参数。
 * @param signal 取消信号，由调用方在 webview 关闭 / 主 CLI 退出 / 用户取消时触发。
 * @returns 最终结论文本与是否出错的标记。
 */
export type AskExpertHandler = (
    args: AskExpertArgs,
    signal?: AbortSignal
) => Promise<{ finalAnswer: string; isError: boolean }>;

// ---------------------------------------------------------------------------
// ExpertMcpServer
// ---------------------------------------------------------------------------

/**
 * server 构造参数。
 */
export interface ExpertMcpServerOptions {
    /**
     * 真正执行 `ask_expert` 的回调。
     *
     * 不传时使用内置占位实现（返回一段标识 "Phase 3 stub" 的文本），用于
     * 在 Phase 4 之前能跑通 initialize → tools/list → tools/call 全链路。
     */
    askExpertHandler?: AskExpertHandler;
}

/**
 * 协议层的内置专家 MCP server。
 *
 * 该类**不**直接绑定 stdio——它只暴露纯函数 {@link dispatch}，输入是已解析的
 * JSON-RPC 消息对象，输出是响应对象（通知不返回响应）。把 stdio 绑定到
 * dispatch 的工作放在 {@link createStdioReadLoop}，方便单元测试。
 *
 * 整个 server 是无状态的（除了 `initialized` 标记），所以多次创建实例的开销
 * 几乎为零；正式部署时通常只创建一个实例。
 */
export class ExpertMcpServer {
    /** 是否已经收到客户端的 `initialize` 请求。 */
    private initialized = false;

    /** ask_expert 真正执行函数（Phase 4 注入）。 */
    private readonly askExpertHandler: AskExpertHandler;

    /**
     * @param opts 构造参数。
     */
    public constructor(opts: ExpertMcpServerOptions = {}) {
        this.askExpertHandler = opts.askExpertHandler ?? defaultStubAskExpertHandler;
    }

    /**
     * 处理一条已解析的 JSON-RPC 消息。
     *
     * 行为分支：
     * - 通知（无 id）：处理后返回 `null`（不写响应）；
     * - 请求（有 id）：处理后返回 JsonRpcResponse；
     * - 非法消息（无 method / 缺 jsonrpc）：返回 `INVALID_REQUEST` 错误响应。
     *
     * @param msg 客户端送来的已解析消息。
     * @param signal 透传给 ask_expert 的 AbortSignal（Phase 4 起生效）。
     * @returns 需要写回客户端的响应；通知时返回 null。
     */
    public async dispatch(
        msg: JsonRpcRequest | JsonRpcNotification | Record<string, unknown>,
        signal?: AbortSignal
    ): Promise<JsonRpcResponse | null> {
        // 基础结构校验
        if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
            return makeErrorResponse(null, JSON_RPC_INVALID_REQUEST, 'invalid JSON-RPC message');
        }
        const method = (msg as { method?: unknown }).method;
        if (typeof method !== 'string' || method.length === 0) {
            return makeErrorResponse(
                ((msg as { id?: number | string | null }).id ?? null),
                JSON_RPC_INVALID_REQUEST,
                'missing method'
            );
        }

        // 通知（无 id 字段）不返回响应
        const id = (msg as { id?: number | string }).id;
        const isNotification = id === undefined;

        try {
            if (isNotification) {
                await this.handleNotification(method, (msg as JsonRpcNotification).params);
                return null;
            }
            const result = await this.handleRequest(
                method,
                (msg as JsonRpcRequest).params,
                signal
            );
            return { jsonrpc: '2.0', id: id!, result };
        } catch (e) {
            // 抛出的若是 JsonRpcLikeError 则保留 code/message；否则视为内部错误
            const err = e as { jsonRpcCode?: number; message?: string };
            const code = typeof err.jsonRpcCode === 'number' ? err.jsonRpcCode : JSON_RPC_INTERNAL_ERROR;
            const message = typeof err.message === 'string' ? err.message : String(e);
            return makeErrorResponse(id ?? null, code, message);
        }
    }

    /**
     * 处理通知类消息（无返回值）。
     *
     * 当前只识别 `notifications/initialized`，其它通知按 MCP 规范允许静默丢弃。
     */
    private async handleNotification(method: string, _params: unknown): Promise<void> {
        if (method === 'notifications/initialized') {
            // 客户端已完成握手，可以开始接受其它方法
            this.initialized = true;
            return;
        }
        // 其它未知通知按规范允许忽略
    }

    /**
     * 处理请求类消息（必须返回 result 或抛 JsonRpcLikeError）。
     */
    private async handleRequest(
        method: string,
        params: unknown,
        signal: AbortSignal | undefined
    ): Promise<unknown> {
        switch (method) {
            case 'initialize':
                return this.handleInitialize(params);
            case 'ping':
                // MCP 规范允许返回空对象表示存活
                return {};
            case 'tools/list':
                this.requireInitialized();
                return { tools: [ASK_EXPERT_TOOL_DEFINITION] };
            case 'tools/call':
                this.requireInitialized();
                return this.handleToolsCall(params, signal);
            default:
                throw makeJsonRpcLikeError(JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
        }
    }

    /**
     * 处理 `initialize` 握手。
     *
     * 严格遵守 MCP 协议：客户端送来 `protocolVersion` / `capabilities` / `clientInfo`；
     * server 必须回 `protocolVersion` / `capabilities` / `serverInfo`。
     *
     * 我们不校验 protocolVersion 是否匹配（Claude CLI 目前接受 2024-11-05 即可），
     * 但忠实回传我们支持的版本号让客户端自行决定是否继续。
     */
    private handleInitialize(_params: unknown): unknown {
        // 注意：按规范，server 应当在收到 initialize 之后、收到 initialized 通知之前
        // 不响应除 ping 之外的请求。但为了兼容某些客户端会在 initialize 之后直接
        // tools/list 的写法，我们在 initialize 返回后就把 initialized 设为 true。
        this.initialized = true;
        return {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: EXPERT_MCP_SERVER_CAPABILITIES,
            serverInfo: EXPERT_MCP_SERVER_INFO
        };
    }

    /**
     * 处理 `tools/call`。
     *
     * 1. 校验 `params.name === 'ask_expert'`；
     * 2. 校验 `params.arguments.question` 是非空字符串；
     * 3. 调用注入的 {@link askExpertHandler}（Phase 3 是 stub，Phase 4 接入 ExpertRunner）；
     * 4. 把结论包成 `{ content: [{ type:"text", text }], isError }` 返回。
     */
    private async handleToolsCall(params: unknown, signal: AbortSignal | undefined): Promise<McpToolCallResult> {
        const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (p.name !== EXPERT_TOOL_NAME) {
            throw makeJsonRpcLikeError(
                JSON_RPC_METHOD_NOT_FOUND,
                `unknown tool: ${String(p.name)}`
            );
        }
        const args = (p.arguments ?? {}) as Partial<AskExpertArgs>;
        if (typeof args.question !== 'string' || args.question.trim().length === 0) {
            throw makeJsonRpcLikeError(
                JSON_RPC_INVALID_PARAMS,
                '`question` is required and must be a non-empty string'
            );
        }
        const result = await this.askExpertHandler(normalizeAskExpertArgs(args), signal);
        return {
            content: [{ type: 'text', text: result.finalAnswer }],
            isError: result.isError
        };
    }

    /**
     * 确保 `initialize` 已完成；否则抛出协议错误。
     *
     * MCP 规范允许 server 在 initialize 之前只接受 `initialize` 和 `ping`，
     * 其它方法应当返回错误。我们保持宽松：initialize 一旦响应就放行所有方法。
     */
    private requireInitialized(): void {
        if (!this.initialized) {
            throw makeJsonRpcLikeError(
                JSON_RPC_INVALID_REQUEST,
                'server has not been initialized; call `initialize` first'
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 归一化 tools/call 传入的 ask_expert 参数。
 *
 * 只保留实际出现且类型正确的可选字段，避免把 `undefined` 属性透传给 handler，
 * 这既保持旧单元测试的 deepStrictEqual 语义，也让 HTTP body 更干净。
 *
 * @param args 原始 MCP tool arguments。
 * @returns 可安全传给 {@link AskExpertHandler} 的参数对象。
 */
function normalizeAskExpertArgs(args: Partial<AskExpertArgs>): AskExpertArgs {
    const normalized: AskExpertArgs = { question: args.question as string };
    if (typeof args.context === 'string') normalized.context = args.context;
    if (typeof args.goal === 'string') normalized.goal = args.goal;
    if (typeof args.constraints === 'string') normalized.constraints = args.constraints;
    if (typeof args.toolSegmentId === 'string') normalized.toolSegmentId = args.toolSegmentId;
    return normalized;
}

/**
 * 构造一条 JSON-RPC 错误响应。
 *
 * @param id 原请求 id（无法解析时传 null）。
 * @param code JSON-RPC 错误码。
 * @param message 人类可读错误描述。
 * @param data 可选附加诊断数据。
 */
function makeErrorResponse(
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown
): JsonRpcErrorResponse {
    const err: JsonRpcErrorResponse['error'] = { code, message };
    if (data !== undefined) {
        err.data = data;
    }
    return { jsonrpc: '2.0', id, error: err };
}

/**
 * 构造一个携带 `jsonRpcCode` 字段的 Error，便于 dispatch 顶层捕获时直接复用 code。
 */
function makeJsonRpcLikeError(code: number, message: string): Error & { jsonRpcCode: number } {
    const e = new Error(message) as Error & { jsonRpcCode: number };
    e.jsonRpcCode = code;
    return e;
}

/**
 * 兜底用的占位 `ask_expert` 实现。
 *
 * 仅在以下场景生效：
 * - 未注入 `askExpertHandler` 且环境变量 `LLS_EXPERT_RELAY_URL`/`LLS_EXPERT_RELAY_TOKEN`
 *   缺失（典型表现为开发者直接 `node expertMcpServer.js` 而不经过扩展宿主装配）；
 * - 单元测试中故意不接 HTTP forwarder。
 *
 * 正常生产路径：扩展宿主会通过 {@link buildExpertMcpServerEntry} 注入
 * 上述两个环境变量，`main()` 会优先选择 {@link createHttpForwardingAskExpertHandler}
 * 取代该 stub。
 */
const defaultStubAskExpertHandler: AskExpertHandler = async (args) => {
    const lines = [
        '[Expert mode stub]',
        '',
        'No relay env (LLS_EXPERT_RELAY_URL / LLS_EXPERT_RELAY_TOKEN) detected;',
        'expertMcpServer is running in standalone mode and cannot spawn the expert CLI.',
        '',
        `question (truncated): ${args.question.slice(0, 200)}`
    ];
    return { finalAnswer: lines.join('\n'), isError: false };
};

// ---------------------------------------------------------------------------
// HTTP 转发 handler（方案 3 主链路）
// ---------------------------------------------------------------------------

/**
 * 创建一个把 `ask_expert` 调用反向 HTTP POST 给扩展宿主 Relay 的 handler。
 *
 * 方案 3 的关键拼接点：expertMcpServer 是扩展宿主的「孙进程」（被 Claude CLI
 * 拉起），无法直接访问 vscode API 或 webview；通过 HTTP 回环让扩展宿主
 * 真正去 spawn 第二个 Claude CLI 作为专家，并把流式事件直接推给 webview。
 *
 * 行为：
 * 1. 把 args + 可选 parentMessageId/callId 序列化为 JSON body；
 * 2. POST 到 `<relayBaseUrl>/__expert/run`，携带 `Authorization: Bearer <token>`；
 * 3. 解析响应 JSON `{ finalAnswer, isError, durationMs, endReason }`；
 * 4. 转换为 `{ finalAnswer, isError }` 返回给上层 dispatch。
 *
 * 错误兜底：网络错误、非 2xx 状态、JSON 解析失败都归一化为
 * `{ isError: true, finalAnswer: '[Expert mode failed: ...]' }`，确保 tools/call
 * 永远不会因为转发失败而崩溃。
 *
 * @param relayBaseUrl 扩展宿主 Relay 的 URL（如 `http://127.0.0.1:3210`）。
 * @param authToken    与扩展宿主侧 ExpertRunnerService 协商一致的鉴权 token。
 * @returns 可作为 {@link ExpertMcpServerOptions.askExpertHandler} 注入的回调。
 */
export function createHttpForwardingAskExpertHandler(
    relayBaseUrl: string,
    authToken: string
): AskExpertHandler {
    return async (args, signal) => {
        try {
            const url = new URL('/__expert/run', relayBaseUrl);
            const body = JSON.stringify(args);
            const result = await postJson(url, authToken, body, signal);
            return {
                finalAnswer: typeof result.finalAnswer === 'string' && result.finalAnswer.length > 0
                    ? result.finalAnswer
                    : '[Expert mode failed: empty finalAnswer from relay]',
                isError: result.isError === true
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                finalAnswer: `[Expert mode failed: relay_call_failed: ${message}]`,
                isError: true
            };
        }
    };
}

/**
 * 内部 HTTP POST 帮助函数：单次请求，content-type=application/json。
 *
 * 选择 Node 内建 `http` 而非 fetch：
 * - 避免对 Node 18+ 的 fetch 全局可用性做假设；
 * - 完全本机回环请求，无需 keepalive / CORS / proxy 等高级特性。
 *
 * @param url    完整目标 URL。
 * @param token  鉴权 token（拼到 `Authorization: Bearer <token>`）。
 * @param body   请求体 JSON 字符串。
 * @param signal 可选 AbortSignal；abort 时会 req.destroy() 中止连接。
 * @returns 响应体反序列化后的对象。
 * @throws 网络错误、非 2xx 状态码、非 JSON 响应都会抛出。
 */
async function postJson(
    url: URL,
    token: string,
    body: string,
    signal?: AbortSignal
): Promise<{ finalAnswer?: string; isError?: boolean; durationMs?: number; endReason?: string }> {
    // 动态 require，避免在被作为 ts-node 测试时引入循环。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http') as typeof import('http');
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port ? Number(url.port) : 80,
                path: url.pathname + (url.search || ''),
                method: 'POST',
                headers: {
                    'content-type': 'application/json; charset=utf-8',
                    'content-length': Buffer.byteLength(body, 'utf8'),
                    authorization: `Bearer ${token}`
                }
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                        reject(new Error(`relay returned ${res.statusCode}: ${text.slice(0, 200)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch (err) {
                        reject(
                            new Error(
                                `relay response not JSON: ${(err as Error).message}; body=${text.slice(0, 200)}`
                            )
                        );
                    }
                });
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        if (signal) {
            const onAbort = () => {
                try {
                    req.destroy(new Error('aborted by signal'));
                } catch {
                    // ignore
                }
            };
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// stdio 入口（Phase 3 提供，但暂未挂到任何 spawn 流程）
// ---------------------------------------------------------------------------

/**
 * 在 Node.js 子进程中把 stdin/stdout 绑定到一个 {@link ExpertMcpServer} 实例。
 *
 * 协议层 framing：每条消息一行 UTF-8 JSON，以 `\n` 结束。
 * 这是 Claude CLI 当前 MCP stdio 客户端使用的格式。
 *
 * 该函数返回一个用于停止循环的 dispose 回调。
 *
 * @param server 已构造好的 server 实例。
 * @param stdin 输入流（默认 process.stdin）。
 * @param stdout 输出流（默认 process.stdout）。
 * @param signal AbortSignal，可用于优雅终止 tools/call。
 * @returns 释放函数，调用后停止读取 stdin。
 */
export function createStdioReadLoop(
    server: ExpertMcpServer,
    stdin: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    signal?: AbortSignal
): () => void {
    let buffer = '';
    let disposed = false;

    /** 处理 stdin 的一段二进制 chunk：按行切分后逐行 dispatch。 */
    const onData = (chunk: Buffer | string): void => {
        if (disposed) return;
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx: number;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            void processLine(line);
        }
    };

    /** 解析单行 JSON 并写回响应（如果有）。 */
    const processLine = async (line: string): Promise<void> => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            const resp = makeErrorResponse(null, JSON_RPC_PARSE_ERROR, 'invalid JSON', String(e));
            stdout.write(JSON.stringify(resp) + '\n');
            return;
        }
        const resp = await server.dispatch(parsed as JsonRpcRequest | JsonRpcNotification, signal);
        if (resp) {
            stdout.write(JSON.stringify(resp) + '\n');
        }
    };

    stdin.on('data', onData);

    /** 关闭 loop：移除监听并清空 buffer。 */
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        stdin.off('data', onData);
        buffer = '';
    };

    if (signal) {
        signal.addEventListener('abort', dispose, { once: true });
    }

    return dispose;
}

// ---------------------------------------------------------------------------
// 子进程 stdio 入口
// ---------------------------------------------------------------------------

/**
 * 作为独立 Node 子进程运行 expertMcpServer。
 *
 * 该函数是 Claude CLI 通过 `--mcp-config '{"mcpServers":{"llsExpert":{"type":"stdio",
 * "command":"node","args":["<extPath>/out/expertMode/expertMcpServer.js"]}}}'` spawn
 * 本文件时的真正入口：
 *
 * 1. 根据环境变量 `LLS_EXPERT_RELAY_URL` / `LLS_EXPERT_RELAY_TOKEN` 选择
 *    `askExpertHandler`：
 *    - 两者齐全 → 使用 {@link createHttpForwardingAskExpertHandler}（方案 3 主链路）；
 *    - 任一缺失  → 退回 {@link defaultStubAskExpertHandler}（仅返回占位文本，
 *      用于开发者独立运行排查协议层）。
 * 2. 把 stdin / stdout 绑定到 dispatch loop；
 * 3. 监听 SIGTERM / SIGINT：父进程（Claude CLI）退出或被用户中断时优雅关闭；
 * 4. 监听 stdin `end` / `close`：上游断流即退出，避免出现僵尸子进程。
 *
 * 任何 stdout 输出都必须是 JSON-RPC 消息（line-delimited JSON），所以诊断日志
 * 一律写到 stderr，绝不写 stdout。
 */
export function main(): void {
    const ac = new AbortController();
    const relayUrl = process.env.LLS_EXPERT_RELAY_URL;
    const relayToken = process.env.LLS_EXPERT_RELAY_TOKEN;
    const askExpertHandler =
        relayUrl && relayToken
            ? createHttpForwardingAskExpertHandler(relayUrl, relayToken)
            : defaultStubAskExpertHandler;
    const server = new ExpertMcpServer({ askExpertHandler });
    const dispose = createStdioReadLoop(server, process.stdin, process.stdout, ac.signal);

    /** 收到终止信号时执行一次性清理：取消 dispatch + 移除 stdin 监听 + 退出进程。 */
    const shutdown = (reason: string): void => {
        try {
            ac.abort();
            dispose();
        } catch {
            // 清理阶段任何异常都吞掉，确保能进入 exit
        }
        // 给 stdout 一个 tick 把最后一条响应刷出去
        setImmediate(() => {
            process.stderr.write(`[expertMcpServer] shutdown: ${reason}\n`);
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.stdin.on('end', () => shutdown('stdin end'));
    process.stdin.on('close', () => shutdown('stdin close'));

    // 启动后立即写一条诊断日志到 stderr，便于排查"Claude CLI 是否真的拉起了我们"。
    const mode = relayUrl && relayToken ? `http→${relayUrl}` : 'stub';
    process.stderr.write(
        `[expertMcpServer] ready (protocol=${MCP_PROTOCOL_VERSION}, tool=${EXPERT_MCP_SERVER_INFO.name}, mode=${mode})\n`
    );
}

// 仅当本文件被 node 直接执行（而非被 require 引入）时启动 stdio loop。
// 这样既能被 Claude CLI 当 stdio MCP server spawn，也能被单元测试 import。
if (require.main === module) {
    main();
}
