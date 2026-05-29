/**
 * @file `/v1/messages` 路由分发器。
 *
 * 第二阶段只承载 Claude Code 必需的 `POST /v1/messages`；其他路径一律返回 404。
 * 路由会从请求体的 `model` 字段解析出 `<providerId>/<modelId>`，缺省则回退到
 * {@link ConfigManager.getCurrentModel}，然后根据 provider 的 `apiType`
 * 委派给对应的 {@link UpstreamAdapter}。
 *
 * 为任务 18 预留可扩展的 adapter 接口，本阶段只注册 anthropic 适配器。
 *
 * Vendored from liliangshan.openapi-compatible-copilot@3.0.3, last-sync 2026-05-20。
 */

import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ChatRoute } from '../chat/protocol';
import type { ConfigManager } from '../configManager';
import { readCompactionConfigFromVscode } from '../expertMode/expertConfig';
import { Logger } from '../logger';
import type { AutoContinueScheduler } from '../llsTask/autoContinue';
import { isLlsCcaiTaskTriggered } from '../llsTask/detector';
import type { LlsTaskService } from '../llsTask/service';
import { isClaudeCompactCommandRequest } from './summCommand';
import type {
    ApiType,
    CurrentModelSelection,
    ProviderConfig
} from '../types';
import type { RelayRequestHandler } from './server';
import type { UpstreamTimeoutKind } from './upstreamTimeouts';

/** Claude Code 当前转发的目标路径。 */
const RELAY_PATH = '/v1/messages';

/** 转发请求体读取上限，避免恶意大包占用内存（10 MiB）。 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 上游适配器拿到的上下文。
 *
 * 适配器拿到原始请求 / 响应、解析后的 provider 与 modelId、读到的请求体，
 * 自行负责对上游发起请求并把响应写回到 res。
 */
export interface UpstreamRequestContext {
    /** 原始 HTTP 请求。 */
    req: http.IncomingMessage;
    /** 原始 HTTP 响应。 */
    res: http.ServerResponse;
    /** 解析后的提供商完整配置（含密钥）。 */
    provider: ProviderConfig;
    /** 解析后的目标 modelId（已剥离 providerId 前缀）。 */
    modelId: string;
    /** 已经完整读取的请求体（utf-8 解码后的字符串）。 */
    rawBody: string;
    /** 请求体解析得到的 JSON，解析失败为 null。 */
    parsedBody: unknown | null;
    /** 本轮请求是否触发了创建 LLS CCAI 任务流。 */
    llsTaskCreateTriggered?: boolean;
    /** 上游卡住时通知扩展宿主自愈。 */
    onUpstreamTimeout?: (kind: UpstreamTimeoutKind) => void;
}

/**
 * 上游适配器接口。
 *
 * 任务 18 中会基于该接口扩展 openai-compatible / v1-response 等适配器。
 */
export interface UpstreamAdapter {
    /** 该适配器对应的 apiType。 */
    readonly apiType: ApiType;
    /**
     * 处理一次上游转发。
     *
     * 适配器必须自己负责写完整响应（包括状态码、headers、body 与流式 chunk）。
     */
    handle(ctx: UpstreamRequestContext): Promise<void>;
}

export interface RelayUpstreamRequestInfo {
    /** 发起本次 HTTP 请求的本地 CLI 路由。 */
    route: ChatRoute;
    providerId: string;
    modelId: string;
}

/** 本地 Claude CLI 进入 Relay 时允许携带的路径路由。 */
export type LocalCliHttpRoute = ChatRoute;

/** 本地 CLI HTTP path 解析结果。 */
export interface ParsedLocalCliPath {
    /** 从 path 前缀解析出的 CLI 路由。 */
    route: LocalCliHttpRoute;
    /** 剥离路由前缀后的上游兼容路径。 */
    upstreamPath: string;
}

/** 从本地 CLI HTTP path 中解析 route 前缀。 */
export function parseLocalCliPath(path: string): ParsedLocalCliPath | undefined {
    if (path === RELAY_PATH) {
        return { route: 'normal', upstreamPath: path };
    }
    const match = path.match(/^\/(normal|expert|plan|review)(\/.*)$/);
    if (!match) return undefined;
    return {
        route: match[1] as LocalCliHttpRoute,
        upstreamPath: match[2]
    };
}

/** 创建路由器所需的依赖。 */
export interface RelayRouterDeps {
    /** 配置管理器，提供 provider/currentModel 读取能力。 */
    configManager: ConfigManager;
    /** 上游适配器列表，按 apiType 选择匹配。 */
    adapters: UpstreamAdapter[];
    /** 上游超时通知回调，用于宿主层触发自动续发。 */
    onUpstreamTimeout?: (kind: UpstreamTimeoutKind) => void;
    /** 上游请求生命周期回调，用于宿主按 normal/expert 路由维护执行中状态。 */
    onUpstreamRequestStart?: (info: RelayUpstreamRequestInfo) => void;
    onUpstreamRequestEnd?: (info: RelayUpstreamRequestInfo) => void;
    /** 可选任务流服务，用于处理 @llsccai-task 触发。 */
    llsTaskService?: LlsTaskService;
    /**
     * 可选自动续推调度器；保留字段以便外部装配。
     *
     * Router 自身不再在收到请求时无条件 cancel——这样会被 Claude Code CLI 的
     * 标题生成等侧轨请求误触发，导致主对话刚登记的"缺失工具调用"续推被清掉。
     * 真正的 cancel 时机已下沉到 {@link injectLlsTaskRequestBody}。
     */
    autoContinueScheduler?: AutoContinueScheduler;
}

/**
 * 解析请求体 model 字段为 `<providerId>/<modelId>`。
 *
 * 当 model 缺省、为空或非字符串时返回 null，调用方需要回退到当前模型选择。
 *
 * @param body 已解析的请求体 JSON。
 * @returns 解析出的 providerId/modelId，或 null。
 */
export function parseModelField(body: unknown): { providerId: string; modelId: string } | null {
    if (!body || typeof body !== 'object') return null;
    const value = (body as { model?: unknown }).model;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1) {
        // 没有 providerId 前缀，让上层走 currentModel 回退。
        return null;
    }
    return {
        providerId: trimmed.slice(0, slash),
        modelId: trimmed.slice(slash + 1)
    };
}

/**
 * 读取完整请求体（带大小上限）。
 *
 * @param req 原始 HTTP 请求。
 * @returns utf-8 解码后的请求体字符串。
 * @throws 当请求体超过 {@link MAX_BODY_BYTES} 时抛出。
 */
export function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            total += buf.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error(`请求体过大，超过 ${MAX_BODY_BYTES} 字节限制`));
                req.destroy();
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => {
            try {
                resolve(Buffer.concat(chunks).toString('utf-8'));
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
        req.on('error', (err) => reject(err));
    });
}

/**
 * 写入一个 JSON 错误响应（仅在尚未发送响应头时使用）。
 *
 * @param res HTTP 响应对象。
 * @param status HTTP 状态码。
 * @param type Anthropic 风格错误类型字符串。
 * @param message 错误描述。
 */
function writeJsonError(
    res: http.ServerResponse,
    status: number,
    type: string,
    message: string
): void {
    if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
    }
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function writeSseEvent(res: http.ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeLocalCompactStream(res: http.ServerResponse, modelId: string, text: string): void {
    const messageId = `msg_compact_local_${Date.now()}`;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    writeSseEvent(res, 'message_start', {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: modelId,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    });
    writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
    });
    writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text }
    });
    writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeSseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: Math.ceil(text.length / 4) }
    });
    writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
}

function buildTaskFlowCompactSummary(service: LlsTaskService | undefined): string {
    if (!service?.consumePreContinueCompactionPending()) return '';
    return '<summary>Task-flow pre-continue compaction completed. Continue with the next user message.</summary>';
}

interface CompactRequestSnapshotInput {
    req: http.IncomingMessage;
    route: ChatRoute;
    providerId: string;
    modelId: string;
    apiType: ApiType;
    rawBody: string;
    parsedBody: unknown | null;
}

async function saveCompactRequestSnapshot(input: CompactRequestSnapshotInput): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const workspacePath = workspaceFolder?.fsPath ?? process.cwd();
        const dir = path.join(workspacePath, '.LLSOAI');
        await fs.mkdir(dir, { recursive: true });
        const timestamp = new Date().toISOString();
        const safeStamp = timestamp.replace(/[:.]/g, '-');
        const filename = `compact-request-${safeStamp}-${Math.random().toString(36).slice(2, 8)}.json`;
        const parsed = input.parsedBody && typeof input.parsedBody === 'object'
            ? input.parsedBody as { stream?: unknown; model?: unknown; messages?: unknown }
            : undefined;
        const payload = {
            timestamp,
            method: input.req.method ?? '',
            url: input.req.url ?? '',
            route: input.route,
            path: (input.req.url ?? '').split('?', 1)[0],
            providerId: input.providerId,
            modelId: input.modelId,
            apiType: input.apiType,
            stream: typeof parsed?.stream === 'boolean' ? parsed.stream : undefined,
            requestModel: typeof parsed?.model === 'string' ? parsed.model : undefined,
            headers: sanitizeHeaders(input.req.headers),
            rawBody: input.rawBody,
            parsedBody: input.parsedBody
        };
        const filePath = path.join(dir, filename);
        await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        Logger.info(`[compact] 已保存压缩请求快照：${filePath}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.warn(`[compact] 保存压缩请求快照失败：${message}`);
    }
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
    const safe: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
        const normalized = key.toLowerCase();
        if (/authorization|api[-_]?key|token|secret|cookie/.test(normalized)) continue;
        if (typeof value === 'string' || Array.isArray(value)) safe[key] = value;
    }
    return safe;
}

/**
 * 创建 Relay 路由处理函数。
 *
 * 该函数仅承担"路径校验 + 模型解析 + 适配器分发"的工作，
 * 真正的上游 HTTP 请求由具体的 {@link UpstreamAdapter} 负责发起。
 *
 * @param deps 路由器所需依赖。
 * @returns 与 {@link RelayRequestHandler} 兼容的请求处理函数。
 */
export function createRelayRouter(deps: RelayRouterDeps): RelayRequestHandler {
    const { configManager, adapters, llsTaskService, onUpstreamTimeout, onUpstreamRequestStart, onUpstreamRequestEnd } = deps;
    const adapterMap = new Map<ApiType, UpstreamAdapter>();
    for (const adapter of adapters) {
        adapterMap.set(adapter.apiType, adapter);
    }

    return async (req, res) => {
        // 注意：此处刻意不再无条件 cancel 自动续推。
        // Claude Code CLI 会与主对话毫秒级并发发送"会话标题生成"等侧轨请求，
        // 早期在 relay 入口就 cancel 会把上一轮主对话刚登记的"缺失工具调用"续推
        // 定时器误清掉。真正需要 cancel 的时机已下沉到 injectLlsTaskRequestBody
        // 中——只有在确认是要注入任务流上下文的非侧轨请求时才取消。
        const method = (req.method ?? 'GET').toUpperCase();
        const url = req.url ?? '';
        const path = url.split('?', 1)[0];
        const parsedPath = parseLocalCliPath(path);

        // 仅匹配 POST /v1/messages，允许 local CLI 在 base path 中携带 route 前缀。
        if (!parsedPath || parsedPath.upstreamPath !== RELAY_PATH || method !== 'POST') {
            writeJsonError(res, 404, 'not_found', `路径不在第二阶段支持范围内：${method} ${path}`);
            return;
        }
        const route = parsedPath.route;

        let rawBody = '';
        try {
            rawBody = await readRequestBody(req);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeJsonError(res, 413, 'request_too_large', message);
            return;
        }

        let parsedBody: unknown | null = null;
        try {
            parsedBody = rawBody ? JSON.parse(rawBody) : null;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeJsonError(res, 400, 'invalid_request_error', `请求体不是合法 JSON：${message}`);
            return;
        }

        const messages = parsedBody && typeof parsedBody === 'object'
            ? (parsedBody as { messages?: unknown }).messages
            : undefined;
        const llsTaskCreateTriggered = !!llsTaskService
            && !llsTaskService.hasActiveWorkflow()
            && isLlsCcaiTaskTriggered(messages);
        if (llsTaskCreateTriggered) {
            // planningDocumentPath / originalUserPrompt 由模型在调用 create
            // 工具时随参数回传（见 buildCreateLlsCcaiTaskWorkflowTool 的 schema），
            // 这里只负责打开「等待创建」标志位，让中间多轮 read 请求继续注入
            // create 工具与系统规则。
            llsTaskService.markWorkflowCreationPending();
        }

        const compactCommandTriggered = isClaudeCompactCommandRequest(parsedBody);

        // 解析目标模型：优先取请求体中的 model 字段，否则回退到当前模型选择。
        // Claude CLI 原生 /compact 走普通模型配置，避免专家/方案/审查路由抢走压缩。
        const explicit = compactCommandTriggered ? null : parseModelField(parsedBody);
        const compactionConfig = compactCommandTriggered ? readCompactionConfigFromVscode() : null;
        const compactionModel = compactionConfig?.enabled ? parseModelField({ model: compactionConfig.model }) : null;
        if (compactCommandTriggered && !compactionModel) {
            Logger.info(
                `[compact] 未使用压缩专用模型：enabled=${compactionConfig?.enabled ? 'true' : 'false'} `
                + `model=${compactionConfig?.model || '(empty)'}，回退普通模型`
            );
        }
        const fallback: CurrentModelSelection | null = explicit || compactionModel ? null : configManager.getCurrentModel();
        const providerId = explicit?.providerId ?? compactionModel?.providerId ?? fallback?.providerId;
        const modelId = explicit?.modelId ?? compactionModel?.modelId ?? fallback?.modelId;
        if (!providerId || !modelId) {
            writeJsonError(
                res,
                400,
                'invalid_request_error',
                '未指定 model 字段且当前模型为空，无法路由请求'
            );
            return;
        }

        if (compactCommandTriggered && compactionModel) {
            Logger.info(`[compact] 使用压缩专用模型：${providerId}/${modelId}`);
        }

        const provider = await configManager.getProviderWithSecret(providerId);
        if (!provider) {
            writeJsonError(res, 404, 'provider_not_found', `提供商不存在：${providerId}`);
            return;
        }
        if (provider.enabled === false) {
            writeJsonError(res, 503, 'provider_disabled', `提供商已禁用：${providerId}`);
            return;
        }

        const adapter = adapterMap.get(provider.apiType);
        if (!adapter) {
            writeJsonError(
                res,
                501,
                'not_implemented',
                `第二阶段尚未支持 apiType=${provider.apiType} 的转发`
            );
            return;
        }

        if (compactCommandTriggered) {
            void saveCompactRequestSnapshot({
                req,
                route,
                providerId,
                modelId,
                apiType: provider.apiType,
                rawBody,
                parsedBody
            });
            const localTaskFlowSummary = buildTaskFlowCompactSummary(llsTaskService);
            if (localTaskFlowSummary) {
                Logger.info('[compact] 任务流本地压缩：直接返回任务流摘要 SSE，不请求上游模型');
                writeLocalCompactStream(res, modelId, localTaskFlowSummary);
                return;
            }
        }

        Logger.info(
            `Relay 转发：${providerId}/${modelId} -> ${provider.baseUrl}（apiType=${provider.apiType}）`
        );
        const requestInfo = { route, providerId, modelId };
        onUpstreamRequestStart?.(requestInfo);
        try {
            await adapter.handle({ req, res, provider, modelId, rawBody, parsedBody, llsTaskCreateTriggered, onUpstreamTimeout });
        } finally {
            onUpstreamRequestEnd?.(requestInfo);
        }
    };
}
