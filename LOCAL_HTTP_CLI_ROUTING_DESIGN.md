# Path-based local HTTP CLI routing design

> 目标：评估并设计用本地 HTTP request path 区分 `normal` / `expert` / `plan` / `review` CLI 来源，替代 Relay 侧依赖显式 expert-mode / role 环境变量的归因方式。

## 1. 结论

可以用 path-based local HTTP routing 替代 Relay 侧的显式 `LLS_CHAT_ROLE` / expert-mode 变量。

原因：

- Relay 收到的是 HTTP 请求，天然可靠可见的是 method、path、headers、body。
- 发起请求的 Claude CLI 子进程环境变量不会随 HTTP 请求自动传到 Relay。
- 当前用 modelId 推断 route 在多路使用同一模型时有歧义。
- request path 是每个 CLI 启动时可通过 `ANTHROPIC_BASE_URL` 固定编码的边界信息，适合做来源归因。

但 path-based routing 不能替代扩展宿主侧的 `activeRoute` 状态。

`activeRoute` 仍然需要负责：

- 决定下一条用户消息发送给哪条 `StreamJsonCliAdapter`。
- 驱动 Webview route badge。
- 支持用户手动切换 normal/expert/plan/review。
- 支持 normal 输出 `@llsExpert` / `@llsPlan*` 后的自动交棒与 plan/review workflow 编排。

因此替代关系是：

```txt
Relay 侧请求来源归因：LLS_CHAT_ROLE / expert-mode env  ->  HTTP path prefix
宿主侧用户消息路由状态：activeRoute                    ->  保留
模型选择：model / ANTHROPIC_MODEL                      ->  保留，仅用于 provider/model routing
```

## 2. 当前问题

当前 Relay 只接受：

```txt
POST /v1/messages
```

所有 CLI 共享类似配置：

```txt
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
```

Relay 再从 request body 的 `model` 字段解析 `providerId/modelId`。宿主侧用类似 `resolveRouteForRelayModel(providerId, modelId)` 的逻辑把 upstream request 归因到 normal/expert/plan/review。

这个方案的问题是：

1. **同模型歧义**：normal、expert、plan、review 如果配置同一个模型 ID，单靠 modelId 无法区分来源。
2. **activeRoute 竞态**：用当前 activeRoute 兜底时，侧轨请求、标题生成请求、并发请求可能被归到错误 route。
3. **环境变量不可见**：`LLS_CHAT_ROLE=expert` 只存在于 CLI 子进程环境中，Relay 无法从 HTTP 请求直接读取。
4. **职责混淆**：model 应只表达 provider/model 选择，不应承担 CLI 来源归因。

## 3. 目标设计

给每条 CLI 注入不同的 local HTTP base path：

```txt
normal CLI:
  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/normal
  -> POST /normal/v1/messages

expert CLI:
  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/expert
  -> POST /expert/v1/messages

plan CLI:
  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/plan
  -> POST /plan/v1/messages

review CLI:
  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/review
  -> POST /review/v1/messages
```

Relay 解析第一个 path segment 得到 route，剥离该 segment 后继续按 Anthropic-compatible path 处理：

```txt
/normal/v1/messages -> route=normal, upstreamPath=/v1/messages
/expert/v1/messages -> route=expert, upstreamPath=/v1/messages
/plan/v1/messages   -> route=plan,   upstreamPath=/v1/messages
/review/v1/messages -> route=review, upstreamPath=/v1/messages
```

裸路径保持兼容：

```txt
/v1/messages -> route=normal, upstreamPath=/v1/messages
```

## 4. Relay path parser

建议新增一个纯函数，便于单测：

```ts
export type LocalCliHttpRoute = 'normal' | 'expert' | 'plan' | 'review';

export interface ParsedLocalCliPath {
    route: LocalCliHttpRoute;
    upstreamPath: string;
}

export function parseLocalCliPath(path: string): ParsedLocalCliPath | undefined {
    if (path === '/v1/messages') {
        return { route: 'normal', upstreamPath: path };
    }

    const match = path.match(/^\/(normal|expert|plan|review)(\/.*)$/);
    if (!match) return undefined;

    return {
        route: match[1] as LocalCliHttpRoute,
        upstreamPath: match[2]
    };
}
```

Relay 入口逻辑改为：

```ts
const method = (req.method ?? 'GET').toUpperCase();
const url = req.url ?? '';
const path = url.split('?', 1)[0];
const parsedPath = parseLocalCliPath(path);

if (!parsedPath || parsedPath.upstreamPath !== '/v1/messages' || method !== 'POST') {
    writeJsonError(res, 404, 'not_found', `unsupported path: ${method} ${path}`);
    return;
}

const route = parsedPath.route;
```

## 5. Request lifecycle attribution

`RelayUpstreamRequestInfo` should include route:

```ts
export interface RelayUpstreamRequestInfo {
    route: ChatRoute;
    providerId: string;
    modelId: string;
}
```

Then request lifecycle callbacks no longer need to infer route from model:

```ts
const requestInfo = { route, providerId, modelId };
onUpstreamRequestStart?.(requestInfo);
try {
    await adapter.handle(ctx);
} finally {
    onUpstreamRequestEnd?.(requestInfo);
}
```

The extension can update busy state directly:

```ts
onUpstreamRequestStart: ({ route }) => setRelayRouteBusy(route, true, 'relay-start'),
onUpstreamRequestEnd: ({ route }) => setRelayRouteBusy(route, false, 'relay-end')
```

## 6. CLI config derivation

Instead of building the same Relay env for every route, generate route-specific base URLs:

```ts
function buildRelayEnv(relayPort: number, modelId: string | undefined, route: ChatRoute): Record<string, string> {
    const env = {
        CLAUDE_CODE_SKIP_AUTH_LOGIN: '1',
        CLAUDE_CODE_SKIP_MODEL_VALIDATION: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayPort}/${route}`,
        ANTHROPIC_AUTH_TOKEN: 'claude-code-relay',
        ANTHROPIC_API_KEY: 'claude-code-relay'
    };
    if (modelId) env.ANTHROPIC_MODEL = modelId;
    return env;
}
```

`LLS_CHAT_ROLE` can then be removed from functional routing. If useful during migration, keep it only as a diagnostic env value and avoid reading it in Relay logic.

## 7. Targeted path binding on CLI start/restart

Each CLI mode must be started or restarted with a route-specific HTTP base path bound into that process' launch config. The route binding is not a mutable global Relay setting; it is part of the individual `ChatCliConfig` passed to the `CliProcess` for that mode.

Required binding table:

```txt
normal  process -> route=normal  -> ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/normal
expert  process -> route=expert  -> ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/expert
plan    process -> route=plan    -> ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/plan
review  process -> route=review  -> ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/review
```

The route-specific URL should be applied every time a launch config is created:

- initial extension activation / first chat start;
- lazy start of optional modes such as plan/review;
- model selection changes;
- relay port changes;
- token-budget reset restarts;
- explicit user restart / clear session flows;
- recovery restart after CLI exit or upstream timeout.

Suggested helper:

```ts
function withRouteRelayBinding(config: ChatCliConfig, relayPort: number, route: ChatRoute): ChatCliConfig {
    return {
        ...config,
        cliEnv: {
            ...config.cliEnv,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayPort}/${route}`
        }
    };
}
```

`startChatCliRoutes` should bind each route before comparing configs or spawning processes:

```ts
async function startChatCliRoutes(options: { forceRestart?: boolean } = {}): Promise<void> {
    const relayPort = await ensureRelayServerStarted();
    const configs = await chatCliConfigService.getRouteConfigsWithRelayEnv(relayPort);

    await startOrRestartRouteCli('normal', withRouteRelayBinding(configs.normal, relayPort, 'normal'), options);

    if (configs.expert) {
        await startOrRestartRouteCli('expert', withRouteRelayBinding(configs.expert, relayPort, 'expert'), options);
    } else {
        await stopRouteCli('expert');
    }

    if (configs.plan) {
        await startOrRestartRouteCli('plan', withRouteRelayBinding(configs.plan, relayPort, 'plan'), options);
    } else {
        await stopRouteCli('plan');
    }

    if (configs.review) {
        await startOrRestartRouteCli('review', withRouteRelayBinding(configs.review, relayPort, 'review'), options);
    } else {
        await stopRouteCli('review');
    }
}
```

`restartRouteCli(route)` must rebuild the launch config for that exact route and preserve the route-specific path. It must not reuse another route's config or a shared `ANTHROPIC_BASE_URL`.

```ts
async function restartRouteCli(route: ChatRoute, reason: string): Promise<void> {
    const relayPort = await ensureRelayServerStarted();
    const config = await resolveConfigForRoute(route, relayPort);
    if (!config) {
        await stopRouteCli(route);
        return;
    }
    await startOrRestartRouteCli(route, withRouteRelayBinding(config, relayPort, route), { forceRestart: true });
}
```

Important invariants:

- `CliProcess.isRunningWithConfig(...)` comparisons must include the route-specific `ANTHROPIC_BASE_URL`; if the route path changes, the process must restart.
- A mode restart must only stop/start that mode unless the caller explicitly requests all-route restart.
- Relay port changes require rebinding and restarting all running modes because every base URL changes.
- Lazy-started modes must use their own path from the first request; they must never briefly start with bare `/v1/messages`.
- Hidden internal handoff messages should call the adapter selected by `activeRoute` / `forceRoute`; the HTTP path then independently confirms the mode at Relay ingress.

## 8. Compatibility and fallback

Migration should be conservative:

1. Keep accepting bare `POST /v1/messages` as `normal`.
2. Log the parsed route and upstream path for early diagnosis.
3. Keep model/session/activeRoute inference as a fallback only when no path prefix exists.
4. Add a warning if a non-normal CLI appears to call bare `/v1/messages`; that indicates the Claude CLI did not preserve the `ANTHROPIC_BASE_URL` path prefix or the route-specific env was not applied.

Fallback priority during migration:

```txt
1. HTTP path prefix
2. sessionId -> route map, if available
3. activeRoute, only as last-resort local UI state
4. modelId matching, only for legacy compatibility
```

After path-based routing is proven stable, modelId matching should not be used for request lifecycle attribution.

## 9. Smoke test requirement

Before relying on this design, verify Claude CLI preserves `ANTHROPIC_BASE_URL` path prefixes.

Expected behavior:

```txt
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/expert
```

Claude CLI should call:

```txt
POST /expert/v1/messages
```

Not:

```txt
POST /v1/messages
```

If the CLI strips the base path, this design cannot be used through `ANTHROPIC_BASE_URL` alone. In that case the fallback is to retain current inference or add another explicit HTTP-visible marker such as a route-specific header, but headers are only viable if Claude CLI allows configuring custom upstream headers per process.

## 10. Test plan

Add unit tests for `parseLocalCliPath`:

- `/v1/messages` -> normal.
- `/normal/v1/messages` -> normal.
- `/expert/v1/messages` -> expert.
- `/plan/v1/messages` -> plan.
- `/review/v1/messages` -> review.
- `/expert/v1/messages?foo=bar` works after query stripping.
- `/bad/v1/messages` returns undefined.
- `/expert/other` parses route but fails upstream path validation.

Add integration-style tests for Relay lifecycle attribution:

- Request to `/expert/v1/messages` calls `onUpstreamRequestStart` with `route='expert'` even if model equals normal model.
- Request to `/plan/v1/messages` calls `route='plan'` even if model equals review model.
- Bare `/v1/messages` remains `normal`.

Add config and lifecycle tests:

- normal config receives `/normal` base path.
- expert config receives `/expert` base path.
- plan config receives `/plan` base path.
- review config receives `/review` base path.
- `LLS_CHAT_ROLE` is absent or documented as diagnostic-only.
- starting all routes binds each running `CliProcess` to its own path-specific `ANTHROPIC_BASE_URL`.
- restarting only expert rebuilds expert with `/expert` and does not restart normal/plan/review.
- lazy-starting plan binds `/plan` before the first plan request.
- relay port changes rebind all running routes to the new port while preserving each route segment.
- `isRunningWithConfig` detects a route-path mismatch and triggers restart.

## 11. Implementation order

1. Add `parseLocalCliPath` and unit tests.
2. Extend `RelayUpstreamRequestInfo` with `route`.
3. Change Relay path validation from fixed `/v1/messages` to route-prefix parsing.
4. Update request start/end callbacks to use explicit `info.route`.
5. Add a route-binding helper that produces `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<route>` for each mode.
6. Apply targeted path binding in every start/restart path: all-route startup, single-route restart, lazy plan/review startup, model changes, relay port changes, token-budget reset, and recovery restarts.
7. Ensure config equality/restart checks include the path-specific `ANTHROPIC_BASE_URL`.
8. Keep legacy fallback and warnings.
9. Remove Relay-side dependence on modelId route inference after validation.
10. Optionally remove `LLS_CHAT_ROLE` from functional config once no tests or code paths rely on it.

## 12. Non-goals

This design does not change:

- The dispatcher prompt and `@llsExpert` / `@llsPlan*` text-token orchestration.
- The host-side `activeRoute` state machine.
- Session isolation files for normal/expert/plan/review.
- Provider/model routing based on request body `model`.
- Upstream adapter selection based on provider `apiType`.
