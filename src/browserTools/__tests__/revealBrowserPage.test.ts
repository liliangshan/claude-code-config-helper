/** @file 浏览器标签显示命令回归：准确 pageId、不导航、不打开新 URL。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revealBrowserPage, type BrowserPageRevealApi } from '../revealBrowserPage';

const PAGE_ID = '11111111-2222-3333-4444-555555555555';

/** 构造只记录编辑器打开命令的 VS Code 桩。 */
function makeApi(withExistingTab: boolean): { api: BrowserPageRevealApi; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const api = {
        Uri: { from: (value: unknown) => value },
        commands: { executeCommand: async (...args: unknown[]) => { calls.push(args); } },
        window: { tabGroups: { all: withExistingTab ? [{ viewColumn: 2, tabs: [{ input: { uri: { scheme: 'vscode-browser', path: `/${PAGE_ID}` } } }] }] : [] } }
    } as unknown as BrowserPageRevealApi;
    return { api, calls };
}

for (const existing of [false, true]) {
    test(`显示指定浏览器页面，保留输入焦点及可识别的原分组 existing=${existing}`, async () => {
        const { api, calls } = makeApi(existing);
        await revealBrowserPage(PAGE_ID, api);
        assert.deepEqual(calls, [[
            'vscode.openWith', { scheme: 'vscode-browser', path: `/${PAGE_ID}` }, 'workbench.editor.browser',
            { ...(existing ? { viewColumn: 2 } : {}), preview: false, preserveFocus: true }
        ]]);
    });
}

test('无效 pageId 不得创建任意浏览器编辑器资源', async () => {
    const { api, calls } = makeApi(false);
    await assert.rejects(revealBrowserPage('https://example.com', api), /Invalid browser page ID/);
    assert.equal(calls.length, 0);
});
