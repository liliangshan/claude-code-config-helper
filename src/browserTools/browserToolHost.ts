/** @file 浏览器工具宿主侧执行器（基于 vscode.lm.invokeTool 调用内置浏览器工具）。 */

import type * as vscode from 'vscode';

import { Logger } from '../logger';
import { EXPORT_SCRIPT, buildImportScript, parseExportResult } from './sessionBridge';
import { toOrigin, isExpired, type BrowserSessionStore } from './sessionStore';
import { LM_BROWSER_TOOLS, isBrowserToolName, type BrowserToolName } from './tools';

/** 执行浏览器工具的统一接口（真实宿主与 HTTP 转发宿主都实现）。 */
export interface BrowserToolExecutor {
    /** 执行一个浏览器工具并返回 MCP 结果。 */
    execute(name: BrowserToolName, args?: Record<string, unknown>): Promise<BrowserToolResult>;
}

const VS_CODE_DESKTOP_UI_KIND = 1;
const PAGE_ID_RE = /Page ID:\s*([0-9a-fA-F-]{36})/;
/** 「已有相似页面」响应里的列表项 id，形如 `  - [uuid] title (url)`。 */
const SIMILAR_PAGE_ID_RE = /^\s*-\s*\[([0-9a-fA-F-]{36})\]/m;
const NO_PAGE_MESSAGE = 'No browser page is open. Call browser_open first.';

/** MCP tool result 文本内容块。 */
export interface BrowserTextContent {
    /** 内容类型。 */
    type: 'text';
    /** 文本内容。 */
    text: string;
}

/** MCP tool result 图片内容块。 */
export interface BrowserImageContent {
    /** 内容类型。 */
    type: 'image';
    /** base64 图片数据。 */
    data: string;
    /** 图片 MIME 类型。 */
    mimeType: string;
}

/** MCP tool result 内容块。 */
export type BrowserToolContent = BrowserTextContent | BrowserImageContent;

/** 浏览器 MCP 工具执行结果。 */
export interface BrowserToolResult {
    /** 是否为工具执行错误。 */
    isError?: boolean;
    /** 返回给模型的内容块。 */
    content: BrowserToolContent[];
}

/** 一次性 cancellation token 的最小形态。 */
export interface DisposableToken {
    /** 传给 invokeTool 的 token。 */
    token: unknown;
    /** 释放底层资源。 */
    dispose(): void;
}

/** 调用 VS Code Language Model 工具的最小接口。 */
export interface LmToolInvoker {
    /** 调用内置/已注册的 LM 工具。 */
    invokeTool(
        name: string,
        options: { input: Record<string, unknown>; toolInvocationToken?: unknown },
        token?: unknown
    ): Thenable<unknown>;
}

/** 宿主侧读取 VS Code UI kind 的最小接口。 */
export interface BrowserEnvironment {
    /** 当前 VS Code UI kind。 */
    uiKind: vscode.UIKind;
}

/** BrowserToolHost 构造参数。 */
export interface BrowserToolHostOptions {
    /** LM 工具调用器。 */
    lm?: LmToolInvoker;
    /** VS Code 环境信息。 */
    env?: BrowserEnvironment;
    /** 创建一次性 cancellation token。 */
    createCancellation?: () => DisposableToken;
    /** 登录态快照存储；缺省时整套持久化静默禁用。 */
    sessionStore?: BrowserSessionStore;
}

/** 在扩展宿主进程通过 vscode.lm.invokeTool 执行浏览器工具并序列化为 MCP tool result。 */
export class BrowserToolHost implements BrowserToolExecutor {
    /** LM 工具调用器。 */
    private readonly lm: LmToolInvoker;

    /** VS Code 环境信息。 */
    private readonly env: BrowserEnvironment;

    /** 创建一次性 cancellation token。 */
    private readonly createCancellation: () => DisposableToken;

    /** 当前跟踪的浏览器页面 id（最近一次 open 的结果）。 */
    private currentPageId?: string;

    /** 登录态快照存储；未注入时不做任何持久化。 */
    private readonly sessionStore?: BrowserSessionStore;

    /** 当前页 origin，用于搭车快照时校验状态是否落定。 */
    private currentOrigin?: string;

    /** 创建 BrowserToolHost。 */
    public constructor(options: BrowserToolHostOptions = {}) {
        this.lm = options.lm ?? loadVscodeLm();
        this.env = options.env ?? loadVscodeEnv();
        this.createCancellation = options.createCancellation ?? loadVscodeCancellation();
        this.sessionStore = options.sessionStore;
    }

    /** 按浏览器工具名分派到底层 VS Code 内置 LM 浏览器工具。 */
    public async execute(name: BrowserToolName, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
        if (!isBrowserToolName(name)) {
            return this.error(`Unknown tool: ${String(name)}`);
        }
        if (this.env.uiKind !== VS_CODE_DESKTOP_UI_KIND) {
            return this.error('Browser tools are only available in VS Code desktop.');
        }
        if (typeof this.lm?.invokeTool !== 'function') {
            return this.error('vscode.lm.invokeTool is unavailable. Update VS Code to 1.110+ and enable workbench.browser.enableChatTools.');
        }
        try {
            return await this.dispatch(name, args);
        } catch (err) {
            return this.error(describeInvokeFailure(err instanceof Error ? err.message : String(err)));
        } finally {
            // browser_open 自身已在 runOpen 内处理恢复，且此刻页面刚导航完，交由下次调用搭车更稳。
            if (name !== 'browser_open') {
                await this.safeCapture();
            }
        }
    }

    /** 按工具名分派到对应的执行方法。 */
    private async dispatch(name: BrowserToolName, args: Record<string, unknown>): Promise<BrowserToolResult> {
        switch (name) {
            case 'browser_open':
                return await this.runOpen(args);
            case 'browser_navigate':
                return await this.runNavigate(args);
            case 'browser_get_content':
                return await this.runReadPage();
            case 'browser_console':
                return await this.runConsole();
            case 'browser_screenshot':
                return await this.runScreenshot();
            case 'browser_eval':
                return await this.runEval(args);
        }
    }

    /**
     * 打开目标 URL。
     *
     * 内置 open_browser_page 有两种返回形态：
     * - 真正新开了页面 → `Page ID: <uuid>`，此时页面已停在目标 URL；
     * - 命中「已有相似页面」→ 只列出候选页 id 并要求调用方自行处理，**不会导航**，
     *   被复用的页面常常还停在 about:blank。
     *
     * 因此复用分支必须由本方法补一次 navigate，否则表现为「打开总是卡在 about:blank」。
     * 另外注入过登录态时也要重新导航，让 cookie 先于目标页首屏请求生效。
     */
    private async runOpen(args: Record<string, unknown>): Promise<BrowserToolResult> {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) {
            return this.error('`url` is required and must be a non-empty string.');
        }
        const input: Record<string, unknown> = { url };
        if (args.forceNew === true) {
            input.forceNew = true;
        }
        const text = await this.invokeText(LM_BROWSER_TOOLS.open, input);
        const openedPageId = PAGE_ID_RE.exec(text)?.[1];
        const reusedPageId = openedPageId ? undefined : SIMILAR_PAGE_ID_RE.exec(text)?.[1];
        const pageId = openedPageId ?? reusedPageId;
        if (pageId) {
            this.currentPageId = pageId;
        }
        this.currentOrigin = toOrigin(url);

        // 必须先注入凭证再导航，否则目标页首屏接口会抢跑在 cookie 生效之前。
        const restored = await this.restoreSession(url);
        if (!this.currentPageId || (!restored && !reusedPageId)) {
            return { content: [{ type: 'text', text }] };
        }
        const navigated = await this.invokeText(
            LM_BROWSER_TOOLS.navigate,
            { pageId: this.currentPageId, type: 'url', url }
        );
        return { content: [{ type: 'text', text: navigated }] };
    }

    private async runNavigate(args: Record<string, unknown>): Promise<BrowserToolResult> {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) {
            return this.error('`url` is required and must be a non-empty string.');
        }
        const pageId = this.requirePageId();
        if (!pageId) {
            return this.error(NO_PAGE_MESSAGE);
        }
        const text = await this.invokeText(LM_BROWSER_TOOLS.navigate, { pageId, type: 'url', url });
        return { content: [{ type: 'text', text }] };
    }

    private async runReadPage(): Promise<BrowserToolResult> {
        const pageId = this.requirePageId();
        if (!pageId) {
            return this.error(NO_PAGE_MESSAGE);
        }
        const text = await this.invokeText(LM_BROWSER_TOOLS.read, { pageId });
        return { content: [{ type: 'text', text }] };
    }

    private async runConsole(): Promise<BrowserToolResult> {
        const pageId = this.requirePageId();
        if (!pageId) {
            return this.error(NO_PAGE_MESSAGE);
        }
        const text = await this.invokeText(LM_BROWSER_TOOLS.read, { pageId });
        return { content: [{ type: 'text', text: extractRecentEvents(text) }] };
    }

    private async runScreenshot(): Promise<BrowserToolResult> {
        const pageId = this.requirePageId();
        if (!pageId) {
            return this.error(NO_PAGE_MESSAGE);
        }
        const raw = await this.invoke(LM_BROWSER_TOOLS.screenshot, { pageId });
        const image = extractImage(raw);
        if (image) {
            return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
        }
        const text = extractText(raw).trim();
        return this.error(text || 'Screenshot returned no image data.');
    }

    private async runEval(args: Record<string, unknown>): Promise<BrowserToolResult> {
        const code = typeof args.script === 'string' ? args.script.trim() : '';
        if (!code) {
            return this.error('`script` is required and must be a non-empty string.');
        }
        const pageId = this.requirePageId();
        if (!pageId) {
            return this.error(NO_PAGE_MESSAGE);
        }
        const text = await this.invokeText(LM_BROWSER_TOOLS.eval, { pageId, code });
        return { content: [{ type: 'text', text }] };
    }

    /** 返回当前 pageId，不存在时返回 undefined。 */
    private requirePageId(): string | undefined {
        return this.currentPageId;
    }

    /**
     * 按目标 url 的 origin 查快照并注入页面。
     *
     * 返回是否实际注入过；未配置存储、无快照或注入失败均返回 false。
     */
    private async restoreSession(url: string): Promise<boolean> {
        const origin = toOrigin(url);
        if (!this.sessionStore || !origin || !this.currentPageId) {
            return false;
        }
        try {
            const snapshot = await this.sessionStore.load(origin);
            if (!snapshot) {
                return false;
            }
            const now = Date.now();
            const cookies = snapshot.cookies.filter((cookie) => !isExpired(cookie, now));
            if (cookies.length === 0 && snapshot.localStorage.length === 0 && snapshot.sessionStorage.length === 0) {
                return false;
            }
            await this.invoke(LM_BROWSER_TOOLS.eval, {
                pageId: this.currentPageId,
                code: buildImportScript({ ...snapshot, cookies })
            });
            return true;
        } catch (err) {
            Logger.warn(`浏览器登录态恢复失败：${origin}`, err);
            return false;
        }
    }

    /**
     * 导出当前页登录态并按 origin 落盘。
     *
     * 仅在状态落定时写入：origin 为 http(s)、页面已加载完成、且与当前 origin 一致。
     * 任一不满足则跳过本次快照（不写入也不清除）。
     * 注意此处不做非空守卫——用户主动登出时空 cookie 即正确状态，须如实覆盖。
     */
    private async captureSession(): Promise<void> {
        if (!this.sessionStore || !this.currentPageId) {
            return;
        }
        const raw = await this.invokeText(LM_BROWSER_TOOLS.eval, {
            pageId: this.currentPageId,
            code: EXPORT_SCRIPT
        });
        const payload = parseExportResult(raw);
        if (!payload) {
            return;
        }
        const origin = toOrigin(payload.url);
        if (!origin || (this.currentOrigin && origin !== this.currentOrigin)) {
            return;
        }
        this.currentOrigin = origin;
        await this.sessionStore.save({
            origin,
            savedAt: new Date().toISOString(),
            cookies: payload.cookies,
            localStorage: payload.localStorage,
            sessionStorage: payload.sessionStorage
        });
    }

    /** 包裹 captureSession，吞掉全部异常——持久化失败绝不能影响主工具返回值。 */
    private async safeCapture(): Promise<void> {
        if (!this.sessionStore) {
            return;
        }
        try {
            await this.captureSession();
        } catch (err) {
            Logger.warn('浏览器登录态保存失败，已忽略。', err);
        }
    }

    /** 调用 LM 工具并把结果内容拼成文本。 */
    private async invokeText(name: string, input: Record<string, unknown>): Promise<string> {
        return extractText(await this.invoke(name, input));
    }

    /** 调用 LM 工具，返回原始 LanguageModelToolResult。 */
    private async invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
        const cancellation = this.createCancellation();
        try {
            return await this.lm.invokeTool(name, { input, toolInvocationToken: undefined }, cancellation.token);
        } finally {
            cancellation.dispose();
        }
    }

    /** 构造统一 MCP isError 结果。 */
    private error(text: string): BrowserToolResult {
        return { isError: true, content: [{ type: 'text', text }] };
    }
}

/** Chromium 未能创建浏览器上下文时的内部报错特征（Linux 上最常见）。 */
const BROKEN_CONTEXT_RE = /newPage[\s\S]*reading '_page'|Target page, context or browser has been closed/;

/**
 * 给内置浏览器的底层报错补一段可操作的定位提示。
 *
 * VS Code 内置浏览器在 Linux 上常因缺少 Chromium 运行库、无可用显示或沙箱受限而
 * 创建不出浏览器上下文，抛出的原始信息（读取 `_page` 失败）无法指向真实原因。
 */
function describeInvokeFailure(message: string): string {
    if (!BROKEN_CONTEXT_RE.test(message)) {
        return message;
    }
    return `${message}\n\nVS Code 内置浏览器未能创建页面（常见于 Linux）。请检查：`
        + '\n1. 安装 Chromium 运行依赖（libnss3、libatk-1.0、libgbm、libasound2 等）；'
        + '\n2. 无桌面环境时提供显示，如 xvfb-run 启动 VS Code；'
        + '\n3. root 账户下需允许沙箱或以非 root 用户运行；'
        + '\n4. 在命令面板执行 "Developer: Reload Window" 后重试 browser_open。';
}

/** 从 LanguageModelToolResult 抽取全部文本内容块拼接成字符串。 */
function extractText(raw: unknown): string {
    if (typeof raw === 'string') {
        return raw;
    }
    const parts = toContentArray(raw);
    const texts: string[] = [];
    for (const part of parts) {
        if (typeof part === 'string') {
            texts.push(part);
            continue;
        }
        if (part && typeof part === 'object') {
            const value = (part as { value?: unknown }).value;
            if (typeof value === 'string') {
                texts.push(value);
            }
        }
    }
    return texts.join('\n');
}

/** 从 LanguageModelToolResult 抽取第一个二进制图片部件并 base64 编码。 */
function extractImage(raw: unknown): { data: string; mimeType: string } | undefined {
    for (const part of toContentArray(raw)) {
        if (!part || typeof part !== 'object') {
            continue;
        }
        const source = part as { data?: unknown; mimeType?: unknown };
        const base64 = toBase64(source.data);
        if (!base64) {
            continue;
        }
        const mimeType = typeof source.mimeType === 'string' && source.mimeType.trim().length > 0
            ? source.mimeType.trim()
            : 'image/jpeg';
        return { data: base64, mimeType };
    }
    return undefined;
}

/** 把 LanguageModelToolResult / 数组 / 单值统一成内容块数组。 */
function toContentArray(raw: unknown): unknown[] {
    if (Array.isArray(raw)) {
        return raw;
    }
    if (raw && typeof raw === 'object') {
        const content = (raw as { content?: unknown }).content;
        if (Array.isArray(content)) {
            return content;
        }
    }
    return raw === undefined || raw === null ? [] : [raw];
}

/** 把多种二进制形态（Uint8Array / Buffer / {type:'Buffer',data} / VSBuffer.buffer）转成 base64，非二进制返回空。 */
function toBase64(data: unknown): string {
    if (!data) {
        return '';
    }
    if (data instanceof Uint8Array) {
        return data.byteLength > 0 ? Buffer.from(data).toString('base64') : '';
    }
    if (typeof data === 'object') {
        const obj = data as { data?: unknown; buffer?: unknown };
        if (Array.isArray(obj.data) && obj.data.length > 0) {
            return Buffer.from(obj.data as number[]).toString('base64');
        }
        if (obj.buffer instanceof Uint8Array && obj.buffer.byteLength > 0) {
            return Buffer.from(obj.buffer).toString('base64');
        }
    }
    return '';
}

/** 从 read_page 文本里截取 `Recent events:` 段，没有则给出占位说明。 */
function extractRecentEvents(text: string): string {
    const idx = text.indexOf('Recent events:');
    if (idx < 0) {
        return 'No console events recorded for the current page.';
    }
    const rest = text.slice(idx);
    const snapshotIdx = rest.indexOf('\nSnapshot:');
    return (snapshotIdx >= 0 ? rest.slice(0, snapshotIdx) : rest).trim();
}

function loadVscodeLm(): LmToolInvoker {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode').lm as LmToolInvoker;
}

function loadVscodeEnv(): BrowserEnvironment {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode').env as BrowserEnvironment;
}

function loadVscodeCancellation(): () => DisposableToken {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscodeApi = require('vscode') as { CancellationTokenSource: new () => { token: unknown; dispose(): void } };
    return () => new vscodeApi.CancellationTokenSource();
}
