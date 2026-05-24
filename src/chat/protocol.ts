/** @file 内置 Chat Webview 与扩展宿主之间的基础消息协议。 */

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
    kind: 'text' | 'markdown' | 'code' | 'fileRef' | 'diff' | 'tool' | 'permission' | 'error' | 'image' | 'usage';
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

/** Chat 底部专家下拉框的当前选择状态。 */
export interface ChatExpertModelSelection {
    /** 是否启用专家；false 表示「关闭专家」。 */
    enabled: boolean;
    /** 专家模型 ID；关闭或未设置时为空字符串。 */
    modelId: string;
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
    | { type: 'session/init'; messages: ChatMessage[]; cliPath: string }
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
    | { type: 'cli/status'; status: 'idle' | 'running' | 'exited' | 'error'; detail?: string }
    | { type: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; text: string }
    | { type: 'composer/fill'; text: string; focus?: boolean }
    | { type: 'composer/defaultAttachment'; attachment?: ChatComposerAttachment; path?: string; name?: string }
    | { type: 'composer/addAttachments'; attachments: ChatComposerAttachment[]; focus?: boolean }
    | { type: 'composer/replaceAttachment'; clientId: string; attachment: ChatComposerAttachment; focus?: boolean }
    | { type: 'permissionMode/current'; mode: ChatQuickPermissionMode }
    | { type: 'model/options'; models: ChatModelOption[]; current?: { providerId: string; modelId: string } | null }
    | {
          /** 推送当前 LLS CCAI / CC 任务流快照，用于 Chat 顶部 Todo 状态卡片实时刷新。 */
          type: 'taskFlow/status';
          /** 当前任务流状态快照；workflow 为 null 时前端隐藏 Todo 卡片。 */
          snapshot: LlsTaskSnapshotPayload;
      }
        | {
                    /** 推送专家模型下拉框可选项与当前有效选择。 */
                    type: 'expert/model/options';
                    /** 可作为专家模型的模型列表。 */
                    models: ChatModelOption[];
                    /** 当前按照「项目 > 全局 > 关闭」规则解析出的专家选择。 */
                    current: ChatExpertModelSelection;
            }
    | {
          /**
           * 推送一条专家模式事件（{@link ExpertEventPayload}）。
           *
           * Webview 收到后将事件按 `parentMessageId` 聚合到 `ExpertPanel`
           * 折叠面板中渲染。`start` 事件创建面板（默认展开），`final` /
           * `error` / `cancelled` 事件会触发自动折叠（用户可手动展开）。
           *
           * 专家事件**不进入** `chatMessages` 数组，也不会持久化到 sessionStore，
           * 因此 webview 关闭后丢失是预期行为。
           */
          type: 'expert/event';
          /** 事件 payload（详见 `src/expertMode/expertEvents.ts`）。 */
          event: ExpertEventPayload;
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

/**
 * 专家事件 webview 透传 payload。
 *
 * 这是 `ExpertEvent` 的 webview 协议视图（字段集与 `expertMode/expertEvents.ts`
 * 中的 `ExpertEvent` 一致；之所以在此重新声明，是为了让 `protocol.ts` 不依赖
 * `src/expertMode/*`，保持协议层零内部依赖）。
 */
export interface ExpertEventPayload {
    /** 当前专家 run 的稳定 id。 */
    runId: string;
    /** 关联的主对话 assistant 消息 id（用于挂载面板位置）。 */
    parentMessageId: string;
    /** 关联的 ask_expert tool_use_id。 */
    callId: string;
    /** 主聊天区 ask_expert 工具卡片的 ChatSegment.id，用于实时追加专家 Output。 */
    toolSegmentId?: string;
    /** 事件产生时间戳（毫秒）。 */
    ts: number;
    /** 事件种类。 */
    kind: 'start' | 'analysis' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'cancelled';
    /** `kind='start'` 时：自包含的用户问题。 */
    question?: string;
    /** `kind='start'` 时：实际使用的专家模型 id。 */
    expertModel?: string;
    /** `kind='analysis' | 'final' | 'error' | 'cancelled'` 时的文本内容。 */
    text?: string;
    /** `kind='tool_call' | 'tool_result'` 时的工具名。 */
    toolName?: string;
    /** `kind='tool_call'` 时的工具入参。 */
    toolArgs?: unknown;
    /** `kind='tool_result'` 时的结果摘要（已截断）。 */
    toolResultSummary?: string;
    /** `kind='tool_result'` 时：该工具结果是否为错误。 */
    toolIsError?: boolean;
    /** `kind='final' | 'error' | 'cancelled'` 时：本次 run 总耗时（毫秒）。 */
    durationMs?: number;
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
    | { type: 'file/pick' }
    | { type: 'file/uploadBlob'; clientId: string; name: string; displayName?: string; size: number; mime: string; base64: string }
    | { type: 'model/select'; providerId: string; modelId: string }
    | { type: 'permissionMode/select'; mode: ChatQuickPermissionMode }
    | {
          /**
           * 保存专家模型下拉框选择。
           *
           * `modelId` 为空字符串表示关闭专家；非空时会同时写入项目配置和全局配置。
           */
          type: 'expert/model/select';
          /** 选择的专家模型 ID；空字符串表示「关闭专家」。 */
          modelId: string;
      }
    | {
          /** 打开 LLS CCAI / CC 任务流菜单，用于替代原状态栏中的 CC 任务流按钮。 */
          type: 'taskFlow/open';
      }
    | { type: 'file/open'; path: string; line?: number; endLine?: number }
    | { type: 'cli/restart' }
    | { type: 'cli/selectPath' }
    | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
