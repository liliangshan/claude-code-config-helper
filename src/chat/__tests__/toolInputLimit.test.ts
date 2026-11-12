/** @file Large tool-input accumulation and warning de-duplication regressions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from './testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { StreamJsonCliAdapter } = require('../cli/cliAdapter') as typeof import('../cli/cliAdapter');

/** Create the smallest process substitute required by the production parser. */
function createFakeCliProcess() {
    return {
        onChunk: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), onStatus: () => ({ dispose() {} }),
        getCwd: () => process.cwd(), send: () => undefined, cancel: () => undefined, isRunning: () => true
    } as unknown as ConstructorParameters<typeof StreamJsonCliAdapter>[0];
}

/** Feed one Anthropic stream event through the real CLI adapter. */
function feed(adapter: InstanceType<typeof StreamJsonCliAdapter>, event: Record<string, unknown>): any[] {
    return adapter.parseOutput({ source: 'stdout', text: JSON.stringify({ type: 'stream_event', event }) + '\n', receivedAt: Date.now() });
}

/** A tool payload around 558 KB must remain parseable after the increased 1 MB guard. */
test('large tool input remains accumulated below the one-megabyte guard', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    try {
        const payload = `{"file_path":"/fixture","new_string":"${'x'.repeat(557_000)}"}`;
        feed(adapter, { type: 'message_start', message: { id: 'large-tool-message' } });
        feed(adapter, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'large-tool', name: 'Edit' } });
        const events = feed(adapter, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: payload } });
        feed(adapter, { type: 'content_block_stop', index: 0 });
        const segments = events.flatMap(event => event.type === 'segments' ? event.segments : []);
        assert.equal(segments.length, 1);
        assert.equal(segments[0].tool.input.new_string.length, 557_000);
    } finally { adapter.dispose(); }
});

/** Once one tool crosses the guard, later deltas are ignored and warning state is local to that block. */
test('tool input overflow stops one block and does not warn once per delta', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    try {
        feed(adapter, { type: 'message_start', message: { id: 'overflow-message' } });
        feed(adapter, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'overflow-tool', name: 'Edit' } });
        const oversized = 'x'.repeat(1_000_001);
        const first = feed(adapter, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: oversized } });
        const second = feed(adapter, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'later' } });
        assert.deepEqual(first.flatMap(event => event.type === 'segments' ? event.segments : []), []);
        assert.deepEqual(second.flatMap(event => event.type === 'segments' ? event.segments : []), []);
    } finally { adapter.dispose(); }
});

/** Split deltas can reach the exact one-megabyte boundary without being rejected. */
test('tool input exactly at the guard remains available for final parsing', () => {
    const adapter = new StreamJsonCliAdapter(createFakeCliProcess());
    try {
        const prefix = '{"data":"';
        const suffix = '"}';
        const body = prefix + 'y'.repeat(1_000_000 - prefix.length - suffix.length) + suffix;
        feed(adapter, { type: 'message_start', message: { id: 'boundary-message' } });
        feed(adapter, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'boundary-tool', name: 'Write' } });
        feed(adapter, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: body.slice(0, 400_000) } });
        const events = feed(adapter, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: body.slice(400_000) } });
        assert.equal(events.flatMap(event => event.type === 'segments' ? event.segments : []).at(-1)?.tool.input.data.length, 1_000_000 - prefix.length - suffix.length);
    } finally { adapter.dispose(); }
});
