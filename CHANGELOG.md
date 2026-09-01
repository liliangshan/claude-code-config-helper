# Changelog

All notable changes to this extension are documented in this file.

## [3.2.43] - 2026-09-02

### Changed

- **Task flow model switching moved from creation time to continuation time.** `sendTaskFlowPrompt` / `trySendTaskFlowPromptToBuiltInChat` used to call `selectChatModel()` when a task flow was started, which changed the global current model permanently and never restored it — the exact opposite of the intended behavior. Workflow creation now always runs on the main model.
- **The model is checked before every auto-continue.** A new `beforeSubmit` hook on `AutoContinueScheduler` (the slot existed but was never injected) calls `applyTaskFlowModelForContinue()`, which returns `skipped` (no task flow model configured), `unchanged` (already on it — no restart, no delay) or `switched`. Only `switched` saves the previous main model to `workspaceState`, calls `selectChatModel(..., { silent: true })` and waits 1.5s for the restarted CLI to settle before the continue prompt is written to stdin. The restart resumes the same session via `--resume`, so context and session id survive the switch.
- **The main model is restored when the workflow ends.** `llsTaskService.onDidChange` restores it as soon as the workflow is cleared or all tasks are completed, and activation compensates for a window that was closed mid-flow (restore only when no active workflow remains).
- `selectChatModel()` gained a `silent` option so automatic switches do not spam the chat with toasts; the model dropdown is still refreshed.
- 6 new unit tests cover the three switch results, the failure degradation path and the restore/key-clearing behavior (274 tests).

## [3.2.42] - 2026-09-02

### Fixed

- **Task flow no longer loops forever when a task is blocked or failed.** Auto-continue only stopped when *every* task was `completed`, but the continue prompt was still produced when no `pending` / `in_progress` task was left — so a workflow holding a blocked task was re-pushed every few seconds with no next step to name. `buildContinuePrompt` now returns an empty string when there is no actionable task, which makes the scheduler stand down.

### Changed

- **`blocked` is no longer a writable task status.** Both task tool schemas and the service validator accept only `pending`, `in_progress` and `completed`; a legacy `blocked` value in `.LLSOAI/task-flow.json` is still readable and is normalized to `pending` on load. The continue instruction (all 7 UI languages) now tells the model that when a task cannot be finished it must append a short explanation to `.LLSOAI/task_error.md`, mark the task completed and move on, instead of parking the workflow in a dead state.
- Task flow unit tests are now part of `npm run test` (268 tests).

## [3.2.41] - 2026-09-02

### Changed

- **Assistant body text is now rendered once per content block instead of line by line.** The streaming chunker emitted every buffered line as its own markdown segment, so a multi-line structure — a table, a nested list, a multi-line quote — was split across separate render roots and each row was parsed in isolation (a table showed up as a stack of one-cell boxes). Text deltas are now accumulated only, and the whole block is parsed in one pass at `content_block_stop`, with fallbacks at `message_stop`, the final `result` frame, and stream teardown so nothing is lost if an upstream skips an event.

## [3.2.40] - 2026-09-02

### Added

- **Task flow guide card on an empty chat.** A new conversation now shows a recommendation card explaining the plan-first task flow (let the main model write a plan document → add it to context with the ＋ button → click `CC task flow` → send). It follows the configured UI language, links to the full [Task Flow usage guide](https://github.com/liliangshan/claude-code-config-helper/blob/main/docs/taskflow-usage-guide.md), and can be dismissed for the session.
- `docs/taskflow-usage-guide.md`: a standalone English guide covering why task flow exists, the recommended workflow, start/continue/resume behavior, and how to configure the task flow model.

### Fixed

- **Streaming long text no longer stacks duplicate 「Long text output」 blocks.** Thinking blocks stream as full accumulated text under one stable segment id, but the collapsible long-text branch dropped its DOM node instead of returning it, so `data-segment-id` was never written and every delta appended yet another collapsed block (13321 chars, 13324 chars, 13350 chars…). The node is now returned and patched in place, and a block you expanded stays open across updates.

## [3.2.39] - 2026-09-02

### Changed

- **Task flow model replaces the expert/plan/review modes.** The model picker, header bar and composer chips are now 「Normal / Task flow / Compaction」 three-way; task flow prompts optionally switch the main model to the configured task flow model before sending, and relay routing collapses to the `normal` / `taskFlow` paths.
- Heads-up: the old `chat.expertMode` / `chat.planMode` / `chat.reviewMode` / `chat.expert*` settings keys are no longer registered, so they show up as unknown settings in `settings.json`. They do not affect functionality; delete them at your convenience.

## [3.2.31] - 2026-08-31

### Internal

- Added `docs/high-priority-fix-plan-2026-08-30.md`, a per-method fix plan for the three high-priority issues raised in the project review: wake-ups being lost when delivery fails after the job was already removed from disk, the same wake-up firing twice when two windows share one `wakeups.json`, and the settings webview rendering user-editable fields into `innerHTML` without HTML escaping. No behaviour changes in this release.

## [3.2.30] - 2026-08-30

### Changed

- **The three built-in MCP bridges (browser / VS Code diagnostics / wake-ups) now share one implementation.** Each bridge previously carried its own copy of the same stdio JSON-RPC server, HTTP relay handler, tool-name guard, injection code and startup logging — four places where the same constants had to be kept in sync by hand. All of it now lives in `src/mcpKit/`, and each bridge is reduced to a single descriptor declaring its server name, HTTP path, relay port env var and tool schemas. No server name, tool name, HTTP path, environment variable or subprocess entrypoint changed, so existing configurations keep working untouched.
- **MCP servers now report the real extension version.** `initialize` used to answer `1.0.0` for all four servers (browser, VS Code, wake-ups, ask-expert); they now report the version from `package.json`.

### Fixed

- **Browser and VS Code tools no longer disappear silently when the extension host relay is unreachable.** Both servers used to crash on the first tool call in that situation, which made the whole tool group vanish from the model's view with no visible error. They now behave like the wake-up server has all along: the tools stay listed, and a call returns an explicit "requires the extension host relay" message.

### Internal

- Added regression tests for the shared MCP kit: stdio line framing across chunks, JSON-RPC error codes, relay routing and body-size limits, plus a guard test asserting that nothing under `src/mcpKit/` statically imports `vscode` or any extension-host module — the failure mode behind the 3.2.23 incident where a subprocess crashed at startup and the tools went missing without a trace.

## [3.2.29] - 2026-08-30

### Fixed

- **Re-fetching models no longer wipes the settings you tuned by hand.** "Fetch Models" used to replace a provider's whole model list with the upstream response, and since `GET /models` only returns an id (plus sometimes a display name), every locally configured field — display name, context length, max tokens, vision, tool calling, temperature, top_p, sampling mode, selectable, transform-think, preserve-reasoning — was reset to its default on each fetch. Only `enabled` survived. The upstream list still decides **which** models exist, but each surviving model now **keeps its local configuration untouched**; the upstream display name is adopted only when you never renamed the model (its display name still equals the model id).
- Models the upstream no longer returns are removed as before (they are treated as retired), and if the removed model was the active selection the current model is cleared. New ids are appended, sorted by id, after the existing ones so your list order is preserved.
- The success toast now reports the merge outcome — `已拉取 N 个模型：新增 A，保留原有配置 K，移除 R` — so the effect of each fetch is explicit.

### Fixed (browser tools)

- **`browserContext.newPage: Cannot read properties of undefined (reading '_page')` on Linux now comes with an actionable hint.** This error is raised inside VS Code's built-in browser (its bundled Playwright), typically because Chromium could not create a browser context — missing system libraries, no display, or a sandbox-restricted root session. The raw message pointed at nothing useful, so the browser tool host now appends concrete checks (install `libnss3`/`libatk-1.0`/`libgbm`/`libasound2`, run under `xvfb-run` when headless, avoid an unsandboxed root session, then reload the window).

## [3.2.28] - 2026-08-16

### Added

- **Repeating wake-ups.** `lls-ccai-schedule-wakeup` now accepts `repeatCount` (total number of fires) plus `intervalSeconds` (gap between them), so the model can ask to be pinged every N seconds for N rounds instead of only once. The job keeps the **same id** across every round, so a single `lls-ccai-cancel-wakeup` stops the whole series; the job is removed automatically after the final fire. `repeatCount > 1` without `intervalSeconds` is rejected with an explicit parameter error, and a job with no interval still behaves exactly as a one-shot.
- **Wake-up messages now identify themselves.** Every fired wake-up is prefixed with a header carrying the job id, the round counter (`第 n 次触发，剩余 m 次`), and the exact call needed to stop it — `mcp__llsccaiWakeup__lls-ccai-cancel-wakeup {"id":"..."}` — so the model can cancel a runaway loop without first querying the list tool. `lls-ccai-list-wakeups` also reports `every=`/`remaining=`/`fired=` for repeating jobs.

## [3.2.27] - 2026-08-16

### Added

- **Scheduled wake-ups: the model can now set itself an alarm.** A new built-in MCP server `llsccaiWakeup` exposes three tools — `mcp__llsccaiWakeup__lls-ccai-schedule-wakeup` (takes a `prompt` plus either `delaySeconds` or an ISO 8601 `at`), `lls-ccai-list-wakeups`, and `lls-ccai-cancel-wakeup`. When the timer fires, the wake-up text is appended to the built-in Chat as a **visible user message** and sent upstream through the CLI, exactly as if you had typed and sent it yourself.
- Wake-ups are one-shot (removed once they fire) and are persisted to `.LLSOAI/wakeups.json`, so they survive a VS Code restart: pending jobs are re-armed on activation, and jobs whose time passed while the window was closed fire once on startup. Delays longer than Node's ~24.8-day `setTimeout` ceiling are re-armed in segments instead of firing immediately.

## [3.2.26] - 2026-08-05

### Fixed

- **`browser_open` got stuck on `about:blank` whenever an existing page was reused.** VS Code's built-in `open_browser_page` has two response shapes: it either opens a fresh page already sitting on the target URL, or it detects a "similar page is already open" and just lists that page's id **without navigating it** — and the reused page is usually still on `about:blank`. The host only issued a follow-up `navigate_page` when a saved session snapshot had been restored, so for any origin with no stored credentials the reuse path returned immediately and the browser never left `about:blank`. The reuse branch now always navigates to the requested URL.
- **AskUserQuestion answers now flow through the CLI permission channel, so the model actually waits for your choice.** Previously the webview question modal posted answers as a plain user message while the CLI's `can_use_tool` request was acknowledged with an empty `answers` field — the CLI immediately packed "(no option selected)" into the tool_result and kept going, which looked like the gateway forwarding requests behind an open popup. The extension now intercepts `AskUserQuestion` permission requests, forwards the questions to the webview (`askUser/request`), and only responds to the CLI after you submit — with your selections merged into `updatedInput.answers` (custom notes go into `annotations`). The CLI blocks until then, so no upstream request is sent while a question is open.
- **Multiple question popups no longer stack on top of each other.** Question requests are now queued FIFO in the webview — one modal at a time, the next appears after the current one is answered. The streaming render path no longer opens the modal directly (it shows a normal tool card instead), which also removes the duplicate VS Code "Answer questions?" dialog. History replay no longer re-opens stale question popups since answers are now part of the recorded tool_result.
- **`bypassPermissions` mode keeps the stdio permission channel** (alongside `--dangerously-skip-permissions`) solely so AskUserQuestion can be intercepted; every other tool's permission request is auto-allowed by the extension host, preserving the bypass experience.

### Changed

- **Upstream `system` JSON events (`api_retry`, `task_updated`, …) no longer print as raw JSON in the chat.** They now render as a collapsed `System · <subtype>` tool-style card — click to expand the full JSON. This covers both top-level stream events and system JSON embedded inside assistant text; internal task-scheduler events are still silently dropped.

## [3.2.25] - 2026-08-02

### Fixed

- **Compaction still fired at ~166k even after it was made manual**, because the Claude CLI was compacting on its own. The CLI never saw the model's configured context length, so it derived its auto-compact line from its built-in 200k default minus the output reserve and a 13k buffer. The context length you set in the model config panel is now passed through as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so the CLI and the extension's token meter share one limit. Expert/plan/review routes resolve it from their own model and drop the inherited value when that model has no context length configured, so a limit never leaks across models. Nothing is injected when the field is left empty — the CLI keeps its default behaviour.

## [3.2.24] - 2026-08-01

### Changed

- **Context compaction is now manual only.** `TokenBudgetService` no longer fires `/compact` on its own once a session crosses the `contextLength - 50000` threshold. Automatic triggering competed with the CLI's own compaction and could compact a conversation the user was still working through, with no way to decline. Token metering is untouched — `beforeSend` still estimates and `afterRecv` still records real API usage, so the token meter, threshold display, and per-session buckets behave exactly as before. Compaction now runs only when you press the compact button on the token meter or type `/compact` yourself; externally initiated compaction is still detected so the same context is never compacted twice.

## [3.2.23] - 2026-08-01

### Fixed

- **The built-in `browser_*` MCP tools disappeared entirely.** `browserMcpServer` runs as a standalone Node child process spawned by the Claude CLI, where the `vscode` module does not exist. Both `browserMcpServer.ts` and `httpBridge.ts` statically imported `browserToolHost`, which chains into `logger` → `require('vscode')`, so the server crashed on startup with `Cannot find module 'vscode'` and the whole browser tool group silently vanished from the model's tool list — with no visible error anywhere. Both files now import `BrowserToolHost` as a type only and `require` it lazily on the extension-host path, matching how `vscodeMcpServer` already handled this. Added a regression test that boots the server in a real child process with no `vscode` available and asserts `tools/list` still returns `browser_open`.

### Changed

- The copy-success feedback now shows a green check SVG plus a localized "Copied" label (English, Simplified/Traditional Chinese, Korean, Japanese, French, German) instead of a bare `✓` character. Inline code and fenced code blocks share the same feedback renderer, and the code-block button widens during feedback to fit the label.

## [3.2.22] - 2026-08-01

### Added

- **Click-to-copy inline code** in the Chat webview. Model replies often put a whole shell command in a single-backtick span (for example a `tsh login --proxy=… --user=…` line), which previously had no copy affordance at all — only fenced code blocks got the hover copy button. Inline code now renders with a trailing copy icon, and clicking anywhere on the span copies the full command (the icon is excluded from the copied text). A short green flash confirms the copy. The handler is delegated from `document`, so it also covers spans appended while a reply is still streaming.

### Fixed

- Copy buttons of multiple code blocks in one message no longer stack in the message's top-right corner. `.copyButton_CEmTFw` is absolutely positioned, but `.codeBlockWrapper_-a7MRw` had no positioning context, so every button anchored to the message root instead of its own block. The wrapper is now `position: relative`.

## [3.2.21] - 2026-08-01

### Fixed

- Context compaction no longer fires twice in a row. Three independent paths could each cause a redundant `/compact`:
  - The compaction **summary request itself** was registered as a normal request. Its body is the entire conversation being summarized, so the estimate always cleared the threshold and `TokenBudgetService` sent another `/compact` while the first was still running. The router now forwards `compactCommandTriggered` to the proxies, and a request carrying that flag only records usage — it never re-evaluates the threshold.
  - Compaction started **outside the service** (a user typing `/compact`, or the CLI's own auto-compaction) never set `compact.inProgress` or `lastTriggeredAt`, so the in-progress check and the 60-second debounce were both bypassed. The CLI's `status: compacting` event now registers the in-flight compaction via `noteExternalCompaction`.
  - `shouldTriggerCompaction` returned `true` straight out of the stale-state reset, skipping the threshold, debounce, and `commandSender` checks — so a single lost status event meant the next request after five minutes compacted for no reason. The reset now only clears the stale flag.

## [3.2.20] - 2026-08-01

### Added

- **Browser session persistence**: login state captured in the integrated browser now survives page close and VS Code restarts. VS Code agent pages run in a private in-memory session, so every reopen previously landed back on the login screen. `browser_open` now restores a saved snapshot (cookies including HttpOnly, `localStorage`, `sessionStorage`) **before** navigating to the target URL, so first-screen API calls already carry credentials; snapshots are captured automatically after every non-open browser tool call. Storage goes through VS Code `SecretStorage` (system keychain), keyed per origin with a self-maintained index. Because Playwright's `storageState`/`addCookies` are blocked inside VS Code (`Method not found: Storage.getCookies`), cookies are read and written over raw CDP (`Network.getAllCookies` / `Network.setCookies`).
- `browser_open` gained an optional `forceNew` flag, forwarded to the underlying VS Code tool to open a fresh page instead of reusing a similar one.

### Fixed

- `browser_open` no longer deadlocks when VS Code answers with "At least one similar page is already open" — that response lists the page id as `- [uuid] title (url)`, which the previous parser missed, leaving every subsequent call failing with "Page not found". A fallback pattern now recovers the id from the similar-page listing.

### Notes

- A snapshot is only written once the page state has settled (http/https origin, `document.readyState === 'complete'`, origin matches the current page), which prevents an OAuth redirect from overwriting another origin's entry. An empty result after the user logs out is treated as the truth and overwrites the stored snapshot — there is no "non-empty" guard. Persistence errors are swallowed and logged, never affecting the browser tool's own result.

## [3.2.19] - 2026-06-23

### Fixed

- Task-flow continuation prompts are now self-contained (next pending task plus the status write-back instruction) instead of relying on injected system rules and a Workflow JSON snapshot. Those volatile blocks changed on every continuation and busted the Anthropic prefix cache; the continuation path now injects only the update-tool definition. Replayed `thinking`/`redacted_thinking` blocks are also sanitized in the Anthropic proxy to avoid "Invalid signature in thinking block" on direct forwarding.

## [3.2.10] - 2026-06-22

### Changed

- Task-flow auto-continuation no longer compacts/clears the conversation context before each continuation. Previously a `beforeSubmit` hook forced a `compactNowAndWait` whose result was replaced by the relay with a one-line placeholder `<summary>`, effectively wiping the pre-continuation context. The pre-continue compaction is removed so continuations keep the full context. Normal token-budget compaction is unaffected — `TokenBudgetService` still runs `/compact` when the threshold is reached, and its summary preserves the conversation's key points. (Side effect: the now-unreached task-flow placeholder-summary interception in the relay router stays inert, so a normal `/compact` is no longer hijacked and produces a real summary.)

## [3.2.9] - 2026-06-20

### Added

- Editable Chat session title: the header title is now truncated to 25 characters (full text on hover) and can be clicked to open a popup dialog for renaming the conversation. Confirming with Enter or OK writes the new name back to the session `<sessionId>.jsonl` as a dedicated `{type:"custom-title"}` meta record, which `extractSessionTitle` reads with top priority; an empty title clears the custom name and falls back to the auto-derived title (ai-title > last-prompt > summary). Escape or Cancel discards the edit. New `session/set-title` webview→extension protocol message.

## [3.2.7] - 2026-06-17

### Fixed

- Built-in Chat now passes `--dangerously-skip-permissions` (instead of `--permission-mode bypassPermissions`) when the permission mode is `bypassPermissions`. In the non-interactive `--print` stream-json transport the extension uses, `--permission-mode bypassPermissions` alone still left some CLI versions (notably the Linux builds) prompting for tool authorization — and with no interactive approval channel those calls could stall. The official `--dangerously-skip-permissions` flag is the real "skip all authorization" switch for print mode; in that branch the extension no longer appends `--permission-mode` or the stdio permission-prompt tool. The startup log now includes a `dangerouslySkip` field for verification.

## [3.2.6] - 2026-06-17

### Changed

- Stopped the relay from writing a per-request `.LLSOAI/test-<timestamp>.json` debug snapshot for every outbound request. That dump was only useful for chasing intermittent 400s and otherwise piled up large single-request files in the workspace. The error snapshot (`error-<status>-*.json`) and the daily deduplicated messages log (`yyyy-MM-dd.json`) are kept.

## [3.2.5] - 2026-06-16

### Fixed

- Fixed Mac Chinese (IME) input where pressing **Enter to confirm a candidate** would wrongly send the message. macOS Pinyin commits per character (`compositionend` fires early) while the candidate window stays open, and the confirming Enter arrives with `isComposing=false`, so composition-state checks could not catch it. The composer and the in-place resend editor now use an arrow-key state machine: pressing an arrow key (the typical "page through candidates" action) marks the next Enter as a candidate confirmation that does not send, while any other key resets the state so a plain Enter sends normally.

## [3.2.4] - 2026-06-16

### Fixed

- Compaction requests now route to the configured **compaction model** even when the Claude CLI summary request carries no `<command-name>/compact</command-name>` marker. The relay used to require that marker to be present alongside the summary prompt, but token-budget-triggered `/compact` (sent programmatically via stream-json) and newer CLI versions emit the summary request without it, so those requests fell back to the main model. The summary prompt itself is now a sufficient signal, and the `/compact` marker match is tolerant of leading-slash and case variations.

## [3.2.3] - 2026-06-16

### Changed

- Packaged the extension with its production dependencies (`js-tiktoken`, `base64-js`) bundled into the VSIX so the token-budget tokenizer works without a separate install step.

## [3.2.2] - 2026-06-16

### Fixed

- Fixed the Anthropic prompt-cache 400 error (`a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`) raised by the built-in Chat CLI. The relay used to force every outbound `cache_control` breakpoint to `ttl='1h'`, but an upstream gateway injects its own `ttl='5m'` breakpoints (and prepends extra messages) before reaching Anthropic, so the rewritten `1h` ended up after the gateway's `5m` and got rejected. The cache TTL now defaults to **Default (follow client)**, which leaves the request's `cache_control` untouched and avoids the ordering conflict.

### Added

- A **Prompt cache TTL** selector inside the model-picker dialog with three options — **Default (follow client)** / **5 minutes** / **1 hour** — and a hint reading *"If requests error, switch back to Default."* The choice is persisted in global state and applies to the relay immediately without a reload. Translations are provided for all seven UI languages (en/zh-cn/zh-tw/ko/ja/fr/de).

### Changed

- Removed the old `claudeCodeConfigHelper.chat.cacheTtl` VS Code setting (and its nls strings); the cache TTL is now controlled entirely from the model-picker dialog.

## [3.2.1] - 2026-06-07

### Fixed

- Fixed an Anthropic protocol error (`tool_use ids were found without tool_result blocks immediately after`) raised during tool round-trips. The shared system/identity prompt injection prepended a text block to the **last** user message, but when that message carries a `tool_result` (which must immediately follow the previous assistant `tool_use`), the inserted text displaced the `tool_result` and broke the adjacency Anthropic requires. The injector now detects user messages whose content starts with a `tool_result` and appends the fallback prompt as a **new trailing user message** instead of prepending into the tool round-trip message.

## [3.2.0] - 2026-06-06

### Fixed

- The **`llsccaiVscode` MCP server** (exposing the `get_errors` VS Code diagnostics tool) now starts correctly as a CLI child process. Its module chain statically imported the real `vscode` module (via `diagnosticsHost`), which crashed the child process at load time so `get_errors` never appeared in the tool list. `DiagnosticsHost` is now lazily required only on the extension-host side, so the child entry loads without a `vscode` runtime.
- **Global / workspace shared system prompts** (`openapicopilot.systemPrompt`) are now forwarded to the model in **every** non-side-track request. Previously they were only injected during task-flow scenarios, so in normal chat the configured prompts were silently dropped. The builtin identity prompt and shared prompts are now injected into both the `system` field and (as a fallback) prepended to the last user message.

### Added

- Startup log line **`VS Code MCP 注入状态`** mirroring the existing browser MCP log, so the injection state of `llsccaiVscode` (server name, entrypoint, relay port, tool prefix) is visible in the output channel before the CLI starts.

## [3.1.0] - 2026-06-05

### Added

- In-Chat **"Skip browser confirmation"** hint rendered right after the **CC task flow** button (multi-language: en/zh-cn/zh-tw/ko/ja/fr/de). It appears only on desktop VS Code when browser auto-approval is not yet fully enabled, and disappears once enabled.
- A **webview confirmation dialog** for that hint: clicking it now opens an in-webview modal explaining the reason and the security trade-off, and only enables the settings after the user confirms. Confirming turns on both `workbench.browser.enableChatTools` and `chat.tools.global.autoApprove` so VS Code stops prompting "Open Browser Page?" on every browser page.

### Changed

- Reworked the **browser tool host** to invoke VS Code's built-in language-model browser tools through `vscode.lm.invokeTool` (with page-id threading) instead of the previous `executeCommand` path, and switched the HTTP bridge to a `{name, arguments}` protocol.
- Removed the **blocking activation popups** that asked to enable `workbench.browser.enableChatTools` / `chat.tools.global.autoApprove`; those settings are now driven entirely by the non-blocking in-Chat hint.

## [3.0.1] - 2026-06-04

### Fixed

- The past-conversations list no longer drops brand-new sessions: when a session has no `customTitle`/`aiTitle`/`lastPrompt`/`summary` yet, it now falls back to the first user prompt as the list title so freshly created sessions still appear.

## [3.0.0] - 2026-06-04

### Added

- Self-built **browser tool suite** for the main CLI (desktop only): `browser_open`, `browser_navigate`, `browser_get_content`, `browser_screenshot`, `browser_console`, and `browser_eval`. They are exposed through a new in-process `browser` MCP server (`src/browserTools/`) that delegates to VS Code's agent browser commands; no version probing or low-version fallback is performed.
- **Task-flow persistence**: the CC task workflow snapshot is now written to `.LLSOAI/task-flow.json` on every create/update (`src/llsTask/store.ts`) and restored on the next launch. The Chat shows a "Resume unfinished task flow?" dialog with Continue / Later / Clear actions so task progress and the original user prompt survive VS Code restarts.
- **Past conversations panel** in the Chat header: lists previous sessions for the current workspace; resuming one reloads its full message history into the webview instead of only writing the session id and restarting the CLI.
- **Session title in the header**: the top `LLS CLAUDE CHAT` title now shows the active session's title (from the JSONL `aiTitle`), falling back to the default when none exists.

### Changed

- Replaced the Chat header **Copy source** and **Clear** buttons with a single **New chat** button that clears the view, deletes the per-route session files, and restarts the CLI for a fresh empty context.

### Fixed

- Made session list/content retrieval **Windows-compatible**: project directory names are encoded exactly like the official Claude CLI (all non-alphanumeric characters mapped to `-`, no truncation), `CLAUDE_CONFIG_DIR` is honored, and the session read path now uses the same `cwd` the CLI writes with so listing and resume work on Windows paths.

## [2.2.3] - 2026-06-03

### Fixed

- Refreshed the full Chat model-picker snapshot when provider/model configuration changes, so normal, expert, plan, review, and compaction dropdowns update without a VS Code restart.
- Stopped adding the OpenAI-style `stream_options.include_usage` field to Anthropic direct-provider requests while keeping it for OpenAI-compatible streaming conversions.

## [2.0.23] - 2026-05-28

### Added

- Introduced **dual CLI routing**: the built-in Chat now keeps a long-lived **normal (dispatcher)** CLI and an **expert** CLI side by side, picked per user message by an in-extension `activeRoute` state. The dispatcher emitting `@llsExpert` (word-boundary match) auto-switches the next message to the expert CLI; users can force a one-shot handoff by prefixing their message with `@llsExpert`.
- Added a unified **model-picker dialog** in the Chat header (gear button on the new model bar): pick the normal and expert task models in one round-trip, save both with a single CLI pair restart via the new `models/applyPair` protocol message, and see both selections in the always-visible top bar.
- Added a composer **route badge** showing `NORMAL` / `EXPERT`; clicking it manually switches the route back to `normal`.
- Added user-overridable system prompts for each role: `claudeCodeConfigHelper.chat.dispatcher.appendSystemPrompt` and `claudeCodeConfigHelper.chat.expert.appendSystemPrompt`. Blank values fall back to built-in defaults.
- Added per-route session persistence: `.LLSOAI/chat-session.json` continues to hold the **normal** session for backward compatibility, and `.LLSOAI/chat-session.expert.json` is the new file for the **expert** session, so token-budget compaction buckets and `--resume` are isolated per route.
- Added new webview ↔ extension protocol messages: `route/changed`, `route/select`, `models/snapshot`, `models/applyPair`.

### Removed

- Removed the legacy expert MCP server (`mcp__llsExpert__ask_expert`), the corresponding `/__expert/run` relay route, the `ExpertRunnerService` state machine, the stdio MCP subprocess script, and the webview `expert/event` panel. Routing now flows entirely through `@llsExpert` text handoff between the two long-lived CLIs.
- Removed the composer expert model dropdown and the old model selector inside the composer toolbar; both are replaced by the header model bar + picker dialog described above.

## [2.0.20] - 2026-05-26

### Changed

- Reduced noisy Chat/relay logs by removing high-frequency CLI chunk logs, assistant segment patch logs, and OpenAI conversion warning logs.
- Adjusted automatic context compaction to trigger at model context limit minus 50k tokens, with request-side estimator fallback when upstream usage is missing.

## [2.0.19] - 2026-05-26

### Added

- Added a per-model visibility switch in the provider model editor; disabled models are hidden from both the Chat model dropdown and expert model dropdown.

### Fixed

- Suppressed Claude Code internal `Agent` / `Task` / Plan Mode tool cards and `taskprogress` system events from the Chat transcript.

## [2.0.18] - 2026-05-26

### Fixed

- Fixed duplicate Chat compaction success cards by deduplicating concurrent and delayed `@llsccai-summ` compaction requests for the same session, with a UI-side duplicate render guard.

## [2.0.14] - 2026-05-26

### Removed

- Removed the internal `get_llsccai_vscode_diagnostics` tool and the `@llsccai-get-errors` continuation trigger, including request injection, local interception, auto-continue scheduling, Chat UI labels, and related documentation. The model can no longer read VS Code Problems through this extension; users can paste error output manually instead.

### Fixed

- Fixed Chat footer responsive layout: the model dropdown, bypass mode select, context token meter, and shortcut bar now wrap to additional rows at narrow widths so the send button stays visible and reachable.

## [2.0.13] - 2026-05-26

### Added

- Added built-in Chat token budget compression: the token meter can trigger manual compression, and large contexts can auto-trigger compression near the configured model context threshold.
- Added relay interception for the internal `@llsccai-summ` trigger so compression uses the current CLI conversation context while avoiding Claude CLI slash-command handling.

### Changed

- Compression now summarizes a single flattened user-context message and removes `tool_use` / `tool_result` blocks from the summary input.
- After compression, the extension clears `.LLSOAI/chat-session.json`, restarts the CLI into a fresh session, and injects the compressed summary internally without showing the seed message in the Chat transcript.

## [2.0.8] - 2026-05-25

### Changed

- In Chat CLI startup, `--permission-prompt-tool stdio` is now only passed for non-`bypassPermissions` modes. `bypassPermissions` launches without the interactive permission-prompt channel so it remains fully non-interactive.

## [2.0.7] - 2026-05-25

### Added

- Added a separate footer panel for native Claude `TodoWrite` todos. It is independent from the CC task-flow Todo panel, so both panels can be shown at the same time and collapsed independently.

## [2.0.6] - 2026-05-25

### Fixed

- Also strip upstream `system/taskstarted` and `system/tasknotification` JSON events when they are embedded inside assistant visible text, not only when they arrive as top-level stream-json events.

## [2.0.5] - 2026-05-25

### Changed

- Silently discard upstream `system/taskstarted` and `system/tasknotification` JSON events instead of rendering them as a chat card. These are internal task scheduler events from the upstream CLI/proxy and are not useful to the chat user.

## [2.0.4] - 2026-05-25

### Fixed

- Fixed a stuck-task-flow case after VS Code restart / extension reload: the Claude CLI session would resume the prior context via `--resume`, but the in-memory `LlsTaskService` workflow was already gone, so the model only replied "Workflow created" in text without actually calling `create_llsccai_task_workflow`. Now the saved `.LLSOAI/chat-session.json` is dropped on the next CLI launch when no active workflow is held in memory, forcing a clean session.

## [2.0.3] - 2026-05-25

### Changed

- Restricted the `@llsccai-task` workflow creation prompt so generated workflows contain only tasks the model can execute autonomously (edit / write / run / search / generate). Tasks that require user verification, approval, manual testing, deployment, configuration, clicks, interactive commands, screenshots, or "wait for user feedback" / "user acceptance" steps are now explicitly skipped instead of being added.

## [2.0.2] - 2026-05-25

### Added

- Added a friendly task event card in the Chat area that renders upstream CLI `system/taskstarted` and `system/tasknotification` JSON events as a compact card with status icon, description, task type, and status badge; the started and notification events for the same `taskid` are merged into one card so the raw JSON is no longer shown in the chat.

### Changed

- Made tool call cards collapsible by default: only the summary row (icon + name + status badge + chevron) is shown; clicking the row toggles the body. Collapse state is preserved when the tool status updates (running → success/failed).
- Enlarged the expand/collapse chevron on tool cards (28×28, 20px glyph) so it is easier to see and click.
- Disabled the bottom composer controls (model select, permission mode, expert model select, CC task flow button) while the chat is responding, so they cannot trigger CLI restarts or panels mid-response.
- Kept the running-state composer border-beam animation visible even when the textarea is focused; the previous blue focus outline that covered the animation is suppressed during running state.

## [2.0.0] - 2026-05-25

### Added

- Added an in-chat LLS CCAI task-flow Todo card that renders workflow progress directly above the Chat composer and refreshes when task statuses change.
- Added animated in-progress task indicators for the task-flow Todo card, replacing the previous static dot state.
- Added Windows-specific Claude CLI setup guidance in the configuration panel, including the npm mirror install command and the detected `%APPDATA%`-based `claude.exe` path.
- Added copy buttons for the Windows Claude CLI install command and executable path in the configuration panel.

### Changed

- Changed the LLS CCAI task menu behavior so completed workflows are cleared silently before starting a new task, while still prompting before replacing an actively running workflow.
- Moved the task-flow Todo card into the Chat footer/composer area so it stays visible near the current input box.
- Updated the Windows Claude CLI executable path hint to use the extension host environment instead of a hard-coded `C:\Users\用户名\AppData` example.
- Updated the Windows Claude CLI path display and copy behavior to keep normal Windows single backslashes, for example `C:\Users\lls\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.

### Fixed

- Fixed cases where task-flow status updates were received by the Chat Webview but the Todo UI did not appear in the expected composer area.
- Fixed stale completed-workflow prompts when the user clicks the LLS CCAI task entry after a workflow has already finished.

## [0.1.4] - 2026-05-23

### Added

- Added the built-in Chat Webview backed by the local Claude CLI long-running stdio `stream-json` transport.
- Added Chat rendering for markdown, code blocks, workspace file references, unified diffs, tool cards, errors, and permission fallback segments.
- Added Chat CLI selection, restart, cancellation, abnormal-exit handling, message batching, and long-output safety behavior.
- Added workspace-scoped Chat session restoration through VS Code `workspaceState`, including a one-time privacy notice and clear-session cleanup.
- Added lightweight Node test coverage for `fileRefScanner`, `chatParser`, and diff parsing, plus a fake CLI fixture for integration/manual testing.

### Changed

- Moved LLS CCAI task-flow sending to the built-in Chat path when configured, while keeping the legacy external-Claude clipboard path as a compatibility target.
- Replaced the old local HTTP relay runtime with direct extension-host-to-CLI communication.
- Updated README and manifest descriptions to describe the Chat Webview architecture and release compatibility state.

### Removed

- Removed the built-in HTTP Relay server, router, proxy adapters, relay status bar, relay restart command, relay tests, and relay configuration UI.
- Removed legacy relay state/config types and activation-time relay startup logic.

### Fixed

- Cleaned legacy managed Claude Code relay settings during activation so old local `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` entries do not point users at a removed service.
- Prevented file-reference scanning from duplicating Markdown-link targets or treating URL path fragments as local workspace file references.

### Planning

- Added the Chat Webview migration plan and CLI communication probe records for a future direct Claude CLI integration.
- Verified `claude-code 2.1.141` can be installed through Homebrew with a local proxy and is exposed as `/opt/homebrew/bin/claude`.
- Verified authenticated CLI probes for `text`, `json`, `stream-json`, and stdin text input through `/opt/homebrew/bin/claude`.
- Recorded that the official Claude Code VS Code extension `2.1.144` launches its native UI CLI process through stdio with `--output-format stream-json --verbose --input-format stream-json`.
- Updated the Chat Webview plan so the primary transport is now long-running stdio with bidirectional `stream-json` JSON Lines; `-p/--print` is documented as a probe/fallback path and PTY as an experimental last resort.
- Recorded that long-link implementation should follow the official extension package's SDK-style stdio stream design; permission/tool events and cancellation behavior still require follow-up probes before those features are finalized.

### Fixed

- Normalized forwarded Claude Code built-in tool schemas for OpenAI Chat Completions and OpenAI Responses upstreams.
- Required `Read.pages` to be non-empty when exposed to OpenAI-compatible providers, preventing repeated invalid `pages: ""` tool calls.
- Required `Write.file_path` and `Write.content` when exposed to OpenAI-compatible providers, reducing empty Write tool inputs.
- Removed the optional `Agent.isolation` field from OpenAI-compatible tool schemas so models do not force `worktree` isolation in non-git workspaces.

### Added

- Wrote the final injected Anthropic request body to `.LLSOAI/test.json` for relay debugging across all supported upstream API types.

## [0.1.2] - 2026-05-21

### Added

- Documented enabling `bypassPermissions` (a.k.a. Claude Code initial permission mode `bypassPermissions`) inside the LLS CCAI task workflow so long-running tasks can continue without being interrupted by per-step permission prompts. When the workflow runs in this mode, Claude Code skips file edit / tool execution confirmations and keeps the task progressing automatically until completion. Use it only in trusted workspaces, ideally inside a sandbox or container with no sensitive credentials.

### Changed

- Settings panel "Apply" button now always triggers a window reload after saving, regardless of whether the current model selection changed, to guarantee Claude Code picks up the latest environment variables and shared settings.

## [0.1.0] - 2026-05-21

### Added

- Added a visual provider/model configuration panel for Claude Code.
- Added local relay support for Claude Code Anthropic `/v1/messages` requests.
- Added upstream routing for `anthropic`, `openai-compatible`, and `v1-response` provider types.
- Added Anthropic Messages to OpenAI Chat Completions request/response conversion.
- Added Anthropic Messages to OpenAI Responses request conversion.
- Added OpenAI Responses JSON and SSE response conversion back to Anthropic-compatible output.
- Added LLS CCAI task workflow support for planning, progress tracking, local workflow tool interception, and automatic continuation.
- Added VS Code Problems diagnostics retrieval through the internal `get_llsccai_vscode_diagnostics` tool and `@llsccai-get-errors` continuation trigger.
- Added global and workspace shared prompt settings pages.
- Added provider configuration import/export support.
- Added multi-language UI support.
- Added marketplace icon and repository metadata.

### Changed

- Updated README documentation to English.
- Documented task workflow and VS Code diagnostics features.
- Kept diagnostics tool instructions in the system rule layer instead of normal user messages.
- Removed single request/response debug snapshot file output while keeping daily messages aggregation for context troubleshooting.

### Security

- Provider secrets are stored in VS Code `SecretStorage` before activation.
- Managed Claude Code environment variables are marked with `__CLAUDE_ROUTER_MANAGED__` for safe replacement.
- OpenAI-compatible forwarding uses minimal upstream authentication headers and avoids leaking Anthropic-specific headers where they are not needed.
