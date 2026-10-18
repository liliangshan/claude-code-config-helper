/** @file 原生策略安全重启回归：工具间隙、待应用、resume 与取消。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscodeStub } from '../../chat/__tests__/testUtils/vscodeStub';
const stub = installVscodeStub({ values: { claudeCodeConfigHelper: { 'chat.autoCompact.enabled': true } } });
const lifecycle = require('../cliLifecycle') as typeof import('../cliLifecycle');
const route = require('../routeState') as typeof import('../routeState');
const runtime = require('../../runtime') as typeof import('../../runtime');
const { buildNativeCompactionPolicy } = require('../../nativeCompactionPolicy') as typeof import('../../nativeCompactionPolicy');

test('工具调用 HTTP 空隙不能重启，整轮结束后保留会话应用关闭策略', async () => {
    const messages: Array<Record<string, unknown>> = [];
    let enabled = true;
    let starts = 0;
    let compacting = false;
    const configs: import('../../chat/cli/types').ChatCliConfig[] = [];
    const readConfig = () => {
        const native = buildNativeCompactionPolicy('m', 200000, enabled, {}, [], '2.1.280');
        return { enabled: true, cliPath: '/synthetic-cli', cliArgs: [], model: 'p/m', cwd: '/tmp', transport: 'streamJsonStdio' as const, cliEnv: native.env, nativeCompaction: native.policy };
    };
    lifecycle.createCliLifecycleServices({ getConfigWithRelayEnv: async () => readConfig(), getRoutedConfigsWithRelayEnv: async () => ({ normal: readConfig() }) } as never);
    const fakeProcess = {
        isRunning: () => starts > 0,
        isRunningWithConfig: () => false,
        start: async (config: import('../../chat/cli/types').ChatCliConfig) => { starts++; configs.push(config); },
        onChunk: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
        getCwd: () => '/tmp'
    };
    route.routes.normal.process = fakeProcess as never;
    route.routes.normal.sessionId = 'original-session';
    runtime.setRelayServer({ getActualPort: () => 23456 } as never);
    runtime.setChatViewHost({ postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; } } as never);
    lifecycle.configureCliLifecycle({
        ensureRelayServerStarted: async () => 23456, syncClaudeCliModelSettingsSafely: async () => undefined,
        appendAssistantSegments: async () => undefined, finishActiveAssistantMessage: async () => undefined,
        showChatToast: async () => undefined, clearHttpExpectation() {}, cancelPendingResend() {},
        handleParsedCliEvent: async () => undefined, notifyPermissionDeniedToUser() {}, logMcpInjection() {},
        getCompactionService: () => ({ isCompactionInFlight: () => compacting, releaseCliCompactions() {} } as never)
    });
    try {
        await lifecycle.startChatCliPair();
        assert.equal(starts, 1);
        route.noteCliTurn(1);
        route.setRelayRouteBusy('normal', true, 'probe');
        route.setRelayRouteBusy('normal', false, 'tool gap');
        assert.equal(route.isAnyRouteBusy(), true);
        enabled = false;
        stub.values.claudeCodeConfigHelper['chat.autoCompact.enabled'] = false;
        lifecycle.scheduleNativeCompactionRefresh();
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(starts, 1, '工具间隙不能强杀');
        assert.equal(messages.filter(message => message.type === 'autoCompact/current').at(-1)?.pending, true);
        route.noteCliTurn(-1);
        compacting = true;
        await lifecycle.applyPendingNativeCompactionPolicy();
        assert.equal(starts, 1, '真实压缩在途不能重启');
        compacting = false;
        await lifecycle.applyPendingNativeCompactionPolicy();
        assert.equal(starts, 2);
        assert.equal(configs[1].resumeSessionId, 'original-session');
        assert.equal(configs[1].cliEnv.DISABLE_AUTO_COMPACT, '1');
        assert.equal(messages.filter(message => message.type === 'autoCompact/current').at(-1)?.pending, false);
    } finally {
        lifecycle.disposeCliLifecycleServices();
        route.resetAllRouteBusy();
        runtime.setChatViewHost(undefined);
        runtime.setRelayServer(undefined);
    }
});
