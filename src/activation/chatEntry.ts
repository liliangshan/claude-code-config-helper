/**
 * 内置 Chat 面板的打开入口与启动期自动展开。
 *
 * 拆分自 extension.ts：把「确保 CLI 已启动 → 展示隐私提示 → 打开 WebviewPanel」
 * 这条入口链路，以及激活末尾「已配置 CLI 路径时自动展开」的兜底调用收敛到一个模块。
 *
 * 依赖方向：本模块位于 chatRuntime 之上，直接 import 会话与生命周期模块；不被其反向引用。
 */
import { chatSessionState, showChatSessionPrivacyNoticeIfNeeded } from '../chatRuntime/chatSession';
import { ensureChatCliStarted, getChatCliConfigService } from '../chatRuntime/cliLifecycle';
import { Logger } from '../logger';
import { getChatViewHost } from '../runtime';

/**
 * 打开内置 Chat 入口并确保 CLI 长连接已启动。
 *
 * 打开前会先拉起 CLI 并按需展示会话隐私提示，随后把已恢复的历史消息与当前
 * CLI 路径一起交给 WebviewPanel 渲染。
 */
export async function openBuiltInChat(): Promise<void> {
    await ensureChatCliStarted();
    const host = getChatViewHost();
    const cliConfig = getChatCliConfigService();
    if (!host || !cliConfig) {
        throw new Error('Chat Webview 组件尚未初始化');
    }
    await showChatSessionPrivacyNoticeIfNeeded();
    await host.open(chatSessionState.messages, cliConfig.getConfig().cliPath);
}

/**
 * 启动后在已配置 CLI 路径时自动展开内置 Chat。
 *
 * 不主动弹出路径选择框；只有用户已经保存过 CLI 路径时才会尝试启动并打开面板。
 * 启动失败只记录日志，避免扩展激活阶段用错误弹窗打断用户。
 */
export async function autoOpenBuiltInChatIfCliConfigured(): Promise<void> {
    const cliPath = getChatCliConfigService()?.getConfig().cliPath;
    if (!cliPath) return;
    try {
        await openBuiltInChat();
    } catch (err) {
        Logger.error('启动时自动展开内置 Chat 失败', err);
    }
}
