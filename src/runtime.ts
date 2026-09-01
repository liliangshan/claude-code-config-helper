/**
 * 扩展运行期全局单例访问器。
 *
 * 该模块只承载「整个扩展生命周期唯一」的实例引用，供各子系统模块跨文件读取，
 * 避免直接导出可变 `let` 造成引用绑定断裂。
 *
 * 约束：本文件禁止 import 任何业务模块（只允许 import type），
 * 以保证它处于依赖图最底层，不会产生循环依赖。
 */
import type * as vscode from 'vscode';
import type { ChatViewHost } from './chat/chatViewHost';
import type { ConfigManager } from './configManager';
import type { LlsTaskService } from './llsTask/service';
import type { RelayServer } from './relay/server';
import type { SettingsWriter } from './settingsWriter';
import type { ConfigWebviewViewProvider } from './views/configView';

/** 扩展上下文实例，用于 Chat 会话 workspaceState 持久化。 */
let extensionContext: vscode.ExtensionContext | undefined;

/** 配置管理器实例，便于 deactivate 兜底释放。 */
let configManager: ConfigManager | undefined;

/** Chat WebviewPanel 宿主实例。 */
let chatViewHost: ChatViewHost | undefined;

/** Claude Code settings.json 写入器。 */
let settingsWriter: SettingsWriter | undefined;

/** 本地 HTTP 中转服务实例，一个扩展宿主/工作区使用一个随机空闲端口。 */
let relayServer: RelayServer | undefined;

/** LLS CCAI 任务流服务实例。 */
let llsTaskService: LlsTaskService | undefined;

/** 侧栏配置视图 Provider，命令层需要用它聚焦设置页。 */
let configViewProvider: ConfigWebviewViewProvider | undefined;

/** 写入侧栏配置视图 Provider；传 undefined 表示 deactivate 时清空。 */
export function setConfigViewProvider(value: ConfigWebviewViewProvider | undefined): void {
    configViewProvider = value;
}

/** 读取侧栏配置视图 Provider，未初始化时返回 undefined。 */
export function getConfigViewProvider(): ConfigWebviewViewProvider | undefined {
    return configViewProvider;
}

/** 写入扩展上下文实例；传 undefined 表示 deactivate 时清空。 */
export function setExtensionContext(value: vscode.ExtensionContext | undefined): void {
    extensionContext = value;
}

/** 读取扩展上下文实例，未激活完成时返回 undefined。 */
export function getExtensionContext(): vscode.ExtensionContext | undefined {
    return extensionContext;
}

/** 写入配置管理器实例；传 undefined 表示 deactivate 时清空。 */
export function setConfigManager(value: ConfigManager | undefined): void {
    configManager = value;
}

/** 读取配置管理器实例，未激活完成时返回 undefined。 */
export function getConfigManager(): ConfigManager | undefined {
    return configManager;
}

/** 写入 Chat Webview 宿主实例；传 undefined 表示已释放。 */
export function setChatViewHost(value: ChatViewHost | undefined): void {
    chatViewHost = value;
}

/** 读取 Chat Webview 宿主实例，Chat 未创建时返回 undefined。 */
export function getChatViewHost(): ChatViewHost | undefined {
    return chatViewHost;
}

/** 写入 settings.json 写入器实例；传 undefined 表示已释放。 */
export function setSettingsWriter(value: SettingsWriter | undefined): void {
    settingsWriter = value;
}

/** 读取 settings.json 写入器实例，未激活完成时返回 undefined。 */
export function getSettingsWriter(): SettingsWriter | undefined {
    return settingsWriter;
}

/** 写入本地中转服务实例；传 undefined 表示已停止。 */
export function setRelayServer(value: RelayServer | undefined): void {
    relayServer = value;
}

/** 读取本地中转服务实例，未启动时返回 undefined。 */
export function getRelayServer(): RelayServer | undefined {
    return relayServer;
}

/** 写入任务流服务实例；传 undefined 表示已释放。 */
export function setLlsTaskService(value: LlsTaskService | undefined): void {
    llsTaskService = value;
}

/** 读取任务流服务实例，未激活完成时返回 undefined。 */
export function getLlsTaskService(): LlsTaskService | undefined {
    return llsTaskService;
}
