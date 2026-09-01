/**
 * Chat 模型档位（普通 / 任务流 / 压缩）的读取、保存与切换。
 *
 * 拆分自 extension.ts：把「按项目 > 全局 > 关闭优先级解析配置」「写回配置」
 * 「Chat 下拉框切换并重启 CLI pair」这三层逻辑收敛到一个模块。
 *
 * 依赖方向：本模块位于 runtime / cliLifecycle 之上；Webview 推送函数
 * （postChat*Options / postModelsSnapshot）与 toast 仍留在 extension.ts，
 * 通过 {@link configureModelSelection} 注入，避免反向 import 造成循环依赖。
 */
import * as vscode from 'vscode';

import type { ChatRoute, ChatRoutedModelSelection } from '../chat/protocol';
import {
    CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY,
    CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY,
    CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY,
    CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY,
    CHAT_TASK_FLOW_MODEL_KEY,
    CONFIG_NAMESPACE
} from '../constants';
import { Logger } from '../logger';
import { getConfigManager, getExtensionContext } from '../runtime';
import type { ModelConfig, ProviderConfigWithoutSecrets } from '../types';
import { restartChatCliPair } from './cliLifecycle';

/** modelSelection 需要但仍留在 extension.ts 的协作函数集合。 */
export interface ModelSelectionDeps {
    /** 向 Webview 推送普通模型下拉框选项。 */
    postChatModelOptions: () => Promise<void>;
    /** 向 Webview 推送模型选择弹窗完整快照。 */
    postModelsSnapshot: () => Promise<void>;
    /** 向 Webview 推送轻提示。 */
    showChatToast: (level: 'info' | 'success' | 'warn' | 'error', text: string) => Promise<void>;
}

/** 已注入的协作函数集合，未装配前访问会抛错。 */
let deps: ModelSelectionDeps | undefined;

/** 装配 modelSelection 依赖，必须在 activate 早期调用一次。 */
export function configureModelSelection(value: ModelSelectionDeps): void {
    deps = value;
}

/** 读取已装配的依赖，未装配时抛出明确错误便于定位装配顺序问题。 */
function requireDeps(): ModelSelectionDeps {
    if (!deps) throw new Error('modelSelection 尚未装配');
    return deps;
}

/** 从配置 inspect 结果中读取工作区层级值。 */
export function getInspectedWorkspaceValue<T>(inspect: { workspaceFolderValue?: T; workspaceValue?: T } | undefined): T | undefined {
    return inspect?.workspaceFolderValue ?? inspect?.workspaceValue;
}

/** 从配置 inspect 结果中读取全局层级值。 */
export function getInspectedGlobalValue<T>(inspect: { globalValue?: T } | undefined): T | undefined {
    return inspect?.globalValue;
}

/**
 * 按「项目 > 全局 > 关闭」规则读取压缩模型下拉框当前值。
 */
export function readEffectiveCompactionModelSelection(): ChatRoutedModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
    if (globalEnabled === false) return { enabled: false, modelId: '' };
    if (globalEnabled === true && globalModel.length > 0) return { enabled: true, modelId: globalModel };
    if (globalModel.length > 0) return { enabled: true, modelId: globalModel };
    return { enabled: false, modelId: '' };
}

/**
 * 保存压缩模型下拉框选择，并同步写入项目配置与全局配置。
 *
 * @param modelId 压缩模型 ID；空字符串表示关闭压缩模型。
 */
export async function saveCompactionModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_COMPACTION_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_COMPACTION_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_COMPACTION_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_COMPACTION_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
    getConfigManager()?.notifyChanged();
}

/**
 * 读取生效的任务流模型。
 *
 * 仅读工作区级配置；未配置时返回空串，由调用方回退到当前主模型。
 * 与 expert/plan/review 不同，任务流模型没有独立 `enabled` 开关，空串即未配置。
 *
 * @returns 形如 `providerId/modelId` 的模型标识；未配置时为空串。
 */
export function readEffectiveTaskFlowModelSelection(): string {
    const inspect = vscode.workspace
        .getConfiguration(CONFIG_NAMESPACE)
        .inspect<string>(CHAT_TASK_FLOW_MODEL_KEY);
    return getInspectedWorkspaceValue(inspect) ?? '';
}

/**
 * 保存任务流模型到工作区配置。
 *
 * 只写 Workspace 作用域、不写 Global，也没有配套的 `enabled` 键。
 *
 * @param modelId 形如 `providerId/modelId`；传空串表示清除配置（回退主模型）。
 */
export async function saveTaskFlowModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = (modelId || '').trim();
    await vscode.workspace
        .getConfiguration(CONFIG_NAMESPACE)
        .update(CHAT_TASK_FLOW_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    getConfigManager()?.notifyChanged();
}

export function findModelDisplayName(modelId: string): string {
    const manager = getConfigManager();
    if (!manager || !modelId) return modelId;
    for (const provider of manager.listProviders()) {
        const model = provider.models.find((item) => item.modelId === modelId || `${provider.id}/${item.modelId}` === modelId);
        if (model) return model.displayName || model.modelId;
    }
    return modelId;
}

export function getModelLabelForRoute(route: ChatRoute): string {
    const manager = getConfigManager();
    if (!manager) return '';
    if (route === 'normal') {
        const current = manager.getCurrentModel();
        return current ? findModelDisplayName(`${current.providerId}/${current.modelId}`) : '';
    }
    const modelId = readEffectiveTaskFlowModelSelection();
    // 未配置时回退主模型标签，与实际执行行为保持一致
    if (!modelId) return getModelLabelForRoute('normal');
    return findModelDisplayName(modelId);
}

/**
 * 判断指定 provider 下的模型是否可在 Chat 模型选择中出现。
 *
 * 同时校验三项：provider 已启用、模型未被显式禁用（enabled !== false）、
 * 模型未被排除在用户可选范围外（isUserSelectable !== false）。任一不满足
 * 即视为不可选，统一供 Chat 模型列表与快照过滤使用。
 *
 * @param provider 不含密钥的提供商配置。
 * @param model 模型配置。
 * @returns 模型可被用户选择则返回 true，否则返回 false。
 */
export function isSelectableModel(provider: ProviderConfigWithoutSecrets, model: ModelConfig): boolean {
    if (!provider.enabled) return false;
    if (model.enabled === false) return false;
    if (model.isUserSelectable === false) return false;
    return true;
}

/**
 * 校验「模型选择弹窗」一次性提交的子项是否仍可被选中。
 *
 * 在普通 / 任务流 / 压缩任一档位提交前调用。当传入空选择时直接放行
 * （表示用户主动关闭该子模型）；当传入非空选择时要求 provider 与 model
 * 仍存在且通过 {@link isSelectableModel} 校验，否则抛出含中文档位标签的错误。
 *
 * @param label 用于错误提示的子模型标签，如「普通」「专家」。
 * @param selection 待校验的 providerId/modelId；null 表示该档位关闭。
 */
export function assertSelectableSubModel(
    label: string,
    selection: { providerId: string; modelId: string } | null
): void {
    if (!selection) return;
    const manager = getConfigManager();
    if (!manager) throw new Error('配置管理器尚未初始化');
    const provider = manager.getProvider(selection.providerId);
    const model = provider?.models.find((item) => item.modelId === selection.modelId);
    if (!provider || !model) {
        throw new Error(`${label}模型不存在：${selection.providerId}/${selection.modelId}`);
    }
    if (!isSelectableModel(provider, model)) {
        throw new Error(`${label}模型已被禁用，无法选择：${provider.name}/${model.displayName || model.modelId}`);
    }
}

/**
 * 处理「模型选择弹窗」一次性提交的普通 + 任务流 + 压缩选择。
 *
 * 串行执行普通模型保存、任务流模型保存与 Chat CLI pair 重启，最后再推送一次
 * snapshot，避免多下拉时代多次 select 各触发一次重启的冗余。
 *
 * @param normal 普通任务模型；null 表示未选。
 * @param taskFlow 任务流模型；null 表示未配置（回退主模型）。
 * @param compaction 压缩请求专用模型；null 表示「关闭压缩模型」。
 */
export async function handleModelsApplyPair(
    normal: { providerId: string; modelId: string } | null,
    taskFlow: { providerId: string; modelId: string } | null,
    compaction: { providerId: string; modelId: string } | null
): Promise<void> {
    const manager = getConfigManager();
    if (!manager) throw new Error('配置管理器尚未初始化');
    assertSelectableSubModel('普通', normal);
    assertSelectableSubModel('任务流', taskFlow);
    assertSelectableSubModel('压缩', compaction);
    if (normal) {
        const provider = manager.getProvider(normal.providerId);
        const model = provider?.models.find((item) => item.modelId === normal.modelId);
        if (!provider || !model) {
            throw new Error(`模型不存在：${normal.providerId}/${normal.modelId}`);
        }
        await manager.setCurrentModel({ providerId: normal.providerId, modelId: normal.modelId });
    }
    const taskFlowModelId = taskFlow ? `${taskFlow.providerId}/${taskFlow.modelId}` : '';
    await saveTaskFlowModelSelection(taskFlowModelId);
    const compactionModelId = compaction ? `${compaction.providerId}/${compaction.modelId}` : '';
    await saveCompactionModelSelection(compactionModelId);
    await requireDeps().postChatModelOptions();
    await requireDeps().postModelsSnapshot();
    await restartChatCliPair({ silent: true });
    await requireDeps().showChatToast('success', '模型已应用，Chat CLI 已重启。');
}

/**
 * 从 Chat 输入框切换当前模型，写入 Claude CLI 配置并自动重启长连接。
 *
 * @param providerId 提供商 ID。
 * @param modelId 模型 ID。
 * @param options.silent 为 true 时抑制成功 toast（任务流自动切模型用，避免刷屏）；
 *                       模型下拉刷新与 CLI 重启照常执行，保证 UI 与实际模型一致。
 */
export async function selectChatModel(
    providerId: string,
    modelId: string,
    options: { silent?: boolean } = {}
): Promise<void> {
    const manager = getConfigManager();
    if (!manager) throw new Error('配置管理器尚未初始化');
    const provider = manager.getProvider(providerId);
    const model = provider?.models.find((item) => item.modelId === modelId);
    if (!provider || !model) throw new Error(`模型不存在：${providerId}/${modelId}`);
    if (!isSelectableModel(provider, model)) {
        throw new Error(`模型已被禁用，无法选择：${provider.name}/${model.displayName || model.modelId}`);
    }
    await manager.setCurrentModel({ providerId, modelId });
    await requireDeps().postChatModelOptions();
    Logger.info(`Chat 输入框切换模型：${provider.name}/${model.displayName || model.modelId}，将重启 Chat CLI pair`);
    await restartChatCliPair({ silent: true });
    if (!options.silent) {
        await requireDeps().showChatToast('success', `模型已切换为：${provider.name}/${model.displayName || model.modelId}`);
    }
}

/**
 * workspaceState 键：任务流切换模型前的原主模型，形如 `providerId/modelId`。
 *
 * 用 workspaceState 而非内存变量，是为了让 VS Code 崩溃或窗口重载后仍能还原。
 */
const TASK_FLOW_PREVIOUS_MODEL_KEY = 'llsccai.taskFlow.previousMainModel';

/**
 * 切模型并重启 CLI 后，等待新进程 resume 会话就绪再提交续推的静置时长（毫秒）。
 *
 * `restartChatCliPair()` 返回时子进程刚 spawn 完，`--resume` 恢复会话与 MCP 桥
 * 握手都还在路上，立刻写 stdin 有丢消息风险。
 */
const TASK_FLOW_MODEL_SETTLE_DELAY_MS = 1_500;

/** {@link applyTaskFlowModelForContinue} 的结果：未配置跳过 / 无需切换 / 已切换。 */
export type TaskFlowModelSwitchResult = 'skipped' | 'unchanged' | 'switched';

/** 把 `providerId/modelId` 拆成两段；格式非法时返回 undefined。 */
function parseModelSelectionId(value: string): { providerId: string; modelId: string } | undefined {
    const separatorIndex = value.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex >= value.length - 1) return undefined;
    return {
        providerId: value.slice(0, separatorIndex),
        modelId: value.slice(separatorIndex + 1)
    };
}

/**
 * 任务流续推前把主 CLI 切到任务流模型，幂等，绝不向外抛错。
 *
 * 每次续推提交前调用：未配置任务流模型或已经处于该模型时不做任何事（不重启、
 * 不延时），只有模型确实需要变更时才保存原主模型、切换并重启 CLI，随后静置
 * {@link TASK_FLOW_MODEL_SETTLE_DELAY_MS} 让新进程就绪。
 *
 * 调用方是 AutoContinueScheduler 的 beforeSubmit 钩子，其抛错会导致本次续推被
 * 跳过，因此这里所有异常都在内部降级为「继续用主模型」。
 *
 * @returns 本次的处理结果。
 */
export async function applyTaskFlowModelForContinue(): Promise<TaskFlowModelSwitchResult> {
    try {
        const configured = readEffectiveTaskFlowModelSelection().trim();
        if (!configured) return 'skipped';
        const target = parseModelSelectionId(configured);
        if (!target) {
            Logger.warn(`[LlsTask] 任务流模型配置格式非法，回退主模型：${configured}`);
            return 'skipped';
        }
        const manager = getConfigManager();
        const current = manager?.getCurrentModel();
        if (current && current.providerId === target.providerId && current.modelId === target.modelId) {
            return 'unchanged';
        }
        const context = getExtensionContext();
        // 已存过就不覆盖，否则第二次切换会把「原主模型」写成任务流模型本身。
        if (context && current && !context.workspaceState.get<string>(TASK_FLOW_PREVIOUS_MODEL_KEY)) {
            await context.workspaceState.update(
                TASK_FLOW_PREVIOUS_MODEL_KEY,
                `${current.providerId}/${current.modelId}`
            );
        }
        Logger.info(`[LlsTask] 续推前切换到任务流模型：${configured}`);
        await selectChatModel(target.providerId, target.modelId, { silent: true });
        await new Promise((resolve) => setTimeout(resolve, TASK_FLOW_MODEL_SETTLE_DELAY_MS));
        return 'switched';
    } catch (err) {
        Logger.warn('[LlsTask] 切换任务流模型失败，本次续推继续使用当前模型：'
            + (err instanceof Error ? err.message : String(err)));
        return 'skipped';
    }
}

/**
 * 任务流结束后把主模型还原回切换前的值，幂等，绝不向外抛错。
 *
 * 先清 workspaceState 键再执行切换：还原过程中若抛错，下次不会重复还原到一个
 * 已经失效的模型上。
 *
 * @param reason 触发还原的原因，仅用于日志。
 */
export async function restoreMainModelAfterTaskFlow(reason: string): Promise<void> {
    const context = getExtensionContext();
    if (!context) return;
    const saved = (context.workspaceState.get<string>(TASK_FLOW_PREVIOUS_MODEL_KEY) ?? '').trim();
    if (!saved) return;
    await context.workspaceState.update(TASK_FLOW_PREVIOUS_MODEL_KEY, undefined);
    const target = parseModelSelectionId(saved);
    if (!target) {
        Logger.warn(`[LlsTask] 原主模型记录格式非法，已丢弃：${saved}`);
        return;
    }
    try {
        await selectChatModel(target.providerId, target.modelId, { silent: true });
        Logger.info(`[LlsTask] 任务流结束，主模型已还原为 ${saved}（reason=${reason}）`);
    } catch (err) {
        Logger.warn(`[LlsTask] 还原主模型 ${saved} 失败（reason=${reason}）：`
            + (err instanceof Error ? err.message : String(err)));
    }
}

/** workspaceState 中是否残留待还原的原主模型，供激活期补偿还原判断。 */
export function hasPendingTaskFlowModelRestore(): boolean {
    const saved = getExtensionContext()?.workspaceState.get<string>(TASK_FLOW_PREVIOUS_MODEL_KEY);
    return typeof saved === 'string' && saved.trim().length > 0;
}
