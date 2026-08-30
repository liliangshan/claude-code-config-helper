/**
 * @file 浏览器会话导出/注入脚本与结果解析（sessionBridge）单元测试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EXPORT_SCRIPT, SKIP_MARKER, buildImportScript, parseExportResult } =
    require('../sessionBridge') as typeof import('../sessionBridge');

type BrowserSessionSnapshot = import('../sessionStore').BrowserSessionSnapshot;

/** 把内层负载包装成 run_playwright_code 的真实返回文本形态。 */
function wrapResult(payload: unknown): string {
    return `Result: ${JSON.stringify(JSON.stringify(payload))}\n`
        + 'Page Title: T\nURL: https://a.com/\nSnapshot: <unchanged>';
}

test('EXPORT_SCRIPT: 走 CDP 读 cookie 并带 readyState 判定', () => {
    assert.match(EXPORT_SCRIPT, /Network\.getAllCookies/);
    assert.match(EXPORT_SCRIPT, /document\.readyState/);
    assert.match(EXPORT_SCRIPT, new RegExp(SKIP_MARKER));
    // storageState 在 VS Code 内置浏览器不可用，不得出现
    assert.doesNotMatch(EXPORT_SCRIPT, /storageState/);
});

test('buildImportScript: 内联快照且脚本内不导航', () => {
    const snapshot: BrowserSessionSnapshot = {
        origin: 'https://a.com',
        savedAt: '2026-08-01T00:00:00.000Z',
        cookies: [{ name: 'tk', value: 'jwt', domain: '.a.com', path: '/', secure: false, httpOnly: true }],
        localStorage: [['token', 'jwt']],
        sessionStorage: [['s', '1']]
    };

    const script = buildImportScript(snapshot);

    assert.match(script, /Network\.setCookies/);
    assert.match(script, /"name":"tk"/);
    assert.match(script, /localStorage\.setItem/);
    assert.match(script, /sessionStorage\.setItem/);
    assert.doesNotMatch(script, /page\.goto|page\.reload/);
});

test('buildImportScript: 无 cookie 时跳过 setCookies 调用', () => {
    const script = buildImportScript({
        origin: 'https://a.com', savedAt: '', cookies: [], localStorage: [], sessionStorage: []
    });

    assert.match(script, /cookies\.length > 0/);
    assert.match(script, /const cookies = \[\];/);
});

test('parseExportResult: 两层反序列化并裁剪 cookie 只读字段', () => {
    const text = wrapResult({
        url: 'https://a.com/dash',
        cookies: [{
            name: 'tk', value: 'jwt', domain: '.a.com', path: '/',
            secure: true, httpOnly: true, expires: 1788155704, size: 250, priority: 'Medium'
        }],
        localStorage: [['token', 'jwt']],
        sessionStorage: []
    });

    const result = parseExportResult(text);

    assert.equal(result?.url, 'https://a.com/dash');
    assert.deepEqual(result?.cookies, [{
        name: 'tk', value: 'jwt', domain: '.a.com', path: '/',
        secure: true, httpOnly: true, expires: 1788155704
    }]);
    assert.deepEqual(result?.localStorage, [['token', 'jwt']]);
});

test('parseExportResult: skip 标记（页面未加载完成）返回 undefined', () => {
    assert.equal(parseExportResult(wrapResult({ skip: SKIP_MARKER })), undefined);
});

test('parseExportResult: 缺少 Result 段或 JSON 损坏时返回 undefined', () => {
    assert.equal(parseExportResult('Page Title: T\nSnapshot: x'), undefined);
    assert.equal(parseExportResult('Result: { broken\n'), undefined);
    assert.equal(parseExportResult('Result:\n'), undefined);
});

test('parseExportResult: 登出后空 cookie 如实解析为空数组（无非空守卫）', () => {
    const result = parseExportResult(wrapResult({
        url: 'https://a.com/login', cookies: [], localStorage: [], sessionStorage: []
    }));

    assert.deepEqual(result?.cookies, []);
    assert.deepEqual(result?.localStorage, []);
});

test('parseExportResult: 丢弃非法的 storage 条目', () => {
    const result = parseExportResult(wrapResult({
        url: 'https://a.com',
        cookies: [],
        localStorage: [['ok', 'v'], ['bad'], 'nope', [1, 2]],
        sessionStorage: 'not-an-array'
    }));

    assert.deepEqual(result?.localStorage, [['ok', 'v']]);
    assert.deepEqual(result?.sessionStorage, []);
});
