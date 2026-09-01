/** @file 内置 Chat Webview 与扩展宿主之间的基础消息协议。 */

/**
 * Chat 消息路由来源。
 *
 * - `'normal'`：主模型 CLI。
 * - `'taskFlow'`：任务流路由，复用 normal CLI，仅发起前自动切换任务流模型。
 */
export type ChatRoute = 'normal' | 'taskFlow';

/** Chat 消息角色。 */
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

/** Chat 消息片段。 */
export interface ChatSegment {
    /**
     * 片段稳定 ID。用于在流式过程中按 ID 复用同一个 segment（典型场景：工具
     * 卡片在 `tool_use` 启动、`input_json_delta` 累积、`tool_result` 回填等
     * 多个时机被反复更新；宿主与 Webview 都通过该 ID 去重合并，避免重复渲染）。
     */
    id?: string;
    /** 片段类型。 */
    kind: 'text' | 'markdown' | 'code' | 'fileRef' | 'diff' | 'tool' | 'permission' | 'error' | 'image' | 'usage' | 'task';
    /** 片段文本内容。 */
    text?: string;
    /** 图片 data URL 或 Webview 可访问 URI。 */
    imageUrl?: string;
    /** 图片 MIME 类型。 */
    mediaType?: string;
    /** 图片展示名称。 */
    alt?: string;
    /** 代码块语言。 */
    language?: string;
    /** 文件引用路径。 */
    filePath?: string;
    /** 文件引用起始行号。 */
    startLine?: number;
    /** 文件引用起始列号。 */
    startColumn?: number;
    /** 文件引用结束行号。 */
    endLine?: number;
    /** 文件引用结束列号。 */
    endColumn?: number;
    /** 生成该片段的原始文本。 */
    sourceText?: string;
    /** 解析器对该片段可信度的评估。 */
    confidence?: 'low' | 'medium' | 'high';
    /** 工具调用展示数据。 */
    tool?: {
        /** 工具名称（典型值：Bash / Read / Edit / Write / TodoWrite / WebFetch / WebSearch / Agent 等）。 */
        name: string;
        /**
         * 工具状态。
         *
         * - `pending`：工具卡片已展示但尚未开始执行
         * - `running`：工具正在执行
         * - `success`：执行成功
         * - `failed`：执行失败（其他类错误）
         * - `permission_denied`：被 Claude CLI 权限策略拦截，需要用户调整
         *   `claudeCodeConfigHelper.chat.permissionMode` 或在 VS Code 终端手动执行
         */
        status: 'pending' | 'running' | 'success' | 'failed' | 'permission_denied';
        /** 工具调用摘要（一行紧凑展示，前端可在此基础上按工具名替换）。 */
        summary?: string;
        /** 工具调用详情（默认为 input 的 pretty JSON，前端可按工具名特化展示）。 */
        detail?: string;
        /**
         * 工具调用的结构化输入参数（已 JSON.parse）。
         *
         * 前端可按工具名读取相应字段做差异化渲染，例如：
         * - Bash: input.command / input.description
         * - Read / Write / Edit: input.file_path / input.offset / input.limit / input.old_string / input.new_string / input.content
         * - TodoWrite: input.todos
         * - WebFetch / WebSearch: input.url / input.query / input.prompt
         * - Agent: input.subagent_type / input.description / input.prompt
         */
        input?: unknown;
        /**
         * 工具调用结果的拍平文本（来自 Anthropic `tool_result.content`）。
         *
         * 与 `detail` 区分：`detail` 在 tool_use 阶段是 input，在 tool_result 到达后
         * 仍主要用于展示 input；`resultText` 专门承载结果，前端可在工具卡片中
         * 同时呈现"参数"与"输出"两个分区。
         */
        resultText?: string;
        /** 工具结果是否为错误（来自 Anthropic `tool_result.is_error`）。 */
        isError?: boolean;
    };
    /** 权限确认展示数据。 */
    permission?: {
        /** 权限请求 ID。 */
        id: string;
        /** 权限请求标题。 */
        title: string;
        /** 权限请求详情。 */
        detail?: string;
        /** 可选操作按钮。 */
        options: Array<{ id: string; label: string }>;
    };
    /**
     * 模型响应 token 使用量。
     *
     * 仅在 `kind === 'usage'` 时使用：Relay 在收到上游响应（Anthropic /
     * OpenAI Chat / OpenAI Responses 任意一种）并完成 Anthropic 协议转换后，
     * 由 `UsageReporter` 抽取并通过扩展宿主追加到当前 assistant 消息末尾，
     * 用于在 Chat UI 模型回复下方展示一行紧凑的 token 统计。
     */
    usage?: {
        /** 上游返回的模型 id。 */
        model?: string;
        /** 输入 token 数。 */
        inputTokens?: number;
        /** 输出 token 数。 */
        outputTokens?: number;
        /** 缓存写入 token（Anthropic prompt caching）。 */
        cacheCreationInputTokens?: number;
        /** 缓存读取 token（Anthropic prompt caching）。 */
        cacheReadInputTokens?: number;
        /** 模型上下文上限（CLI result.modelUsage.contextWindow）。 */
        contextWindow?: number;
    };
    /**
     * CLI / 代理上游附带的任务事件展示数据。
     *
     * 仅在 `kind === 'task'` 时使用：来自上游 stdout 的
     * `{"type":"system","subtype":"taskstarted"|"tasknotification", ...}` JSON
     * 事件。同一个 `id`（即 taskid）会在 webview 端按 started → notification
     * 合并为同一张卡片，避免原始 JSON 直显。
     */
    task?: {
        /** 任务展示标题（来自 description 字段）。 */
        description: string;
        /** 任务状态。 */
        status: 'started' | 'completed' | 'failed' | 'cancelled' | 'unknown';
        /** 可选：任务类型（localbash 等）。 */
        taskType?: string;
        /** 可选：扩展端用于读取输出的文件路径。 */
        outputFile?: string;
        /** 可选：上游附带的概要文本。 */
        summary?: string;
    };
}

/** Chat 单条消息。 */
export interface ChatMessage {
    /** 消息唯一 ID。 */
    id: string;
    /** 消息角色。 */
    role: ChatRole;
    /** 消息片段列表。 */
    segments: ChatSegment[];
    /**
     * 消息原始文本。
     *
     * 对 user 消息：保存调用 `appendLocalChatMessage('user', text, segments)`
     * 时传入的完整 prompt 文本（含通过附件构造出来的 `@file` 标记）。前端
     * Webview 渲染 user 消息时会优先读取该字段；重发功能也依赖它，确保
     * 重发出去的内容与首次发送时等价。
     */
    text?: string;
    /** 是否仍在流式生成中。 */
    pending?: boolean;
    /** 消息路由来源，用于区分普通模型与专家模型输出。 */
    route?: ChatRoute;
    /** 生成该 assistant 消息时使用的模型展示名。 */
    modelLabel?: string;
    /** 创建时间戳。 */
    createdAt: number;
}

/** 用户输入框中附带的上下文文件。 */
export interface ChatComposerAttachment {
    /** 附件文件路径。 */
    path: string;
    /** 前端展示文件名。 */
    name?: string;
    /** 当前光标或选区起始行号，1-based。 */
    startLine?: number;
    /** 当前光标或选区结束行号，1-based。 */
    endLine?: number;
    /** 当前选区起始列号，0-based。 */
    startColumn?: number;
    /** 当前选区结束列号，0-based。 */
    endColumn?: number;
    /** 当前选中的文本，仅在有选区时填充。 */
    selectedText?: string;
}

/** Chat 输入框底部模型切换选项。 */
export interface ChatModelOption {
    /** 提供商 ID。 */
    providerId: string;
    /** 提供商显示名称。 */
    providerName: string;
    /** 模型 ID。 */
    modelId: string;
    /** 模型展示名称。 */
    displayName: string;
    /** 是否为当前选中模型。 */
    selected: boolean;
}

/** Chat 输入框快捷权限模式选项。 */
export type ChatQuickPermissionMode = 'acceptEdits' | 'bypassPermissions';

/**
 * 模型选择弹窗里的缓存时长选项。`default` 表示不改写、沿用客户端原样（系统默认 5m）。
 *
 * 该选项改写的是请求体里的 `cache_control.ttl`。对 OpenAI 兼容 / Responses 提供商，
 * 需要先在模型设置中把缓存模式设为 `passthrough`（透传 cache_control）才会生效；
 * `auto` / `off` 下缓存断点会在转换时被丢弃，TTL 设置等同空操作。
 */
export type ChatCacheTtlOption = 'default' | '5m' | '1h';

/** Chat 路由模型（任务流/压缩）下拉框的当前选择状态。 */
export interface ChatRoutedModelSelection {
    /** 是否启用；false 表示关闭。 */
    enabled: boolean;
    /** 模型 ID；关闭或未设置时为空字符串。 */
    modelId: string;
}

/** AskUserQuestion 工具提问项中的单个选项。 */
export interface AskUserQuestionOption {
    /** 选项显示文本（1-5 词的简短标签）。 */
    label: string;
    /** 选项含义说明，帮助用户理解权衡。 */
    description?: string;
}

/**
 * AskUserQuestion 工具的单个问题。
 *
 * 对应 Claude CLI `can_use_tool` 授权请求 `input.questions` 数组元素；
 * 扩展宿主原样透传给 Webview 渲染选择弹窗。
 */
export interface AskUserQuestionItem {
    /** 完整问题文本。 */
    question: string;
    /** 短标签（chip 展示，如 "Auth method"）。 */
    header?: string;
    /** 是否允许多选。 */
    multiSelect?: boolean;
    /** 可选项列表（CLI 约定 2-4 项）。 */
    options: AskUserQuestionOption[];
}

/** Chat Webview 当前支持的界面语言。 */
export type ChatUiLanguage = 'en' | 'zh-cn' | 'zh-tw' | 'ko' | 'ja' | 'fr' | 'de';

/** 扩展宿主发送给 Webview 的消息。 */
export type ExtensionToWebview =
    | {
          /** 通知 Webview 切换语言并重绘本地动态 UI。 */
          type: 'i18n/update';
          /** 扩展设置解析后的实际界面语言。 */
          language: ChatUiLanguage;
      }
    | {
          /** 通知 Webview 浏览器工具自动放行（chat.tools.global.autoApprove）状态。 */
          type: 'browser/autoApproveState';
          /** 浏览器工具是否可用（桌面端 + 已开启 enableChatTools）。 */
          supported: boolean;
          /** chat.tools.global.autoApprove 是否已开启。 */
          enabled: boolean;
      }
    | { type: 'session/init'; messages: ChatMessage[]; cliPath: string }
    | { type: 'session/title'; title: string; sessionId: string }
    | { type: 'sessions/list/result'; sessions: SessionListItem[] }
    | { type: 'message/append'; message: ChatMessage }
    | { type: 'message/patch'; id: string; segments: ChatSegment[]; pending?: boolean; append?: boolean }
    | {
          /**
           * 局部截断消息列表。
           *
           * 用于"重发"等场景：只删除从 `fromIndex` 起（含自身）的所有消息节点，
           * 而不像 `session/init` 那样把整个消息容器全量重建。这样可以避免
           * 重绘期间 scrollTop 跳到 0 又被随后的 append 拉到底部产生的"闪滚"。
           *
           * `fromIndex` 与每条消息节点上的 `data-index` 对应：扩展端用消息在
           * `chatMessages` 数组中的下标，Webview 端在 `appendMessage` 渲染时
           * 写入 `dataset.index` 作为稳定的"位置坐标"。
           */
          type: 'messages/truncate';
          /** 起始消息索引（基于 chatMessages 数组的下标）。 */
          fromIndex: number;
      }
    | { type: 'message/error'; id?: string; error: string; detail?: string }
    /**
     * 兼容保留：按需专家方案下 route/changed 协议已退役，但 webview 可能仍订阅
     * 该消息。扩展宿主不再 post 此消息；旧 webview 收到时按 noop 处理。
     */
    | { type: 'route/changed'; route: ChatRoute }
    | { type: 'chat/running'; running: boolean; route?: ChatRoute }
    | { type: 'cli/status'; status: 'idle' | 'running' | 'exited' | 'error'; detail?: string }
    | { type: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; text: string }
    | { type: 'composer/fill'; text: string; focus?: boolean }
    | { type: 'composer/defaultAttachment'; attachment?: ChatComposerAttachment; path?: string; name?: string }
    | { type: 'composer/addAttachments'; attachments: ChatComposerAttachment[]; focus?: boolean }
    | { type: 'composer/replaceAttachment'; clientId: string; attachment: ChatComposerAttachment; focus?: boolean }
    | { type: 'permissionMode/current'; mode: ChatQuickPermissionMode }
    | { type: 'cacheTtl/current'; ttl: ChatCacheTtlOption }
    | {
          /**
           * AskUserQuestion 授权通道提问：CLI 发出 `can_use_tool` 后由扩展宿主
           * 转发给 Webview，弹出选择弹窗；answers 必须经 `askUser/answers` 回传，
           * CLI 在回包前保持阻塞（网关不会继续转发上游请求）。
           */
          type: 'askUser/request';
          /** control_request 的请求 ID，回包配对用。 */
          requestId: string;
          /** 发起提问的 CLI 路由，回包时选择对应 adapter。 */
          route: ChatRoute;
          /** 提问列表（1-4 个）。 */
          questions: AskUserQuestionItem[];
      }
    | {
          /**
           * 推送 Chat 输入框上方「当前模型」下拉框可选项与已选状态。
           *
           * 模型列表由扩展宿主在 {@link ConfigViewState.providers} 基础上做了
           * 三重过滤：跳过 provider.enabled === false、model.enabled === false
           * 与 model.isUserSelectable === false 的条目，避免用户在此下拉中
           * 看到任何「已禁用」或「不可见」模型。
           */
          type: 'model/options';
          /** 已经过 enabled / selectable 过滤的可选模型列表。 */
          models: ChatModelOption[];
          /** 当前选中的模型，未选中或被清空时为 null。 */
          current?: { providerId: string; modelId: string } | null;
      }
    | {
          /** 推送当前 LLS CCAI / CC 任务流快照，用于 Chat 顶部 Todo 状态卡片实时刷新。 */
          type: 'taskFlow/status';
          /** 当前任务流状态快照；workflow 为 null 时前端隐藏 Todo 卡片。 */
          snapshot: LlsTaskSnapshotPayload;
      }
    | {
          /**
           * 提示用户上次有未完成任务流被恢复，请在 Chat webview 内弹自定义对话框
           * 让用户决定「继续 / 清除 / 关闭」。
           *
           * 由扩展宿主在 webview 首次 ready 后、检测到 restore 出未完成 workflow 时
           * 推送一次（只弹一次）。webview 渲染对话框，三按钮回传 taskFlow/restoreChoice。
           */
          type: 'taskFlow/restorePrompt';
          /** 恢复出的任务流标题。 */
          title: string;
          /** 恢复出的任务流摘要。 */
          summary: string;
          /** 进度文本，如 `2/5`（completed/total）。 */
          progress: string;
      }
        | {
                    /**
                     * 推送任务流模型下拉框可选项与当前有效选择。
                     *
                     * 与 `model/options` 一致，列表已过滤被禁用的 provider/model
                     * 与 isUserSelectable === false 的条目。
                     */
                    type: 'taskFlow/model/options';
                    /** 可作为任务流模型的模型列表（已过滤禁用 provider/model）。 */
                    models: ChatModelOption[];
                    /** 当前工作区配置解析出的任务流选择；modelId 为空表示回退主模型。 */
                    current: ChatRoutedModelSelection;
            }
    | {
          /**
           * 推送当前会话的 token 用量与上下文上限，用于 bypass 下拉右侧的
           * token meter 实时显示「used / limit · pct%」。
           *
           * 由 TokenBudgetService 的 onDidChangeUsage 事件触发，扩展宿主聚合后
           * 同步给 webview。webview 端只负责渲染，不做任何统计。
           */
          type: 'tokenBudget/usage';
          /** 当前 CLI session_id。 */
          sessionId: string;
          /** 用于阈值判定的 input token 数（含 cache_creation）。 */
          used: number;
          /** 模型上下文上限（来自 ModelConfig.contextLength 或静态表）。 */
          limit: number;
          /** 压缩触发阈值 = limit - 50000。 */
          threshold: number;
          /** 数据来源：上游 usage 权威值（api）或本地 estimator 估算（estimated）。 */
          source: 'api' | 'estimated';
      }
    | {
          /**
           * 自动压缩开始：通知 Webview 禁用输入框并显示「正在压缩上下文…」提示。
           *
           * 由 TokenBudgetService 在 `afterRecv` 检测到累计 input ≥ threshold
           * 后发出，触发时机紧跟在用户看完本轮流式响应之后。
           */
          type: 'compaction/started';
          /** 触发压缩时的 CLI session_id（即旧 session）。 */
          sessionId: string;
          /** 压缩前 totalInputForBudget，用于卡片显示节省比例。 */
          beforeTokens: number;
      }
    | {
          /**
           * 自动压缩完成：通知 Webview 启用输入框、渲染「上下文已压缩」卡片。
           *
           * 卡片视觉对齐"任务完成"卡片，显示压缩前/后 token 数与摘要预览。
           */
          type: 'compaction/finished';
          /** 旧 session_id（已被归档）。 */
          oldSessionId: string;
          /** 新 session_id（CLI 重启后落盘）。 */
          newSessionId: string;
          /** 压缩前 totalInputForBudget。 */
          beforeTokens: number;
          /** 压缩后（新 session 首轮）的 totalInputForBudget。 */
          afterTokens: number;
          /** 模型产出的纯 Markdown 摘要文本（已包 <summ> 之外的内容）。 */
          summary: string;
      }
    | {
          /**
           * 自动压缩失败：通知 Webview 启用输入框并展示错误提示条。
           *
           * 失败时旧 session 不切换，用户仍可继续在旧 session 里发送消息
           * （但可能很快撞上下文上限）。
           */
          type: 'compaction/failed';
          /** 触发压缩时的 session_id（保持不变）。 */
          sessionId: string;
          /** 失败原因描述（已脱敏可直接展示）。 */
          error: string;
      }
    | {
          /**
           * 推送当前普通 / 任务流 / 压缩模型可选项与已选状态，供「模型选择弹窗」一次性渲染。
           *
           * 与单条 `model/options` / `taskFlow/model/options` 相比，本消息合并为一次
           * 推送，避免弹窗打开时多次刷新闪动。
           *
           * 所有列表均已在扩展宿主侧通过 isSelectableModel(provider, model) 统一过滤：
           * 跳过 provider.enabled === false、model.enabled === false 与
           * model.isUserSelectable === false 的条目。Webview 收到后可直接渲染，
           * 不需要再做禁用过滤。
           */
          type: 'models/snapshot';
          /** 普通任务模型可选项（已过滤禁用 provider/model）。 */
          normalModels: ChatModelOption[];
          /** 任务流模型可选项（已过滤禁用 provider/model）。 */
          taskFlowModels: ChatModelOption[];
          /** 压缩请求专用模型可选项（不含「关闭压缩模型」）。 */
          compactionModels: ChatModelOption[];
          /** 当前生效的压缩模型选择，含 enabled 与 modelId。 */
          currentCompaction: ChatRoutedModelSelection;

          /** 当前选中的普通任务模型；未选中时为 null。 */
          currentNormal: { providerId: string; modelId: string } | null;
          /** 当前生效的任务流模型选择；modelId 为空表示未配置（回退主模型）。 */
          currentTaskFlow: ChatRoutedModelSelection;
      };

/** Chat Webview 可渲染的任务流任务状态。 */
export type LlsTaskStatusPayload = 'pending' | 'in_progress' | 'completed' | 'blocked';

/** Chat Webview 可渲染的单个任务流任务。 */
export interface LlsTaskItemPayload {
    /** 任务唯一 ID。 */
    id: string;
    /** 任务标题。 */
    title: string;
    /** 任务描述。 */
    description: string;
    /** 当前任务状态。 */
    status: LlsTaskStatusPayload;
}

/** Chat Webview 可渲染的任务流内容。 */
export interface LlsTaskWorkflowPayload {
    /** 任务流标题。 */
    title: string;
    /** 任务流摘要。 */
    summary: string;
    /** 任务列表。 */
    tasks: LlsTaskItemPayload[];
}

/** Chat Webview 可渲染的任务流快照。 */
export interface LlsTaskSnapshotPayload {
    /** 当前任务流；不存在表示尚未启动。 */
    workflow: LlsTaskWorkflowPayload | null;
    /** 最近一次错误信息。 */
    lastError?: string;
    /** 最近一次更新时间戳。 */
    updatedAt: number;
}

/** Webview 发送给扩展宿主的消息。 */
export type WebviewToExtension =
    | { type: 'webview/ready' }
    | { type: 'user/send'; text: string; attachments?: ChatComposerAttachment[] }
    | { type: 'user/cancel' }
    | {
          /**
           * 重发某条 user 消息。Webview 通过点击 user 消息下方的"重发"
           * 图标触发；扩展端会截断该消息及其之后所有消息，然后用其原始
           * 文本作为新一轮 user 消息重新发送。
           */
          type: 'user/resend';
          /** 待重发的 user 消息 ID。 */
          id: string;
          /**
           * 用户在重发编辑框中修改后的文本。
           *
           * 未传或为空字符串时，扩展端继续回退到目标消息保存的原始文本，兼容旧版
           * Webview 直接点击重发的行为。
           */
          text?: string;
      }
    | { type: 'session/clear' }
    | {
          /**
           * 用户在 Chat 顶部内联编辑会话标题后回传。
           *
           * 扩展宿主会把 `title` 写回 `<sessionId>.jsonl` 的 `customTitle` 字段；
           * `title` 为空字符串表示删除自定义标题，回退到自动派生标题
           * （aiTitle > lastPrompt > summary）。
           */
          type: 'session/set-title';
          /** 新的会话标题；空字符串表示清除自定义标题。 */
          title: string;
          /** 目标会话 ID；为空时扩展端使用当前活动会话。 */
          sessionId: string;
      }
    | { type: 'file/pick' }
    | { type: 'file/uploadBlob'; clientId: string; name: string; displayName?: string; size: number; mime: string; base64: string }
    | { type: 'model/select'; providerId: string; modelId: string }
    | { type: 'permissionMode/select'; mode: ChatQuickPermissionMode }
    | { type: 'cacheTtl/select'; ttl: ChatCacheTtlOption }
    | {
          /**
           * 用户在 AskUserQuestion 弹窗中提交答案，与 `askUser/request` 配对。
           *
           * 扩展宿主收到后把 answers/notes 填进授权响应 `updatedInput` 并写回
           * CLI stdin（control_response allow），解除 CLI 阻塞。
           */
          type: 'askUser/answers';
          /** 对应 askUser/request 的请求 ID。 */
          requestId: string;
          /** 对应 askUser/request 的路由。 */
          route: ChatRoute;
          /** 每个问题的答案：问题文本 → 选项 label（多选逗号分隔）。 */
          answers: Record<string, string>;
          /** 用户在自定义输入框填写的补充说明。 */
          notes?: string;
      }
    | {
          /**
           * 保存任务流模型下拉框选择（仅写入工作区配置）。
           *
           * `modelId` 为空字符串表示未配置，任务流回退当前主模型。
           */
          type: 'taskFlow/model/select';
          /** 选择的任务流模型 ID；空字符串表示清除配置。 */
          modelId: string;
      }
    | {
          /** 打开 LLS CCAI / CC 任务流菜单，用于替代原状态栏中的 CC 任务流按钮。 */
          type: 'taskFlow/open';
      }
    | {
          /** 请求开启 chat.tools.global.autoApprove，免去每次「Open Browser Page?」确认。 */
          type: 'browser/enableAutoApprove';
      }
    | {
          /**
           * 用户在恢复对话框上的选择回传。
           *
           * - continue：启动 CLI 后自动发送续推提示；
           * - clear：清空任务流并删除 .LLSOAI/task-flow.json；
           * - dismiss：关闭对话框，内存与磁盘任务流均保留，用户之后仍可从菜单继续。
           */
          type: 'taskFlow/restoreChoice';
          /** 用户选择。 */
          choice: 'continue' | 'clear' | 'dismiss';
      }
    | { type: 'file/open'; path: string; line?: number; endLine?: number }
    | { type: 'cli/restart' }
    | { type: 'cli/selectPath' }
    | { type: 'tokenBudget/compactNow' }
    | {
          /**
           * 用户在路由徽章上手动切换 Chat CLI 路由。
           *
           * 第一版仅支持 `'normal'`（手动切回）；后续若实现「expert → normal 自动回退」
           * 也共用本协议消息。
           */
          type: 'route/select';
          /** 目标路由。 */
          route: ChatRoute;
      }
    | {
          /**
           * 模型选择弹窗一次性下发普通 / 任务流 / 压缩三个选择，避免多重重启 CLI。
           *
           * 扩展宿主收到后串行执行：
           *   1. configManager.setCurrentModel(normal)
           *   2. saveTaskFlowModelSelection(taskFlow ? `${providerId}/${modelId}` : '')
           *   3. saveCompactionModelSelection(compaction ? `${providerId}/${modelId}` : '')
           *   4. postModelsSnapshot()
           *   5. restartChatCliPair({ silent: true })
           */
          type: 'models/applyPair';
          /** 普通任务模型；null 表示未选。 */
          normal: { providerId: string; modelId: string } | null;
          /** 任务流模型；null 表示未配置（回退主模型）。 */
          taskFlow: { providerId: string; modelId: string } | null;
          /** 压缩请求专用模型；null 表示「关闭压缩模型」。 */
          compaction: { providerId: string; modelId: string } | null;
      }
    | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
    | { type: 'sessions/list' }
    | { type: 'session/resume'; sessionId: string };

/** 会话列表条目。 */
export interface SessionListItem {
    sessionId: string;
    summary: string;
    gitBranch?: string;
    lastModified: number;
    fileSize: number;
}
