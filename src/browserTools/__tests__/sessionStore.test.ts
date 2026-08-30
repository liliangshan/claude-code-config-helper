/**
 * @file 浏览器会话快照持久化（sessionStore）单元测试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BrowserSessionStore, toOrigin, sanitizeCookies, isExpired } =
    require('../sessionStore') as typeof import('../sessionStore');

type BrowserSessionSnapshot = import('../sessionStore').BrowserSessionSnapshot;

/** 构造内存版 SecretStorage 替身。 */
function makeSecrets(): { secrets: import('../sessionStore').SecretStorageLike; data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        secrets: {
            get: (key) => Promise.resolve(data.get(key)),
            store: (key, value) => { data.set(key, value); return Promise.resolve(); },
            delete: (key) => { data.delete(key); return Promise.resolve(); }
        }
    };
}

/** 构造一个最小快照。 */
function makeSnapshot(origin: string): BrowserSessionSnapshot {
    return {
        origin,
        savedAt: '2026-08-01T00:00:00.000Z',
        cookies: [{ name: 'a', value: '1', domain: '.example.com', path: '/', secure: false, httpOnly: false }],
        localStorage: [['token', 'jwt']],
        sessionStorage: []
    };
}

test('toOrigin: 提取 http(s) origin，非 http(s) 返回 undefined', () => {
    assert.equal(toOrigin('https://console.xingchiyun.com/dashboard?a=1'), 'https://console.xingchiyun.com');
    assert.equal(toOrigin('http://localhost:3000/x'), 'http://localhost:3000');
    assert.equal(toOrigin('about:blank'), undefined);
    assert.equal(toOrigin('chrome-error://chromewebdata/'), undefined);
    assert.equal(toOrigin('not a url'), undefined);
});

test('sanitizeCookies: 裁剪只读字段并保留可回灌字段', () => {
    const result = sanitizeCookies([
        {
            name: 'gtxi_auth_token', value: 'jwt', domain: '.xingchiyun.com', path: '/',
            secure: false, httpOnly: true, expires: 1788155704,
            size: 250, priority: 'Medium', sourcePort: 443, sourceScheme: 'Secure'
        }
    ]);

    assert.deepEqual(result, [{
        name: 'gtxi_auth_token', value: 'jwt', domain: '.xingchiyun.com', path: '/',
        secure: false, httpOnly: true, expires: 1788155704
    }]);
});

test('sanitizeCookies: 丢弃缺少必要字段的项并保留合法 sameSite', () => {
    const result = sanitizeCookies([
        null,
        'nope',
        { name: 'x' },
        { name: 'ok', value: 'v', domain: 'a.com', sameSite: 'None' },
        { name: 'bad', value: 'v', domain: 'a.com', sameSite: 'Weird' }
    ]);

    assert.equal(result.length, 2);
    assert.equal(result[0].sameSite, 'None');
    assert.equal(result[0].path, '/');
    assert.equal(result[1].sameSite, undefined);
});

test('isExpired: 会话级 cookie 视为未过期，过期时间戳按秒比较', () => {
    const now = 1_800_000_000_000;
    assert.equal(isExpired({ name: 'a', value: '1', domain: 'x', path: '/', secure: false, httpOnly: false }, now), false);
    assert.equal(isExpired({ name: 'a', value: '1', domain: 'x', path: '/', secure: false, httpOnly: false, expires: 1_700_000_000 }, now), true);
    assert.equal(isExpired({ name: 'a', value: '1', domain: 'x', path: '/', secure: false, httpOnly: false, expires: 1_900_000_000 }, now), false);
});

test('BrowserSessionStore: save 后可 load 回同一快照并登记索引', async () => {
    const { secrets } = makeSecrets();
    const store = new BrowserSessionStore(secrets);
    const snapshot = makeSnapshot('https://a.com');

    await store.save(snapshot);

    assert.deepEqual(await store.load('https://a.com'), snapshot);
    assert.deepEqual(await store.listOrigins(), ['https://a.com']);
});

test('BrowserSessionStore: 重复 save 同一 origin 不重复登记索引', async () => {
    const { secrets } = makeSecrets();
    const store = new BrowserSessionStore(secrets);

    await store.save(makeSnapshot('https://a.com'));
    await store.save(makeSnapshot('https://a.com'));
    await store.save(makeSnapshot('https://b.com'));

    assert.deepEqual(await store.listOrigins(), ['https://a.com', 'https://b.com']);
});

test('BrowserSessionStore: load 不存在的 origin 返回 undefined', async () => {
    const { secrets } = makeSecrets();
    assert.equal(await new BrowserSessionStore(secrets).load('https://nope.com'), undefined);
});

test('BrowserSessionStore: 快照 JSON 损坏时 load 返回 undefined 而不抛错', async () => {
    const { secrets, data } = makeSecrets();
    data.set('llsccai.browserSession.https://a.com', '{ broken');

    assert.equal(await new BrowserSessionStore(secrets).load('https://a.com'), undefined);
});

test('BrowserSessionStore: delete 移除快照与索引项', async () => {
    const { secrets } = makeSecrets();
    const store = new BrowserSessionStore(secrets);
    await store.save(makeSnapshot('https://a.com'));
    await store.save(makeSnapshot('https://b.com'));

    await store.delete('https://a.com');

    assert.equal(await store.load('https://a.com'), undefined);
    assert.deepEqual(await store.listOrigins(), ['https://b.com']);
});

test('BrowserSessionStore: 索引损坏时按空索引处理', async () => {
    const { secrets, data } = makeSecrets();
    data.set('llsccai.browserSession.__index', 'not json');

    assert.deepEqual(await new BrowserSessionStore(secrets).listOrigins(), []);
});
