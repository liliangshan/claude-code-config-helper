/** @file Direct help website, localization and non-blocking left/right chat integration. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: {} });
const vscode = require('vscode');
Object.assign(vscode, { commands: {} });
Object.assign(vscode.Uri, { parse: (url: string) => ({ toString: () => url }) });
const runtime = require('../../runtime') as typeof import('../../runtime');
const { openHelp, HELP_URL } = require('../help') as typeof import('../help');
const { COMMANDS } = require('../../constants') as typeof import('../../constants');

/** All locales open the same bare homepage immediately, without a topic picker or any private URL parameters. */
test('help opens the public homepage directly in every supported language without a dropdown', async () => {
    const languages = ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'];
    const opened: string[] = []; let language = 'en';
    runtime.setConfigManager({ getResolvedUiLanguage: () => language } as any);
    Object.assign(vscode.window, { showQuickPick: () => assert.fail('Help must not show a dropdown') });
    Object.assign(vscode.env, { openExternal: async (uri: any) => { opened.push(uri.toString()); return true; } });
    try {
        for (language of languages) await openHelp();
        assert.equal(HELP_URL, 'https://www.zhineng.dev/');
        assert.deepEqual(opened, Array(languages.length).fill(HELP_URL));
        for (const url of opened) {
            const parsed = new URL(url);
            assert.equal(parsed.origin, 'https://www.zhineng.dev'); assert.equal(parsed.pathname, '/');
            assert.equal(parsed.search, ''); assert.equal(parsed.hash, '');
        }
    } finally { runtime.setConfigManager(undefined); }
});

/** Simultaneous clicks share one browser request; false results and exceptions use localized warnings without retries. */
test('help coalesces browser launches and reports failures in all seven languages', async () => {
    let launches = 0; let finish!: (opened: boolean) => void;
    Object.assign(vscode.env, { openExternal: () => { launches++; return new Promise<boolean>(resolve => { finish = resolve; }); } });
    const first = openHelp(); const second = openHelp();
    assert.equal(first, second); assert.equal(launches, 1); finish(true); await first;
    const errors: Record<string, string> = {
        en: 'Could not open', 'zh-cn': '无法打开', 'zh-tw': '無法開啟', ja: 'ヘルプサイト',
        ko: '도움말 웹사이트', fr: 'Impossible', de: 'Hilfewebsite'
    };
    let language = 'en'; const warnings: string[] = [];
    runtime.setConfigManager({ getResolvedUiLanguage: () => language } as any);
    Object.assign(vscode.window, { showWarningMessage: async (message: string) => { warnings.push(message); } });
    try {
        for (language of Object.keys(errors)) {
            Object.assign(vscode.env, { openExternal: async () => false }); await openHelp();
            assert.ok(warnings.at(-1)?.includes(errors[language]));
            Object.assign(vscode.env, { openExternal: async () => { throw new Error('synthetic browser failure'); } }); await openHelp();
            assert.ok(warnings.at(-1)?.includes(errors[language]));
        }
        assert.equal(warnings.length, Object.keys(errors).length * 2);
        assert.ok(warnings.every(message => message.includes('www.zhineng.dev')));
    } finally { runtime.setConfigManager(undefined); }
});

/** All four controls use one command; no sidebar-only CSS may hide the text button from the left chat. */
test('both native toolbars and the shared chat button expose localized help', () => {
    const root = resolve(__dirname, '../../..');
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const help = manifest.contributes.commands.find((item: any) => item.command === COMMANDS.openHelp);
    assert.equal(help.icon, '$(question)'); assert.equal(help.title, '%command.help.open.title%');
    const toolbar = manifest.contributes.menus['view/title'].filter((item: any) => item.command === COMMANDS.openHelp);
    assert.deepEqual(toolbar.map((item: any) => item.when), ['view == claudeRouter.chatSidebarSecondary', 'view == claudeRouter.providersView && claudeRouter.leftChatActive']);
    for (const language of ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de']) {
        const file = language === 'en' ? 'package.nls.json' : `package.nls.${language}.json`;
        assert.ok(JSON.parse(readFileSync(resolve(root, file), 'utf8'))['command.help.open.title']);
    }
    const html = readFileSync(resolve(root, 'media/chat/index.html'), 'utf8');
    const button = html.match(/<button[^>]*data-role="help-open"[^>]*>/)?.[0] || '';
    assert.ok(button); assert.equal(button.includes('sidebar-only'), false);
    for (const attribute of ['data-i18n="helpLabel"', 'data-i18n-title="helpTitle"', 'data-i18n-aria-label="helpTitle"']) assert.ok(button.includes(attribute));
    const source = readFileSync(resolve(root, 'media/chat/main.js'), 'utf8');
    const start = source.indexOf('    const helpActionLabels = {'); const end = source.indexOf('\n    /**', start);
    const translations: Record<string, Record<string, string>> = Object.fromEntries(['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'fr', 'de'].map(language => [language, {}]));
    runInNewContext(source.slice(start, end), { chatTranslations: translations });
    for (const labels of Object.values(translations)) { assert.ok(labels.helpLabel); assert.ok(labels.helpTitle); }
    assert.equal(translations['zh-cn'].helpLabel, '帮助');
    const handler = source.split('\n').find(line => line.includes('[data-role="help-open"]') && line.includes('addEventListener'));
    assert.ok(handler); let click!: () => void; const sent: unknown[] = [];
    runInNewContext(handler, { document: { querySelector: () => ({ addEventListener: (_event: string, listener: () => void) => { click = listener; } }) },
        post: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))) });
    click(); assert.deepEqual(sent, [{ type: 'help/open' }]);
});

/** Help stays responsive while either conversation is updating or waiting on unrelated state operations. */
test('main, left and retained editor chat buttons route help without entering task queues or restarting CLI', async () => {
    const messages = require('../../chatRuntime/webviewMessages') as typeof import('../../chatRuntime/webviewMessages');
    const { EditorChatRuntime } = require('../../editorChat/runtime') as typeof import('../../editorChat/runtime');
    const { LeftChatSession } = require('../../editorChat/leftSession') as typeof import('../../editorChat/leftSession');
    const gate = require('../../setup/gate') as typeof import('../../setup/gate');
    const commands: string[] = [];
    Object.assign(vscode.commands, { executeCommand: async (command: string) => { commands.push(command); } });
    const never = new Promise<void>(() => {});
    const editor = Object.create(EditorChatRuntime.prototype) as InstanceType<typeof EditorChatRuntime>;
    Object.assign(editor, { closed: false, settingsQueue: never });
    const left = Object.create(LeftChatSession.prototype) as InstanceType<typeof LeftChatSession>;
    Object.assign(left, { operations: never });
    gate.setCliUpdateInProgress(true);
    try {
        await Promise.all([messages.handleChatWebviewMessage({ type: 'help/open' }), editor.receive({ type: 'help/open' }), left.receive({ type: 'help/open' })]);
        assert.deepEqual(commands, Array(3).fill(COMMANDS.openHelp));
        assert.equal((editor as any).settingsQueue, never); assert.equal((left as any).operations, never);
    } finally { gate.setCliUpdateInProgress(false); }
});

/** Native shortcuts and the command palette invoke the same direct homepage launcher as chat messages. */
test('command registration binds the shared help handler without requiring setup or a selected chat', () => {
    const { registerAllCommands } = require('../commands') as typeof import('../commands');
    const registered = new Map<string, unknown>();
    Object.assign(vscode.commands, { registerCommand: (name: string, handler: unknown) => { registered.set(name, handler); return { dispose() {} }; } });
    const context = { subscriptions: [] } as unknown as import('vscode').ExtensionContext;
    registerAllCommands(context);
    assert.equal(registered.get(COMMANDS.openHelp), openHelp);
    for (const disposable of context.subscriptions) disposable.dispose();
});

/** Public documentation stays English-only while retaining the website and optional MCP recommendations. */
test('README is English-only and keeps the website and all five recommended MCP package links', () => {
    const readme = readFileSync(resolve(__dirname, '../../../README.md'), 'utf8');
    assert.doesNotMatch(readme, /\p{Script=Han}/u);
    assert.ok(readme.includes('**Website: [www.zhineng.dev](https://www.zhineng.dev/)**'));
    assert.ok(readme.includes('## Recommended MCP Tools'));
    for (const name of ['ssh', 'mysql', 'mssqlserver', 'redis', 'apidebug']) {
        assert.ok(readme.includes(`https://www.npmjs.com/package/@liangshanli/mcp-server-${name}`));
    }
});
