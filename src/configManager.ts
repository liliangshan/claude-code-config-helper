/**
 * @file LLS CCAI 配置管理器。
 *
 * Vendored design from liliangshan.openapi-compatible-copilot configManager，
 * 负责 Provider / Model / 当前模型与共享提示词配置管理能力。
 */

import * as vscode from 'vscode';

import {
    CHAT_CURRENT_MODEL_KEY,
    CONFIG_NAMESPACE,
    CURRENT_MODEL_STATE_KEY,
    PROVIDER_API_KEY_SECRET_PREFIX,
    PROVIDERS_STATE_KEY,
    TASK_FLOW_BYPASS_PERMISSIONS_KEY,
    TASK_FLOW_TARGET_KEY,
    CHAT_CLI_PATH_KEY
} from './constants';
import type {
    AppLanguage,
    ConfigViewState,
    CurrentModelSelection,
    ModelConfig,
    ProviderConfig,
    ProviderConfigWithoutSecrets,
    ResolvedAppLanguage,
    SharedOpenApiCopilotSettings,
    TaskFlowTarget
} from './types';

/** 导入导出 JSON 的版本号。 */
const EXPORT_VERSION = 1;

/** 与 liliangshan.openapi-compatible-copilot 保持一致的配置命名空间。 */
const OPENAPI_COPILOT_NAMESPACE = 'openapicopilot';

/** LLS CCAI 自有配置命名空间，不与 LLS OAI 的语言配置共享。 */
const CCAI_NAMESPACE = CONFIG_NAMESPACE;

/** LLS CCAI 自有语言配置字段：claudeCodeConfigHelper.language。 */
const CCAI_LANGUAGE_KEY = 'language';

/** LLS CCAI 支持的实际 UI 语言集合，不包含 auto。 */
const SUPPORTED_APP_LANGUAGES: readonly ResolvedAppLanguage[] = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja', 'fr', 'de'];

/** 共享系统提示词字段名：openapicopilot.systemPrompt。 */
const SHARED_SYSTEM_PROMPT_KEY = 'systemPrompt';

/** 获取工作区或工作区文件夹层级的配置值。 */
function getWorkspaceInspectValue<T>(inspect: { workspaceValue?: T; workspaceFolderValue?: T } | undefined): T | undefined {
    return inspect?.workspaceFolderValue ?? inspect?.workspaceValue;
}

/** 获取配置检查结果中的全局层级值。 */
function getGlobalInspectValue<T>(inspect: { globalValue?: T } | undefined): T | undefined {
    return inspect?.globalValue;
}

/** 导入导出配置文件结构。 */
export interface ExportedConfig {
    /** 配置文件版本。 */
    version: number;
    /** 导出时间戳。 */
    exportedAt: number;
    /** 不含密钥的提供商配置。 */
    providers: ProviderConfigWithoutSecrets[];
    /** 当前模型选择。 */
    currentModel: CurrentModelSelection | null;
}

/**
 * 管理 Provider、Model 与 Claude Code 顶部配置。
 *
 * 该类负责本扩展自己的 globalState / SecretStorage 数据，
 * 也不写入最终 Claude Code settings.json。
 */
export class ConfigManager implements vscode.Disposable {
    /** 配置变更事件发送器。 */
    private readonly changeEmitter = new vscode.EventEmitter<void>();

    /** 配置变更事件，供 TreeView / Webview 后续刷新使用。 */
    public readonly onDidChange = this.changeEmitter.event;

    /**
     * 创建配置管理器。
     *
     * @param context VS Code 扩展上下文。
     */
    public constructor(private readonly context: vscode.ExtensionContext) {}

    /** 读取完整配置页面状态。 */
    public getState(): ConfigViewState {
        return {
            providers: this.listProviders(),
            currentModel: this.getCurrentModel(),
            chatCliPath: this.getChatCliPath(),
            configuredLanguage: this.getConfiguredUiLanguage(),
            resolvedLanguage: this.getResolvedUiLanguage(),
            taskFlowBypassPermissions: this.getTaskFlowBypassPermissions(),
            taskFlowTarget: this.getTaskFlowTarget()
        };
    }

    /** 主动通知配置状态已变化，供外部配置监听触发 Webview 刷新。 */
    public notifyChanged(): void {
        this.changeEmitter.fire();
    }

    /**
     * 读取用户配置的 LLS CCAI UI 语言。
     *
     * 该方法只读取 claudeCodeConfigHelper.language，不读取 openapicopilot.language，确保与 LLS OAI 完全隔离。
     */
    public getConfiguredUiLanguage(): AppLanguage {
        const value = vscode.workspace
            .getConfiguration(CCAI_NAMESPACE)
            .get<AppLanguage>(CCAI_LANGUAGE_KEY, 'auto');
        return this.normalizeUiLanguage(value);
    }

    /**
     * 解析当前实际生效的 LLS CCAI UI 语言。
     *
     * 用户选择具体语言时直接返回该语言；用户选择 auto 时根据 vscode.env.language 解析。
     */
    public getResolvedUiLanguage(): ResolvedAppLanguage {
        const configured = this.getConfiguredUiLanguage();
        if (configured !== 'auto') return configured;
        return this.resolveVsCodeLanguage(vscode.env.language);
    }

    /**
     * 写入 LLS CCAI 自有 UI 语言配置。
     *
     * 只写 claudeCodeConfigHelper.language 的全局值，不写 openapicopilot.language。
     */
    public async updateUiLanguage(language: AppLanguage): Promise<void> {
        const normalized = this.normalizeUiLanguage(language);
        await vscode.workspace
            .getConfiguration(CCAI_NAMESPACE)
            .update(CCAI_LANGUAGE_KEY, normalized, vscode.ConfigurationTarget.Global);
        this.changeEmitter.fire();
    }

    /** 读取任务流是否启用 Claude Code bypass permissions 危险权限模式。 */
    public getTaskFlowBypassPermissions(): boolean {
        return vscode.workspace
            .getConfiguration(CCAI_NAMESPACE)
            .get<boolean>(TASK_FLOW_BYPASS_PERMISSIONS_KEY, false);
    }

    /** 写入任务流是否启用 Claude Code bypass permissions 危险权限模式。 */
    public async updateTaskFlowBypassPermissions(enabled: boolean): Promise<void> {
        await vscode.workspace
            .getConfiguration(CCAI_NAMESPACE)
            .update(TASK_FLOW_BYPASS_PERMISSIONS_KEY, !!enabled, vscode.ConfigurationTarget.Global);
        this.changeEmitter.fire();
    }

    /** 读取任务流提示词发送目标，默认保留外部 Claude Code 以兼容旧链路。 */
    public getTaskFlowTarget(): TaskFlowTarget {
        const value = vscode.workspace
            .getConfiguration(CCAI_NAMESPACE)
            .get<string>(TASK_FLOW_TARGET_KEY, 'externalClaudeCode');
        return value === 'builtinChat' ? 'builtinChat' : 'externalClaudeCode';
    }

    /** 读取内置 Chat 当前配置的 Claude CLI 可执行文件路径。 */
    public getChatCliPath(): string {
        return vscode.workspace
            .getConfiguration(CCAI_NAMESPACE)
            .get<string>(CHAT_CLI_PATH_KEY, '')
            .trim();
    }

    /** 读取全部提供商配置。 */
    public listProviders(): ProviderConfigWithoutSecrets[] {
        const raw = this.context.globalState.get<ProviderConfigWithoutSecrets[]>(PROVIDERS_STATE_KEY, []);
        return raw.map((provider) => this.normalizeProvider(provider));
    }

    /** 根据 ID 查找提供商配置。 */
    public getProvider(providerId: string): ProviderConfigWithoutSecrets | undefined {
        return this.listProviders().find((provider) => provider.id === providerId);
    }

    /** 读取带密钥的提供商运行时配置。 */
    public async getProviderWithSecret(providerId: string): Promise<ProviderConfig | undefined> {
        const provider = this.getProvider(providerId);
        if (!provider) return undefined;
        const apiKey = await this.context.secrets.get(this.secretKey(providerId));
        const { hasApiKey: _hasApiKey, ...rest } = provider;
        return { ...rest, apiKey: apiKey ?? '' };
    }

    /** 新增或更新提供商配置。 */
    public async saveProvider(provider: ProviderConfigWithoutSecrets, apiKey?: string): Promise<void> {
        const now = Date.now();
        const normalized = this.normalizeProvider({
            ...provider,
            updatedAt: now,
            createdAt: provider.createdAt || now,
            hasApiKey: provider.hasApiKey || !!apiKey
        });
        const providers = this.listProviders();
        const index = providers.findIndex((item) => item.id === normalized.id);
        if (index >= 0) {
            providers[index] = normalized;
        } else {
            providers.push(normalized);
        }
        if (apiKey !== undefined) {
            await this.saveProviderApiKey(normalized.id, apiKey);
            normalized.hasApiKey = apiKey.trim().length > 0;
        }
        await this.updateProviders(providers);
    }

    /** 删除提供商及其密钥，并在必要时清空当前模型。 */
    public async deleteProvider(providerId: string): Promise<void> {
        const providers = this.listProviders().filter((provider) => provider.id !== providerId);
        await this.context.secrets.delete(this.secretKey(providerId));
        const currentModel = this.getCurrentModel();
        if (currentModel?.providerId === providerId) {
            await this.setCurrentModel(null);
        }
        await this.updateProviders(providers);
    }

    /** 保存某个提供商的模型配置。 */
    public async saveModel(providerId: string, model: ModelConfig): Promise<void> {
        const providers = this.listProviders();
        const provider = providers.find((item) => item.id === providerId);
        if (!provider) throw new Error(`提供商不存在：${providerId}`);
        const normalized = this.normalizeModel(model);
        const index = provider.models.findIndex((item) => item.modelId === normalized.modelId);
        if (index >= 0) {
            provider.models[index] = normalized;
        } else {
            provider.models.push(normalized);
        }
        provider.updatedAt = Date.now();
        await this.updateProviders(providers);
    }

    /** 删除某个提供商下的模型，并在必要时清空当前模型。 */
    public async deleteModel(providerId: string, modelId: string): Promise<void> {
        const providers = this.listProviders();
        const provider = providers.find((item) => item.id === providerId);
        if (!provider) return;
        provider.models = provider.models.filter((model) => model.modelId !== modelId);
        provider.updatedAt = Date.now();
        const currentModel = this.getCurrentModel();
        if (currentModel?.providerId === providerId && currentModel.modelId === modelId) {
            await this.setCurrentModel(null);
        }
        await this.updateProviders(providers);
    }

    /** 批量替换某个提供商的模型列表。 */
    public async replaceProviderModels(providerId: string, models: ModelConfig[]): Promise<void> {
        const providers = this.listProviders();
        const provider = providers.find((item) => item.id === providerId);
        if (!provider) throw new Error(`提供商不存在：${providerId}`);
        provider.models = models.map((model) => this.normalizeModel(model));
        provider.updatedAt = Date.now();
        await this.updateProviders(providers);
    }

    /**
     * 读取当前模型选择。
     *
     * 优先读取项目/工作区配置，其次读取全局配置；如果新配置不存在，则兼容读取旧版 globalState。
     */
    public getCurrentModel(): CurrentModelSelection | null {
        const config = vscode.workspace.getConfiguration(CCAI_NAMESPACE);
        const inspected = config.inspect<CurrentModelSelection | null>(CHAT_CURRENT_MODEL_KEY);
        return this.normalizeCurrentModelSelection(
            getWorkspaceInspectValue(inspected) ??
                getGlobalInspectValue(inspected) ??
                this.context.globalState.get<CurrentModelSelection | null>(CURRENT_MODEL_STATE_KEY, null)
        );
    }

    /**
     * 同时保存项目级和全局级当前模型选择。
     *
     * 项目级配置用于当前仓库优先命中，全局配置用于其它仓库兜底；旧版 globalState 也同步更新以兼容配置页导入导出。
     */
    public async setCurrentModel(selection: CurrentModelSelection | null): Promise<void> {
        const normalized = this.normalizeCurrentModelSelection(selection);
        const config = vscode.workspace.getConfiguration(CCAI_NAMESPACE);
        await config.update(CHAT_CURRENT_MODEL_KEY, normalized, vscode.ConfigurationTarget.Workspace);
        await config.update(CHAT_CURRENT_MODEL_KEY, normalized, vscode.ConfigurationTarget.Global);
        await this.context.globalState.update(CURRENT_MODEL_STATE_KEY, selection);
        this.changeEmitter.fire();
    }

    /**
     * 校验并规范化当前模型选择对象。
     *
     * @param selection 原始配置值。
     * @returns 合法模型选择；否则为 null。
     */
    private normalizeCurrentModelSelection(selection: unknown): CurrentModelSelection | null {
        if (!selection || typeof selection !== 'object') return null;
        const record = selection as Record<string, unknown>;
        const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : '';
        const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
        if (!providerId || !modelId) return null;
        return { providerId, modelId };
    }

    /** 读取设置快照：系统提示词继续共享。 */
    public getSharedOpenApiCopilotSettings(): SharedOpenApiCopilotSettings {
        return {
            globalSystemPrompt: this.getGlobalSystemPrompt(),
            workspaceSystemPrompt: this.getWorkspaceSystemPrompt()
        };
    }

    /** 读取 openapicopilot.systemPrompt 的全局值。 */
    public getGlobalSystemPrompt(): string {
        const config = vscode.workspace.getConfiguration(OPENAPI_COPILOT_NAMESPACE);
        return config.inspect<string>(SHARED_SYSTEM_PROMPT_KEY)?.globalValue ?? '';
    }

    /** 读取 openapicopilot.systemPrompt 的工作区值。 */
    public getWorkspaceSystemPrompt(): string {
        const config = vscode.workspace.getConfiguration(OPENAPI_COPILOT_NAMESPACE);
        return getWorkspaceInspectValue(config.inspect<string>(SHARED_SYSTEM_PROMPT_KEY)) ?? '';
    }

    /** 写入 openapicopilot.systemPrompt 的全局值。 */
    public async updateGlobalSystemPrompt(prompt: string): Promise<void> {
        await vscode.workspace
            .getConfiguration(OPENAPI_COPILOT_NAMESPACE)
            .update(SHARED_SYSTEM_PROMPT_KEY, prompt, vscode.ConfigurationTarget.Global);
        this.changeEmitter.fire();
    }

    /** 写入 openapicopilot.systemPrompt 的工作区值。 */
    public async updateWorkspaceSystemPrompt(prompt: string): Promise<void> {
        await vscode.workspace
            .getConfiguration(OPENAPI_COPILOT_NAMESPACE)
            .update(SHARED_SYSTEM_PROMPT_KEY, prompt, vscode.ConfigurationTarget.Workspace);
        this.changeEmitter.fire();
    }

    /** 导出不含密钥的配置 JSON。 */
    public exportConfig(): ExportedConfig {
        return {
            version: EXPORT_VERSION,
            exportedAt: Date.now(),
            providers: this.listProviders(),
            currentModel: this.getCurrentModel()
        };
    }

    /** 导入不含密钥的配置 JSON。 */
    public async importConfig(config: ExportedConfig): Promise<void> {
        if (!config || !Array.isArray(config.providers)) {
            throw new Error('配置文件格式不正确');
        }
        await this.context.globalState.update(
            PROVIDERS_STATE_KEY,
            config.providers.map((provider) => this.normalizeProvider(provider))
        );
        await this.context.globalState.update(CURRENT_MODEL_STATE_KEY, config.currentModel ?? null);
        this.changeEmitter.fire();
    }

    /** 批量替换提供商列表，供 Webview 保存配置使用。 */
    public async replaceProviders(
        providers: ProviderConfigWithoutSecrets[],
        providerApiKeys?: Record<string, string>
    ): Promise<void> {
        const normalizedProviders = providers.map((provider) => this.normalizeProvider(provider));
        if (providerApiKeys) {
            for (const provider of normalizedProviders) {
                if (!Object.prototype.hasOwnProperty.call(providerApiKeys, provider.id)) {
                    continue;
                }
                const apiKey = providerApiKeys[provider.id];
                if (apiKey && apiKey.trim()) {
                    await this.saveProviderApiKey(provider.id, apiKey);
                    provider.hasApiKey = true;
                }
            }
        }
        await this.updateProviders(normalizedProviders);
    }

    /** 释放事件资源。 */
    public dispose(): void {
        this.changeEmitter.dispose();
    }

    /** 保存提供商密钥到 SecretStorage。 */
    private async saveProviderApiKey(providerId: string, apiKey: string): Promise<void> {
        if (apiKey.trim()) {
            await this.context.secrets.store(this.secretKey(providerId), apiKey.trim());
        } else {
            await this.context.secrets.delete(this.secretKey(providerId));
        }
    }

    /** 更新提供商列表并触发变更事件。 */
    private async updateProviders(providers: ProviderConfigWithoutSecrets[]): Promise<void> {
        await this.context.globalState.update(PROVIDERS_STATE_KEY, providers);
        this.changeEmitter.fire();
    }

    /** 构造某个提供商密钥在 SecretStorage 中的 key。 */
    private secretKey(providerId: string): string {
        return `${PROVIDER_API_KEY_SECRET_PREFIX}${providerId}`;
    }

    /** 规范化 UI 语言配置，非法值统一回退为 auto。 */
    private normalizeUiLanguage(language: AppLanguage | string | undefined): AppLanguage {
        if (language === 'auto') return 'auto';
        return SUPPORTED_APP_LANGUAGES.includes(language as ResolvedAppLanguage)
            ? language as ResolvedAppLanguage
            : 'auto';
    }

    /** 将 VS Code locale 解析为 LLS CCAI 支持的 UI 语言。 */
    private resolveVsCodeLanguage(language: string | undefined): ResolvedAppLanguage {
        const normalized = (language || '').toLowerCase();
        if (
            normalized.startsWith('zh-tw') ||
            normalized.startsWith('zh-hk') ||
            normalized.startsWith('zh-mo') ||
            normalized.startsWith('zh-hant')
        ) {
            return 'zh-tw';
        }
        if (normalized.startsWith('zh')) return 'zh-cn';
        if (normalized.startsWith('ko')) return 'ko';
        if (normalized.startsWith('ja')) return 'ja';
        if (normalized.startsWith('fr')) return 'fr';
        if (normalized.startsWith('de')) return 'de';
        return 'en';
    }

    /** 规范化提供商配置，补齐旧数据或导入数据中缺失的字段。 */
    private normalizeProvider(provider: ProviderConfigWithoutSecrets): ProviderConfigWithoutSecrets {
        const now = Date.now();
        return {
            id: provider.id || `provider-${now}`,
            name: provider.name || '未命名提供商',
            baseUrl: provider.baseUrl || '',
            apiType: provider.apiType || 'openai-compatible',
            models: Array.isArray(provider.models)
                ? provider.models.map((model) => this.normalizeModel(model))
                : [],
            enabled: provider.enabled !== false,
            autoFetchModels: provider.autoFetchModels !== false,
            createdAt: provider.createdAt || now,
            updatedAt: provider.updatedAt || now,
            hasApiKey: !!provider.hasApiKey,
            authMode: provider.authMode || 'api_key',
            customHeaders: Array.isArray(provider.customHeaders) ? provider.customHeaders : []
        };
    }

    /** 规范化模型配置，补齐高级参数默认值。 */
    private normalizeModel(model: ModelConfig): ModelConfig {
        return {
            modelId: model.modelId,
            displayName: model.displayName || model.modelId,
            contextLength: model.contextLength || 0,
            maxTokens: model.maxTokens || 0,
            vision: !!model.vision,
            toolCalling: model.toolCalling !== false,
            temperature: model.temperature ?? 1,
            topP: model.topP ?? 1,
            samplingMode: model.samplingMode || 'temperature',
            isUserSelectable: model.isUserSelectable !== false,
            transformThink: !!model.transformThink,
            preserveReasoningContent: !!model.preserveReasoningContent
        };
    }

}
