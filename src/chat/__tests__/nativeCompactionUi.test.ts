/** @file 原生压缩七语言、待应用及 CLI 错误事件回归。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { installVscodeStub } from './testUtils/vscodeStub';

const source = readFileSync(resolve(__dirname, '../../../media/chat/main.js'), 'utf8');
installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { StreamJsonCliAdapter } = require('../cli/cliAdapter') as typeof import('../cli/cliAdapter');

/** 从真实源码提取函数，避免测试另写一份逻辑。 */
function extract(name: string): string {
    const start = source.indexOf(`    function ${name}(`);
    const end = source.indexOf('\n    /**', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
}

test('七语言提供比例、禁用、待应用、冲突和估算说明', () => {
    const languages = ['en', 'zh-cn', 'zh-tw', 'ko', 'ja', 'fr', 'de'];
    const translations: Record<string, Record<string, string>> = Object.fromEntries(languages.map(language => [language, {}]));
    const start = source.indexOf('    /** 原生比例策略');
    const end = source.indexOf('    /** 代码预览开关标签', start);
    runInNewContext(source.slice(start, end), { chatTranslations: translations });
    for (const language of languages) {
        const labels = translations[language];
        for (const key of ['autoCompactPending', 'autoCompactManaged', 'autoCompactDisabled', 'autoCompactConflict', 'autoCompactUnsupported', 'autoCompactEstimate', 'compactModelCapacity', 'compactFailed']) assert.ok(labels[key]);
        assert.ok(labels.autoCompactTitle.includes('90%') || labels.autoCompactTitle.includes('90 %'));
        assert.ok(labels.autoCompactTitle.includes('80%') || labels.autoCompactTitle.includes('80 %'));
        const state = { autoCompactPending: true, nativeCompactionPolicy: { status: 'managed' } };
        const sandbox = { composerState: state, t: (key: string) => labels[key], nativeCompactionStatusText: undefined as unknown };
        runInNewContext(extract('nativeCompactionStatusText') + '\nthis.result = nativeCompactionStatusText();', sandbox);
        assert.equal((sandbox as unknown as { result: string }).result, labels.autoCompactPending);
    }
});

test('CLI 压缩失败保留原始 compact_error，普通 requesting 状态不误报结束', () => {
    const adapter = new StreamJsonCliAdapter({ onChunk: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) } as never);
    const internal = adapter as unknown as { parseJsonEvent: (event: unknown, raw: string) => import('../cli/cliAdapter').ParsedCliEvent };
    const failed = internal.parseJsonEvent({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: '402 insufficient quota', session_id: 's' }, '');
    assert.equal(failed.type, 'compact/status');
    if (failed.type === 'compact/status') assert.equal(failed.compactError, '402 insufficient quota');
    assert.equal(internal.parseJsonEvent({ type: 'system', subtype: 'status', status: 'requesting' }, '').type, 'segments');
    adapter.dispose();
});
