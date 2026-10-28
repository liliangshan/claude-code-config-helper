/** @file Direct website help shared by native title bars and chat buttons, with localized failure messages. */
import * as vscode from 'vscode';
import { getConfigManager } from '../runtime';

/** Fixed public homepage; no conversation, credential or workspace data is appended. */
export const HELP_URL = 'https://www.zhineng.dev/';

/** Browser failure messages follow the extension's selected language. */
const HELP_ERRORS: Record<string, string> = {
    en: 'Could not open the help website. Please visit www.zhineng.dev in your browser.',
    'zh-cn': '无法打开帮助网站，请在浏览器访问 www.zhineng.dev。',
    'zh-tw': '無法開啟說明網站，請在瀏覽器造訪 www.zhineng.dev。',
    ja: 'ヘルプサイトを開けません。ブラウザーで www.zhineng.dev を開いてください。',
    ko: '도움말 웹사이트를 열 수 없습니다. 브라우저에서 www.zhineng.dev를 방문하세요.',
    fr: 'Impossible d’ouvrir le site d’aide. Consultez www.zhineng.dev dans votre navigateur.',
    de: 'Die Hilfewebsite konnte nicht geöffnet werden. Öffnen Sie www.zhineng.dev im Browser.'
};

let pendingHelp: Promise<void> | undefined;

/** Open the homepage directly and coalesce simultaneous clicks without changing either chat's lifecycle. */
export function openHelp(): Promise<void> {
    if (pendingHelp) return pendingHelp;
    const action = openHelpWebsite();
    pendingHelp = action;
    void action.then(() => { if (pendingHelp === action) pendingHelp = undefined; }, () => { if (pendingHelp === action) pendingHelp = undefined; });
    return action;
}

/** Launch the fixed homepage without a topic picker; accurately report rejected or failed browser requests. */
async function openHelpWebsite(): Promise<void> {
    const language = getConfigManager()?.getResolvedUiLanguage() ?? 'en';
    try {
        if (await vscode.env.openExternal(vscode.Uri.parse(HELP_URL))) return;
    } catch { /* Browser failures are reported without logging any user data. */ }
    void vscode.window.showWarningMessage(HELP_ERRORS[language] || HELP_ERRORS.en);
}
