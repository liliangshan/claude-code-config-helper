/**
 * @file 专家子请求服务（按需专家方案的核心）。
 *
 * 当主 CLI 通过 MCP 工具 `ask_expert` 委托一个独立任务时，本服务负责：
 *
 * 1. 用「严格只含一条 user message」的方式调用 Relay 的 `/v1/messages` 端点；
 *    系统提示词、工具白名单与 §5.3 文案一致——专家不带任何对话历史。
 * 2. 内部跑一个 mini-agent loop：模型 tool_use → 本地执行 → tool_result → 续问。
 *    步数受 `maxSteps` 限制，单步与总耗时分别受 `stepTimeoutMs` /
 *    `totalTimeoutMs` 限制，并支持 `AbortSignal` 主动取消。
 * 3. 通过 {@link ExpertSubturnService.onEvent} 向上层 webview/MCP 工具流式
 *    报告 `started` / `tool_use` / `tool_result` / `text` / `done` / `failed`
 *    五类事件，便于前端展示专家面板。
 */

import * as http from 'http';
import * as vscode from 'vscode';

import { Logger } from '../logger';
import type { ExpertSubturnOptions } from './expertConfig';

/** Anthropic messages API 中的 content block 类型（仅覆盖我们用到的字段）。 */
export interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
}

/** Expert sub-turn 调用 Relay 后统一返回的消息结果。 */
export interface RelayMessagesResponse {
    content: AnthropicContentBlock[] | string;
    stop_reason?: string;
}

/** Anthropic messages API 的 message 结构。 */
interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

/** Anthropic 工具描述。 */
interface AnthropicToolSpec {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

/** 专家 sub-turn 事件类型联合。 */
export type ExpertSubturnEvent =
    | { type: 'started'; sessionId: string; question: string; model: string }
    | { type: 'tool_use'; sessionId: string; toolUseId: string; name: string; input: unknown }
    | { type: 'tool_result'; sessionId: string; toolUseId: string; content: string; isError?: boolean }
    | { type: 'text'; sessionId: string; text: string }
    | { type: 'done'; sessionId: string; finalText: string; steps: number }
    | { type: 'failed'; sessionId: string; reason: 'canceled' | 'timeout' | 'maxSteps' | 'error' | 'noModel'; message: string };

/** 专家 sub-turn 运行参数。 */
export interface ExpertSubturnRunArgs {
    /** 自包含的问题文本——不会附带任何主对话历史。 */
    question: string;
    /** 调用方提供的 sessionId，用于事件追踪与 webview ��联；缺省自动生成。 */
    sessionId?: string;
    /** 取消信号；触发后 sub-turn 立即停止并发出 failed(canceled)。 */
    signal?: AbortSignal;
}

/** 专家 sub-turn 运行结果。 */
export interface ExpertSubturnRunResult {
    /** 与 args.sessionId 一致；缺省自动生成。 */
    sessionId: string;
    /** 是否成功完成。 */
    ok: boolean;
    /** 成功时的最终回答文本；失败时是错误消息。 */
    text: string;
    /** 实际经历的 mini-agent 步数。 */
    steps: number;
    /** 失败原因；成功时为 undefined。 */
    failureReason?: ExpertFailureReason;
}

/** 专家 sub-turn 失败原因联合。 */
export type ExpertFailureReason = 'canceled' | 'timeout' | 'maxSteps' | 'error' | 'noModel';

/** ExpertSubturnService 依赖项。 */
export interface ExpertSubturnServiceDeps {
    /** 读取 Relay 监听端口；未启动时返回 undefined。 */
    getRelayPort: () => number | undefined;
    /** 读取当前 ask_expert 应该使用的模型 id；空串视为未配置。 */
    getExpertModel: () => string;
    /** 读取专家 sub-turn 运行选项。 */
    getOptions: () => ExpertSubturnOptions;
    /** 可选的鉴权 token（与 Relay 的 ANTHROPIC_AUTH_TOKEN 一致）；缺省不附带。 */
    getAuthToken?: () => string | undefined;
}

/**
 * 构造专家 sub-turn 用的初始 messages。
 *
 * 严格只放一条 user message；system prompt 单独通过 `system` 字段传给 Anthropic API。
 * 任何主对话历史都不会出现，参考 §5.3。
 */
export function buildExpertMessages(question: string): {
    system: string;
    messages: AnthropicMessage[];
} {
    const system = [
        'You are the expert model. Independently handle the delegated task',
        'from the question only. Previous conversation history and any',
        'project-wide context are intentionally NOT included.',
        '',
        'You may use the provided read-only tools (read_file, grep_search,',
        'get_errors) to gather evidence. Make intermediate reasoning visible.',
        'When you have enough information, return ONE concise final',
        'recommendation for the dispatcher to apply.',
        '',
        'Do not call ask_expert recursively. Do not request planning',
        'workflow tokens (@llsPlanTask etc.).'
    ].join('\n');

    const messages: AnthropicMessage[] = [
        { role: 'user', content: question }
    ];

    return { system, messages };
}

/** 专家 sub-agent 允许使用的只读工具白名单。 */
export const EXPERT_READONLY_TOOLS: AnthropicToolSpec[] = [
    {
        name: 'read_file',
        description: 'Read a file from the workspace and return its content.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
                offset: { type: 'number', description: 'Line offset (1-based, optional).' },
                limit: { type: 'number', description: 'Max lines to read (optional).' }
            },
            required: ['path']
        }
    },
    {
        name: 'grep_search',
        description: 'Search for a regex pattern across the workspace; returns matching lines.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regex pattern to search for.' },
                path: { type: 'string', description: 'Optional path or glob to limit the search.' }
            },
            required: ['pattern']
        }
    },
    {
        name: 'get_errors',
        description: 'Return current diagnostics (errors / warnings) for files in the workspace.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Optional file path to filter diagnostics.' }
            }
        }
    }
];

/** 监听器签名。 */
type ExpertSubturnEventListener = (event: ExpertSubturnEvent) => void;

/**
 * 专家子请求服务。
 *
 * 单例由扩展宿主在 activate 时创建并通过依赖注入持有 Relay 端口、专家模型 id 等
 * 运行时上下文。每次 `run()` 调用即一次完整的专家 sub-turn，互不共享上下文。
 */
export class ExpertSubturnService implements vscode.Disposable {
    /** 事件订阅集合。 */
    private readonly listeners = new Set<ExpertSubturnEventListener>();

    /** 自增 sessionId 计数器，便于无传入 sessionId 时生成唯一值。 */
    private sessionCounter = 0;

    /**
     * 创建 ExpertSubturnService 实例。
     *
     * @param deps 运行时依赖（端口、模型 id、配置读取等）。
     */
    public constructor(private readonly deps: ExpertSubturnServiceDeps) {}

    /**
     * 订阅专家事件流。
     *
     * @param listener 事件回调。
     * @returns 取消订阅函数。
     */
    public onEvent(listener: ExpertSubturnEventListener): vscode.Disposable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /**
     * 释放服务资源。
     */
    public dispose(): void {
        this.listeners.clear();
    }

    /**
     * ��行一次专家 sub-turn。
     *
     * 调用方拿到的 result.text 已经是最终回答（成功时）或失败原因（失败时）。
     * 事件流会在 result resolve 之前完成 emit。
     */
    public async run(args: ExpertSubturnRunArgs): Promise<ExpertSubturnRunResult> {
        const sessionId = args.sessionId ?? this.generateSessionId();
        const question = args.question.trim();
        const options = this.deps.getOptions();
        const model = this.deps.getExpertModel();

        if (!model) {
            const message = 'There is currently no available expert.';
            this.emit({ type: 'failed', sessionId, reason: 'noModel', message });
            return { sessionId, ok: false, text: message, steps: 0, failureReason: 'noModel' };
        }

        const port = this.deps.getRelayPort();
        if (!port) {
            const message = 'Relay server is not running; expert sub-turn cannot start.';
            this.emit({ type: 'failed', sessionId, reason: 'error', message });
            return { sessionId, ok: false, text: message, steps: 0, failureReason: 'error' };
        }

        this.emit({ type: 'started', sessionId, question, model });

        const { system, messages } = buildExpertMessages(question);
        const totalDeadline = Date.now() + options.totalTimeoutMs;
        let steps = 0;
        let finalText = '';

        try {
            while (steps < options.maxSteps) {
                if (args.signal?.aborted) {
                    return this.fail(sessionId, 'canceled', 'Expert sub-turn canceled by signal.', steps);
                }
                if (Date.now() > totalDeadline) {
                    return this.fail(sessionId, 'timeout', 'Expert sub-turn total timeout exceeded.', steps);
                }

                const remaining = totalDeadline - Date.now();
                const stepTimeout = Math.min(options.stepTimeoutMs, Math.max(1000, remaining));

                const response = await this.callRelayMessages({
                    port,
                    model,
                    system,
                    messages,
                    tools: EXPERT_READONLY_TOOLS,
                    timeoutMs: stepTimeout,
                    signal: args.signal,
                    authToken: this.deps.getAuthToken?.()
                });

                steps += 1;

                const assistantBlocks = normalizeContent(response.content);
                messages.push({ role: 'assistant', content: assistantBlocks });

                const textPieces: string[] = [];
                const toolUses: AnthropicContentBlock[] = [];
                for (const block of assistantBlocks) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        textPieces.push(block.text);
                    } else if (block.type === 'tool_use') {
                        toolUses.push(block);
                    }
                }

                if (textPieces.length > 0) {
                    const text = textPieces.join('\n');
                    this.emit({ type: 'text', sessionId, text });
                    finalText = text;
                }

                if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
                    this.emit({ type: 'done', sessionId, finalText, steps });
                    return { sessionId, ok: true, text: finalText, steps };
                }

                const toolResultBlocks: AnthropicContentBlock[] = [];
                for (const toolUse of toolUses) {
                    const toolUseId = toolUse.id ?? this.generateSessionId();
                    const name = toolUse.name ?? '';
                    this.emit({ type: 'tool_use', sessionId, toolUseId, name, input: toolUse.input });
                    const result = await this.executeReadonlyTool(name, toolUse.input);
                    this.emit({
                        type: 'tool_result',
                        sessionId,
                        toolUseId,
                        content: result.content,
                        isError: result.isError
                    });
                    toolResultBlocks.push({
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: result.content,
                        ...(result.isError ? { is_error: true } as Record<string, unknown> : {})
                    });
                }

                messages.push({ role: 'user', content: toolResultBlocks });
            }

            return this.fail(sessionId, 'maxSteps',
                `Expert sub-turn exceeded maxSteps=${options.maxSteps}.`, steps);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (args.signal?.aborted) {
                return this.fail(sessionId, 'canceled', message || 'canceled', steps);
            }
            return this.fail(sessionId, 'error', message, steps);
        }
    }

    /**
     * 发送一条事件给所有订阅者；监听器异常被吞掉。
     */
    private emit(event: ExpertSubturnEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                Logger.warn(`ExpertSubturnService listener threw: ${String(err)}`);
            }
        }
    }

    /**
     * 生成 sub-turn sessionId。
     */
    private generateSessionId(): string {
        this.sessionCounter += 1;
        return `expert-${Date.now()}-${this.sessionCounter}`;
    }

    /**
     * 统一封装失败路径。
     */
    private fail(
        sessionId: string,
        reason: ExpertFailureReason,
        message: string,
        steps: number
    ): ExpertSubturnRunResult {
        this.emit({ type: 'failed', sessionId, reason, message });
        return {
            sessionId,
            ok: false,
            text: message,
            steps,
            failureReason: reason
        };
    }

    /**
     * 调用本地 Relay 的 /v1/messages 端点（非流式 JSON 响应）。
     */
    private callRelayMessages(args: {
        port: number;
        model: string;
        system: string;
        messages: AnthropicMessage[];
        tools: AnthropicToolSpec[];
        timeoutMs: number;
        signal?: AbortSignal;
        authToken?: string;
    }): Promise<RelayMessagesResponse> {
        const body = JSON.stringify({
            model: args.model,
            system: args.system,
            messages: args.messages,
            tools: args.tools,
            max_tokens: 4096,
            stream: false
        });

        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    method: 'POST',
                    host: '127.0.0.1',
                    port: args.port,
                    path: '/expert/v1/messages',
                    headers: {
                        'content-type': 'application/json; charset=utf-8',
                        'content-length': Buffer.byteLength(body).toString(),
                        ...(args.authToken ? { authorization: `Bearer ${args.authToken}` } : {})
                    },
                    timeout: args.timeoutMs
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                    res.on('end', () => {
                        const raw = Buffer.concat(chunks).toString('utf-8');
                        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                            reject(new Error(`Relay returned HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
                            return;
                        }
                        try {
                            resolve(parseRelayMessagesResponse(raw, String(res.headers['content-type'] ?? '')));
                        } catch (err) {
                            reject(err);
                        }
                    });
                    res.on('error', reject);
                }
            );

            req.on('timeout', () => {
                req.destroy(new Error(`Expert sub-turn step timeout after ${args.timeoutMs}ms`));
            });
            req.on('error', reject);

            if (args.signal) {
                if (args.signal.aborted) {
                    req.destroy(new Error('canceled'));
                } else {
                    const onAbort = () => req.destroy(new Error('canceled'));
                    args.signal.addEventListener('abort', onAbort, { once: true });
                }
            }

            req.write(body);
            req.end();
        });
    }

    /**
     * 执行白名单内的只读工具。
     *
     * 第一版采用 VS Code 原生 API 实现 read_file / grep_search / get_errors，
     * 失败时统一返回 isError=true，让专家自行修正。
     */
    private async executeReadonlyTool(
        name: string,
        rawInput: unknown
    ): Promise<{ content: string; isError?: boolean }> {
        const input = (rawInput && typeof rawInput === 'object') ? rawInput as Record<string, unknown> : {};
        try {
            switch (name) {
                case 'read_file': {
                    const pathArg = typeof input.path === 'string' ? input.path : '';
                    if (!pathArg) {
                        return { content: 'read_file requires a non-empty "path".', isError: true };
                    }
                    const uri = resolveWorkspaceUri(pathArg);
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(bytes).toString('utf-8');
                    const offset = typeof input.offset === 'number' ? Math.max(1, Math.floor(input.offset)) : 1;
                    const limit = typeof input.limit === 'number' ? Math.max(1, Math.floor(input.limit)) : undefined;
                    const lines = text.split(/\r?\n/);
                    const sliced = limit ? lines.slice(offset - 1, offset - 1 + limit) : lines.slice(offset - 1);
                    return { content: sliced.join('\n') };
                }
                case 'grep_search': {
                    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
                    if (!pattern) {
                        return { content: 'grep_search requires a non-empty "pattern".', isError: true };
                    }
                    const include = typeof input.path === 'string' ? input.path : undefined;
                    const uris = await vscode.workspace.findFiles(
                        include ?? '**/*',
                        '**/node_modules/**',
                        200
                    );
                    const re = new RegExp(pattern);
                    const hits: string[] = [];
                    for (const uri of uris) {
                        if (hits.length >= 200) break;
                        try {
                            const data = await vscode.workspace.fs.readFile(uri);
                            const text = Buffer.from(data).toString('utf-8');
                            const lines = text.split(/\r?\n/);
                            for (let i = 0; i < lines.length; i += 1) {
                                if (re.test(lines[i])) {
                                    hits.push(`${uri.fsPath}:${i + 1}: ${lines[i]}`);
                                    if (hits.length >= 200) break;
                                }
                            }
                        } catch {
                            // skip unreadable files
                        }
                    }
                    return { content: hits.length ? hits.join('\n') : '(no matches)' };
                }
                case 'get_errors': {
                    const filterPath = typeof input.path === 'string' ? input.path : undefined;
                    const all = vscode.languages.getDiagnostics();
                    const lines: string[] = [];
                    for (const [uri, diags] of all) {
                        if (filterPath && !uri.fsPath.includes(filterPath)) continue;
                        for (const diag of diags) {
                            lines.push(
                                `${uri.fsPath}:${diag.range.start.line + 1}: ` +
                                    `[${severityLabel(diag.severity)}] ${diag.message}`
                            );
                        }
                    }
                    return { content: lines.length ? lines.join('\n') : '(no diagnostics)' };
                }
                default:
                    return { content: `Unknown tool "${name}". Allowed: read_file, grep_search, get_errors.`, isError: true };
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: `Tool "${name}" failed: ${message}`, isError: true };
        }
    }
}

export function parseRelayMessagesResponse(raw: string, contentType = ''): RelayMessagesResponse {
    const trimmed = raw.trimStart();
    if (contentType.toLowerCase().includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
        return parseRelaySseMessagesResponse(raw);
    }
    try {
        const parsed = JSON.parse(raw) as {
            content?: AnthropicContentBlock[] | string;
            stop_reason?: string;
        };
        return {
            content: parsed.content ?? [],
            stop_reason: parsed.stop_reason
        };
    } catch (err) {
        throw new Error(`Failed to parse Relay response JSON: ${String(err)}`);
    }
}

function parseRelaySseMessagesResponse(raw: string): RelayMessagesResponse {
    const blocks: AnthropicContentBlock[] = [];
    let currentEvent = '';
    let stopReason: string | undefined;

    for (const event of splitSseEvents(raw)) {
        const eventName = event.event || currentEvent;
        if (event.event) currentEvent = event.event;
        for (const data of event.data) {
            if (!data || data === '[DONE]') continue;
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(data) as Record<string, unknown>;
            } catch (err) {
                throw new Error(`Failed to parse Relay SSE data JSON: ${String(err)}`);
            }
            const type = typeof parsed.type === 'string' ? parsed.type : eventName;
            if (type === 'error') {
                const error = parsed.error && typeof parsed.error === 'object'
                    ? parsed.error as { message?: unknown; type?: unknown }
                    : undefined;
                const message = typeof error?.message === 'string'
                    ? error.message
                    : (typeof parsed.message === 'string' ? parsed.message : 'Relay SSE error event');
                throw new Error(message);
            }
            if (type === 'content_block_start') {
                const contentBlock = parsed.content_block && typeof parsed.content_block === 'object'
                    ? parsed.content_block as AnthropicContentBlock
                    : undefined;
                if (contentBlock) blocks.push({ ...contentBlock });
                continue;
            }
            if (type === 'content_block_delta') {
                const index = typeof parsed.index === 'number' ? parsed.index : Math.max(0, blocks.length - 1);
                const delta = parsed.delta && typeof parsed.delta === 'object'
                    ? parsed.delta as { type?: unknown; text?: unknown; partial_json?: unknown }
                    : undefined;
                const block = blocks[index] ?? { type: 'text', text: '' };
                blocks[index] = block;
                if (typeof delta?.text === 'string') {
                    block.type = block.type || 'text';
                    block.text = `${block.text ?? ''}${delta.text}`;
                } else if (typeof delta?.partial_json === 'string') {
                    block.input = `${typeof block.input === 'string' ? block.input : ''}${delta.partial_json}`;
                }
                continue;
            }
            if (type === 'message_delta') {
                const delta = parsed.delta && typeof parsed.delta === 'object'
                    ? parsed.delta as { stop_reason?: unknown }
                    : undefined;
                if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
            }
        }
    }

    return { content: blocks, stop_reason: stopReason };
}

function splitSseEvents(raw: string): Array<{ event?: string; data: string[] }> {
    return raw
        .replace(/\r\n/g, '\n')
        .split(/\n\n+/)
        .map((chunk) => {
            const event: { event?: string; data: string[] } = { data: [] };
            for (const line of chunk.split('\n')) {
                if (line.startsWith('event:')) {
                    event.event = line.slice('event:'.length).trim();
                } else if (line.startsWith('data:')) {
                    event.data.push(line.slice('data:'.length).trimStart());
                }
            }
            return event;
        })
        .filter((event) => event.event || event.data.length > 0);
}

/**
 * 把 Anthropic API 返回的 content 规范化为 block 数组。
 *
 * Anthropic /v1/messages 的响应里 content 永远是 block 数组；但兼容某些
 * OpenAI-compat 上游可能返回纯字符串的 corner case，这里做一次保护。
 */
function normalizeContent(content: AnthropicContentBlock[] | string | undefined): AnthropicContentBlock[] {
    if (Array.isArray(content)) {
        return content;
    }
    if (typeof content === 'string' && content.length > 0) {
        return [{ type: 'text', text: content }];
    }
    return [];
}

/**
 * 把工具参数中的路径解析为 vscode.Uri；绝对路径直接 file://，相对路径相对当前 workspace。
 */
function resolveWorkspaceUri(path: string): vscode.Uri {
    if (path.startsWith('/')) {
        return vscode.Uri.file(path);
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
        return vscode.Uri.file(path);
    }
    return vscode.Uri.joinPath(root, path);
}

/**
 * 将 vscode.DiagnosticSeverity 转换为可读字符串。
 */
function severityLabel(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return 'error';
        case vscode.DiagnosticSeverity.Warning:
            return 'warning';
        case vscode.DiagnosticSeverity.Information:
            return 'info';
        case vscode.DiagnosticSeverity.Hint:
            return 'hint';
        default:
            return 'unknown';
    }
}

