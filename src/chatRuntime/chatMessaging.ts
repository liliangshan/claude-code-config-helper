/**
 * Chat 用户消息发送链路、附件处理与工作区文件跳转。
 *
 * 拆分自 extension.ts：把「用户输入 → 组装 prompt → 投递给 CLI」这条主链路，
 * 以及围绕它的附件采集（编辑器选区 / 文件选择器 / Webview 上传）、图片段构建、
 * 工作区文件引用跳转收敛到一个模块。
 *
 * 依赖方向：本模块位于 routeState / cliLifecycle / chatSession 之上，
 * 仍留在 extension.ts 的上层协作函数（路由切换、自愈计时、专家子回合）
 * 通过 {@link configureChatMessaging} 注入，避免反向 import 造成循环依赖。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

import type { ChatComposerAttachment, ChatRoute, ChatSegment, WebviewToExtension } from '../chat/protocol';
import { Logger } from '../logger';
import { getChatViewHost } from '../runtime';
import { ensureChatCliStarted } from './cliLifecycle';
import {
    appendAssistantSegments,
    appendLocalChatMessage,
    chatSessionState,
    createActiveAssistantMessage,
    extractPlainTextFromSegments,
    finishActiveAssistantMessage,
    schedulePersistChatSession
} from './chatSession';
import { cancelRouteProcess, chatCliCancelState, chatRouteState, getStreamAdapterForRoute, hiddenCliResponseTurnsByRoute, isRouteBusy } from './routeState';
import type { UpstreamTimeoutKind } from '../relay/upstreamTimeouts';

/** chatMessaging 需要但仍留在 extension.ts 的协作函数集合。 */
export interface ChatMessagingDeps {
    /** 打开（必要时创建）内置 Chat 面板。 */
    openBuiltInChat: () => Promise<void>;
    /** 切换当前活动路由。 */
    switchChatRoute: (route: ChatRoute, reason: string) => Promise<void>;
    /** 提交后启动 Relay 命中等待计时器。 */
    armHttpExpectation: (prompt: string) => void;
    /** 清除 Relay 命中等待计时器。 */
    clearHttpExpectation: (reason: string) => void;
    /** 取消自愈流程排队中的静默重发任务。 */
    cancelPendingResend: (reason: string) => void;
    /** 向 Webview 推送轻提示。 */
    showChatToast: (level: 'info' | 'success' | 'warn' | 'error', text: string) => Promise<void>;
    /** 截断日志文本，避免超长内容写入输出面板。 */
    formatLogPreview: (text: string, limit?: number) => string;
}

/** 已注入的协作函数集合，未装配前访问会抛错。 */
let deps: ChatMessagingDeps | undefined;

/** 装配 chatMessaging 依赖，必须在 activate 早期调用一次。 */
export function configureChatMessaging(value: ChatMessagingDeps): void {
    deps = value;
}

/** 读取已装配的依赖，未装配时抛出明确错误便于定位装配顺序问题。 */
function requireDeps(): ChatMessagingDeps {
    if (!deps) throw new Error('chatMessaging 尚未装配');
    return deps;
}

/** Webview 粘贴/拖放二进制文件写入的临时目录名。 */
const CHAT_UPLOAD_TEMP_DIR = 'lls-ccai-chat-uploads';

/** 单个 Webview 上传文件允许的最大大小，避免异常剪贴板内容撑爆扩展进程。 */
const MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 上游超时自动 Continue 的冷却窗口，防止抖动时连续重发。 */
const UPSTREAM_TIMEOUT_CONTINUE_COOLDOWN_MS = 30_000;

/** 上游转发卡死后自动续发的固定英文提示。 */
const UPSTREAM_TIMEOUT_CONTINUE_PROMPT = 'Continue';

/** 编辑器附件与超时续写的可变状态（容器可变字段，避免导出可变 let）。 */
const messagingState: {
    /** 最近一次有效的 Chat 当前编辑器上下文，焦点进入 Webview 时用于保留默认文件。 */
    lastEditorAttachment?: ChatComposerAttachment;
    /** 当前编辑器/选区刷新版本号，用于丢弃乱序完成的过期异步结果。 */
    editorSelectionVersion: number;
    /** 上一次触发自动 Continue 的时间戳，用于冷却判断。 */
    lastUpstreamTimeoutContinueAt: number;
} = { editorSelectionVersion: 0, lastUpstreamTimeoutContinueAt: 0 };

/**
 * 打开 VS Code 文件选择器并把选中文件以 @path 形式填充到输入框。
 */
export async function pickChatContextFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: '添加到 Chat 上下文'
    });
    if (!uris || uris.length === 0) return;
    await getChatViewHost()?.postMessage({
        type: 'composer/addAttachments',
        attachments: uris.map((uri) => ({ path: uri.fsPath, name: path.basename(uri.fsPath) })),
        focus: true
    });
}

/**
 * 保存 Webview 粘贴/拖放上传的二进制文件，并把真实临时文件路径回填到输入框附件。
 *
 * @param message file/uploadBlob 协议消息。
 */
export async function saveChatUploadedBlob(message: Extract<WebviewToExtension, { type: 'file/uploadBlob' }>): Promise<void> {
    try {
        const safeName = sanitizeUploadFileName(message.name, message.mime);
        const size = Number.isFinite(message.size) ? message.size : 0;
        if (size < 0 || size > MAX_CHAT_UPLOAD_BYTES) throw new Error(`文件过大：${size} bytes`);
        const bytes = Buffer.from(message.base64 || '', 'base64');
        if (bytes.byteLength > MAX_CHAT_UPLOAD_BYTES) throw new Error(`文件过大：${bytes.byteLength} bytes`);
        const tempRoot = vscode.Uri.file(path.join(os.tmpdir(), CHAT_UPLOAD_TEMP_DIR));
        await vscode.workspace.fs.createDirectory(tempRoot);
        const target = vscode.Uri.joinPath(tempRoot, `${Date.now()}-${safeName}`);
        await vscode.workspace.fs.writeFile(target, bytes);
        await getChatViewHost()?.postMessage({
            type: 'composer/replaceAttachment',
            clientId: message.clientId,
            attachment: { path: target.fsPath, name: message.displayName || safeName },
            focus: true
        });
        await requireDeps().showChatToast('success', `已添加图片：${safeName}`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        Logger.error(`保存 Chat 上传文件失败：${detail}`);
        await requireDeps().showChatToast('error', `保存粘贴图片失败：${detail}`);
    }
}

/**
 * 清理 Webview 上传文件名，防止路径穿越并在缺少扩展名时按 MIME 补齐。
 *
 * @param name Webview 传入的文件名。
 * @param mime 文件 MIME 类型。
 * @returns 可安全拼接到临时目录中的文件名。
 */
export function sanitizeUploadFileName(name: string, mime: string): string {
    const extensionByMime: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/tiff': '.tiff'
    };
    const fallbackExtension = extensionByMime[mime.toLowerCase()] ?? '.bin';
    const fallbackName = `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-')}${fallbackExtension}`;
    const baseName = path.basename(String(name || fallbackName)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim();
    const safeName = baseName || fallbackName;
    if (path.extname(safeName)) return safeName;
    return `${safeName}${fallbackExtension}`;
}

/**
 * 将当前活动编辑器中的本地文件和选区作为 Chat 默认上下文附件发送给 Webview。
 *
 * 逻辑参考 Claude Code：优先使用 activeTextEditor；当焦点进入 Webview 导致 activeTextEditor 为空、
 * 但仍有可见编辑器时，保留上一次上下文，避免默认文件被误清空。
 */
export async function postActiveEditorAttachmentToChat(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const version = ++messagingState.editorSelectionVersion;
    if (!editor) {
        if (vscode.window.visibleTextEditors.length > 0 && messagingState.lastEditorAttachment) {
            await getChatViewHost()?.postMessage({ type: 'composer/defaultAttachment', attachment: messagingState.lastEditorAttachment });
            return;
        }
        messagingState.lastEditorAttachment = undefined;
        await getChatViewHost()?.postMessage({ type: 'composer/defaultAttachment' });
        return;
    }
    if (!uri || uri.scheme === 'comment' || uri.scheme === 'output' || uri.scheme !== 'file') {
        if (messagingState.lastEditorAttachment && vscode.window.visibleTextEditors.length > 0) {
            await getChatViewHost()?.postMessage({ type: 'composer/defaultAttachment', attachment: messagingState.lastEditorAttachment });
            return;
        }
        messagingState.lastEditorAttachment = undefined;
        await getChatViewHost()?.postMessage({ type: 'composer/defaultAttachment' });
        return;
    }
    const attachment = buildEditorAttachment(editor);
    if (version !== messagingState.editorSelectionVersion) {
        return;
    }
    messagingState.lastEditorAttachment = attachment;
    await getChatViewHost()?.postMessage({ type: 'composer/defaultAttachment', attachment });
}

/**
 * 将 VS Code Selection 序列化为日志友好的普通对象。
 *
 * @param selection VS Code 当前选区。
 * @returns 适合 JSON.stringify 的选区对象。
 */
export function serializeSelection(selection: vscode.Selection): Record<string, unknown> {
    return {
        start: { line: selection.start.line, character: selection.start.character },
        end: { line: selection.end.line, character: selection.end.character },
        isEmpty: selection.isEmpty,
        isReversed: selection.isReversed
    };
}

/**
 * 从活动编辑器构造 Claude Code 风格的当前文件/选区上下文。
 *
 * @param editor 当前活动文本编辑器。
 * @returns 带文件路径、光标行或选区信息的默认上下文附件。
 */
export function buildEditorAttachment(editor: vscode.TextEditor): ChatComposerAttachment {
    const selection = editor.selection;
    const attachment: ChatComposerAttachment = {
        path: editor.document.uri.fsPath,
        name: path.basename(editor.document.uri.fsPath),
        startLine: selection.start.line + 1,
        endLine: selection.isEmpty ? selection.start.line + 1 : selection.end.line + 1
    };
    if (!selection.isEmpty) {
        attachment.startColumn = selection.start.character;
        attachment.endColumn = selection.end.character;
        attachment.selectedText = editor.document.getText(selection);
    }
    return attachment;
}

/**
 * 将输入文本和附件合并为发送给 CLI 的提示词。
 *
 * @param text 用户输入的自然语言内容。
 * @param attachments 输入框附带的上下文文件。
 * @returns 包含 @file 引用的完整提示词。
 */
export function buildPromptWithAttachments(text: string, attachments?: ChatComposerAttachment[]): string {
    const uniqueKeys = new Set<string>();
    const uniqueAttachments: ChatComposerAttachment[] = [];
    for (const item of attachments ?? []) {
        if (!item?.path) continue;
        const key = formatAttachmentForPrompt(item);
        if (uniqueKeys.has(key)) continue;
        uniqueKeys.add(key);
        uniqueAttachments.push(item);
    }
    const attachmentText = uniqueAttachments.map((item) => `@${formatAttachmentForPrompt(item)}`).join(' ');
    return [attachmentText, text.trim()].filter(Boolean).join('\n\n');
}

/**
 * 为用户本地消息构造展示片段，图片附件会额外转为可直接渲染的 data URL。
 *
 * 发送给 Claude CLI 的真实 prompt 仍保持 `@file` 文本引用；本函数只影响 Webview
 * 本地回显，让用户确认自己刚刚发出的截图/图片确实被提取到了。
 *
 * @param prompt 已合成的发送给 CLI 的 prompt 文本。
 * @param attachments 用户随消息发送的附件。
 * @returns 可用于 ChatMessage 的片段列表。
 */
export async function buildUserDisplaySegments(prompt: string, attachments?: ChatComposerAttachment[]): Promise<ChatSegment[]> {
    const segments: ChatSegment[] = [{ kind: 'markdown', text: prompt }];
    for (const attachment of attachments ?? []) {
        const image = await buildImageSegmentFromAttachment(attachment);
        if (image) segments.push(image);
    }
    return segments;
}

/**
 * 从单个附件读取图片并构造 image 片段。
 *
 * @param attachment 用户输入框附件。
 * @returns 图片可读时返回 image 片段；非图片或读取失败时返回 undefined。
 */
export async function buildImageSegmentFromAttachment(attachment: ChatComposerAttachment): Promise<ChatSegment | undefined> {
    if (!attachment?.path) return undefined;
    const mediaType = getImageMediaTypeFromPath(attachment.path);
    if (!mediaType) return undefined;
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(attachment.path));
        const base64 = Buffer.from(bytes).toString('base64');
        return {
            kind: 'image',
            imageUrl: `data:${mediaType};base64,${base64}`,
            mediaType,
            alt: attachment.name || path.basename(attachment.path),
            filePath: attachment.path
        };
    } catch (err) {
        Logger.warn(`读取 Chat 图片附件失败：${attachment.path} :: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

/**
 * 根据文件扩展名推断图片 MIME 类型。
 *
 * @param filePath 图片文件路径。
 * @returns 支持的图片 MIME；非图片扩展名返回 undefined。
 */
export function getImageMediaTypeFromPath(filePath: string): string | undefined {
    switch (path.extname(filePath).toLowerCase()) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        case '.bmp':
            return 'image/bmp';
        case '.tif':
        case '.tiff':
            return 'image/tiff';
        default:
            return undefined;
    }
}

/**
 * 将附件格式化为 Claude Code 风格的 @file#line 引用。
 *
 * @param attachment Chat 输入框上下文附件。
 * @returns 适合放入 prompt 的文件引用路径。
 */
export function formatAttachmentForPrompt(attachment: ChatComposerAttachment): string {
    const filePath = formatPathForPrompt(attachment.path);
    if (attachment.startLine && attachment.endLine && attachment.startLine !== attachment.endLine) {
        return `${filePath}#${attachment.startLine}-${attachment.endLine}`;
    }
    if (attachment.startLine) return `${filePath}#${attachment.startLine}`;
    return filePath;
}

/**
 * 尽量把文件路径格式化为 workspace 相对路径，保持提示词简洁。
 *
 * @param filePath 待格式化的绝对路径或文件名。
 * @returns 适合放入 prompt 的路径文本。
 */
export function formatPathForPrompt(filePath: string): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
        const relative = path.relative(folder.uri.fsPath, filePath);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    }
    return filePath;
}

/**
 * 打开 Webview 文件引用指向的 workspace 内文件。
 *
 * @param filePath Webview 传回的相对或绝对文件路径。
 * @param line 可选 1-based 起始行号。
 * @param endLine 可选 1-based 结束行号。
 */
export async function openWorkspaceFileReference(filePath: string, line?: number, endLine?: number): Promise<void> {
    const uri = await resolveWorkspaceFileUri(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const selection = typeof line === 'number' && line > 0
        ? new vscode.Range(line - 1, 0, Math.max((endLine ?? line) - 1, line - 1), 0)
        : undefined;
    await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
        selection
    });
}

/**
 * 将 Webview 传入的文件路径解析为 workspace allowlist 内 URI。
 *
 * @param filePath Webview 传回的不可信路径。
 * @returns 通过校验且存在的文件 URI。
 * @throws 路径危险、无 workspace、越界或文件不存在时抛出错误。
 */
export async function resolveWorkspaceFileUri(filePath: string): Promise<vscode.Uri> {
    if (!filePath || /^(?:javascript|command|data):/i.test(filePath)) {
        throw new Error('拒绝打开不安全的文件路径');
    }
    const normalizedInput = filePath.replace(/\\/g, path.sep);
    const folders = vscode.workspace.workspaceFolders;
    const candidates = buildWorkspaceFileCandidates(normalizedInput, folders);
    if (!folders || folders.length === 0) {
        throw new Error('当前没有 workspace，无法校验文件引用');
    }
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        for (const inputCandidate of candidates) {
            const candidate = path.isAbsolute(inputCandidate)
                ? inputCandidate
                : path.resolve(root, inputCandidate);
            if (!isPathInside(candidate, root)) continue;
            const uri = vscode.Uri.file(candidate);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.File) return uri;
            } catch {
                // 尝试下一个 workspace folder。
            }
        }
    }
    throw new Error(`文件不存在或不在 workspace 内：${filePath}`);
}

/**
 * 构造 Webview 文件引用的候选路径列表。
 *
 * 某些模型或 Markdown 解析链路会把 macOS/Linux 绝对路径 `/Users/a/b.ts`
 * 误写成 `Users/a/b.ts`，少了开头的根斜杠。这里会在安全校验前补充一个
 * `/${input}` 候选；后续仍会经过 workspace allowlist 判断，避免因为自动补斜杠
 * 打开工作区外文件。
 *
 * 同时，如果当前 workspace 根路径去掉开头 `/` 后正好是输入路径前缀，也会生成
 * 对应的绝对候选，解决 `Users/.../workspace/src/a.ts` 这类缺斜杠引用。
 *
 * @param normalizedInput 已把反斜杠归一化后的用户输入路径。
 * @param folders 当前 workspace folders，可能为空。
 * @returns 去重后的候选路径列表，第一项始终是原始归一化输入。
 */
export function buildWorkspaceFileCandidates(
    normalizedInput: string,
    folders: readonly vscode.WorkspaceFolder[] | undefined
): string[] {
    const candidates: string[] = [normalizedInput];
    const addCandidate = (candidate: string): void => {
        if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    };
    if (!path.isAbsolute(normalizedInput) && !normalizedInput.startsWith(`.${path.sep}`)) {
        addCandidate(`${path.sep}${normalizedInput}`);
    }
    for (const folder of folders ?? []) {
        let rootWithoutLeadingSlash = folder.uri.fsPath;
        while (rootWithoutLeadingSlash.startsWith(path.sep)) {
            rootWithoutLeadingSlash = rootWithoutLeadingSlash.slice(path.sep.length);
        }
        if (rootWithoutLeadingSlash && normalizedInput.startsWith(rootWithoutLeadingSlash)) {
            addCandidate(`${path.sep}${normalizedInput}`);
        }
    }
    return candidates;
}

/**
 * 判断目标路径是否位于 workspace 根目录内。
 *
 * @param target 待判断绝对路径。
 * @param root workspace 根目录绝对路径。
 * @returns target 在 root 内或等于 root 时返回 true。
 */
export function isPathInside(target: string, root: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 通过 stream-json CLI 适配器发送用户消息。
 *
 * taskFlow 路由复用 normal CLI 进程（仅模型不同），因此适配器与隐藏回合计数
 * 统一挂在 normal 一路；`forceRoute: 'taskFlow'` 是任务流唯一入口。
 *
 * @param text 用户输入文本。
 */
export async function sendUserMessageToCli(text: string, options: { hidden?: boolean; suppressResponse?: boolean; forceRoute?: ChatRoute } = {}): Promise<void> {
    chatCliCancelState.requested = false;
    chatSessionState.activeAssistantMessageId = undefined;

    const route = options.forceRoute ?? chatRouteState.active;
    const outgoingText = text;
    // taskFlow 复用 normal CLI，进程与适配器均挂在 normal 路由下。
    const cliRoute: ChatRoute = 'normal';
    if (options.forceRoute) {
        await requireDeps().switchChatRoute(options.forceRoute, 'force-route');
    }

    const hidden = options.hidden === true;
    const suppressResponse = options.suppressResponse === true;
    if (suppressResponse) hiddenCliResponseTurnsByRoute[cliRoute] += 1;

    Logger.info(`用户发送内容(${route}, hidden=${hidden})：${requireDeps().formatLogPreview(outgoingText)}`);

    if (!hidden) {
        const assistantMessage = await createActiveAssistantMessage(route);
        Logger.info(`Chat 已创建 ${route} assistant 输出区域：id=${assistantMessage.id}`);
    }
    try {
        await ensureChatCliStarted();
        const adapter = getStreamAdapterForRoute(cliRoute);
        if (!adapter) {
            throw new Error(`${cliRoute} Chat CLI adapter 未就绪`);
        }
        Logger.info(`发送消息到 ${route} Chat CLI：length=${outgoingText.length}, hidden=${hidden}, forceRoute=${options.forceRoute ?? ''}`);
        await adapter.sendUserMessage(outgoingText);
    } catch (err) {
        if (suppressResponse) hiddenCliResponseTurnsByRoute[cliRoute] = Math.max(0, hiddenCliResponseTurnsByRoute[cliRoute] - 1);
        const message = err instanceof Error ? err.message : String(err);
        if (!hidden) {
            await appendAssistantSegments([{ kind: 'error', text: `\n发送到 CLI 失败：${message}\n` }], true);
        }
        throw err;
    }
}

/**
 * 向内置 Chat 追加用户消息并立即发送到 CLI。
 *
 * @param text 用户消息文本。
 * @param options 发送选项；`forceRoute` 用于任务流等需要显式指定路由的入口。
 */
export async function appendUserMessageAndSend(
    text: string,
    options: { forceRoute?: ChatRoute } = {}
): Promise<void> {
    await requireDeps().openBuiltInChat();
    await appendLocalChatMessage('user', text);
    await sendUserMessageToCli(text, { forceRoute: options.forceRoute });
}
/**
 * 向 CLI 发送内部消息，不在内置 Chat 中追加用户气泡。
 *
 * @param text 内部消息文本。
 */
export async function sendHiddenUserMessageToCli(text: string, route: ChatRoute = chatRouteState.active): Promise<void> {
    const previousRoute = chatRouteState.active;
    chatRouteState.active = route;
    try {
        await ensureChatCliStarted();
        await sendUserMessageToCli(text, { hidden: true });
    } finally {
        chatRouteState.active = previousRoute;
    }
}

/**
 * 将文本填充到内置 Chat 输入框，供用户编辑后手动发送。
 *
 * @param text 需要填充的文本。
 * @param focus 是否聚焦输入框。
 */
export async function fillBuiltInChatComposer(text: string, focus: boolean): Promise<void> {
    await requireDeps().openBuiltInChat();
    await getChatViewHost()?.postMessage({ type: 'composer/fill', text, focus });
}

/**
 * 上游首字节或流空闲超时后，结束当前 pending 气泡并自动发送英文 Continue。
 *
 * @param kind 超时类型。
 */
export async function handleUpstreamTimeoutAutoContinue(kind: UpstreamTimeoutKind): Promise<void> {
    const now = Date.now();
    if (now - messagingState.lastUpstreamTimeoutContinueAt < UPSTREAM_TIMEOUT_CONTINUE_COOLDOWN_MS) {
        Logger.warn(`上游超时自动 Continue 已在冷却中，忽略：kind=${kind}`);
        return;
    }
    messagingState.lastUpstreamTimeoutContinueAt = now;
    Logger.warn(`检测到上游${kind === 'first_byte' ? '首字节' : '流空闲'}超时，自动发送 Continue`);
    requireDeps().clearHttpExpectation(`upstream_${kind}_timeout`);
    await finishActiveAssistantMessage();
    requireDeps().armHttpExpectation(UPSTREAM_TIMEOUT_CONTINUE_PROMPT);
    await appendUserMessageAndSend(UPSTREAM_TIMEOUT_CONTINUE_PROMPT);
}

/**
 * 处理 Webview 的 user/resend 请求。
 *
 * 行为：
 *
 * 1. 在 `chatSessionState.messages` 中按 id 定位目标 user 消息；
 * 2. **连同该消息一起**截断到该索引之前，移除其后所有 assistant / user / tool
 *    上下文；
 * 3. 取消当前正在进行的 CLI 请求与自愈重发，并清理 HTTP 预期；
 * 4. 通过 `session/init` 让 Webview 全量重绘到截断后的状态；
 * 5. 用目标消息保存的原始文本作为新一轮 user 消息重新发送（走标准
 *    {@link appendUserMessageAndSend} 链路）。
 *
 * 若目标消息不存在、不是 user 角色或缺少原始文本，则直接放弃并提示。
 *
 * @param id 待重发的消息 id。
 * @param editedText Webview 重发编辑框提交的覆盖文本；为空时使用原消息文本。
 */
export async function handleUserResend(id: string, editedText?: string): Promise<void> {
    const index = chatSessionState.messages.findIndex((item) => item.id === id);
    if (index < 0) {
        Logger.warn(`收到 user/resend 但目标消息不存在：id=${id}`);
        return;
    }
    const target = chatSessionState.messages[index];
    if (target.role !== 'user') {
        Logger.warn(`收到 user/resend 但目标消息不是 user 角色：id=${id}, role=${target.role}`);
        return;
    }
    const promptText = typeof editedText === 'string' && editedText.trim()
        ? editedText
        : typeof target.text === 'string'
            ? target.text
            : extractPlainTextFromSegments(target.segments);
    if (!promptText) {
        Logger.warn(`收到 user/resend 但目标消息缺少原始文本：id=${id}`);
        await getChatViewHost()?.postMessage({
            type: 'toast',
            level: 'warn',
            text: '无法重发：该消息缺少原始文本'
        });
        return;
    }

    Logger.info(`处理 user/resend：id=${id}, index=${index}, totalBefore=${chatSessionState.messages.length}, promptLength=${promptText.length}`);

    // 仅中断正在执行的请求；空闲 CLI 不发 SIGINT，避免重发时把常驻进程打退出。
    chatCliCancelState.requested = true;
    requireDeps().clearHttpExpectation('user_resend');
    requireDeps().cancelPendingResend('user_resend');
    if (isRouteBusy('normal')) {
        cancelRouteProcess('normal');
    }
    if (isRouteBusy('taskFlow')) {
        cancelRouteProcess('taskFlow');
    }

    // 截断：连同目标 user 消息一起删除。
    chatSessionState.messages = chatSessionState.messages.slice(0, index);
    chatSessionState.activeAssistantMessageId = undefined;
    schedulePersistChatSession();
    // 走"局部截断"通知前端只移除该消息及其之后的 DOM 节点，避免
    // 走 session/init 全量重绘导致 scrollTop 先归零再被随后的 append 强拉
    // 到底部，从而产生肉眼可见的"先到顶再到底"闪烁。
    //
    // fromIndex 与 webview 在 appendMessage 时写入的 dataset.index 一一对应：
    // 这里传入的就是被删 user 消息原来的下标，webview 据此找到节点并删除自身
    // 与之后的所有兄弟节点。
    await getChatViewHost()?.postMessage({
        type: 'messages/truncate',
        fromIndex: index
    });

    // 重发：等价于用户在输入框里又敲了一遍同样的内容回车。
    requireDeps().armHttpExpectation(promptText);
    await appendUserMessageAndSend(promptText);
}
