#!/usr/bin/env node
/** @file Offline editor CLI fixture: persistent stdin, distinct sessions and predictable result delivery. */
const readline = require('node:readline');
if (!process.argv.includes('--version') && (!process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_SKIP_AUTH_LOGIN !== '1' || process.env.CLAUDE_CODE_SKIP_MODEL_VALIDATION !== '1')) {
    process.stderr.write('Editor relay authentication environment is incomplete\n'); process.exit(1);
}
if (process.argv.includes('--version')) { console.log('2.1.303 (Claude Code)'); process.exit(0); }
const args = process.argv.slice(2);
const i = args.indexOf('--resume');
const id = i < 0 ? require('node:crypto').randomUUID() : args[i + 1];
/** Emit one JSON protocol event. */
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: id });
readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line); if (message.type !== 'user') return;
    const content = message.message.content;
    const text = typeof content === 'string' ? content : content.map(item => item.text || '').join('');
    setTimeout(() => emit({ type: 'result', subtype: 'success', is_error: false, session_id: id, result: `Reply ${text}` }), text.includes('slow') ? 400 : 20);
});
