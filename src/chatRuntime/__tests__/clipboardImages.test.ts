/** @file 网页粘贴图片读取的格式、地址与下载限制回归测试。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { isPublicImageAddress, readClipboardImage, validateClipboardImage, CLIPBOARD_IMAGE_MAX_BYTES } from '../clipboardImages';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iN0AAAAASUVORK5CYII=', 'base64');

test('拒绝内网、回环、链路本地与映射 IPv6 地址', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1']) assert.equal(isPublicImageAddress(ip), false, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicImageAddress(ip), true, ip);
});

test('内嵌 PNG 直接解码，假图片和超限图片被拒绝', async () => {
    const image = await readClipboardImage('data:image/png;base64,' + PNG.toString('base64'));
    assert.deepEqual(image.bytes, PNG);
    assert.equal(image.extension, '.png');
    assert.throws(() => validateClipboardImage(Buffer.from('<html>not image</html>')), /Unsupported/);
    assert.throws(() => validateClipboardImage(Buffer.alloc(CLIPBOARD_IMAGE_MAX_BYTES + 1)), /20 MiB/);
    for (const url of ['file:///etc/passwd', 'blob:https://example.com/a', 'http://127.0.0.1/a.png', 'http://2130706433/a.png', 'https://user:password@example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=']) await assert.rejects(readClipboardImage(url));
});

test('公网图片下载不携带凭据，DNS 私有地址和重定向到内网均拒绝', async t => {
    let address = '8.8.8.8';
    let redirect = false;
    const requests: any[] = [];
    t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address, family: 4 }]);
    t.mock.method(require('node:https'), 'get', (_url: URL, options: any, onResponse: (res: any) => void) => {
        requests.push(options);
        const req = Object.assign(new EventEmitter(), { destroy: (error: Error) => { req.emit('error', error); } });
        queueMicrotask(() => {
            options.lookup('img.example.com', { all: true }, (error: Error | null) => {
                if (error) { req.emit('error', error); return; }
                const res = Object.assign(new EventEmitter(), {
                    statusCode: redirect ? 302 : 200,
                    headers: redirect ? { location: 'https://127.0.0.1/private.png' } : { 'content-type': 'image/png' },
                    destroy: () => {}
                });
                onResponse(res);
                if (!redirect) { res.emit('data', PNG); res.emit('end'); }
            });
        });
        return req;
    });
    assert.deepEqual((await readClipboardImage('https://img.example.com/a.png')).bytes, PNG);
    assert.equal(requests[0].headers.Cookie, undefined);
    assert.equal(requests[0].headers.Authorization, undefined);
    address = '127.0.0.1';
    await assert.rejects(readClipboardImage('https://img.example.com/a.png'));
    address = '8.8.8.8';
    redirect = true;
    await assert.rejects(readClipboardImage('https://img.example.com/a.png'), /Private/);
});
