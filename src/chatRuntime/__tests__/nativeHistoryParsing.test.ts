/** @file Native history parsing accepts current CLI text formats and preserves active state on explicit-load failures. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';

installVscodeStub({ values: {} });
const { parseSessionJsonl } = require('../chatSession') as typeof import('../chatSession');

/** Read mixed native formats without dropping string messages or crashing on malformed non-message records. */
test('native history preserves string and block text with stable IDs, timestamps and model labels', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-history-'));
    const file = path.join(directory, 'history.jsonl');
    const records = [null, 5, { type: 'queue-operation' },
        { type: 'user', uuid: 'string-user', timestamp: 10, message: { role: 'user', content: 'Original question' } },
        { type: 'assistant', uuid: 'string-assistant', timestamp: '2026-10-29T00:00:00Z', message: { role: 'assistant', model: 'example-model', content: 'Original answer' } },
        { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', content: 'not a new prompt' }] } },
        { type: 'assistant', uuid: 'block-assistant', message: { content: [null, { type: 'text', text: 'Block reply' }, { type: 'tool_use', id: 'call-one', name: 'Read', input: { file_path: 'sample.txt' } }] } },
        { type: 'user', uuid: 'sidechain', isSidechain: true, message: { content: 'Not this session' } }
    ];
    try {
        await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\ninvalid-json\n');
        const messages = await parseSessionJsonl(file, { strict: true });
        assert.deepEqual(messages.map(message => message.id), ['string-user', 'string-assistant', 'block-assistant']);
        assert.equal(messages[0].text, 'Original question'); assert.equal(messages[0].createdAt, 10);
        assert.equal(messages[1].segments[0].text, 'Original answer'); assert.equal(messages[1].modelLabel, 'example-model');
        assert.equal(messages[2].segments[1].tool?.name, 'Read');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

/** Automatic recovery may tolerate absence, but a user-selected unreadable history must not become empty chat. */
test('strict history loading rejects missing and empty transcripts while optional startup reads remain tolerant', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-errors-'));
    const file = path.join(directory, 'empty.jsonl');
    try {
        await assert.rejects(parseSessionJsonl(file, { strict: true }), { code: 'ENOENT' });
        assert.deepEqual(await parseSessionJsonl(file), []);
        await fs.writeFile(file, JSON.stringify({ type: 'custom-title', customTitle: 'Title without transcript' }));
        await assert.rejects(parseSessionJsonl(file, { strict: true }), /no readable conversation messages/);
        assert.deepEqual(await parseSessionJsonl(file), []);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
