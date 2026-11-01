/** @file Bounded HTTP 301/302 redirect tests with loopback fixtures; no external network requests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { HttpToolHost } from '../httpHost';
import { HTTP_MAX_REDIRECTS } from '../tools';

/** Bind an isolated local server. */
async function listen(server: http.Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

/** Release fixture connections, including unfinished intermediate bodies. */
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Relative and absolute locations resolve to the last response; same-origin authorization stays intact. */
test('HTTP follows a 301/302 chain and extracts final HTML with original final status/headers', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
        req.resume(); seen.push(req.url!); assert.equal(req.headers.authorization, 'Bearer fixture');
        if (req.url === '/start') { res.writeHead(301, { location: './step' }); res.end(); }
        else if (req.url === '/step') { res.writeHead(302, { location: '/final?q=1' }); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/html', 'x-final': 'yes' }); res.end('<title>Final</title><p>Readable body</p><script>discard()</script>'); }
    });
    const url = await listen(server), host = new HttpToolHost();
    try {
        const result = JSON.parse(String((await host.execute('http_fetch', { url: url + '/start', options: { headers: { authorization: 'Bearer fixture' } } })).content[0].text));
        assert.deepEqual(seen, ['/start', '/step', '/final?q=1']);
        assert.equal(result.url, url + '/final?q=1'); assert.equal(result.redirectFollowed, true); assert.equal(result.redirectCount, 2);
        assert.equal(result.status, 200); assert.equal(result.headers['x-final'], 'yes'); assert.equal(result.body, 'Readable body'); assert.equal(result.bodyFormat, 'html-text');
    } finally { host.dispose(); await close(server); }
});

/** Cross-origin POST redirects become credential-free GETs, and stripped headers never reappear on later same-origin hops. */
for (const status of [301, 302]) test(`HTTP ${status} strips headers/body across origins and rewrites POST to GET`, async () => {
    const seen: any[] = [];
    const target = http.createServer((req, res) => {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            seen.push({ method: req.method, headers: req.headers, body });
            if (req.url === '/first') { res.writeHead(302, { location: '/last' }); res.end(); } else res.end('ok');
        });
    });
    const targetUrl = await listen(target);
    const source = http.createServer((req, res) => { req.resume(); res.writeHead(status, { location: targetUrl + '/first', 'set-cookie': 'secret=never-reused' }); res.end(); });
    const sourceUrl = await listen(source), host = new HttpToolHost();
    try {
        const result = JSON.parse(String((await host.execute('http_fetch', { url: sourceUrl, options: { method: 'POST', body: 'private-body', headers: { authorization: 'Bearer fixture', cookie: 'private=1', 'x-api-key': 'fixture', 'x-custom-secret': 'fixture', 'content-type': 'application/json' } } })).content[0].text));
        assert.equal(result.status, 200); assert.equal(result.redirectCount, 2); assert.equal(seen.length, 2);
        for (const request of seen) {
            assert.equal(request.method, 'GET'); assert.equal(request.body, '');
            for (const header of ['authorization', 'cookie', 'x-api-key', 'x-custom-secret', 'content-type']) assert.equal(request.headers[header], undefined, header);
        }
    } finally { host.dispose(); await close(source); await close(target); }
});

/** A redirect must never replay a body or destructive method to a different origin. */
test('HTTP cross-origin PUT returns 302 without replaying the mutation', async () => {
    let targetHits = 0;
    const target = http.createServer((req, res) => { targetHits++; req.resume(); res.end(); });
    const destination = await listen(target);
    const source = http.createServer((req, res) => { req.resume(); res.writeHead(302, { location: destination }); res.end('manual follow needed'); });
    const url = await listen(source), host = new HttpToolHost();
    try {
        const result = JSON.parse(String((await host.execute('http_fetch', { url, options: { method: 'PUT', body: 'private' } })).content[0].text));
        assert.equal(result.status, 302); assert.equal(result.redirectStopped, 'cross_origin_method'); assert.equal(result.body, 'manual follow needed'); assert.equal(targetHits, 0);
    } finally { host.dispose(); await close(source); await close(target); }
});

/** Repeated loops stop after the exact configured hop limit and preserve the final 3xx details. */
test('HTTP redirect loops stop after five followed hops', async () => {
    let calls = 0;
    const server = http.createServer((req, res) => { calls++; req.resume(); res.writeHead(301, { location: '/loop' }); res.end('loop'); });
    const url = await listen(server), host = new HttpToolHost();
    try {
        const result = JSON.parse(String((await host.execute('http_fetch', { url })).content[0].text));
        assert.equal(calls, HTTP_MAX_REDIRECTS + 1); assert.equal(result.status, 301); assert.equal(result.redirectCount, HTTP_MAX_REDIRECTS); assert.equal(result.redirectStopped, 'limit');
    } finally { host.dispose(); await close(server); }
});

/** Every hop revalidates protocol, URL credentials and metadata addresses; secure requests cannot downgrade. */
test('HTTP blocks unsafe redirect targets and HTTPS downgrade without a second request', async () => {
    for (const [location, reason] of [['file:///etc/passwd', 'unsafe_target'], ['http://169.254.169.254/', 'unsafe_target'], ['https://user:pass@example.com/', 'unsafe_target'], ['http://example.com/', 'https_downgrade'], ['http://[', 'unsafe_target']]) {
        let calls = 0;
        const host = new HttpToolHost({ fetch: async () => { calls++; return new Response('stop', { status: 302, headers: { location } }); } });
        const result = JSON.parse(String((await host.execute('http_fetch', { url: 'https://example.com/' })).content[0].text));
        assert.equal(calls, 1); assert.equal(result.status, 302); assert.equal(result.redirectStopped, reason); assert.equal(result.redirectFollowed, false);
        host.dispose();
    }
});

/** Standard same-origin method rules keep HEAD and rewrite POST without retaining content headers/body. */
test('HTTP same-origin 301/302 method rules retain only appropriate request data', async () => {
    const seen: any[] = [];
    const server = http.createServer((req, res) => {
        let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            seen.push({ url: req.url, method: req.method, headers: req.headers, body });
            if (req.url === '/start') { res.writeHead(302, { location: '/end' }); res.end(); }
            else res.end('final');
        });
    });
    const url = await listen(server), host = new HttpToolHost();
    try {
        for (const method of ['POST', 'HEAD']) {
            seen.length = 0;
            const result = JSON.parse(String((await host.execute('http_fetch', { url: url + '/start', options: { method, headers: { authorization: 'Bearer same-origin', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: 'initial' } : {}) } })).content[0].text));
            assert.equal(result.status, 200); assert.equal(result.redirectCount, 1); assert.equal(seen.length, 2);
            assert.equal(seen[1].method, method === 'POST' ? 'GET' : 'HEAD'); assert.equal(seen[1].body, '');
            assert.equal(seen[1].headers.authorization, 'Bearer same-origin');
            if (method === 'POST') assert.equal(seen[1].headers['content-type'], undefined);
            else assert.equal(result.body, '');
        }
    } finally { host.dispose(); await close(server); }
});

/** The chain shares one deadline and abort signal; an intermediate response is cancelled before another hop. */
test('HTTP redirects share a single timeout and release intermediate response bodies', async () => {
    const signals: AbortSignal[] = []; let cancelled = false, calls = 0;
    const host = new HttpToolHost({ timeoutMs: 100, fetch: async (_url, init) => {
        calls++; signals.push(init!.signal!);
        if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 301, headers: { location: '/slow' } });
        assert.equal(cancelled, true);
        return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    try {
        const result = await host.execute('http_fetch', { url: 'https://example.com/start' });
        assert.equal(result.isError, true); assert.match(String(result.content[0].text), /HTTP_TIMEOUT/);
        assert.equal(calls, 2); assert.equal(signals[0], signals[1]); assert.equal(signals[0].aborted, true);
    } finally { host.dispose(); }
});

/** Missing Location, unsupported statuses and final failures do not trigger further requests or retries. */
test('HTTP missing locations and 303/307/308 stay manual; final 500 is not retried', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
        let calls = 0;
        const host = new HttpToolHost({ fetch: async () => {
            calls++; return new Response('original body', { status, headers: status > 302 ? { location: '/other' } : {} });
        } });
        const result = JSON.parse(String((await host.execute('http_fetch', { url: 'https://example.com' })).content[0].text));
        assert.equal(calls, 1); assert.equal(result.status, status); assert.equal(result.body, 'original body');
        assert.equal(result.redirectCount, 0); assert.equal(result.redirectFollowed, false); host.dispose();
    }
    let calls = 0;
    const host = new HttpToolHost({ fetch: async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: '/fail' } }) : new Response('upstream failed', { status: 500 }) });
    const result = JSON.parse(String((await host.execute('http_fetch', { url: 'https://example.com' })).content[0].text));
    assert.equal(calls, 2); assert.equal(result.status, 500); assert.equal(result.body, 'upstream failed'); assert.equal(result.redirectCount, 1); host.dispose();
});
