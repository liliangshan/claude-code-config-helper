/** @file 按 pageId 显示已有集成浏览器标签，不导航或重新创建页面。 */
import type * as vscode from 'vscode';

/** VS Code 内置浏览器编辑器标识；浏览器 URI 使用页面 UUID 作为路径。 */
const BROWSER_EDITOR_ID = 'workbench.editor.browser';

/** 显示浏览器页所需的最小 VS Code API，方便隔离测试。 */
export interface BrowserPageRevealApi {
    /** 构造浏览器资源 URI。 */
    Uri: Pick<typeof vscode.Uri, 'from'>;
    /** 使用公开的 vscode.openWith 打开指定编辑器。 */
    commands: Pick<typeof vscode.commands, 'executeCommand'>;
    /** 如标签 API 提供资源 URI，则优先保持原有编辑器分组。 */
    window: { tabGroups?: Pick<typeof vscode.window.tabGroups, 'all'> };
}

/**
 * 将指定页面的浏览器标签切到编辑区前台，同时保留聊天输入框焦点。
 *
 * 仅使用 pageId 对应的 vscode-browser 资源，不传 URL 或 viewState，避免导航或刷新。
 * 标签 URI 可见时复用原分组；内部编辑器不可用时由宿主捕获错误并继续工具调用。
 * @param pageId 已打开页面的 UUID。
 * @param api 可替换的 VS Code API，默认从扩展宿主读取。
 * @returns 编辑器显示完成。
 */
export async function revealBrowserPage(
    pageId: string,
    api: BrowserPageRevealApi = require('vscode') as BrowserPageRevealApi
): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
        throw new Error('Invalid browser page ID');
    }
    const resource = api.Uri.from({ scheme: 'vscode-browser', path: `/${pageId}` });
    const group = api.window.tabGroups?.all.find(candidate => candidate.tabs.some(tab => {
        const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
        return uri?.scheme === resource.scheme && uri.path === resource.path;
    }));
    await api.commands.executeCommand('vscode.openWith', resource, BROWSER_EDITOR_ID, {
        ...(group ? { viewColumn: group.viewColumn } : {}),
        preview: false,
        preserveFocus: true
    });
}
