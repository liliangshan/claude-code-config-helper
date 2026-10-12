/** @file 工作区代码预览：自动开档过滤、运行时切换及消息保存回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} }, workspaceFolderFsPath: '/workspace' });
const vscodeApi = require('vscode') as typeof import('vscode');
const { EditorAutoOpener, CODE_PREVIEW_SETTING_KEY, getCodePreviewEnabled, setCodePreviewEnabled } = require('../../editorAutoOpen') as typeof import('../../editorAutoOpen');

/** 为当前测试设置仅工作区范围的开关。 */
function preview(enabled?: boolean): void {
    stub.inspect = { claudeCodeConfigHelper: { [CODE_PREVIEW_SETTING_KEY]: { workspaceValue: enabled } } };
}

/** 安装记录自动显示行为的 VS Code 文件 API，不读取真实文件。 */
function mockEditors() {
    const opened: string[] = [];
    const shown: string[] = [];
    Object.assign(vscodeApi.window, {
        visibleTextEditors: [],
        showTextDocument: async (document: { uri: { fsPath: string } }, options: unknown) => {
            assert.deepEqual(options, { preview: false, preserveFocus: true });
            shown.push(document.uri.fsPath);
        }
    });
    Object.assign(vscodeApi.workspace, {
        openTextDocument: async (uri: { fsPath: string }) => { opened.push(uri.fsPath); return { uri }; }
    });
    stub.values = { claudeCodeConfigHelper: {} };
    stub.workspaceFolderFsPath = '/workspace';
    preview();
    return { opened, shown, opener: new EditorAutoOpener() };
}

test('默认关闭：文件工具不打开代码，但 Markdown 文档保持自动打开', async () => {
    const { opener, opened, shown } = mockEditors();
    assert.equal(getCodePreviewEnabled(), false);
    for (const toolName of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        await opener.observeToolUse({ toolName, filePath: toolName === 'NotebookEdit' ? 'test.ipynb' : 'src/test.ts' });
    }
    assert.deepEqual(opened, []);
    for (const filePath of ['README.md', 'NOTES.MD', 'docs/guide.markdown']) await opener.observeToolUse({ toolName: 'Read', filePath });
    assert.deepEqual(shown, ['/workspace/README.md', '/workspace/NOTES.MD', '/workspace/docs/guide.markdown']);
});

test('工作区配置不继承全局，开关即时生效且工作区外文件仍被拒绝', async () => {
    const { opener, shown } = mockEditors();
    stub.inspect = { claudeCodeConfigHelper: { [CODE_PREVIEW_SETTING_KEY]: { globalValue: true } } };
    assert.equal(getCodePreviewEnabled(), false);
    preview(true);
    await opener.observeToolUse({ toolName: 'Edit', filePath: 'src/a.ts' });
    preview(false);
    await opener.observeToolUse({ toolName: 'Read', filePath: 'src/b.ts' });
    await opener.observeToolUse({ toolName: 'Read', filePath: '../outside.md' });
    await opener.observeToolUse({ toolName: 'browser_open', filePath: 'docs/readme.md' });
    assert.deepEqual(shown, ['/workspace/src/a.ts']);
});

test('开启预览后所有文件工具恢复显示，已显示文件仍不重复打开', async () => {
    const { opener, shown, opened } = mockEditors();
    preview(true);
    for (const [index, toolName] of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].entries()) {
        await opener.observeToolUse({ toolName, filePath: toolName === 'NotebookEdit' ? 'note.ipynb' : `src/file-${index}.ts` });
    }
    assert.equal(shown.length, 5);
    Object.assign(vscodeApi.window, { visibleTextEditors: [{ document: { uri: { fsPath: '/workspace/visible.ts' } } }] });
    await opener.observeToolUse({ toolName: 'Read', filePath: 'visible.ts' });
    assert.equal(opened.length, 5);
});

test('等待新文件重试期间关闭预览，不再重试或自动显示', async () => {
    const { opener, shown } = mockEditors();
    preview(true);
    let attempts = 0;
    Object.assign(vscodeApi.workspace, {
        openTextDocument: async () => { attempts += 1; preview(false); throw new Error('not created yet'); }
    });
    await opener.observeToolUse({ toolName: 'Write', filePath: 'new.ts' });
    assert.equal(attempts, 1);
    assert.deepEqual(shown, []);
});

test('文件读取等待期间关闭预览，迟到文档不会弹出', async () => {
    const { opener, shown } = mockEditors();
    preview(true);
    Object.assign(vscodeApi.workspace, { openTextDocument: async (uri: unknown) => { preview(false); return { uri }; } });
    await opener.observeToolUse({ toolName: 'Edit', filePath: 'src/a.ts' });
    assert.deepEqual(shown, []);
});

test('消息写入工作区、失败回填真实状态，无工作区时不写全局', async t => {
    mockEditors();
    let value = false;
    let fail = false;
    const writes: unknown[][] = [];
    const received: unknown[] = [];
    const runtime = require('../../runtime') as typeof import('../../runtime');
    const messages = require('../webviewMessages') as typeof import('../webviewMessages');
    const lifecycle = require('../cliLifecycle');
    t.mock.method(lifecycle, 'restartChatCli', async () => assert.fail('不得重启 CLI'));
    t.mock.method(vscodeApi.workspace, 'getConfiguration', () => ({
        inspect: () => ({ workspaceValue: value }),
        update: async (key: string, enabled: boolean, target: unknown) => {
            writes.push([key, enabled, target]);
            if (fail) throw new Error('denied');
            value = enabled;
        }
    }) as never);
    runtime.setConfigManager({ getResolvedUiLanguage: () => 'zh-tw' } as never);
    runtime.setChatViewHost({ postMessage: async (message: unknown) => { received.push(message); return true; } } as never);
    try {
        await messages.postChatCodePreviewEnabled();
        assert.deepEqual(received.pop(), { type: 'codePreview/current', enabled: false });
        await messages.handleChatWebviewMessage({ type: 'codePreview/select', enabled: true });
        assert.deepEqual(writes[0], [CODE_PREVIEW_SETTING_KEY, true, vscodeApi.ConfigurationTarget.Workspace]);
        assert.deepEqual(received.pop(), { type: 'codePreview/current', enabled: true });
        fail = true;
        await messages.handleChatWebviewMessage({ type: 'codePreview/select', enabled: false });
        assert.deepEqual(received.pop(), { type: 'codePreview/current', enabled: true });
        assert.match(JSON.stringify(received.pop()), /程式碼預覽設定儲存失敗/);
        stub.workspaceFolderFsPath = undefined;
        const count = writes.length;
        await assert.rejects(setCodePreviewEnabled(false), /Workspace/);
        assert.equal(writes.length, count);
        await assert.rejects(setCodePreviewEnabled('true' as unknown as boolean), /Invalid/);
    } finally {
        runtime.setConfigManager(undefined);
        runtime.setChatViewHost(undefined);
        stub.workspaceFolderFsPath = '/workspace';
    }
});

test('原有自动打开总开关关闭时，代码和 Markdown 均遵守原行为', async () => {
    const { opener, shown } = mockEditors();
    preview(true);
    stub.values.claudeCodeConfigHelper['editor.autoOpenReadWriteFiles'] = false;
    await opener.observeToolUse({ toolName: 'Edit', filePath: 'src/a.ts' });
    await opener.observeToolUse({ toolName: 'Read', filePath: 'README.md' });
    assert.deepEqual(shown, []);
});
