/** @file LLS CCAI 任务流共享类型。 */

/** 任务流任务状态。 */
export type LlsTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

/** 单个任务流任务。 */
export interface LlsTaskItem {
    /** 任务唯一 ID。 */
    id: string;
    /** 任务标题。 */
    title: string;
    /** 任务描述。 */
    description: string;
    /** 当前任务状态。 */
    status: LlsTaskStatus;
}

/** LLS CCAI 任务流 JSON。 */
export interface LlsTaskWorkflow {
    /** 任务流标题。 */
    title: string;
    /** 任务流摘要。 */
    summary: string;
    /** 任务列表。 */
    tasks: LlsTaskItem[];
}

/** 任务流服务快照。 */
export interface LlsTaskSnapshot {
    /** 当前任务流；不存在表示尚未启动。 */
    workflow: LlsTaskWorkflow | null;
    /** 最近一次错误信息。 */
    lastError?: string;
    /** 最近一次更新时间戳。 */
    updatedAt: number;
    /**
     * 触发任务流时 IDE 中打开的方案规划文档路径。
     *
     * 由 router 在检测到 `@llsccai-task` 时从 `<ide_opened_file>` 标签里
     * 提取并交给 service 持久化；用于后续自动续推提示词和系统规则中作为
     * "原始用户上下文"的锚点，避免模型在多轮续推后忘记最初要做什么。
     * 用户未打开任何文档时为 undefined。
     */
    planningDocumentPath?: string;
    /**
     * 触发任务流时用户在 `@llsccai-task` 后面手输入的原始提示词。
     *
     * 与 {@link planningDocumentPath} 互补：用户没有打开任何文档、直接手输
     * 需求描述时（例如 `@llsccai-task 帮我把所有 console.log 改成 logger`），
     * 由 router 提取并交给 service 持久化。续推提示词和系统规则会反复展示
     * 该原始需求给模型，避免多轮续推后丢失意图。
     *
     * 仅当用户提示词非空、且不是默认占位文案时才会保存。
     */
    originalUserPrompt?: string;
}

/** 工具回写任务状态更新项。 */
export interface LlsTaskStatusUpdate {
    /** 要更新的任务 ID。 */
    taskId: string;
    /** 要写入的新状态。 */
    status: LlsTaskStatus;
}

/** 工具回写执行结果。 */
export interface LlsTaskUpdateResult {
    /** 是否成功执行。 */
    ok: boolean;
    /** 成功更新的任务数。 */
    updated: number;
    /** 更新后的进度文本。 */
    progress: string;
    /** 结果消息。 */
    message: string;
}
