/** @file Native HTTP tool tests use loopback servers only; no paid APIs or real credentials. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { HttpToolHost } from '../httpHost';
import { HTTP_BODY_LIMIT, HTTP_RESPONSE_LIMIT } from '../tools';

/** Bind an isolated local fixture. */
async function listen(server: http.Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

/** Release all fixture connections, including intentional slow responses. */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Preserve exact request fields, query, UTF-8 and HTTP errors while leaving response cookies stateless. */
test('HTTP native fetch sends explicit headers/body once and returns 400/500 response bodies', async () => {
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
        let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', () => {
            requests.push({ url: req.url, method: req.method, headers: req.headers, body });
            res.writeHead(req.url?.startsWith('/error') ? 500 : 400, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'fixture=not-reused' });
            res.end(JSON.stringify({ detail: '中文🙂', method: req.method }));
        });
    });
    const url = await listen(server), host = new HttpToolHost();
    try {
        const first = await host.execute('http_fetch', { url: url + '/api?q=a%20b', options: { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic' }, body: '{"test":"中文🙂"}' } });
        assert.equal(first.isError, undefined);
        const result = JSON.parse(String(first.content[0].text));
        assert.equal(result.status, 400); assert.equal(result.ok, false); assert.equal(result.encoding, 'text'); assert.match(result.body, /中文🙂/);
        assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].url, '/api?q=a%20b'); assert.equal(requests[0].headers.authorization, 'Bearer synthetic'); assert.equal(requests[0].body, '{"test":"中文🙂"}');
        const second = await host.execute('http_fetch', { url: url + '/error' });
        assert.equal(JSON.parse(String(second.content[0].text)).status, 500); assert.equal(requests.length, 2);
        assert.equal(requests[1].headers.cookie, undefined); assert.equal(requests[1].headers.authorization, undefined);
    } finally { host.dispose(); await close(server); }
});

/** 307 remains manual: preserving its POST/body across origins requires a separate explicit request. */
test('HTTP 307 remains a 3xx response without forwarding secrets', async () => {
    let targetHits = 0;
    const target = http.createServer((_req, res) => { targetHits++; res.end('unexpected'); });
    const targetUrl = await listen(target);
    const redirect = http.createServer((req, res) => { req.resume(); res.writeHead(307, { location: targetUrl + '/receive' }); res.end('redirect'); });
    const url = await listen(redirect), host = new HttpToolHost();
    try {
        const result = JSON.parse(String((await host.execute('http_fetch', { url, options: { method: 'POST', headers: { authorization: 'Bearer synthetic', 'x-private-key': 'synthetic' }, body: 'private request body' } })).content[0].text));
        assert.equal(result.status, 307); assert.equal(result.headers.location, targetUrl + '/receive'); assert.equal(result.redirectFollowed, false); assert.equal(targetHits, 0);
    } finally { host.dispose(); await close(redirect); await close(target); }
});

/** Invalid input, trust failures and metadata endpoints stop before any transport is invoked. */
test('HTTP validates JSON fetch subset and does not expose transport or filesystem options', async () => {
    let calls = 0; const fake: typeof fetch = async () => { calls++; return new Response('test'); };
    const host = new HttpToolHost({ fetch: fake });
    for (const args of [
        { url: 'file:///etc/passwd' }, { url: 'http://user:pass@example.com' }, { url: 'http://169.254.169.254/latest/meta-data' },
        { url: 'http://metadata.google.internal/' }, { url: 'https://example.com', options: { method: 'GET', body: '' } },
        { url: 'https://example.com', options: { method: 'HEAD', body: 'x' } }, { url: 'https://example.com', options: { method: 'CONNECT' } },
        { url: 'https://example.com', options: { method: 'POST', body: {} } }, { url: 'https://example.com', options: { dispatcher: {} } },
        { url: 'https://example.com', options: { headers: { host: 'elsewhere' } } }, { url: 'https://example.com', options: { headers: { test: 1 } } },
        { url: 'https://example.com', options: { method: 'POST', body: 'x'.repeat(HTTP_BODY_LIMIT + 1) } }
    ]) assert.equal((await host.execute('http_fetch', args)).isError, true);
    assert.equal((await new HttpToolHost({ fetch: fake, isTrusted: () => false }).execute('http_fetch', { url: 'https://example.com' })).isError, true);
    assert.equal(calls, 0);
});

/** Response byte limits apply after decompression; binary output is explicit Base64 and not mistaken for text. */
test('HTTP response limits and binary encoding are explicit', async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        if (req.url === '/binary') { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from([0, 255, 1, 2])); }
        else { res.setHeader('content-type', 'text/plain'); res.end('x'.repeat(HTTP_RESPONSE_LIMIT + 1024)); }
    });
    const url = await listen(server), host = new HttpToolHost();
    try {
        const large = JSON.parse(String((await host.execute('http_fetch', { url })).content[0].text));
        assert.equal(large.truncated, true); assert.equal(large.bytes, HTTP_RESPONSE_LIMIT); assert.equal(large.body.length, HTTP_RESPONSE_LIMIT);
        const binary = JSON.parse(String((await host.execute('http_fetch', { url: url + '/binary' })).content[0].text));
        assert.equal(binary.encoding, 'base64'); assert.equal(binary.body, Buffer.from([0, 255, 1, 2]).toString('base64'));
    } finally { host.dispose(); await close(server); }
});

/** Deadline and disposal abort local transport without retrying, and error messages never reflect credentials. */
test('HTTP timeout, cancellation and network errors are bounded and non-retrying', async () => {
    let requests = 0;
    const server = http.createServer(req => { req.resume(); requests++; });
    const url = await listen(server), host = new HttpToolHost({ timeoutMs: 100 });
    try {
        const result = await host.execute('http_fetch', { url, options: { method: 'POST', body: 'once' } });
        assert.equal(result.isError, true); assert.match(String(result.content[0].text), /HTTP_TIMEOUT/); assert.equal(requests, 1);
        const external = new AbortController(); external.abort();
        assert.match(String((await host.execute('http_fetch', { url }, external.signal)).content[0].text), /HTTP_ABORTED/);
        assert.equal(requests, 1);
        const faulty = new HttpToolHost({ fetch: async () => { throw new Error('secret-credential-value'); } });
        const failed = await faulty.execute('http_fetch', { url });
        assert.match(String(failed.content[0].text), /HTTP_NETWORK_ERROR/); assert.equal(String(failed.content[0].text).includes('secret-credential-value'), false);
        host.dispose(); assert.match(String((await host.execute('http_fetch', { url })).content[0].text), /HTTP_ABORTED/);
    } finally { host.dispose(); await close(server); }
});

/** Only HTML responses are transformed; HTTP error status, original headers and raw-byte limits remain intact. */
test('HTTP HTML extraction returns clean text while JSON, plain text and binary remain unchanged', async () => {
    const html = '<html><head><title>Fixture</title><style>ignored{}</style></head><body><h1>Title</h1><p>中文 &amp; text</p><script>secretCode()</script></body></html>';
    const json = '{"html":"<p>raw value</p>","value":1}';
    const plain = '<html><script>literal documentation</script></html>';
    const server = http.createServer((req, res) => {
        req.resume();
        if (req.url === '/json') { res.setHeader('content-type', 'application/json'); res.end(json); }
        else if (req.url === '/plain') { res.setHeader('content-type', 'text/plain'); res.end(plain); }
        else if (req.url === '/binary') { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from([0, 255])); }
        else { res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'x-fixture': 'original' }); res.end(html); }
    });
    const url = await listen(server), host = new HttpToolHost();
    try {
        const extracted = JSON.parse(String((await host.execute('http_fetch', { url })).content[0].text));
        assert.equal(extracted.status, 503); assert.equal(extracted.ok, false);
        assert.equal(extracted.headers['content-type'], 'text/html; charset=utf-8'); assert.equal(extracted.headers['x-fixture'], 'original');
        assert.equal(extracted.bodyFormat, 'html-text'); assert.equal(extracted.title, 'Fixture'); assert.equal(extracted.body, 'Title\n中文 & text');
        assert.equal(extracted.bytes, Buffer.byteLength(html)); assert.equal(extracted.truncated, false);
        for (const [route, body] of [['/json', json], ['/plain', plain]]) {
            const result = JSON.parse(String((await host.execute('http_fetch', { url: url + route })).content[0].text));
            assert.equal(result.body, body); assert.equal(result.bodyFormat, undefined); assert.equal(result.title, undefined);
        }
        const binary = JSON.parse(String((await host.execute('http_fetch', { url: url + '/binary' })).content[0].text));
        assert.equal(binary.encoding, 'base64'); assert.equal(binary.body, Buffer.from([0, 255]).toString('base64')); assert.equal(binary.bodyFormat, undefined);
    } finally { host.dispose(); await close(server); }
});

/** A truncated HTML stream cannot expose its script tail or trigger a second request. */
test('HTTP HTML truncation filters incomplete scripts and leaves empty dynamic pages empty', async () => {
    const host = new HttpToolHost({ fetch: async () => new Response('<p>Visible</p><script>' + 'x'.repeat(HTTP_RESPONSE_LIMIT), { headers: { 'content-type': 'text/html' } }) });
    const result = JSON.parse(String((await host.execute('http_fetch', { url: 'https://example.com' })).content[0].text));
    assert.equal(result.body, 'Visible'); assert.equal(result.truncated, true); assert.equal(result.bytes, HTTP_RESPONSE_LIMIT);
    const dynamic = new HttpToolHost({ fetch: async () => new Response('<html><head><title>App</title></head><body><script>renderApp()</script></body></html>', { headers: { 'content-type': 'text/html' } }) });
    const empty = JSON.parse(String((await dynamic.execute('http_fetch', { url: 'https://example.com' })).content[0].text));
    assert.equal(empty.body, ''); assert.equal(empty.title, 'App'); assert.equal(empty.bodyFormat, 'html-text');
});

/** Cancellation applies after response headers too, and does not abort a separate conversation's host. */
test('HTTP cancellation stops a pending body and does not affect another host', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const server = http.createServer((req, res) => {
        req.resume();
        if (req.url === '/fast') { res.end('other-host-ok'); return; }
        res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); started();
    });
    const url = await listen(server), a = new HttpToolHost(), b = new HttpToolHost();
    try {
        const pending = a.execute('http_fetch', { url: url + '/slow' });
        await ready; a.abort();
        assert.match(String((await pending).content[0].text), /HTTP_ABORTED/);
        assert.equal(JSON.parse(String((await b.execute('http_fetch', { url: url + '/fast' })).content[0].text)).body, 'other-host-ok');
    } finally { a.dispose(); b.dispose(); await close(server); }
});
