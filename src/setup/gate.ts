/** @file Initialization gate shared by sidebar, editor sessions and lifecycle restarts. */
let checker: (() => Promise<boolean>) | undefined;
let updating = false;
/** Bind the setup controller during extension activation. */
export function setSetupChecker(value: () => Promise<boolean>): void { checker = value; }
/** Check explicit global completion before any new CLI activity; isolated unit tests have no controller. */
export async function requireSetup(): Promise<boolean> {
    if (updating) return false;
    const ready = checker ? await checker() : true;
    return ready && !updating;
}
/** Block new task admission during an approved all-session CLI update. */
export function setCliUpdateInProgress(value: boolean): void { updating = value; }
/** Existing runtimes use this synchronous guard to reject sends during a version switch. */
export function isCliUpdateInProgress(): boolean { return updating; }
