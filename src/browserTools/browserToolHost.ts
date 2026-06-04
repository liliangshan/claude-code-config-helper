/** @file 浏览器工具宿主侧执行器（基于 vscode.lm.invokeTool 调用内置浏览器工具）。 */

import type * as vscode from 'vscode';

import { LM_BROWSER_TOOLS, isBrowserToolName, type BrowserToolName } from './tools';

/** 执行浏览器工具的统一接口（真实宿主与 HTTP 转发宿主都实现）。 */
export interface BrowserToolExecutor {
    /** 执行一个浏览器工具并返回 MCP 结果。 */
    execute(name: BrowserToolName, args?: Record<string, unknown>): Promise<BrowserToolResult>;
}

const VS_CODE_DESKTOP_UI_KIND = 1;
const PAGE_ID_RE = /Page ID:\s*([0-9a-fA-F-]{36})/;
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

    /** 创建 BrowserToolHost。 */
    public constructor(options: BrowserToolHostOptions = {}) {
        this.lm = options.lm ?? loadVscodeLm();
        this.env = options.env ?? loadVscodeEnv();
        this.createCancellation = options.createCancellation ?? loadVscodeCancellation();
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
        } catch (err) {
            return this.error(err instanceof Error ? err.message : String(err));
        }
    }

    private async runOpen(args: Record<string, unknown>): Promise<BrowserToolResult> {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) {
            return this.error('`url` is required and must be a non-empty string.');
        }
        const text = await this.invokeText(LM_BROWSER_TOOLS.open, { url });
        const pageId = PAGE_ID_RE.exec(text)?.[1];
        if (pageId) {
            this.currentPageId = pageId;
        }
        return { content: [{ type: 'text', text }] };
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
