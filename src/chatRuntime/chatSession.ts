/**
 * Chat 会话状态：内存消息列表、workspaceState 持久化、assistant 消息拼装、
 * 历史会话 JSONL 解析与标题读写，以及 token 计量挂钩。
 *
 * 拆分自 extension.ts。依赖方向：位于 routeState / runtime 之上，
 * 对上层（webview 消息分发）的调用通过 {@link configureChatSession} 注入。
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatMessage, ChatRoute, ChatSegment } from '../chat/protocol';
import { Logger } from '../logger';
import type { TokenBudgetService } from '../relay/tokenBudget/service';
import { getChatViewHost, getExtensionContext } from '../runtime';
import { currentChatCliSessionIdSync } from './cliLifecycle';
import { chatRouteState } from './routeState';

/** chatSession 对尚未拆出的上层模块的依赖，由 activate 在装配期注入。 */
export interface ChatSessionDeps {
    /** 取指定路由当前模型的展示名，用于 assistant 气泡标签。 */
    getModelLabelForRoute: (route: ChatRoute) => string | undefined;
}

/** 注入的上层依赖。 */
let deps: ChatSessionDeps | undefined;

/** 注入上层依赖；必须在任何其它导出函数之前调用。 */
export function configureChatSession(value: ChatSessionDeps): void {
    deps = value;
}

/** 读取已注入的依赖，未装配时抛错以暴露装配顺序问题。 */
function requireDeps(): ChatSessionDeps {
    if (!deps) throw new Error('chatSession 尚未装配');
    return deps;
}

/** workspaceState 中保存的 Chat 会话结构。 */
export interface PersistedChatSession {
    /** 数据结构版本号。 */
    version: 1;
    /** 最近一次保存时间戳。 */
    updatedAt: number;
    /** 已保存的 Chat 消息。 */
    messages: ChatMessage[];
}

/** Chat 会话 workspaceState 持久化键。 */
const CHAT_SESSION_STATE_KEY = 'claudeRouter.chat.session.v1';

/** Chat 会话隐私提示是否已经展示的 workspaceState 键。 */
const CHAT_SESSION_PRIVACY_NOTICE_KEY = 'claudeRouter.chat.sessionPrivacyNotice.v1';

/** 最多持久化的 Chat 消息数量，避免 workspaceState 过大。 */
const MAX_PERSISTED_CHAT_MESSAGES = 80;

/**
 * 内存中保留的 Chat 消息上限。
 *
 * 只对持久化做 80 条截断不够：内存里的消息数组若从不裁剪，长会话中
 * {@link appendAssistantSegments} 按 id 查找 segment 的 O(n) 扫描会逐渐变慢。
 * 这里取略大于持久化窗口的 160 条，兼顾"向上翻看"体验与内存有界。
 */
const MAX_IN_MEMORY_CHAT_MESSAGES = 160;

/**
 * Chat 会话的内存状态容器。
 *
 * 用容器而非可变 `let` 导出，既满足「禁止导出可变 let」的约束，
 * 又保留调用方 `chatSessionState.messages = []` 这样的整表替换语义。
 */
export const chatSessionState: {
    /** 内存消息列表，用于 Webview reload 恢复。 */
    messages: ChatMessage[];
    /** 当前正在接收流式输出的 assistant 消息 ID。 */
    activeAssistantMessageId?: string;
} = { messages: [] };

/** Chat 会话持久化防抖定时器。 */
let chatSessionPersistTimer: NodeJS.Timeout | undefined;

/** TokenBudgetService 实例，用于 CLI usage segment 回填 contextWindow。 */
let tokenBudgetServiceRef: TokenBudgetService | undefined;

/** 注入 TokenBudgetService 实例；传 undefined 表示已释放。 */
export function setTokenBudgetServiceRef(value: TokenBudgetService | undefined): void {
    tokenBudgetServiceRef = value;
}

/** 读取 TokenBudgetService 实例，未装配时返回 undefined。 */
export function getTokenBudgetServiceRef(): TokenBudgetService | undefined {
    return tokenBudgetServiceRef;
}

/**
 * 从 workspaceState 恢复上一轮 Chat 会话。
 *
 * 仅恢复当前工作区内保存的消息，pending 消息会被标记为已结束，避免重载后误显示仍在生成。
 */
export function restorePersistedChatSession(): void {
    const persisted = getExtensionContext()?.workspaceState.get<PersistedChatSession>(CHAT_SESSION_STATE_KEY);
    if (!persisted || persisted.version !== 1 || !Array.isArray(persisted.messages)) {
        chatSessionState.messages = [];
        return;
    }
    chatSessionState.messages = sanitizePersistedChatMessages(persisted.messages).map((message) => ({
        ...message,
        pending: false
    }));
    chatSessionState.activeAssistantMessageId = undefined;
    Logger.info(`已恢复 Chat 会话消息：${chatSessionState.messages.length} 条`);
}

/**
 * 规范化 workspaceState 中恢复出的 Chat 消息。
 *
 * @param messages 从持久化状态读取出的消息数组。
 * @returns 校验并裁剪后的消息数组。
 */
export function sanitizePersistedChatMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages
        .filter((message) => !!message && typeof message.id === 'string' && Array.isArray(message.segments))
        .slice(-MAX_PERSISTED_CHAT_MESSAGES)
        .map((message) => ({
            id: message.id,
            role: message.role,
            segments: message.segments,
            text: message.text,
            pending: !!message.pending,
            route: message.route === 'normal' || message.route === 'taskFlow' ? message.route : undefined,
            modelLabel: typeof message.modelLabel === 'string' && message.modelLabel.trim() ? message.modelLabel : undefined,
            createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now()
        }));
}

/**
 * 读取 Claude Code 原始 JSONL 会话文件并转换为 ChatMessage 数组。
 *
 * 只处理 user / assistant 类型的记录；忽略 isSidechain=true 记录和纯 tool_result 的 user 消息。
 */
export async function parseSessionJsonl(jsonlPath: string): Promise<ChatMessage[]> {
    let raw: string;
    try {
        raw = await fs.readFile(jsonlPath, 'utf8');
    } catch (e) {
        Logger.warn(`[parseSessionJsonl] 读取文件失败：path=${jsonlPath} err=${e instanceof Error ? e.message : String(e)}`);
        return [];
    }

    const lines = raw.split('\n');
    const messages: ChatMessage[] = [];
    let skippedSidechain = 0;
    let skippedType = 0;
    let skippedNoContent = 0;
    let skippedEmptyUser = 0;
    let skippedEmptyAssistant = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(trimmed); } catch { continue; }

        if (rec['isSidechain']) { skippedSidechain++; continue; }
        const recType = rec['type'] as string;
        if (recType !== 'user' && recType !== 'assistant') { skippedType++; continue; }

        const msg = rec['message'] as {
            role?: string;
            content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }>;
            model?: string;
        } | undefined;
        if (!msg || !Array.isArray(msg.content)) { skippedNoContent++; continue; }

        const ts = typeof rec['timestamp'] === 'string' ? new Date(rec['timestamp'] as string).getTime() : Date.now();
        const uuid = typeof rec['uuid'] === 'string' ? rec['uuid'] as string : `hist_${Date.now()}_${messages.length}`;

        if (recType === 'user') {
            const textItems = msg.content.filter(c => c.type === 'text' && c.text);
            if (textItems.length === 0) { skippedEmptyUser++; continue; }
            const text = textItems.map(c => c.text!).join('\n');
            messages.push({ id: uuid, role: 'user', segments: [{ kind: 'text', text }], text, createdAt: ts });
        } else {
            const segments: ChatSegment[] = [];
            for (const c of msg.content) {
                if (c.type === 'text' && c.text) {
                    segments.push({ kind: 'markdown', text: c.text });
                } else if (c.type === 'tool_use' && c.name) {
                    const inputStr = c.input ? JSON.stringify(c.input, null, 2) : '';
                    segments.push({
                        id: c.id,
                        kind: 'tool',
                        tool: { name: c.name, status: 'success', summary: c.name, detail: inputStr, input: c.input }
                    });
                }
            }
            if (segments.length === 0) { skippedEmptyAssistant++; continue; }
            messages.push({ id: uuid, role: 'assistant', segments, modelLabel: msg.model, createdAt: ts });
        }
    }

    Logger.info(`[parseSessionJsonl] path=${jsonlPath} totalLines=${lines.length} parsed=${messages.length} skip{sidechain=${skippedSidechain},type=${skippedType},noContent=${skippedNoContent},emptyUser=${skippedEmptyUser},emptyAssistant=${skippedEmptyAssistant}}`);
    return messages.slice(-MAX_IN_MEMORY_CHAT_MESSAGES);
}

/**
 * 推导 Claude Code 会话存储目录：`<configDir>/projects/<encodedCwd>`。
 *
 * 编码规则与 Claude Code 官方一致：把 cwd 中所有非 [a-zA-Z0-9] 字符替换为
 * `-`。该规则同时覆盖 POSIX 的 `/`、`.` 与 Windows 的 `:`、`\`，因此跨平台
 * 都能命中官方生成的目录名。注意不要做长度截断——官方不截断，截断会导致
 * 深路径（尤其 Windows 长路径）算出错误目录名。
 *
 * @param cwd 工作区目录绝对路径。
 * @returns 该工作区对应的 projects 子目录绝对路径。
 */
export function resolveClaudeProjectDir(cwd: string): string {
    const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
    const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(configDir, 'projects', encodedCwd);
}

/**
 * 从 JSONL 会话文件中提取会话标题。
 *
 * 优先级：customTitle > aiTitle > lastPrompt > summary。
 * 仅读取文件首尾各 64KB，避免大文件全量读入。
 *
 * @param jsonlPath JSONL 会话文件绝对路径。
 * @returns 会话标题；未找到时返回空字符串。
 */
export async function extractSessionTitle(jsonlPath: string): Promise<string> {
    const BUF_SIZE = 65536;
    try {
        const fh = await fs.open(jsonlPath, 'r');
        try {
            const st = await fh.stat();
            const buf = Buffer.allocUnsafe(BUF_SIZE);
            const r1 = await fh.read(buf, 0, BUF_SIZE, 0);
            if (r1.bytesRead === 0) return '';
            const head = buf.toString('utf8', 0, r1.bytesRead);
            let tail = head;
            const tailStart = Math.max(0, st.size - BUF_SIZE);
            if (tailStart > 0) {
                const r2 = await fh.read(buf, 0, BUF_SIZE, tailStart);
                tail = buf.toString('utf8', 0, r2.bytesRead);
            }
            const extract = (text: string, field: string): string | undefined => {
                const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
                return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim() : undefined;
            };
            return (
                extract(tail, 'customTitle') ?? extract(head, 'customTitle') ??
                extract(tail, 'aiTitle') ?? extract(head, 'aiTitle') ??
                extract(tail, 'lastPrompt') ?? extract(tail, 'summary') ??
                extract(head, 'summary') ?? ''
            );
        } finally { await fh.close(); }
    } catch {
        return '';
    }
}

/**
 * 提取指定 session 的标题并推送到 Chat Webview 顶部。
 *
 * 新会话尚未生成 aiTitle 时标题为空，Webview 端会回退到默认标题。
 *
 * @param cwd 工作区目录，用于推导 projectKey。
 * @param sessionId 目标会话 ID。
 */
export async function pushSessionTitleToWebview(cwd: string, sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
        const jsonlPath = path.join(resolveClaudeProjectDir(cwd), `${sessionId}.jsonl`);
        const title = await extractSessionTitle(jsonlPath);
        await getChatViewHost()?.postMessage({ type: 'session/title', title, sessionId });
    } catch (e) {
        Logger.warn('[session/title] 推送会话标题失败：' + (e instanceof Error ? e.message : String(e)));
    }
}

/**
 * 把用户内联编辑的会话标题写回 JSONL，并刷新 Webview 顶部标题。
 *
 * 标题以独立的 `{type:"custom-title", customTitle, sessionId}` 元记录持久化：
 * 文件中已存在该记录时原地替换，否则追加到文件末尾。`customTitle` 在
 * extractSessionTitle 中优先级最高，因此写回后会立即成为展示标题。传入空标题
 * 表示清除自定义标题：删除已有 custom-title 记录，回退到自动派生标题。
 *
 * @param cwd 工作区目录，用于推导 projectKey。
 * @param sessionId 目标会话 ID。
 * @param title 新标题；空字符串表示清除自定义标题。
 */
export async function writeSessionCustomTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    if (!sessionId) return;
    const jsonlPath = path.join(resolveClaudeProjectDir(cwd), `${sessionId}.jsonl`);
    let raw: string;
    try {
        raw = await fs.readFile(jsonlPath, 'utf8');
    } catch (e) {
        Logger.warn('[session/set-title] 读取会话文件失败：' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    const trimmedTitle = (title || '').trim();
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    // 过滤掉已有 custom-title 记录，稍后按需重新追加，确保最终只保留一条。
    const kept: string[] = [];
    for (const line of lines) {
        if (!line.trim()) { kept.push(line); continue; }
        let isCustomTitle = false;
        try { isCustomTitle = (JSON.parse(line) as { type?: string }).type === 'custom-title'; } catch { isCustomTitle = false; }
        if (!isCustomTitle) kept.push(line);
    }
    // 去掉尾部空行，避免重复追加后留下多余空白。
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    if (trimmedTitle) {
        kept.push(JSON.stringify({ type: 'custom-title', customTitle: trimmedTitle, sessionId }));
    }
    try {
        await fs.writeFile(jsonlPath, kept.join(eol) + eol, 'utf8');
    } catch (e) {
        Logger.warn('[session/set-title] 写回会话文件失败：' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    await pushSessionTitleToWebview(cwd, sessionId);
}

/**
 * 计划保存 Chat 会话到 workspaceState。
 *
 * 使用短防抖减少流式输出期间的频繁写入；真正写入由 {@link flushPersistedChatSession} 完成。
 */
export function schedulePersistChatSession(): void {
    if (!getExtensionContext()) return;
    if (chatSessionPersistTimer) clearTimeout(chatSessionPersistTimer);
    chatSessionPersistTimer = setTimeout(() => {
        void flushPersistedChatSession();
    }, 250);
}

/**
 * 立即把当前 Chat 会话写入 workspaceState。
 */
export async function flushPersistedChatSession(): Promise<void> {
    if (chatSessionPersistTimer) clearTimeout(chatSessionPersistTimer);
    chatSessionPersistTimer = undefined;
    const context = getExtensionContext();
    if (!context) return;
    const payload: PersistedChatSession = {
        version: 1,
        updatedAt: Date.now(),
        messages: chatSessionState.messages.slice(-MAX_PERSISTED_CHAT_MESSAGES)
    };
    await context.workspaceState.update(CHAT_SESSION_STATE_KEY, payload);
}

/**
 * 清空 workspaceState 中保存的 Chat 会话。
 */
export async function clearPersistedChatSession(): Promise<void> {
    if (chatSessionPersistTimer) clearTimeout(chatSessionPersistTimer);
    chatSessionPersistTimer = undefined;
    await getExtensionContext()?.workspaceState.update(CHAT_SESSION_STATE_KEY, undefined);
}

/**
 * 首次打开内置 Chat 时展示会话恢复隐私提示。
 *
 * 提示只在当前工作区展示一次，说明消息会保存在 workspaceState 中，用户可通过清空会话删除。
 */
export async function showChatSessionPrivacyNoticeIfNeeded(): Promise<void> {
    const context = getExtensionContext();
    if (!context) return;
    const shown = context.workspaceState.get<boolean>(CHAT_SESSION_PRIVACY_NOTICE_KEY, false);
    if (shown) return;
    await context.workspaceState.update(CHAT_SESSION_PRIVACY_NOTICE_KEY, true);
    await vscode.window.showInformationMessage(
        '内置 Chat 会在当前工作区恢复最近会话消息；如不希望保留，可点击 Chat 面板里的清空会话。'
    );
}

/**
 * 按窗口大小裁剪内存 `chatSessionState.messages` 数组。
 *
 * 仅在数组长度超出 {@link MAX_IN_MEMORY_CHAT_MESSAGES} 时生效；裁掉的是数组
 * 前段（最早的消息），并同步检查 {@link chatSessionState.activeAssistantMessageId} 是否落在被裁
 * 区间——若是则一并清空，避免后续 {@link getActiveAssistantMessageForPatch}
 * 在内存里找不到对应消息时无谓地兜底创建新区域。
 */
export function trimInMemoryChatMessages(): void {
    if (chatSessionState.messages.length <= MAX_IN_MEMORY_CHAT_MESSAGES) return;
    const dropCount = chatSessionState.messages.length - MAX_IN_MEMORY_CHAT_MESSAGES;
    const dropped = chatSessionState.messages.splice(0, dropCount);
    if (chatSessionState.activeAssistantMessageId && dropped.some((item) => item.id === chatSessionState.activeAssistantMessageId)) {
        Logger.info(`内存 chatSessionState.messages 裁剪丢弃了当前活动 assistant 消息：id=${chatSessionState.activeAssistantMessageId}`);
        chatSessionState.activeAssistantMessageId = undefined;
    }
    Logger.info(`内存 chatSessionState.messages 已裁剪：dropped=${dropCount}, remaining=${chatSessionState.messages.length}`);
}

/**
 * 添加一条本地内存 Chat 消息并推送到 Webview。
 *
 * @param role 消息角色。
 * @param text 消息文本。
 */
export async function appendLocalChatMessage(role: ChatMessage['role'], text: string, segments?: ChatSegment[], route: ChatRoute = chatRouteState.active): Promise<void> {
    const message: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        // 同时保存原始 text，方便 user 消息重发与前端 fallback 渲染。
        text,
        segments: segments ?? [{ kind: 'markdown', text }],
        route,
        createdAt: Date.now()
    };
    chatSessionState.messages.push(message);
    trimInMemoryChatMessages();
    schedulePersistChatSession();
    await getChatViewHost()?.postMessage({ type: 'message/append', message });
}

/**
 * 从 ChatSegment 列表里提取纯文本，用于 user 消息缺少 `text` 字段时的兜底。
 *
 * 只关心可能承载 user 输入的 `text` / `markdown` 类型片段；其它类型按 `sourceText`
 * → `text` 顺序回退。
 *
 * @param segments 消息片段数组。
 * @returns 拼接后的纯文本；无可用文本时返回空串。
 */
export function extractPlainTextFromSegments(segments: ChatSegment[] | undefined): string {
    if (!Array.isArray(segments) || segments.length === 0) return '';
    const parts: string[] = [];
    for (const segment of segments) {
        if (!segment) continue;
        const text = typeof segment.text === 'string' ? segment.text : typeof segment.sourceText === 'string' ? segment.sourceText : '';
        if (text) parts.push(text);
    }
    return parts.join('\n');
}

/**
 * 追加 assistant 流式片段；若尚无 assistant 消息则先创建 pending 消息。
 *
 * 调用本函数即视为一段 CLI 解析事件被宿主接受并准备投递到 Webview。为方便排查
 * "CLI 已输出但聊天区不渲染" 类问题，进入和发送 postMessage 时均会在 info 级别
 * 打印日志，便于在 OutputChannel 中追踪。
 *
 * 注：token 使用量统计由 CLI 在其最终 `result` 事件中自带，经 stream-json 适配
 * 器解析为 `kind:'usage'` ChatSegment 与 done 同帧到达；本函数无需特殊处理，
 * 按普通 segment 走 patch 即可，统计行天然跟随最后一条消息渲染。
 *
 * @param segments 需要追加的消息片段。
 * @param done 是否标记当前 assistant 消息完成。
 */
export async function appendAssistantSegments(segments: ChatSegment[], done: boolean): Promise<void> {
    const visibleSegments = segments.filter((segment) => !isHiddenChatToolSegment(segment));
    if (visibleSegments.length === 0 && !done) return;
    const message = await getActiveAssistantMessageForPatch();
    const activeSegments: ChatSegment[] = [];
    // 按 segment.id 去重合并：相同 id 的片段视为对同一 segment 的多次更新（典型场景为工具卡片）
    // —— 此时应原地替换已有 segment，而不是追加新条目，以避免重复渲染。
    for (const incoming of visibleSegments) {
        syncTokenBudgetContextWindowFromUsage(incoming, message);
        if (incoming.id) {
            const existingIndex = message.segments.findIndex((item) => item.id === incoming.id);
            if (existingIndex >= 0) {
                message.segments[existingIndex] = incoming;
                activeSegments.push(incoming);
                continue;
            }
            // 工具卡片的 tool_result 常常晚于 message_stop 到达，此时活动消息已经
            // 换成新的一条，直接追加会让同一次调用渲染出「执行中」「成功」两张卡片。
            // 找到最初承载该 segment 的历史消息并就地回填，卡片才能原地更新。
            if (await patchSegmentIntoOwnerMessage(incoming, message.id)) continue;
        }
        message.segments.push(incoming);
        activeSegments.push(incoming);
    }
    if (done) message.pending = false;
    schedulePersistChatSession();
    // 这里只发送本次 incoming segments（append: true），交由 ChatViewHost 微批合并：
    // 同一 message id 的多次 patch 会在 ~4ms 窗口内 concat 成单条 message/patch
    // 投递给 webview，避免流式高峰期对 postMessage 通道造成抖动。
    if (activeSegments.length === 0 && !done) return;
    await getChatViewHost()?.postMessage({
        type: 'message/patch',
        id: message.id,
        segments: activeSegments,
        pending: message.pending,
        append: true
    });
}

/**
 * 把带稳定 id 的 segment 回填到最初渲染它的历史 assistant 消息。
 *
 * @param incoming        本次到达的 segment（必须带 id）。
 * @param activeMessageId 当前活动 assistant 消息 id，用于跳过自身。
 * @returns 命中历史消息并已回填时返回 true。
 */
async function patchSegmentIntoOwnerMessage(incoming: ChatSegment, activeMessageId: string): Promise<boolean> {
    for (let i = chatSessionState.messages.length - 1; i >= 0; i -= 1) {
        const candidate = chatSessionState.messages[i];
        if (candidate.role !== 'assistant' || candidate.id === activeMessageId) continue;
        const index = candidate.segments.findIndex((item) => item.id === incoming.id);
        if (index < 0) continue;
        candidate.segments[index] = incoming;
        await getChatViewHost()?.postMessage({
            type: 'message/patch',
            id: candidate.id,
            segments: [incoming],
            pending: candidate.pending,
            append: true
        });
        return true;
    }
    return false;
}

export function isHiddenChatToolSegment(segment: ChatSegment): boolean {
    if (segment.kind !== 'tool') return false;
    const name = segment.tool?.name || segment.text || '';
    return name === 'Agent' || name === 'Task' || name === 'EnterPlanMode' || name === 'ExitPlanMode';
}

/**
 * 从 CLI result 的 usage segment 中回填 modelUsage.contextWindow。
 *
 * 上游 OpenAI-compatible 服务有时返回 usage.input_tokens=0，但 CLI result.modelUsage
 * 仍会携带准确 contextWindow。这里把 contextWindow 同步给 TokenBudgetService，
 * 让 token-meter 从「29k/166k」修正为「29k/200k」，同时不改变 estimator 的 used。
 *
 * @param segment 本次到达的 ChatSegment。
 */
export function syncTokenBudgetContextWindowFromUsage(segment: ChatSegment, message: ChatMessage): void {
    if (segment.kind !== 'usage') return;
    const sessionId = currentChatCliSessionIdSync();
    if (!sessionId) return;
    const contextWindow = segment.usage?.contextWindow;
    const outputTokens = estimateAssistantOutputTokensForMeter(segment, message);
    tokenBudgetServiceRef?.updateCliUsage(sessionId, contextWindow, outputTokens);
}

/**
 * 估算 token-meter 中应计入的本轮 assistant 回复 token。
 *
 * 优先使用 CLI result.modelUsage.outputTokens；若上游返回 0，则从当前 assistant
 * message 已聚合的 text/markdown/code 内容做本地粗估，避免请求结束后 used 仍只
 * 显示 input，不包含刚生成的回复。
 *
 * @param usageSegment 本轮 usage segment。
 * @param message      当前 assistant 消息。
 * @returns output token 数或 undefined。
 */
export function estimateAssistantOutputTokensForMeter(usageSegment: ChatSegment, message: ChatMessage): number | undefined {
    const fromUsage = usageSegment.usage?.outputTokens;
    if (typeof fromUsage === 'number' && Number.isFinite(fromUsage) && fromUsage > 0) return fromUsage;
    const text = message.segments
        .filter((segment) => segment.kind === 'text' || segment.kind === 'markdown' || segment.kind === 'code')
        .map((segment) => segment.text || '')
        .join('\n');
    if (!text.trim()) return undefined;
    return Math.max(1, Math.ceil(text.length / 3.5));
}

/**
 * 标记当前 assistant 流式消息完成。
 */
export async function finishActiveAssistantMessage(): Promise<void> {
    if (!chatSessionState.activeAssistantMessageId) return;
    const message = chatSessionState.messages.find((item) => item.id === chatSessionState.activeAssistantMessageId);
    if (!message) return;
    message.pending = false;
    schedulePersistChatSession();
    await getChatViewHost()?.postMessage({
        type: 'message/patch',
        id: message.id,
        segments: [],
        pending: false,
        append: true
    });
    chatSessionState.activeAssistantMessageId = undefined;
}

/**
 * 创建新的流式 assistant 消息，并把其 ID 保存为当前 CLI 输出目标。
 *
 * @returns 新创建的活动 assistant 消息。
 */
export async function createActiveAssistantMessage(route: ChatRoute = chatRouteState.active): Promise<ChatMessage> {
    const message = buildAssistantMessage(route);
    chatSessionState.messages.push(message);
    chatSessionState.activeAssistantMessageId = message.id;
    schedulePersistChatSession();
    await getChatViewHost()?.postMessage({ type: 'message/append', message });
    return message;
}

/**
 * 获取当前 CLI 输出目标 assistant 消息，丢失时兜底重新创建。
 *
 * 正常情况下该 ID 在点击发送时由 {@link createActiveAssistantMessage} 写入，
 * 后续所有 CLI stdout 解析结果都只 patch 到这个 ID 对应的显示区域。
 *
 * @returns 当前活动 assistant 消息。
 */
export async function getActiveAssistantMessageForPatch(): Promise<ChatMessage> {
    if (chatSessionState.activeAssistantMessageId) {
        const existing = chatSessionState.messages.find((item) => item.id === chatSessionState.activeAssistantMessageId);
        if (existing) return existing;
    }
    Logger.warn('Chat assistant 输出目标 ID 丢失，已兜底创建新的 assistant 区域');
    return createActiveAssistantMessage();
}

/**
 * 构造带随机 ID 的 pending assistant 消息对象。
 *
 * @returns 新的 assistant 消息。
 */
export function buildAssistantMessage(route: ChatRoute = chatRouteState.active): ChatMessage {
    return {
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        segments: [],
        pending: true,
        route,
        modelLabel: requireDeps().getModelLabelForRoute(route),
        createdAt: Date.now()
    };
}
