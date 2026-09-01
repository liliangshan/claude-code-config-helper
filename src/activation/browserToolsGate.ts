/**
 * 浏览器工具自动放行的能力判定、状态推送与一键开启。
 *
 * 拆分自 extension.ts：把「判断当前 VS Code 是否支持内置浏览器工具、两项放行
 * 设置是否已开启、向 Chat Webview 推送状态、以及用户点击提示后一次性写入设置」
 * 这条链路收敛到一个模块。
 *
 * 依赖方向：本模块只依赖 runtime 的 chatViewHost 访问器，不被其它模块反向引用。
 */
import * as vscode from 'vscode';

import { Logger } from '../logger';
import { getChatViewHost } from '../runtime';

/** VS Code 全局「自动放行所有 agent 工具」设置键。 */
export const TOOL_AUTO_APPROVE_KEY = 'chat.tools.global.autoApprove';
/** VS Code 内置浏览器工具开关设置键。 */
const BROWSER_ENABLE_CHAT_TOOLS_KEY = 'workbench.browser.enableChatTools';
/** vscode.env.uiKind 中代表桌面端的取值。 */
const VS_CODE_DESKTOP_UI_KIND = 1;

/**
 * 启动期的浏览器工具提示入口：仅回推一次自动放行状态，不弹任何阻塞式窗口。
 */
export async function promptEnableBrowserChatToolsIfNeeded(): Promise<void> {
    // 不再使用任何阻塞式弹窗（会卡住激活/加载）。浏览器相关设置统一由 Chat 输入框
    // 下方「CC 任务流」按钮后的内联提示驱动：用户点击后一次性开启所需设置。
    await postBrowserAutoApproveState();
}

/** 是否应在 Chat 中提供「免去浏览器确认」提示：仅要求 VS Code ≥ 1.110 且为桌面端。 */
export function isBrowserToolsSupported(): boolean {
    if (!isVsCodeAtLeast(1, 110)) return false;
    return vscode.env.uiKind === VS_CODE_DESKTOP_UI_KIND;
}

/** 浏览器自动放行所需的两项设置是否都已开启。 */
export function isBrowserFullyAutoApproved(): boolean {
    const root = vscode.workspace.getConfiguration();
    const autoApprove = root.get<boolean>(TOOL_AUTO_APPROVE_KEY, false) === true;
    const enableChatTools = root.get<boolean>(BROWSER_ENABLE_CHAT_TOOLS_KEY, false) === true;
    return autoApprove && enableChatTools;
}

/**
 * 向 Chat Webview 推送浏览器工具自动放行状态，驱动 CC 任务流后的「免去浏览器确认」提示按钮显隐。
 *
 * 不再使用阻塞式弹窗（会卡住激活/加载）；改为前端在任务流按钮旁内联提示，用户点击后再开启。
 */
export async function postBrowserAutoApproveState(): Promise<void> {
    await getChatViewHost()?.postMessage({
        type: 'browser/autoApproveState',
        supported: isBrowserToolsSupported(),
        enabled: isBrowserFullyAutoApproved()
    });
}

/**
 * 应前端「免去浏览器确认」提示点击，一次性开启浏览器工具所需的两项 VS Code 设置并回推最新状态。
 *
 * - workbench.browser.enableChatTools：开启内置浏览器工具；
 * - chat.tools.global.autoApprove：免去每次「Open Browser Page?」确认（会放行所有 agent 工具，
 *   含写文件、跑命令），因此仅在用户主动点击提示时才写入。
 */
export async function enableBrowserAutoApprove(): Promise<void> {
    const root = vscode.workspace.getConfiguration();
    await root.update(BROWSER_ENABLE_CHAT_TOOLS_KEY, true, vscode.ConfigurationTarget.Global);
    await root.update(TOOL_AUTO_APPROVE_KEY, true, vscode.ConfigurationTarget.Global);
    Logger.info('已开启浏览器工具自动放行（来自 Chat 提示点击）：enableChatTools=true, chat.tools.global.autoApprove=true');
    await postBrowserAutoApproveState();
}

/**
 * 判断当前 VS Code 版本是否不低于给定的主次版本号。
 *
 * @param major 目标主版本号。
 * @param minor 目标次版本号。
 */
export function isVsCodeAtLeast(major: number, minor: number): boolean {
    const parts = vscode.version.split('.').map((part) => Number.parseInt(part, 10));
    const currentMajor = Number.isFinite(parts[0]) ? parts[0] : 0;
    const currentMinor = Number.isFinite(parts[1]) ? parts[1] : 0;
    return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}
