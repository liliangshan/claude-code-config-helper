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
