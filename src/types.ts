/**
 * @file LLS CCAI 共享类型定义。
 *
 * 覆盖提供商、模型、共享提示词与 Webview 消息协议。
 */

/** 上游接口协议类型。 */
export type ApiType = 'openai-compatible' | 'anthropic' | 'v1-response';

/** 上游鉴权模式。 */
export type AuthMode = 'auth_token' | 'api_key' | 'none';

/** 模型采样模式。 */
export type SamplingMode = 'temperature' | 'top_p' | 'both' | 'none';

/** Webview 提示消息级别。 */
export type ToastLevel = 'info' | 'warn' | 'error' | 'success';

/** UI 可选语言，auto 表示跟随 VS Code 显示语言。 */
export type AppLanguage = 'auto' | 'en' | 'zh-cn' | 'zh-tw' | 'ko' | 'ja' | 'fr' | 'de';

/** 实际生效的 UI 语言，不包含 auto。 */
export type ResolvedAppLanguage = Exclude<AppLanguage, 'auto'>;

/** 自定义请求头键值对。 */
export interface CustomHeader {
    /** Header 名称。 */
    key: string;
    /** Header 值。 */
    value: string;
}

/** 额外注入到 Claude Code 的环境变量。 */
export interface ExtraEnvVar {
    /** 环境变量名。 */
    name: string;
    /** 环境变量值。 */
    value: string;
}

/** 提供商下的单个模型配置。 */
export interface ModelConfig {
    /** 请求上游时使用的模型 ID。 */
    modelId: string;
    /** UI 显示名称。 */
    displayName: string;
    /** 上下文窗口长度。 */
    contextLength: number;
    /** 最大输出 token。 */
    maxTokens: number;
    /** 是否支持视觉输入。 */
    vision: boolean;
    /** 是否支持工具调用。 */
    toolCalling: boolean;
    /** 默认 temperature。 */
    temperature: number;
    /** 默认 top_p。 */
    topP: number;
    /** 采样参数启用模式。 */
    samplingMode: SamplingMode;
    /** 是否出现在顶部 Claude Code 当前模型下拉框中。 */
    isUserSelectable?: boolean;
    /** 是否转换 reasoning/think 内容。 */
    transformThink?: boolean;
    /** 是否保留 reasoning_content 字段。 */
    preserveReasoningContent?: boolean;
}

/** 不含密钥的提供商持久化配置。 */
export interface ProviderConfigWithoutSecrets {
    /** 提供商唯一 ID。 */
    id: string;
    /** 提供商显示名称。 */
    name: string;
    /** 上游 BaseURL。 */
    baseUrl: string;
    /** 上游协议类型。 */
    apiType: ApiType;
    /** 提供商下的模型列表。 */
    models: ModelConfig[];
    /** 是否启用该提供商。 */
    enabled: boolean;
    /** 是否允许自动拉取模型列表。 */
    autoFetchModels: boolean;
    /** 创建时间戳。 */
    createdAt: number;
    /** 更新时间戳。 */
    updatedAt: number;
    /** 是否已经在 SecretStorage 中保存密钥。 */
    hasApiKey: boolean;
    /** 中转服务调用上游时采用的鉴权模式。 */
    authMode: AuthMode;
    /** 中转服务调用上游时附加的自定义请求头。 */
    customHeaders: CustomHeader[];
}

/** 含密钥的提供商运行时配置。 */
export interface ProviderConfig extends Omit<ProviderConfigWithoutSecrets, 'hasApiKey'> {
    /** 从 SecretStorage 读取出的上游密钥。 */
    apiKey: string;
}

/** Claude Code 当前选中的模型。 */
export interface CurrentModelSelection {
    /** 当前模型所属提供商 ID。 */
    providerId: string;
    /** 当前模型 ID。 */
    modelId: string;
}

/** 第二阶段本地中转服务运行状态。 */
export type RelayStatus =
    | { kind: 'starting'; port: number }
    | { kind: 'leader'; port: number; pid: number; startedAt: number }
    | { kind: 'stopped'; port?: number }
    | { kind: 'error'; port?: number; message: string };

/** 系统提示词共享设置。 */
export interface SharedOpenApiCopilotSettings {
    /** 全局系统提示词，对应 openapicopilot.systemPrompt 的 globalValue。 */
    globalSystemPrompt: string;
    /** 工作区系统提示词，对应 openapicopilot.systemPrompt 的 workspace/workspaceFolder 值。 */
    workspaceSystemPrompt: string;
}

/** 任务流提示词发送目标。 */
export type TaskFlowTarget = 'builtinChat' | 'externalClaudeCode';

/** 配置页面需要的完整状态快照。 */
export interface ConfigViewState {
    /** 所有提供商配置。 */
    providers: ProviderConfigWithoutSecrets[];
    /** 当前 Claude Code 模型选择。 */
    currentModel: CurrentModelSelection | null;
    /** 内置 Chat 当前配置的 Claude CLI 可执行文件路径。 */
    chatCliPath: string;
    /** 当前宿主系统平台，用于 Webview 按系统展示安装提示。 */
    hostPlatform: NodeJS.Platform;
    /** Windows APPDATA 环境变量路径，非 Windows 或读取不到时为空。 */
    windowsAppDataPath: string;
    /** 用户配置的 UI 语言，可能为 auto。 */
    configuredLanguage: AppLanguage;
    /** 解析后实际生效的 UI 语言。 */
    resolvedLanguage: ResolvedAppLanguage;
    /** 是否为任务流启用 Claude Code bypass permissions 危险权限模式。 */
    taskFlowBypassPermissions: boolean;
    /** 任务流提示词发送目标。 */
    taskFlowTarget: TaskFlowTarget;
}

/** Webview 发给扩展宿主的消息。 */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'openSettingsJson' }
    | { type: 'openGlobalSharedSettings' }
    | { type: 'openWorkspaceSharedSettings' }
    | { type: 'reloadWindow' }
    | { type: 'selectChatCliPath' }
    | { type: 'exportConfig' }
    | { type: 'importConfig' }
    | { type: 'updateUiLanguage'; payload: AppLanguage }
    | { type: 'updateTaskFlowBypassPermissions'; payload: boolean }
    | { type: 'setCurrentModel'; payload: CurrentModelSelection | null }
    | {
          type: 'saveProviders';
          payload:
              | ProviderConfigWithoutSecrets[]
              | {
                    providers: ProviderConfigWithoutSecrets[];
                    providerApiKeys?: Record<string, string>;
                };
      }
    | { type: 'fetchProviderModels'; payload: { providerId: string } }
    | { type: 'showInfo'; payload: { message: string } }
    | { type: 'openUrl'; payload: { url: string } };

/** 顶部广告项的数据结构，对应 ads-starmodel 接口返回的数组元素。 */
export interface AdItem {
    /** 广告图片 URL，必须 https。 */
    image: string;
    /** 点击跳转的外部地址。 */
    url: string;
}

/** 扩展宿主发给 Webview 的消息。 */
export type ExtensionMessage =
    | { type: 'state'; payload: ConfigViewState }
    | { type: 'toast'; payload: { level: ToastLevel; message: string } }
    | { type: 'ad'; payload: AdItem | null };
