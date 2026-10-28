/** @file Saved main-chat settings copied once when an independent conversation is created. */
import * as vscode from 'vscode';
import type { ConfigManager } from '../configManager';
import { ChatCliConfigService } from '../chat/cli/cliConfig';
import { readEffectiveTaskFlowModelSelection, readEffectiveCompactionModelSelection } from '../chatRuntime/modelSelection';
import type { EditorSettings } from './store';

/** Copy persisted main settings without inheriting another conversation's runtime state or credentials. */
export function independentChatDefaults(context: vscode.ExtensionContext, manager: ConfigManager): EditorSettings {
    const config = vscode.workspace.getConfiguration('claudeCodeConfigHelper');
    const selected = manager.getCurrentModel();
    const compact = readEffectiveCompactionModelSelection();
    const previousMain = context.workspaceState.get<string>('llsccai.taskFlow.previousMainModel');
    return { normalModel: previousMain || (selected ? `${selected.providerId}/${selected.modelId}` : ''), taskFlowModel: readEffectiveTaskFlowModelSelection(),
        compactionModel: compact.enabled ? compact.modelId : '', reasoningEffort: manager.getChatReasoningEffort(),
        permissionMode: new ChatCliConfigService(manager).getConfig().permissionMode ?? 'acceptEdits',
        subagentsEnabled: manager.getChatSubagentsEnabled(), autoCompactEnabled: config.get('chat.autoCompact.enabled', false),
        codePreviewEnabled: config.get('editor.codePreview.enabled', false), cacheTtl: manager.getChatCacheTtl() };
}
