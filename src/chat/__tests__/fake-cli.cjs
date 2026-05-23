#!/usr/bin/env node
/**
 * Fake Claude CLI stream-json fixture for manual/integration testing.
 *
 * It accepts JSON Lines on stdin and emits Claude-like stream-json events on stdout.
 * Use with chat.cliPath pointing to this file after making it executable, or run via node.
 */

const readline = require('node:readline');

/** Emit one JSON event as a stdout JSON Line. */
function emit(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Extract a user text from the loose SDK-style input line. */
function extractText(input) {
    try {
        const json = JSON.parse(input);
        const content = json?.message?.content;
        if (Array.isArray(content)) {
            return content.map((item) => item?.text || '').join('');
        }
        if (typeof content === 'string') return content;
        return JSON.stringify(json);
    } catch {
        return input;
    }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
    const text = extractText(line);
    emit({ type: 'message_delta', delta: { text: `Echo: ${text}\n` } });
    emit({ type: 'tool_use', name: 'fake_cli', status: 'success', summary: 'fake cli handled one request' });
    emit({ type: 'result' });
});

process.on('SIGINT', () => {
    emit({ type: 'message_delta', delta: { text: 'Cancelled by SIGINT\n' } });
    emit({ type: 'result' });
});
