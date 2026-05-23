import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createChatParserState, flushParser, parseChunk } from '../parser/chatParser';
import { isUnifiedDiff, scanDiff } from '../parser/diffScanner';
import { scanFileRefs } from '../parser/fileRefScanner';

test('scanFileRefs detects markdown links and plain paths', () => {
    const segments = scanFileRefs('See [main](src/extension.ts#L10-L20) and src/chat/protocol.ts:53:1');
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[0], {
        kind: 'fileRef',
        text: 'main',
        filePath: 'src/extension.ts',
        startLine: 10,
        endLine: 20,
        sourceText: '[main](src/extension.ts#L10-L20)',
        confidence: 'high'
    });
    assert.equal(segments[1].kind, 'fileRef');
    assert.equal(segments[1].filePath, 'src/chat/protocol.ts');
    assert.equal(segments[1].startLine, 53);
    assert.equal(segments[1].startColumn, 1);
});

test('scanFileRefs ignores unsafe uri links', () => {
    const segments = scanFileRefs('[bad](javascript:alert(1)) https://example.com/foo.ts src/safe.ts');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].filePath, 'src/safe.ts');
});

test('scanDiff recognizes unified diff blocks', () => {
    const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', '-old', '+new', ''].join('\n');
    assert.equal(isUnifiedDiff(diff), true);
    const segment = scanDiff(diff);
    assert.equal(segment?.kind, 'diff');
    assert.equal(segment?.confidence, 'high');
});

test('parseChunk emits code segment across streamed fenced block', () => {
    let state = createChatParserState();
    let result = parseChunk(state, { text: 'Before\n```ts\nconst a = 1;\n' });
    state = result.state;
    assert.equal(result.segments.some((item) => item.kind === 'code'), false);

    result = parseChunk(state, { text: '```\nAfter src/a.ts:1\n' });
    state = result.state;
    const flushed = flushParser(state);
    const all = [...result.segments, ...flushed];
    const code = all.find((item) => item.kind === 'code');
    assert.equal(code?.language, 'ts');
    assert.equal(code?.text, 'const a = 1;\n');
    assert.equal(all.some((item) => item.kind === 'fileRef' && item.filePath === 'src/a.ts'), true);
});

test('parseChunk marks stderr as error with file refs', () => {
    const state = createChatParserState();
    const result = parseChunk(state, { source: 'stderr', text: 'Error at src/b.ts:12' });
    assert.equal(result.segments[0].kind, 'error');
    assert.equal(result.segments.some((item) => item.kind === 'fileRef' && item.filePath === 'src/b.ts'), true);
});
