/** @file Restore saved workflow state only after explicit onboarding completion. */
import { getLlsTaskService } from '../runtime';
import { setPendingRestorePrompt } from '../taskFlow/taskFlowCommands';

/** Load pending workflow without automatically replaying task commands. */
export async function restoreTaskFlowSafelyForSetup(): Promise<void> {
    const service = getLlsTaskService();
    if (service && !service.hasActiveWorkflow()) setPendingRestorePrompt(await service.restore());
}
