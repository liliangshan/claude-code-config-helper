/**
 * 本地中转服务、token 预算与各 proxy adapter 的装配。
 *
 * 拆分自 extension.ts：把 TokenBudgetService、usage sink、编辑器自动打开观察者、
 * 三个工具 relay handler 与 createRelayRouter 这一整块组装收敛到一个模块，
 * activate 只需调用 {@link setupRelayPipeline} 一次。
 *
 * 依赖方向：本模块位于 relay / chatRuntime 之上，不被它们反向引用。
 */
import * as vscode from 'vscode';

import { createBrowserToolRelayHandler } from '../browserTools/httpBridge';
import { BrowserSessionStore } from '../browserTools/sessionStore';
import { handleUpstreamTimeoutAutoContinue, sendHiddenUserMessageToCli } from '../chatRuntime/chatMessaging';
import { setTokenBudgetServiceRef } from '../chatRuntime/chatSession';
import { currentChatCliSessionIdSync } from '../chatRuntime/cliLifecycle';
import { setRelayRouteBusy } from '../chatRuntime/routeState';
import { clearHttpExpectation } from '../chatRuntime/selfHealing';
import { EditorAutoOpener, extractFilePathFromToolInput } from '../editorAutoOpen';
import type { AutoContinueScheduler } from '../llsTask/autoContinue';
import { Logger } from '../logger';
import { AnthropicProxyAdapter } from '../relay/anthropicProxy';
import { DebugRecorder } from '../relay/debugRecorder';
import { OpenAIChatProxyAdapter } from '../relay/openaiChatProxy';
import { OpenAIResponsesProxyAdapter } from '../relay/openaiResponsesProxy';
import { createRelayRouter } from '../relay/router';
import { TokenBudgetService, type CompactionState } from '../relay/tokenBudget/service';
import type { UsageSink } from '../relay/usageReporter';
import { getChatViewHost, getConfigManager, getLlsTaskService, getRelayServer } from '../runtime';
import { createVscodeToolRelayHandler } from '../vscodeTools/httpBridge';
import { createWakeupToolRelayHandler } from '../wakeupTools/httpBridge';
import { WakeupHost } from '../wakeupTools/wakeupHost';
import { WakeupStore } from '../wakeupTools/wakeupStore';
import { WakeupScheduler } from '../wakeupTools/wakeupScheduler';
import { fireWakeupJob, setWakeupScheduler } from '../wakeup/wakeupWiring';

/**
 * 创建 TokenBudgetService，并把压缩状态与用量变化推送到 Chat Webview。
 *
 * @param context 扩展上下文，用于挂载 dispose 与用量订阅。
 * @returns 已装配好的 token 预算服务。
 */
function createTokenBudgetService(context: vscode.ExtensionContext): TokenBudgetService {
    const configManager = getConfigManager()!;
    const service = new TokenBudgetService({
        configManager,
        commandSender: async (command: string) => {
            await sendHiddenUserMessageToCli(command, 'normal');
        },
        notifier: {
            notifyCompactionState: (state: CompactionState) => {
                if (state.kind === 'started') {
                    void getChatViewHost()?.postMessage({
                        type: 'compaction/started',
                        sessionId: state.sessionId,
                        beforeTokens: state.beforeTokens
                    });
                } else if (state.kind === 'finished') {
                    void getChatViewHost()?.postMessage({
                        type: 'compaction/finished',
                        oldSessionId: state.oldSessionId,
                        newSessionId: state.newSessionId,
                        beforeTokens: state.beforeTokens,
                        afterTokens: state.afterTokens,
                        summary: state.summary
                    });
                } else {
                    void getChatViewHost()?.postMessage({
                        type: 'compaction/failed',
                        sessionId: state.sessionId,
                        error: state.error
                    });
                }
            }
        }
    });
    setTokenBudgetServiceRef(service);
    context.subscriptions.push({ dispose: () => { void service.dispose(); } });
    // 把每次 token 用量变更推送给 webview，让 bypass 下拉右侧的 token-meter
    // 渲染「used / limit · pct%」。订阅本身在扩展生命周期内一直保持。
    context.subscriptions.push(service.onDidChangeUsage((snapshot) => {
        void getChatViewHost()?.postMessage({
            type: 'tokenBudget/usage',
            sessionId: snapshot.sessionId,
            used: snapshot.current.totalInputForBudget + snapshot.current.outputTokens,
            limit: snapshot.contextLimit,
            threshold: snapshot.threshold,
            source: snapshot.lastSource
        });
    }));
    return service;
}

/**
 * 构造三个 proxy 共用的 usage sink。
 *
 * 上游 usage 里没有 providerId，只有 model 字段无法可靠反查 provider，
 * 因此这里用 sessionId 去 TokenBudgetService 的快照里反查 providerId；
 * requestBodyAtSend 由 service 在 beforeSend 阶段自行缓存，sink 给空串即可。
 *
 * @param tokenBudgetService 已创建的 token 预算服务。
 */
function createUsageSink(tokenBudgetService: TokenBudgetService): UsageSink {
    return (report) => {
        const sessionId = currentChatCliSessionIdSync();
        if (!sessionId) return;
        const snapshot = tokenBudgetService.getSnapshot(sessionId);
        const providerId = snapshot?.providerId ?? '';
        if (!providerId) return;
        tokenBudgetService.afterRecv({
            sessionId,
            providerId,
            modelId: report.model ?? snapshot?.modelId ?? '',
            usage: report,
            requestBodyAtSend: ''
        });
    };
}

/**
 * 创建定时唤醒调度器与其 relay handler，并注册到全局与 context。
 *
 * @param context 扩展上下文，用于挂载调度器 dispose。
 * @returns 定时唤醒工具的 relay handler。
 */
function createWakeupPipeline(context: vscode.ExtensionContext): ReturnType<typeof createWakeupToolRelayHandler> {
    const scheduler = new WakeupScheduler(new WakeupStore(), fireWakeupJob);
    setWakeupScheduler(scheduler);
    context.subscriptions.push(scheduler);
    return createWakeupToolRelayHandler(new WakeupHost(scheduler));
}

/**
 * 装配本地中转服务的全部请求处理链路。
 *
 * 请求依次尝试浏览器工具、VS Code 工具、定时唤醒工具三个 relay handler，
 * 都未命中时才交给 Chat 的 proxy router。
 *
 * @param context 扩展上下文。
 * @param autoContinueScheduler 自动续推调度器，proxy adapter 需要用它感知任务流。
 */
export function setupRelayPipeline(
    context: vscode.ExtensionContext,
    autoContinueScheduler: AutoContinueScheduler
): void {
    const configManager = getConfigManager()!;
    const llsTaskService = getLlsTaskService()!;
    const relayServer = getRelayServer()!;
    const tokenBudgetService = createTokenBudgetService(context);
    const usageSink = createUsageSink(tokenBudgetService);

    const editorAutoOpener = new EditorAutoOpener();
    const observeFileTool = (toolName: string, input: unknown): void => {
        const filePath = extractFilePathFromToolInput(toolName, input);
        if (!filePath) return;
        void editorAutoOpener.observeToolUse({ toolName, filePath });
    };

    // 调试落盘默认关闭，用函数注入而非布尔值，保证用户改配置后立即生效、无需重启 relay。
    const debugRecorder = new DebugRecorder(() => configManager.getRelayDebugRecordEnabled());
    const adapterDeps = { configManager, llsTaskService, autoContinueScheduler };
    const buildAdapterArgs = () => [
        debugRecorder,
        adapterDeps,
        (report: Parameters<UsageSink>[0]) => usageSink(report),
        tokenBudgetService,
        observeFileTool
    ] as const;

    const chatRelayHandler = createRelayRouter({
        configManager,
        llsTaskService,
        autoContinueScheduler,
        adapters: [
            new AnthropicProxyAdapter(...buildAdapterArgs()),
            new OpenAIChatProxyAdapter(...buildAdapterArgs()),
            new OpenAIResponsesProxyAdapter(...buildAdapterArgs())
        ],
        onUpstreamTimeout: (kind) => {
            void handleUpstreamTimeoutAutoContinue(kind).catch((err: unknown) => {
                Logger.error(`上游超时自动 Continue 失败：${err instanceof Error ? err.message : String(err)}`);
            });
        },
        onUpstreamRequestStart: ({ route }) => {
            setRelayRouteBusy(route, true, 'relay_request_start');
            // 新请求进来说明 CLI 仍在活动：撤销命中非任务流工具后武装的空闲看门狗，
            // 避免在 CLI 自己发起 tool_result 往返时还兜底续推，造成抢跑。
            if (route === 'normal') autoContinueScheduler.notifyRequestStarted();
        },
        onUpstreamRequestEnd: ({ route }) => {
            setRelayRouteBusy(route, false, 'relay_request_end');
        }
    });

    const browserToolRelayHandler = createBrowserToolRelayHandler(undefined, new BrowserSessionStore(context.secrets));
    const vscodeToolRelayHandler = createVscodeToolRelayHandler();
    const wakeupToolRelayHandler = createWakeupPipeline(context);

    relayServer.setHandler(async (req, res) => {
        if (await browserToolRelayHandler(req, res)) return;
        if (await vscodeToolRelayHandler(req, res)) return;
        if (await wakeupToolRelayHandler(req, res)) return;
        await chatRelayHandler(req, res);
    });
    relayServer.setOnHit(() => clearHttpExpectation('relay_hit'));
}
