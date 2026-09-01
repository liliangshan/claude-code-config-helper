/** @file 内置 Chat WebviewPanel 宿主。 */

import * as fs from 'fs/promises';
import * as vscode from 'vscode';

import { CHAT_SECONDARY_CONTAINER_ID, CHAT_SECONDARY_VIEW_ID } from '../constants';
import { Logger } from '../logger';
import type { ChatMessage, ExtensionToWebview, WebviewToExtension } from './protocol';

/** 内置 Chat WebviewPanel 的 viewType，保留给旧会话或调试兜底使用。 */
export const CHAT_WEBVIEW_VIEW_TYPE = 'claudeRouter.chatPanel';

/** 当前 Chat WebviewView 实例及其 Webview。 */
type ChatWebviewTarget = { view: vscode.WebviewView; webview: vscode.Webview };

/**
 * 管理右侧 Chat WebviewView 生命周期和扩展/Webview 消息收发。
 *
 * 该类优先把 Chat 放到 VS Code Secondary Sidebar，视觉位置与官方 Claude Code 类似；
 * 该类只负责视图创建、HTML 注入、postMessage 和 Webview 消息转发，
 * 不直接包含 CLI 协议、任务流注入或解析器业务逻辑。
 */
export class ChatViewHost implements vscode.WebviewViewProvider, vscode.Disposable {
    /** 当前已解析的 Chat Webview 宿主。 */
    private target: ChatWebviewTarget | undefined;

    /** 最近一次用于初始化 Webview 的消息列表。 */
    private initialMessages: ChatMessage[] = [];

    /** 最近一次用于初始化 Webview 的 CLI 路径。 */
    private cliPath = '';

    /** 最近一次任务流状态消息，用于 Webview 延迟创建后补发顶部 Todo 卡片状态。 */
    private lastTaskFlowStatus: Extract<ExtensionToWebview, { type: 'taskFlow/status' }> | undefined;

    /** 按消息 ID 合并的流式 patch 队列。 */
    private readonly patchQueue = new Map<string, Extract<ExtensionToWebview, { type: 'message/patch' }>>();

    /** patch 队列刷新定时器。 */
    private patchFlushTimer: NodeJS.Timeout | undefined;

    /**
     * 微批合并的最大保留时长（毫秒）。
     *
     * 取值 50ms 大致对应 ~20Hz 的合并节奏：
     * - 用户感知不到额外延迟。
     * - 足以把同一段 CLI 解析中相邻产出的多个 segment 合并成单条 message/patch，
     *   避免流式高峰期对 webview postMessage 通道造成抖动。
     */
    private static readonly PATCH_FLUSH_WINDOW_MS = 50;

    /** Webview 消息事件发送器。 */
    private readonly messageEmitter = new vscode.EventEmitter<WebviewToExtension>();

    /** Webview 发给扩展宿主的消息事件。 */
    public readonly onDidReceiveMessage = this.messageEmitter.event;

    /**
     * 创建 Chat Webview 宿主。
     *
     * @param context VS Code 扩展上下文，用于解析扩展资源路径。
     */
    public constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * 解析 VS Code 创建的侧边栏 Chat WebviewView。
     *
     * @param webviewView VS Code 根据 package.json 贡献点创建的 WebviewView。
     */
    public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat'),
                vscode.Uri.joinPath(this.context.extensionUri, 'media')
            ]
        };
        this.target = { view: webviewView, webview: webviewView.webview };
        webviewView.webview.html = await this.buildHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message: WebviewToExtension | Record<string, unknown>) => {
            // React 前端发送的消息类型可能不匹配 WebviewToExtension 协议，
            // 这里透传给上层处理，上层会忽略未知类型
            this.messageEmitter.fire(message as WebviewToExtension);
        });
        webviewView.onDidDispose(() => {
            if (this.target?.view === webviewView) {
                this.target = undefined;
            }
        });
        // React 前端期望消息以 {type: "from-extension", message: ...} 格式接收，
        // 因此初始化消息也需要包装
        await this.postMessage({ type: 'session/init', messages: this.initialMessages, cliPath: this.cliPath });
        await this.postLastTaskFlowStatus();
    }

    /**
     * 打开或聚焦右侧 Chat 侧边栏。
     *
     * @param initialMessages 初始会话消息列表。
     * @param cliPath 当前 CLI 路径，用于显示状态栏提示。
     */
    public async open(initialMessages: ChatMessage[], cliPath: string): Promise<void> {
        this.initialMessages = initialMessages;
        this.cliPath = cliPath;
        if (this.target) {
            this.target.view.show(false);
            await this.postMessage({ type: 'session/init', messages: initialMessages, cliPath });
            await this.postLastTaskFlowStatus();
            return;
        }
        await this.revealSidebarView();
        await this.postMessage({ type: 'session/init', messages: initialMessages, cliPath });
        await this.postLastTaskFlowStatus();
    }

    /**
     * 判断当前 Chat Webview 是否已经由 VS Code 创建并解析。
     *
     * @returns 已存在可直接 postMessage 的 Webview 时返回 true。
     */
    public hasResolvedView(): boolean {
        return !!this.target;
    }

    /**
     * 向当前 Webview 发送消息。
     *
     * 注意：React 前端只识别 type="from-extension" 的消息格式，
     * 因此所有消息都需要包装在 {type: "from-extension", message: original} 结构中。
     *
     * @param message 扩展宿主到 Webview 的协议消息。
     * @returns Webview 不存在时返回 false，否则返回 postMessage 结果。
     */
    public async postMessage(message: ExtensionToWebview): Promise<boolean> {
        if (message.type === 'taskFlow/status') {
            this.lastTaskFlowStatus = message;
            const taskCount = message.snapshot?.workflow?.tasks?.length ?? 0;
            Logger.info(`[ChatViewHost] postMessage taskFlow/status：tasks=${taskCount}, hasTarget=${!!this.target}`);
        }
        const webview = this.target?.webview;
        if (!webview) return false;
        if (message.type === 'message/patch') {
            this.enqueuePatchMessage(message);
            return true;
        }
        try {
            // React 前端监听 message 事件并仅处理 type === "from-extension" 的消息
            // 参考实现：window.addEventListener("message", (G) => { if (G.data.type === "from-extension") ... })
            const wrappedMessage = { type: 'from-extension', message };
            return await webview.postMessage(wrappedMessage);
        } catch (err) {
            Logger.error('Chat Webview postMessage 失败', err);
            return false;
        }
    }

    /**
     * 释放 WebviewPanel 与事件资源。
     */
    public dispose(): void {
        this.flushPatchQueue();
        if (this.patchFlushTimer) clearTimeout(this.patchFlushTimer);
        this.patchFlushTimer = undefined;
        this.target = undefined;
        this.messageEmitter.dispose();
    }

    /**
     * 按官方 Claude Code 的方式优先打开 Secondary Sidebar 中的 Chat 视图。
     *
     * VS Code 会在执行容器打开命令后按需调用 resolveWebviewView。这里不再注册
     * Activity Bar 兜底视图，避免 Chat 图标出现在左侧活动栏。
     */
    private async revealSidebarView(): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'claudeRouter.chat.useActivityBarFallback', false);
        await vscode.commands.executeCommand(`workbench.view.extension.${CHAT_SECONDARY_CONTAINER_ID}`);
        await vscode.commands.executeCommand(`${CHAT_SECONDARY_VIEW_ID}.focus`);
    }

    /**
     * 将缓存的最近一次任务流状态补发给 Webview。
     *
     * 任务流工具可能在 Chat Webview 尚未 resolve 时已经创建 workflow；此时
     * `postMessage` 会因为没有 target 而返回 false。缓存后在视图创建或重新打开时
     * 补发，可确保用户看到 “Workflow created ...” 后顶部 Todo 卡片不会丢失。
     */
    private async postLastTaskFlowStatus(): Promise<void> {
        if (!this.lastTaskFlowStatus) return;
        await this.postMessage(this.lastTaskFlowStatus);
    }

    /**
     * 把高频 message/patch 按消息 ID 合并到短周期队列中。
     *
     * 合并时按 `segment.id` 去重：工具卡片在 tool_use / input_json_delta / tool_result
     * 各阶段会被适配器就地改写并反复投递同一个对象引用，若直接 push，一次 flush 就会
     * 把同一张卡片的多份快照发给 Webview，导致卡片在同一帧内被重建多次（视觉抖动）。
     *
     * @param message 待合并的 patch 消息。
     */
    private enqueuePatchMessage(message: Extract<ExtensionToWebview, { type: 'message/patch' }>): void {
        const existing = this.patchQueue.get(message.id);
        if (existing) {
            for (const segment of message.segments) {
                const index = segment.id
                    ? existing.segments.findIndex((item) => item.id === segment.id)
                    : -1;
                if (index >= 0) existing.segments[index] = segment;
                else existing.segments.push(segment);
            }
            existing.pending = message.pending;
        } else {
            this.patchQueue.set(message.id, { ...message, segments: [...message.segments] });
        }
        if (!this.patchFlushTimer) {
            this.patchFlushTimer = setTimeout(() => this.flushPatchQueue(), ChatViewHost.PATCH_FLUSH_WINDOW_MS);
        }
    }

    /**
     * 将合并后的 patch 队列发送给 Webview。
     *
     * 消息需要包装为 React 前端可识别的格式：{type: "from-extension", message: original}。
     */
    private flushPatchQueue(): void {
        if (this.patchFlushTimer) clearTimeout(this.patchFlushTimer);
        this.patchFlushTimer = undefined;
        const webview = this.target?.webview;
        if (!webview || this.patchQueue.size === 0) {
            this.patchQueue.clear();
            return;
        }
        const pendingMessages = Array.from(this.patchQueue.values());
        this.patchQueue.clear();
        for (const message of pendingMessages) {
            void webview.postMessage({ type: 'from-extension', message }).then(undefined, (err: unknown) => {
                Logger.error('Chat Webview 合并 patch 发送失败', err);
            });
        }
    }

    /**
     * 读取 HTML 模板并替换 Webview 资源 URI、CSP source 和 nonce。
     *
     * HTML 模板基于参考实现的模板结构，加载：
     * - style.css：参考实现 CSS（已替换图标）
     * - bridge.js：协议桥接脚本，使 React 前端与扩展协议兼容
     * - main.js：参考实现 React 应用捆绑包
     *
     * @param webview 当前 Panel 的 Webview 实例。
     * @returns 可赋给 webview.html 的完整 HTML。
     */
    private async buildHtml(webview: vscode.Webview): Promise<string> {
        const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat');
        const htmlUri = vscode.Uri.joinPath(mediaRoot, 'index.html');
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'style.css'));
        const bridgeUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'bridge.js'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
        const nonce = this.createNonce();
        const html = await fs.readFile(htmlUri.fsPath, 'utf8');
        return html
            .replace(/{{cspSource}}/g, webview.cspSource)
            .replace(/{{nonce}}/g, nonce)
            .replace(/{{styleUri}}/g, String(styleUri))
            .replace(/{{bridgeUri}}/g, String(bridgeUri))
            .replace(/{{scriptUri}}/g, String(scriptUri));
    }

    /**
     * 生成 CSP nonce。
     *
     * @returns 32 字符随机 nonce 字符串。
     */
    private createNonce(): string {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let text = '';
        for (let index = 0; index < 32; index += 1) {
            text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        }
        return text;
    }
}
