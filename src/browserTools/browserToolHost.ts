/** @file 浏览器工具宿主侧执行器。 */

import type * as vscode from 'vscode';

import { VSCODE_BROWSER_COMMANDS, isBrowserToolName, type BrowserToolName } from './tools';

const VS_CODE_DESKTOP_UI_KIND = 1;
const GET_CONTENT_SCRIPT = `return await page.evaluate(() => ({ title: document.title, url: location.href, text: document.body?.innerText || '', html: document.documentElement?.outerHTML || '' }))`;
const GET_CONSOLE_SCRIPT = `return await page.evaluate(() => ({ title: document.title, url: location.href, note: 'Console logs are only available when VS Code exposes them through the browser agent runtime.' }))`;
const SCREENSHOT_SCRIPT = `return await page.screenshot({ type: 'png', fullPage: false })`;
const OPEN_BROWSER_COMMAND_CANDIDATES = [
    'openBrowserPage',
    'browser.openIntegratedBrowser',
    'workbench.action.openIntegratedBrowser',
    'simpleBrowser.show'
] as const;

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

/** 宿主侧执行 vscode.commands 浏览器命令的最小接口。 */
export interface BrowserCommandExecutor {
    /** 执行 VS Code 命令并返回原始结果。 */
    executeCommand<T = unknown>(command: string, ...args: unknown[]): Thenable<T>;
    /** 枚举已注册命令；缺省时会直接尝试候选命令。 */
    getCommands?(filterInternal?: boolean): Thenable<string[]>;
}

/** 宿主侧读取 VS Code UI kind 的最小接口。 */
export interface BrowserEnvironment {
    /** 当前 VS Code UI kind。 */
    uiKind: vscode.UIKind;
}

/** BrowserToolHost 构造参数。 */
export interface BrowserToolHostOptions {
    /** VS Code 命令执行器。 */
    commands?: BrowserCommandExecutor;
    /** VS Code 环境信息。 */
    env?: BrowserEnvironment;
}

/** 在扩展宿主进程执行浏览器工具并序列化为 MCP tool result。 */
export class BrowserToolHost {
    /** VS Code 命令执行器。 */
    private readonly commands: BrowserCommandExecutor;

    /** VS Code 环境信息。 */
    private readonly env: BrowserEnvironment;

    /** 创建 BrowserToolHost。 */
    public constructor(options: BrowserToolHostOptions = {}) {
        this.commands = options.commands ?? loadVscodeCommands();
        this.env = options.env ?? loadVscodeEnv();
    }

    /** 按浏览器工具名分派到底层 VS Code agent 浏览器命令。 */
    public async execute(name: BrowserToolName, args: Record<string, unknown> = {}): Promise<BrowserToolResult> {
        if (!isBrowserToolName(name)) {
            return this.error(`Unknown tool: ${String(name)}`);
        }
        if (this.env.uiKind !== VS_CODE_DESKTOP_UI_KIND) {
            return this.error('Browser tools are only available in VS Code desktop.');
        }
        try {
            switch (name) {
                case 'browser_open':
                    return await this.runOpen(args);
                case 'browser_navigate':
                    return await this.runRequiredStringArg(VSCODE_BROWSER_COMMANDS.navigate, args, 'url');
                case 'browser_get_content':
                    return await this.runText(VSCODE_BROWSER_COMMANDS.eval, GET_CONTENT_SCRIPT);
                case 'browser_console':
                    return await this.runText(VSCODE_BROWSER_COMMANDS.eval, GET_CONSOLE_SCRIPT);
                case 'browser_screenshot':
                    return await this.runScreenshot();
                case 'browser_eval':
                    return await this.runRequiredStringArg(VSCODE_BROWSER_COMMANDS.eval, args, 'script');
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
        const command = await this.pickCommand(OPEN_BROWSER_COMMAND_CANDIDATES);
        if (!command) {
            return this.error('No VS Code browser open command is available. Enable the VS Code Integrated Browser or Simple Browser extension.');
        }
        const raw = await this.commands.executeCommand<unknown>(command, url);
        const suffix = command === VSCODE_BROWSER_COMMANDS.open
            ? ''
            : `\nOpened via fallback command \`${command}\`; browser automation commands such as screenshot/eval may not be available in this VS Code build.`;
        return { content: [{ type: 'text', text: this.stringify(raw) + suffix }] };
    }

    /** 执行需要非空字符串参数的命令。 */
    private async runRequiredStringArg(
        command: string,
        args: Record<string, unknown>,
        key: string
    ): Promise<BrowserToolResult> {
        const value = typeof args[key] === 'string' ? args[key].trim() : '';
        if (!value) {
            return this.error(`\`${key}\` is required and must be a non-empty string.`);
        }
        return this.runText(command, value);
    }

    private async pickCommand(candidates: readonly string[]): Promise<string | undefined> {
        if (!this.commands.getCommands) {
            return candidates[0];
        }
        const available = new Set(await this.commands.getCommands(true));
        return candidates.find((command) => available.has(command));
    }

    /** 执行命令并将返回值序列化为文本内容。 */
    private async runText(command: string, ...cmdArgs: unknown[]): Promise<BrowserToolResult> {
        const raw = await this.commands.executeCommand<unknown>(command, ...cmdArgs);
        return { content: [{ type: 'text', text: this.stringify(raw) }] };
    }

    /** 执行截图命令并将返回值序列化为 MCP image content。 */
    private async runScreenshot(): Promise<BrowserToolResult> {
        const raw = await this.commands.executeCommand<unknown>(VSCODE_BROWSER_COMMANDS.eval, SCREENSHOT_SCRIPT);
        const image = this.extractImage(raw);
        if (!image) {
            return this.error('Screenshot command returned no image data.');
        }
        return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
    }

    /** 从底层截图命令返回值中提取 base64 图片。 */
    private extractImage(raw: unknown): { data: string; mimeType: string } | undefined {
        if (typeof raw === 'string' && raw.trim().length > 0) {
            return { data: this.stripDataUrlPrefix(raw.trim()), mimeType: this.inferMimeType(raw) };
        }
        if (!raw || typeof raw !== 'object') {
            return undefined;
        }
        const source = raw as Record<string, unknown>;
        const data = typeof source.data === 'string'
            ? source.data
            : typeof source.base64 === 'string'
                ? source.base64
                : undefined;
        if (!data || data.trim().length === 0) {
            return undefined;
        }
        const mimeType = typeof source.mimeType === 'string' && source.mimeType.trim().length > 0
            ? source.mimeType.trim()
            : this.inferMimeType(data);
        return { data: this.stripDataUrlPrefix(data.trim()), mimeType };
    }

    /** 去掉 data URL 头部，只保留 base64 数据。 */
    private stripDataUrlPrefix(data: string): string {
        const match = /^data:[^;]+;base64,(.*)$/i.exec(data);
        return match ? match[1] : data;
    }

    /** 从 data URL 粗略推断 MIME 类型，无法推断时使用 image/png。 */
    private inferMimeType(data: string): string {
        const match = /^data:([^;]+);base64,/i.exec(data);
        return match ? match[1] : 'image/png';
    }

    /** 将未知返回值序列化为稳定文本。 */
    private stringify(raw: unknown): string {
        if (typeof raw === 'string') {
            return raw;
        }
        if (raw === undefined) {
            return 'null';
        }
        try {
            return JSON.stringify(raw ?? null);
        } catch (err) {
            return err instanceof Error ? err.message : String(raw);
        }
    }

    /** 构造统一 MCP isError 结果。 */
    private error(text: string): BrowserToolResult {
        return { isError: true, content: [{ type: 'text', text }] };
    }
}

function loadVscodeCommands(): BrowserCommandExecutor {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode').commands as BrowserCommandExecutor;
}

function loadVscodeEnv(): BrowserEnvironment {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode').env as BrowserEnvironment;
}
