/** @file 验证每次 CLI 配置生成均刷新策略和原始环境（无真实 API）。 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from '../../__tests__/testUtils/vscodeStub';

const stub = installVscodeStub({ values: { claudeCodeConfigHelper: {} } });
const { ChatCliConfigService } = require('../cliConfig') as typeof import('../cliConfig');
const { buildCliChildEnv, NATIVE_COMPACTION_ENV_KEYS } = require('../../../nativeCompactionPolicy') as typeof import('../../../nativeCompactionPolicy');
/** 单元测试隔离宿主的显式压缩变量，测试完原样恢复。 */
const inherited = Object.fromEntries(NATIVE_COMPACTION_ENV_KEYS.map(key => [key, process.env[key]]));
before(() => { for (const key of NATIVE_COMPACTION_ENV_KEYS) delete process.env[key]; });
after(() => { for (const key of NATIVE_COMPACTION_ENV_KEYS) { if (inherited[key] === undefined) delete process.env[key]; else process.env[key] = inherited[key]; } });

/** 原始环境不会继承上一次模型生成值，冲突只暴露键名。 */
test('配置刷新：大窗口→小窗口→关闭→开启；禁用冲突可见', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccai-policy-config-'));
    const configDir = path.join(root, 'config');
    await fs.mkdir(configDir);
    const executable = path.join(root, 'cli-version');
    await fs.writeFile(executable, '#!/bin/sh\nprintf "2.1.280 (Claude Code)\\n"\n', { mode: 0o755 });
    let model = 'large';
    let limit = 500000;
    const manager = { getCurrentModel: () => ({ providerId: 'p', modelId: model }), getProviderModel: () => ({ contextLength: limit }) };
    const service = new ChatCliConfigService(manager as never);
    stub.values.claudeCodeConfigHelper = { 'chat.cliPath': executable, 'chat.cliCwd': root, 'chat.cliEnv': { CLAUDE_CONFIG_DIR: configDir }, 'chat.autoCompact.enabled': true };
    const large = await service.getConfigWithRelayEnv(23456);
    assert.equal(large.nativeCompaction?.status, 'managed', JSON.stringify(large.nativeCompaction));
    assert.equal(large.cliEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '500000');
    assert.equal(large.cliEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80');
    model = 'small'; limit = 200000;
    const small = await service.getConfigWithRelayEnv(23456);
    assert.equal(small.cliEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
    assert.equal(small.cliEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '90');
    assert.equal(large.cliEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '500000', '旧快照不应被修改');
    stub.values.claudeCodeConfigHelper['chat.autoCompact.enabled'] = false;
    const off = await service.getConfigWithRelayEnv(23456);
    assert.equal(off.cliEnv.DISABLE_AUTO_COMPACT, '1');
    assert.equal(off.cliEnv.DISABLE_COMPACT, undefined);
    stub.values.claudeCodeConfigHelper['chat.autoCompact.enabled'] = true;
    const on = await service.getConfigWithRelayEnv(23456);
    const childEnv = buildCliChildEnv({ DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', TEST_PRESERVED: 'yes' }, on.cliEnv, on.nativeCompactionEnv);
    assert.equal(childEnv.DISABLE_AUTO_COMPACT, undefined);
    assert.equal(childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
    assert.equal(childEnv.TEST_PRESERVED, 'yes');
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ autoCompactEnabled: false, env: { DISABLE_COMPACT: '1' } }));
    const conflict = await service.getConfigWithRelayEnv(23456);
    assert.equal(conflict.nativeCompaction?.status, 'conflict');
    assert.deepEqual(conflict.nativeCompaction?.conflicts.sort(), ['DISABLE_COMPACT', 'autoCompactEnabled']);
    assert.equal(conflict.cliEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
});
