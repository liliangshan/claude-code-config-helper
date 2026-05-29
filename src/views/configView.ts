/**
 * @file 配置 Webview 后端。
 *
 * Vendored layout idea from liliangshan.openapi-compatible-copilot/src/views/configView.ts，
 * 当前版本提供 Provider/Model 管理、内置 Chat 设置与共享提示词入口。
 */

import * as vscode from 'vscode';

import { ConfigManager } from '../configManager';
import { COMMANDS, WEBVIEW_TITLE, WEBVIEW_VIEW_TYPE } from '../constants';
import { Logger } from '../logger';
import { fetchModels } from '../modelFetcher';
import type {
    AdItem,
    ConfigViewState,
    ExtensionMessage,
    ToastLevel,
    WebviewMessage
} from '../types';

/**
 * 顶部广告接口地址，与 liliangshan.openapi-compatible-copilot 项目保持一致，
 * 由阿里云 OSS 提供静态 JSON；每条数据形如 `{ image, url }`。
 */
const TOP_AD_ENDPOINT = 'https://ads-starmodel.oss-cn-shenzhen.aliyuncs.com/data2.json';

/** 顶部广告网络请求超时时间，单位毫秒；超时直接静默放弃，不影响设置页可用性。 */
const TOP_AD_FETCH_TIMEOUT_MS = 3_000;

/**
 * 把远端返回的任意一项规范化为内部 {@link AdItem}。
 *
 * 接口数据不可信，必须显式过滤：
 * - 字段 `image` / `url` 都是非空字符串；
 * - 都是 `https://` 起头（避免 webview 在严格 CSP 下加载失败，
 *   也避免点击跳转打开非 http(s) 链接）。
 *
 * @param raw 远端原始 JSON 项。
 * @returns 规范化后的广告项；任意校验未通过返回 `null`。
 */
function normalizeAdItem(raw: unknown): AdItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as { image?: unknown; url?: unknown };
    const image = typeof candidate.image === 'string' ? candidate.image.trim() : '';
    const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
    if (!image || !url) return null;
    if (!/^https:\/\//i.test(image)) return null;
    if (!/^https?:\/\//i.test(url)) return null;
    return { image, url };
}

/** 可承载配置页的 Webview 宿主。 */
type ConfigWebviewHost = vscode.WebviewPanel | vscode.WebviewView;

/**
 * 判断两次当前模型选择是否一致。
 *
 * @param left 旧的当前模型选择。
 * @param right 新的当前模型选择。
 * @returns providerId 与 modelId 都一致时返回 true。
 */
function isSameCurrentModelSelection(
    left: ConfigViewState['currentModel'],
    right: ConfigViewState['currentModel']
): boolean {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return left.providerId === right.providerId && left.modelId === right.modelId;
}

/**
 * 配置 Webview 共享控制器。
 *
 * 同一套前端既可以显示在 Activity Bar 的 WebviewView 中，也可以作为备用打开到编辑器 WebviewPanel。
 */
class ConfigWebviewController implements vscode.Disposable {
    /** 待释放资源集合。 */
    private readonly disposables: vscode.Disposable[] = [];

    /**
     * 顶部广告接口数据缓存。
     *
     * 接口返回的是数组，每次只随机展示一条；多次进入视图时复用缓存，避免重复网络请求。
     * 缓存仅保留在控制器实例中，控制器随宿主销毁；下次重新打开会重新请求。
     */
    private adCache: AdItem[] | null = null;

    /**
     * 创建共享 Webview 控制器。
     *
     * @param context 扩展上下文。
     * @param manager 配置管理器。
     * @param host WebviewPanel 或 WebviewView 宿主。
     * @param onDispose 宿主释放时的回调。
     */
    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly manager: ConfigManager,
        private readonly host: ConfigWebviewHost,
        onDispose?: () => void
    ) {
        this.configureWebview();
        this.webview.html = this.renderHtml();
        this.disposables.push(
            this.webview.onDidReceiveMessage((message: WebviewMessage) => {
                void this.handleMessage(message);
            }),
            this.manager.onDidChange(() => this.postState())
        );
        if ('onDidDispose' in host) {
            this.disposables.push(host.onDidDispose(() => {
                onDispose?.();
                this.dispose();
            }));
        }
        // 视图初次创建时立即拉取一次顶部广告；网络失败会被静默吞掉，不影响设置页。
        void this.loadAd();
        // 视图从隐藏切换为可见时再尝试拉取一次（缓存命中时不会触发网络请求），
        // 让用户每次回到设置页都能看到广告位的最新状态。
        this.registerVisibilityRefresh();
    }

    /**
     * 注册宿主可见性变化监听，可见时重新触发一次广告加载。
     *
     * WebviewView 走 `onDidChangeVisibility`，WebviewPanel 走 `onDidChangeViewState`；
     * 这里统一封装，避免在构造里写两套分支。
     */
    private registerVisibilityRefresh(): void {
        const host = this.host;
        if ('onDidChangeVisibility' in host && typeof host.onDidChangeVisibility === 'function') {
            this.disposables.push(host.onDidChangeVisibility(() => {
                if (host.visible) {
                    void this.loadAd();
                }
            }));
            return;
        }
        if ('onDidChangeViewState' in host && typeof host.onDidChangeViewState === 'function') {
            this.disposables.push(host.onDidChangeViewState(() => {
                if (host.visible) {
                    void this.loadAd();
                }
            }));
        }
    }

    /** 主动向前端推送最新状态。 */
    public refresh(): void {
        this.postState();
    }

    /** 释放 Webview 相关资源。 */
    public dispose(): void {
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    /** 获取当前宿主的 Webview 对象。 */
    private get webview(): vscode.Webview {
        return this.host.webview;
    }

    /** 配置 Webview 安全选项与资源根路径。 */
    private configureWebview(): void {
        this.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };
    }

    /** 处理 Webview 前端发来的消息。 */
    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                    this.postState();
                    return;
                case 'openSettingsJson':
                    await vscode.commands.executeCommand(COMMANDS.openSettingsJson);
                    return;
                case 'openGlobalSharedSettings':
                    await vscode.commands.executeCommand(COMMANDS.openGlobalSharedSettings);
                    return;
                case 'openWorkspaceSharedSettings':
                    await vscode.commands.executeCommand(COMMANDS.openWorkspaceSharedSettings);
                    return;
                case 'selectChatCliPath':
                    await vscode.commands.executeCommand(COMMANDS.chatSelectCli);
                    await vscode.commands.executeCommand(COMMANDS.chatOpen);
                    this.postState();
                    return;
                case 'reloadWindow':
                    await vscode.commands.executeCommand(COMMANDS.reloadWindow);
                    return;
                case 'setCurrentModel': {
                    const previousModel = this.manager.getCurrentModel();
                    await this.manager.setCurrentModel(message.payload);
                    this.postToast('success', message.payload ? '已切换当前模型并同步配置' : '已清空当前模型');
                    if (!isSameCurrentModelSelection(previousModel, message.payload)) {
                        await vscode.commands.executeCommand(COMMANDS.reloadWindow);
                    }
                    return;
                }
                case 'saveProviders':
                    if (Array.isArray(message.payload)) {
                        await this.manager.replaceProviders(message.payload);
                    } else {
                        await this.manager.replaceProviders(
                            message.payload.providers,
                            message.payload.providerApiKeys
                        );
                    }
                    this.postToast('success', '已保存提供商配置');
                    return;
                case 'exportConfig':
                    await this.exportConfig();
                    return;
                case 'importConfig':
                    await this.importConfig();
                    return;
                case 'updateUiLanguage':
                    await this.manager.updateUiLanguage(message.payload);
                    this.postState();
                    return;
                case 'updateTaskFlowBypassPermissions':
                    await this.manager.updateTaskFlowBypassPermissions(message.payload);
                    this.postState();
                    this.postToast('warn', message.payload
                        ? '已启用任务流 bypass permissions；一键写入时会同步 Claude Code 危险权限设置'
                        : '已关闭任务流 bypass permissions；一键写入时会恢复 Claude Code 默认权限模式');
                    return;
                case 'showInfo':
                    this.postToast('info', message.payload.message);
                    return;
                case 'fetchProviderModels':
                    await this.fetchProviderModels(message.payload.providerId);
                    return;
                case 'openUrl': {
                    // 前端点击顶部广告会发来 openUrl 请求；这里收一次校验后用 VS Code
                    // 标准 API 打开外部链接，避免在 webview 里直接 window.open（CSP 默认禁止）。
                    const url = message.payload?.url?.trim();
                    if (!url) return;
                    try {
                        const parsed = vscode.Uri.parse(url, true);
                        if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
                            Logger.warn(`拒绝打开非 http(s) 链接: ${url}`);
                            return;
                        }
                        await vscode.env.openExternal(parsed);
                    } catch (err) {
                        Logger.warn(`打开外部链接失败: ${err instanceof Error ? err.message : String(err)}`);
                    }
                    return;
                }
                default:
                    this.postToast('warn', '暂不支持的操作');
            }
        } catch (error) {
            Logger.error('处理 Webview 消息失败', error);
            this.postToast('error', error instanceof Error ? error.message : String(error));
        }
    }

    /** 使用已保存的提供商配置和密钥拉取模型列表。 */
    private async fetchProviderModels(providerId: string): Promise<void> {
        const provider = await this.manager.getProviderWithSecret(providerId);
        if (!provider) throw new Error('提供商不存在');
        if (provider.enabled === false) {
            this.postToast('warn', `提供商 ${provider.name} 已禁用，跳过模型拉取`);
            return;
        }
        const result = await fetchModels({
            baseUrl: provider.baseUrl,
            apiType: provider.apiType,
            authMode: provider.authMode,
            token: provider.authMode === 'auth_token' ? provider.apiKey : undefined,
            apiKey: provider.authMode === 'api_key' ? provider.apiKey : undefined,
            customHeaders: provider.customHeaders
        });
        await this.manager.replaceProviderModels(providerId, result.models);
        this.postToast('success', `已拉取 ${result.models.length} 个模型`);
    }

    /** 导出配置到用户选择的 JSON 文件。 */
    private async exportConfig(): Promise<void> {
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('claude-router-config.json'),
            filters: { JSON: ['json'] }
        });
        if (!target) return;
        const content = JSON.stringify(this.manager.exportConfig(), null, 2);
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
        this.postToast('success', '配置已导出');
    }

    /** 从用户选择的 JSON 文件导入配置。 */
    private async importConfig(): Promise<void> {
        const targets = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { JSON: ['json'] }
        });
        const target = targets?.[0];
        if (!target) return;
        const bytes = await vscode.workspace.fs.readFile(target);
        const text = Buffer.from(bytes).toString('utf8');
        await this.manager.importConfig(JSON.parse(text));
        this.postToast('success', '配置已导入');
    }

    /**
     * 拉取顶部广告并随机推送一条给 Webview。
     *
     * 设计要点：
     * - 命中 {@link adCache} 时直接复用，不发起网络请求；
     * - 网络请求挂上 {@link TOP_AD_FETCH_TIMEOUT_MS} 超时，避免阻塞设置页加载；
     * - 任何异常（超时、网络断开、CORS、空数组、JSON 解析失败等）都吞掉，
     *   只在日志里 info/warn，**绝对不**通过 toast 或抛出影响主流程；
     * - 接口数据不可信，使用 {@link normalizeAdItem} 严格筛选有效字段后才推送给前端。
     */
    private async loadAd(): Promise<void> {
        try {
            let pool = this.adCache;
            if (!pool) {
                pool = await this.fetchAdList();
                if (!pool || pool.length === 0) {
                    this.postMessage({ type: 'ad', payload: null });
                    return;
                }
                this.adCache = pool;
            }
            const picked = pool[Math.floor(Math.random() * pool.length)] ?? null;
            this.postMessage({ type: 'ad', payload: picked });
        } catch (error) {
            Logger.info(`顶部广告加载失败（已忽略）: ${error instanceof Error ? error.message : String(error)}`);
            this.postMessage({ type: 'ad', payload: null });
        }
    }

    /**
     * 调用远端广告接口并返回规范化后的列表。
     *
     * 与参考项目使用同一个接口地址 {@link TOP_AD_ENDPOINT}，请求超时使用
     * {@link AbortController} 控制，便于在 Node.js / Electron 内置 fetch 上稳定生效。
     *
     * @returns 规范化的广告列表；接口异常或数据非数组时返回空数组。
     */
    private async fetchAdList(): Promise<AdItem[]> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TOP_AD_FETCH_TIMEOUT_MS);
        try {
            const response = await fetch(TOP_AD_ENDPOINT, { signal: controller.signal });
            if (!response.ok) {
                return [];
            }
            const data = await response.json();
            if (!Array.isArray(data)) {
                return [];
            }
            const normalized: AdItem[] = [];
            for (const raw of data) {
                const item = normalizeAdItem(raw);
                if (item) normalized.push(item);
            }
            return normalized;
        } finally {
            clearTimeout(timer);
        }
    }

    /** 向 Webview 推送完整状态。 */
    private postState(): void {
        this.postMessage({ type: 'state', payload: this.manager.getState() });
    }

    /** 向 Webview 推送提示消息。 */
    private postToast(level: ToastLevel, message: string): void {
        this.postMessage({ type: 'toast', payload: { level, message } });
    }

    /** 向 Webview 发送强类型消息。 */
    private postMessage(message: ExtensionMessage): void {
        void this.webview.postMessage(message);
    }

    /** 渲染 Webview HTML 壳。 */
    private renderHtml(): string {
        const webview = this.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'configView.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'configView.css'));
        const nonce = this.createNonce();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>${WEBVIEW_TITLE}</title>
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    /** 创建 CSP nonce。 */
    private createNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i += 1) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }
}

/**
 * Activity Bar 内嵌设置视图 Provider。
 *
 * 用户点击左侧 LLS CCAI 图标后，设置页面会直接显示在该 WebviewView 中。
 */
export class ConfigWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    /** 当前侧栏 Webview 控制器。 */
    private controller: ConfigWebviewController | undefined;

    /**
     * 创建侧栏配置视图 Provider。
     *
     * @param context 扩展上下文。
     * @param manager 配置管理器。
     */
    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly manager: ConfigManager
    ) {}

    /** VS Code 解析 WebviewView 时调用，用于填充侧栏内容。 */
    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.controller?.dispose();
        this.controller = new ConfigWebviewController(this.context, this.manager, webviewView);
        this.controller.refresh();
    }

    /** 聚焦侧栏配置视图。 */
    public async focus(): Promise<void> {
        await vscode.commands.executeCommand('workbench.view.extension.claudeRouter');
        this.controller?.refresh();
    }

    /** 释放侧栏控制器。 */
    public dispose(): void {
        this.controller?.dispose();
        this.controller = undefined;
    }
}

/**
 * 配置面板 Webview 控制器。
 *
 * 作为备用入口：如果用户从命令面板希望打开编辑器大面板，可复用同一套页面。
 */
export class ConfigView implements vscode.Disposable {
    /** 当前打开的单例面板。 */
    private static currentPanel: ConfigView | undefined;

    /** WebviewPanel 实例。 */
    private readonly panel: vscode.WebviewPanel;

    /** 共享 Webview 控制器。 */
    private readonly controller: ConfigWebviewController;

    /** 待释放资源集合。 */
    private readonly disposables: vscode.Disposable[] = [];

    /**
     * 打开或聚焦配置面板。
     *
     * @param context 扩展上下文。
     * @param manager 配置管理器。
     */
    public static show(context: vscode.ExtensionContext, manager: ConfigManager): void {
        if (ConfigView.currentPanel) {
            ConfigView.currentPanel.panel.reveal(vscode.ViewColumn.One);
            ConfigView.currentPanel.controller.refresh();
            return;
        }
        ConfigView.currentPanel = new ConfigView(context, manager);
    }

    /**
     * 创建配置面板控制器。
     *
     * @param context 扩展上下文。
     * @param manager 配置管理器。
     */
    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly manager: ConfigManager
    ) {
        this.panel = vscode.window.createWebviewPanel(
            WEBVIEW_VIEW_TYPE,
            WEBVIEW_TITLE,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            }
        );
        this.controller = new ConfigWebviewController(context, manager, this.panel, () => {
            ConfigView.currentPanel = undefined;
        });
        this.disposables.push(
            this.controller
        );
    }

    /** 释放面板相关资源。 */
    public dispose(): void {
        ConfigView.currentPanel = undefined;
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }
}
