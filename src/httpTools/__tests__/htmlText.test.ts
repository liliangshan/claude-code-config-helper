/** @file Static HTML response extraction tests; no browser, remote URL or script execution. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeHtmlResponse, htmlToText, isHtmlResponse } from '../htmlText';

/** Keep visible text/title while ignoring code and non-content HTML subtrees. */
test('HTML removes tags, scripts, styles, comments and explicitly hidden content', () => {
    const source = '<!doctype html><html><head><title>Docs &amp; 帮助</title><style>.x{color:red}</style><script>badHead()</script></head>'
        + '<body><!-- private comment --><h1>欢迎</h1><p>Hello <strong>world</strong> &amp; &#x1f642;</p>'
        + '<script>if (1 < 2) { badBody("<p>not content</p>"); }</script><template>template only</template>'
        + '<noscript>fallback script warning</noscript><div hidden>hidden child <b>nested</b></div>'
        + '<span aria-hidden="true">aria hidden</span><p style="display: none !important">style hidden</p>'
        + '<svg><text>vector</text></svg><iframe src="https://example.com">frame text</iframe><p>End</p></body></html>';
    assert.deepEqual(htmlToText(source), { title: 'Docs & 帮助', text: '欢迎\nHello world & 🙂\nEnd' });
});

/** Preserve block boundaries, visible image alternatives, comparisons and escaped code examples. */
test('HTML paragraphs, lists, tables and preformatted text remain readable', () => {
    const result = htmlToText('<p>first<br>second</p><ul><li>One</li><li>Two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
        + '<pre>const x = &lt;Thing&gt;;\n  return x &amp;&amp; 1 &lt; 2;</pre><p><img src="never-fetched.png" alt="Chart &amp; notes"></p>');
    assert.equal(result.text, 'first\nsecond\n- One\n- Two\nA B\n1 2\nconst x = <Thing>;\n  return x && 1 < 2;\nChart & notes');
});

/** A tokenizer handles quoted angle brackets and incomplete markup without leaking script bodies. */
test('HTML malformed/truncated markup and quoted attributes do not corrupt visible text', () => {
    assert.equal(htmlToText('<p title="a > b">Keep <b>this</b></p><script>never reveal').text, 'Keep this');
    assert.equal(htmlToText('<p>first<p>second <em>last').text, 'first\nsecond last');
    assert.equal(htmlToText('<div>中文<span>正文</span> &quot;yes&quot; &copy; &mdash; &#60;tag&#62;</div>').text, '中文正文 "yes" © — <tag>');
    assert.equal(htmlToText('<script src="https://example.com/run.js"></script><style>body{}</style>').text, '');
});

/** Explicit plain/JSON/XML types are never sniffed as HTML, including literal HTML examples. */
test('HTML detection is MIME-aware and charset decoding is bounded to the received bytes', () => {
    assert.equal(isHtmlResponse('text/html; charset=utf-8', '<p>x</p>'), true);
    assert.equal(isHtmlResponse('APPLICATION/XHTML+XML', '<html/>'), true);
    assert.equal(isHtmlResponse('', '  <!DOCTYPE html><html/>'), true);
    for (const type of ['application/json', 'text/plain', 'application/xml', 'application/octet-stream']) assert.equal(isHtmlResponse(type, '<html>x</html>'), false);
    assert.equal(isHtmlResponse('', '{"html":"<html>"}'), false);
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    assert.equal(decodeHtmlResponse(latin, 'text/html; charset=iso-8859-1'), 'café');
    assert.equal(decodeHtmlResponse(Buffer.from('中文'), 'text/html; charset=invalid-label'), '中文');
});
