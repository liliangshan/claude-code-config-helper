/** @file Setup lifecycle façade shared with the configuration page. */
import type * as vscode from 'vscode';
import type { ConfigManager } from '../configManager';
import { SetupController } from './controller';
let controller: SetupController | undefined;
/** Initialize setup before registering chat open handlers. */
export function configureSetup(context: vscode.ExtensionContext, manager: ConfigManager): void { controller = new SetupController(context, manager); }
/** Return the non-secret status for the shared settings view. */
export function setupSnapshot(): ReturnType<SetupController['snapshot']> | undefined { return controller?.snapshot(); }
/** Expose the current host's setup coordinator to the single settings/onboarding Webview provider. */
export function getSetupController(): SetupController | undefined { return controller; }
