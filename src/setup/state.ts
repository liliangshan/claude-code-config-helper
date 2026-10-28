/** @file Validated onboarding state; an existing CLI never substitutes for explicit completion. */
export const SETUP_KEY = 'setup.state';
export const SETUP_COMPLETE_KEY = 'setup.completed';
/** Machine/profile-local onboarding checkpoint, containing references but no credentials. */
export interface SetupState {
    schemaVersion: 1;
    completed: boolean;
    lastStep: 1 | 2 | 3;
    environmentId: string;
    installSource?: 'official' | 'china';
    installRoot?: string;
    cli?: { path: string; version: string; source: 'managed' | 'external'; verifiedAt: number; installRoot?: string };
    previousCli?: SetupState['cli'];
    defaultModel?: { providerId: string; modelId: string };
    completedAt?: number;
}
/** Missing state or either incomplete flag always requires the wizard, even for existing users. */
export function isSetupComplete(flag: unknown, state: unknown, environmentId: string): state is SetupState {
    const value = state as SetupState | undefined;
    return flag === true && value?.schemaVersion === 1 && value.completed === true && value.environmentId === environmentId;
}
/** Compare stable numeric releases, rejecting prereleases and malformed metadata. */
export function compareVersions(a: string, b: string): number {
    if (![a, b].every(v => /^\d+\.\d+\.\d+$/.test(v))) throw new Error('Invalid stable CLI version');
    const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
    return 0;
}
