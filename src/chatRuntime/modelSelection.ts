/**
 * Chat 四档模型（普通 / 专家 / 方案 / 审查）与压缩模型的读取、保存与切换。
 *
 * 拆分自 extension.ts：把「按项目 > 全局 > 关闭优先级解析配置」「写回项目与全局配置」
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
    CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY,
    CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY,
    CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY,
    CHAT_EXPERT_MODE_PROJECT_MODEL_KEY,
    CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY,
    CHAT_PLAN_MODE_GLOBAL_MODEL_KEY,
    CHAT_PLAN_MODE_PROJECT_ENABLED_KEY,
    CHAT_PLAN_MODE_PROJECT_MODEL_KEY,
    CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY,
    CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY,
    CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY,
    CHAT_REVIEW_MODE_PROJECT_MODEL_KEY,
    CONFIG_NAMESPACE
} from '../constants';
import { Logger } from '../logger';
import { getConfigManager } from '../runtime';
import type { ModelConfig, ProviderConfigWithoutSecrets } from '../types';
import { restartChatCliPair } from './cliLifecycle';

/** modelSelection 需要但仍留在 extension.ts 的协作函数集合。 */
export interface ModelSelectionDeps {
    /** 向 Webview 推送普通模型下拉框选项。 */
    postChatModelOptions: () => Promise<void>;
    /** 向 Webview 推送专家模型下拉框选项。 */
    postChatExpertModelOptions: () => Promise<void>;
    /** 向 Webview 推送方案模型下拉框选项。 */
    postChatPlanModelOptions: () => Promise<void>;
    /** 向 Webview 推送审查模型下拉框选项。 */
    postChatReviewModelOptions: () => Promise<void>;
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

/** Chat 底部专家模型下拉框的解析结果。 */
export interface EffectiveExpertModelSelection {
    /** 是否启用专家；false 表示关闭专家。 */
    enabled: boolean;
    /** 生效专家模型 ID，关闭或未配置时为空字符串。 */
    modelId: string;
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
 * 按「项目 > 全局 > 关闭」规则读取专家模型下拉框当前值。
 *
 * 项目显式关闭时直接关闭；项目没有非关闭配置时读取全局；全局也没有时关闭。
 */
export function readEffectiveExpertModelSelection(): EffectiveExpertModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_EXPERT_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
    if (globalEnabled === false) return { enabled: false, modelId: '' };
    if (globalEnabled === true && globalModel.length > 0) return { enabled: true, modelId: globalModel };
    if (globalModel.length > 0) return { enabled: true, modelId: globalModel };
    return { enabled: false, modelId: '' };
}

/**
 * 按「项目 > 全局 > 关闭」规则读取方案模型下拉框当前值。
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

export function readEffectivePlanModelSelection(): ChatRoutedModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_PLAN_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_PLAN_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_PLAN_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
    if (globalEnabled === false) return { enabled: false, modelId: '' };
    if (globalEnabled === true && globalModel.length > 0) return { enabled: true, modelId: globalModel };
    if (globalModel.length > 0) return { enabled: true, modelId: globalModel };
    return { enabled: false, modelId: '' };
}

/**
 * 按「项目 > 全局 > 关闭」规则读取审查模型下拉框当前值。
 */
export function readEffectiveReviewModelSelection(): ChatRoutedModelSelection {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const projectEnabled = getInspectedWorkspaceValue(config.inspect<boolean>(CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY));
    const projectModel = (getInspectedWorkspaceValue(config.inspect<string>(CHAT_REVIEW_MODE_PROJECT_MODEL_KEY)) ?? '').trim();
    if (projectEnabled === false) return { enabled: false, modelId: '' };
    if (projectEnabled === true && projectModel.length > 0) return { enabled: true, modelId: projectModel };
    if (projectModel.length > 0) return { enabled: true, modelId: projectModel };

    const globalEnabled = getInspectedGlobalValue(config.inspect<boolean>(CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY));
    const globalModel = (getInspectedGlobalValue(config.inspect<string>(CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY)) ?? '').trim();
    if (globalEnabled === false) return { enabled: false, modelId: '' };
    if (globalEnabled === true && globalModel.length > 0) return { enabled: true, modelId: globalModel };
    if (globalModel.length > 0) return { enabled: true, modelId: globalModel };
    return { enabled: false, modelId: '' };
}

/**
 * 保存专家模型下拉框选择，并同步写入项目配置与全局配置。
 *
 * @param modelId 专家模型 ID；空字符串表示关闭专家。
 */
export async function saveExpertModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_EXPERT_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_EXPERT_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_EXPERT_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_EXPERT_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
    getConfigManager()?.notifyChanged();
}

/**
 * 保存方案模型下拉框选择，并同步写入项目配置与全局配置。
 *
 * @param modelId 方案模型 ID；空字符串表示关闭方案。
 */
export async function savePlanModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_PLAN_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_PLAN_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_PLAN_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_PLAN_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
    getConfigManager()?.notifyChanged();
}

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
 * 保存审查模型下拉框选择，并同步写入项目配置与全局配置。
 *
 * @param modelId 审查模型 ID；空字符串表示关闭审查。
 */
export async function saveReviewModelSelection(modelId: string): Promise<void> {
    const normalizedModelId = modelId.trim();
    const enabled = normalizedModelId.length > 0;
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(CHAT_REVIEW_MODE_PROJECT_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_REVIEW_MODE_PROJECT_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Workspace);
    await config.update(CHAT_REVIEW_MODE_GLOBAL_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
    await config.update(CHAT_REVIEW_MODE_GLOBAL_MODEL_KEY, normalizedModelId, vscode.ConfigurationTarget.Global);
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
    if (route === 'expert') {
        const current = readEffectiveExpertModelSelection();
        return current.enabled ? findModelDisplayName(current.modelId) : '';
    }
    if (route === 'plan') {
        const current = readEffectivePlanModelSelection();
        return current.enabled ? findModelDisplayName(current.modelId) : '';
    }
    const current = readEffectiveReviewModelSelection();
    return current.enabled ? findModelDisplayName(current.modelId) : '';
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
 * 在普通 / 专家 / 方案 / 审查任一档位提交前调用。当传入空选择时直接放行
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
 * 处理「模型选择弹窗」一次性提交的普通 + 专家选择。
 *
 * 串行执行普通模型保存、专家模型保存与 Chat CLI pair 重启，最后再推送一次
 * snapshot，避免双下拉时代两次 select 各触发一次重启的冗余。
 *
 * @param normal 普通任务模型；null 表示未选。
 * @param expert 专家任务模型；null 表示「关闭专家」。
 */
export async function handleModelsApplyPair(
    normal: { providerId: string; modelId: string } | null,
    expert: { providerId: string; modelId: string } | null,
    plan: { providerId: string; modelId: string } | null,
    review: { providerId: string; modelId: string } | null,
    compaction: { providerId: string; modelId: string } | null
): Promise<void> {
    const manager = getConfigManager();
    if (!manager) throw new Error('配置管理器尚未初始化');
    assertSelectableSubModel('普通', normal);
    assertSelectableSubModel('专家', expert);
    assertSelectableSubModel('方案', plan);
    assertSelectableSubModel('审查', review);
    assertSelectableSubModel('压缩', compaction);
    if (normal) {
        const provider = manager.getProvider(normal.providerId);
        const model = provider?.models.find((item) => item.modelId === normal.modelId);
        if (!provider || !model) {
            throw new Error(`模型不存在：${normal.providerId}/${normal.modelId}`);
        }
        await manager.setCurrentModel({ providerId: normal.providerId, modelId: normal.modelId });
    }
    const expertModelId = expert ? `${expert.providerId}/${expert.modelId}` : '';
    await saveExpertModelSelection(expertModelId);
    const planModelId = plan ? `${plan.providerId}/${plan.modelId}` : '';
    await savePlanModelSelection(planModelId);
    const reviewModelId = review ? `${review.providerId}/${review.modelId}` : '';
    await saveReviewModelSelection(reviewModelId);
    const compactionModelId = compaction ? `${compaction.providerId}/${compaction.modelId}` : '';
    await saveCompactionModelSelection(compactionModelId);
    await requireDeps().postChatModelOptions();
    await requireDeps().postChatExpertModelOptions();
    await requireDeps().postChatPlanModelOptions();
    await requireDeps().postChatReviewModelOptions();
    await requireDeps().postModelsSnapshot();
    await restartChatCliPair({ silent: true });
    await requireDeps().showChatToast('success', '模型已应用，Chat CLI 已重启。');
}

/**
 * 从 Chat 输入框切换当前模型，写入 Claude CLI 配置并自动重启长连接。
 *
 * @param providerId 提供商 ID。
 * @param modelId 模型 ID。
 */
export async function selectChatModel(providerId: string, modelId: string): Promise<void> {
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
    await requireDeps().showChatToast('success', `模型已切换为：${provider.name}/${model.displayName || model.modelId}`);
}

/**
 * 从 Chat 输入框下方专家下拉框切换专家模型，并同步保存项目与全局配置。
 *
 * @param modelId 专家模型 ID；空字符串表示关闭专家。
 */
export async function selectChatExpertModel(modelId: string): Promise<void> {
    await saveExpertModelSelection(modelId);
    await requireDeps().postChatExpertModelOptions();
    const current = readEffectiveExpertModelSelection();
    if (!current.enabled) {
        Logger.info('Chat 输入框关闭专家模式，已同步保存项目与全局配置');
        await restartChatCliPair({ silent: true });
        await requireDeps().showChatToast('success', '专家已关闭');
        return;
    }
    Logger.info(`Chat 输入框切换专家模型：${current.modelId}，已同步保存项目与全局配置`);
    await restartChatCliPair({ silent: true });
    await requireDeps().showChatToast('success', `专家模型已切换为：${current.modelId}`);
}

/**
 * 从 Chat 输入框方案模型下拉框切换方案模型，并同步保存项目与全局配置。
 *
 * @param modelId 方案模型 ID；空字符串表示关闭方案。
 */
export async function selectChatPlanModel(modelId: string): Promise<void> {
    await savePlanModelSelection(modelId);
    await requireDeps().postChatPlanModelOptions();
    const current = readEffectivePlanModelSelection();
    if (!current.enabled) {
        Logger.info('Chat 输入框关闭方案模式，已同步保存项目与全局配置');
        await restartChatCliPair({ silent: true });
        await requireDeps().showChatToast('success', '方案已关闭');
        return;
    }
    Logger.info(`Chat 输入框切换方案模型：${current.modelId}，已同步保存项目与全局配置`);
    await restartChatCliPair({ silent: true });
    await requireDeps().showChatToast('success', `方案模型已切换为：${current.modelId}`);
}

/**
 * 从 Chat 输入框审查模型下拉框切换审查模型，并同步保存项目与全局配置。
 *
 * @param modelId 审查模型 ID；空字符串表示关闭审查。
 */
export async function selectChatReviewModel(modelId: string): Promise<void> {
    await saveReviewModelSelection(modelId);
    await requireDeps().postChatReviewModelOptions();
    const current = readEffectiveReviewModelSelection();
    if (!current.enabled) {
        Logger.info('Chat 输入框关闭审查模式，已同步保存项目与全局配置');
        await restartChatCliPair({ silent: true });
        await requireDeps().showChatToast('success', '审查已关闭');
        return;
    }
    Logger.info(`Chat 输入框切换审查模型：${current.modelId}，已同步保存项目与全局配置`);
    await restartChatCliPair({ silent: true });
    await requireDeps().showChatToast('success', `审查模型已切换为：${current.modelId}`);
}
