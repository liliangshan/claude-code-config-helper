# Claude Code Config Helper

**Version:** 3.2.80

**Website: [www.zhineng.dev](https://www.zhineng.dev/)**

[Overview](https://www.zhineng.dev/extension.html) · [Getting Started](https://www.zhineng.dev/guide.html) · [FAQ](https://www.zhineng.dev/faq.html) · [MCP Tools](https://www.zhineng.dev/mcp.html)

Move beyond AI chat and keep development moving. **Claude Code Config Helper (LLS CCAI)** connects the local Claude CLI, model providers, independent left/right conversations and MCP tools inside VS Code, bringing coding, troubleshooting, task flows and diagnostics into one workspace.

- **Guided setup:** download or reuse an existing CLI, manage providers, and choose workspace models and reasoning effort.
- **Independent conversations:** keep primary and supporting tasks in separate contexts with their own model and permission settings, leaving the editor area for code.
- **Tools on demand:** connect databases, SSH hosts, caches and APIs; inspect request usage and cache statistics; work in seven interface languages.

Bring your own model service and credentials; model credits are not included. Usage charges and feature availability depend on your provider. This is an independent project, not an official Anthropic or Microsoft product.

The Help icons in both native chat title bars and the Help text buttons open **https://www.zhineng.dev/** directly in your default browser, without a topic menu. Button labels remain localized, and the link contains no credentials, conversation content or workspace paths.

## Recommended MCP Tools

The following MCP servers are maintained by the same author and can complement this extension or run independently with other compatible clients. **They are optional: installing the extension does not automatically install or enable them.**

| Tool | Use Cases | npm Documentation |
| --- | --- | --- |
| **SSH** | Remote commands and SFTP transfers with password/key authentication and host-fingerprint verification. | [@liangshanli/mcp-server-ssh](https://www.npmjs.com/package/@liangshanli/mcp-server-ssh) |
| **MySQL** | Data queries, schema inspection and DDL/DML with read-only mode, permission controls and operation logs. | [@liangshanli/mcp-server-mysql](https://www.npmjs.com/package/@liangshanli/mcp-server-mysql) |
| **SQL Server** | SQL queries and schema operations with permission controls, connection pooling and logs. | [@liangshanli/mcp-server-mssqlserver](https://www.npmjs.com/package/@liangshanli/mcp-server-mssqlserver) |
| **Redis** | Cache inspection and key/data management with configurable operation permissions and logs. | [@liangshanli/mcp-server-redis](https://www.npmjs.com/package/@liangshanli/mcp-server-redis) |
| **API Debug** | HTTP API debugging, shared configuration, login requests and indexed execution of saved endpoints. | [@liangshanli/mcp-server-apidebug](https://www.npmjs.com/package/@liangshanli/mcp-server-apidebug) |

See the [MCP configuration guide](https://www.zhineng.dev/guide.html#mcp-config) for client-specific examples. Consult each package's npm documentation for current requirements. Start with a test environment and least-privilege accounts, verify SSH host fingerprints, and keep credentials out of Git. Application-level switches do not replace database, operating-system or network access controls.

## Tool JSON error diagnostics

When the Responses stream converter detects malformed tool arguments, it automatically writes `.LLSOAI/error/YYYY-MM-DD/error-tooljson-<timestamp>-<random>.json`, even when `relay.debugRecord` is off. Each file preserves the entire upstream SSE received for that request, the converted response, tool argument diagnostics, HTTP completion flags, end reason and the actual output-budget/reasoning parameters. A truncated stream can only preserve bytes received before it stopped; it cannot recover data the upstream never sent. Invalid UTF-8 additionally includes a Base64 copy of the original bytes.

Files share the existing 20-snapshot error retention limit across date directories. Detection compares the upstream final arguments with the actual emitted argument fragments, including `__unparsedToolInput` wrappers and late fragments. The recorder also retains up to eight recent tool responses in memory (64 MiB total) to correlate a subsequent CLI `InputValidationError` by call ID. If the original response has expired or the extension was reloaded, the fallback file explicitly marks `originalResponseUnavailable`; it never substitutes an unrelated response.

Request bodies, URLs and authentication headers are not included in these diagnostics, but **raw model responses and tool arguments can contain sensitive content**; review them before sharing. Token limits remain unchanged, and arguments are never repaired by guessing missing JSON characters.

## What's New in 3.2.80

- **Moved conversations stay selectable.** The parallel/settings view no longer reopens the main chat whenever it becomes visible. Both conversations can be selected independently when moved into the same sidebar or placed on opposite sides.
- **View identity, not default placement.** Chat-opening actions focus the registered view or existing WebviewView rather than its original container. Moving a view does not exchange its history, model settings or CLI identity; repeated switching does not remount the parallel runtime.
- **Settings keep their intended focus.** Explicit settings opening may reveal the main chat first, but finishes at the settings view's current location. Manual visibility changes and opening the parallel conversation never force main-chat activation.

**Known issue:** the existing `requestUsageBinding` failure (`true !== false`) and the reused-response-ID association limitation remain unresolved. Simulated layout regressions pass; real-window drag-and-drop still requires manual acceptance.

## What's New in 3.2.79

- **Selected history actually reloads.** Explicit history selection replaces the visible transcript even when cached message IDs match. Reselecting the current left/editor history rereads its native file; ordinary duplicate initialization still avoids unnecessary redraws.
- **Broader native transcript support.** String messages and content-block arrays are both recognized. Missing, unreadable or empty selected histories report failure without silently clearing the current chat.
- **Safe switching and earlier display.** The main chat reads and validates history before stopping its previous CLI and saving the selected identity. The left/editor chat publishes loaded history before process startup, keeping it visible even if that startup fails. Stop an active left/editor task before selecting history; interrupted prompts are never automatically replayed.

**Known issue:** the existing `requestUsageBinding` failure (`true !== false`) and the reused-response-ID association limitation remain unresolved. The reload behavior is covered by regression tests and an isolated browser check; manual acceptance in real workspaces is still required.

## What's New in 3.2.78

- **Conversation history is back on both sides.** Each chat header includes a Conversation list button that opens its native CLI history drawer. Selecting a history resumes it only in the originating left or right conversation; listing or dismissing history does not reset either chat.
- **Localized and keyboard-friendly.** Loading/empty states, close controls, date groups and relative timestamps follow the selected UI language. Close through the button, backdrop or Escape; focus returns to the history button and the closed drawer is inert.
- **Parallel entry stays direct.** Parallel session and the native plus action still open the left conversation without an intermediate list or editor tab. This restores native CLI history, not the separate independent-session picker. Website Help continues to open the homepage directly.

**Known issue:** the existing `requestUsageBinding` failure (`true !== false`) and the reused-response-ID association limitation remain unresolved. Real-window history selection still requires manual acceptance.

## What's New in 3.2.77

- **One-click website help.** Both chat title bars have a Help icon, and both chat headers have a Help text button. Every entry opens [www.zhineng.dev](https://www.zhineng.dev/) directly in the system browser without a dropdown or topic menu. The command palette also provides **LLS CCAI: Open Help**.
- **Localized controls, English documentation.** Help labels, tooltips, accessible names, command titles and launch-failure notices support all seven interface languages. The README is English-only, with website links and recommended optional MCP tools near the top.
- **No interruption or private URL data.** Opening Help does not wait for chat task/settings queues or CLI updates, restart a conversation, change a model or send a model request. The fixed homepage URL contains no credentials, messages or workspace paths; simultaneous clicks share the pending browser launch.

**Known issue:** the existing `requestUsageBinding` failure (`true !== false`) and the reused-response-ID association limitation remain unresolved. Real-window external-browser behavior still requires manual acceptance.

## What's New in 3.2.76

- **Two-sided conversations.** The right main chat stays in place. Parallel session and the native **＋** open the left independent conversation directly, restoring its saved selection or first history, and creating one only when no history exists. Repeated clicks reuse the same conversation without refreshing the chat or restarting its CLI. Settings can replace the left page without stopping its task.
- **Matching title-bar actions.** The left chat has Edit title, Settings and Restart CLI icons like the right chat, but no plus. Rename/restart affect only the corresponding conversation. Chat no longer exposes conversation-list controls; editor task code, histories and restoration remain retained behind hidden legacy entries.
- **Left usage and MCP fixes.** Exact request/response bindings and persisted statistics restore per-request token/cache usage and the context meter. Each conversation owns its bindings. Native workspace `.mcp.json` discovery follows the user's strict-mode setting rather than being forcibly disabled; folder-scoped VS Code MCP settings resolve against the conversation's own workspace.
- **Automatic setup activation.** Missing or incomplete global installation records automatically open and focus the shared wizard before either chat starts. The Reset Installation State and Open Setup command clears only setup records through VS Code's live API; it preserves CLI files, providers, secrets, MCP configuration and histories. Development-only one-shot reset requests are ignored by production installations.
- **Build identification.** Startup output records the actual extension path, mode, version and setup-completion flag, making installed-versus-development testing easier to verify.

**Known issue:** the existing `requestUsageBinding` failure (`true !== false`) and reused-response-ID association limitation remain unresolved. Manual acceptance is still needed for real workspace/provider/MCP behavior.

## What's New in 3.2.75

- **Setup and settings share one view.** The left LLS CCAI view shows the three-step wizard until this host has an explicit global setup-completion record, then switches in place to settings. Existing CLI/model settings are prefilled, not treated as proof that setup is complete. Step 1 configures language, download source and CLI; step 2 manages providers and models directly; step 3 selects workspace Normal, Task flow and Compaction models plus Auto/Low/Medium/High/XHigh reasoning effort.
- **Managed CLI downloads and updates.** Choose official npm (default) or the explicitly selected third-party China mirror, npmmirror. The extension downloads the host's native platform package, verifies its SHA512 integrity, extracts without running install scripts and validates `--version`. Executables are published directly as `<selected directory>/claude-<version>` (`.exe` on Windows), without overwriting an existing file. Custom download-directory choices survive reloads.
- **Updates stay in settings.** The CLI card contains only the current version and Check for updates. Checking shows the result inline without switching back to onboarding or refreshing provider forms. New versions require confirmation; validated updates switch the path and restart extension-managed live sessions, preserving their identities and settings. Running tasks can be interrupted and are not replayed; unopened histories remain stopped and old executables are retained.
- **Up to three parallel task tabs.** The main chat defaults to the right sidebar; settings remain on the left. The title-bar **＋ Parallel task** action reopens saved editor conversations in creation order without a picker, creating a new UUID only after all saved conversations are open. The maximum is three editor task areas, excluding the main chat; hidden, opening and closing tabs count toward the limit. Each tab owns its CLI, context, model choices, reasoning effort, task flow and draft. This is independent chat concurrency, not the separate multi-agent orchestration project.
- **Cleaner chat and provider controls.** Editor tabs place Edit title, Restart CLI, Conversation list and New chat after the title. Main-chat page actions stay right-aligned, with existing native title-bar shortcuts retained. Manual restart reuses the relay-and-CLI restart flow with visible progress; editor restarts affect only their own runtime. Provider lists show `*` plus the last four key characters only when a hint was generated during saving; older entries retain Saved key, and full credentials remain in SecretStorage.
- **Recovery and copy fixes.** Reload restores the main chat's exact saved CLI history when its message cache is empty or mismatched. Editor tabs retain UUID association and automatically recover locks only when the recorded owner process is gone. Copying selected chat output uses the host clipboard with a real success acknowledgement and preserves right-click selection.

**Known issue:** the existing `requestUsageBinding` regression (`true !== false`) and the separately documented reused-response-ID usage-association problem remain unresolved. Synthetic/local tests do not replace manual acceptance on every OS, mirror and upstream provider.

## What's New in 3.2.74

- **Accurate cache-write accounting.** Chat and Responses JSON/SSE responses share one normalizer. Gateway-provided cache writes are displayed separately from ordinary input, with ordinary input + cache reads + cache writes matching total input. Root-level write aliases take precedence over detail fields, including explicit zero; invalid counts are ignored and oversized details cannot inflate totals.
- **Late usage preserved.** Cache-write details arriving after Chat `finish_reason` remain available in the final usage event. Missing write details keep the existing read-cache compatibility behavior; no cache writes are inferred without evidence.
- **Previous test-package fixes included.** Retains removal of the local 10 MiB Relay request limit, portable CLI version detection and actionable compatibility notices. The independently diagnosed duplicate-response-ID usage-display problem is not fixed by cache accounting changes.

## What's New in 3.2.73

- **Large-context Relay requests.** Removed the local 10 MiB chat/compaction request-body limit that could terminate long-session requests and cause CLI retries. Request bytes are preserved across chunks; interrupted reads release buffers without reporting a false size error. Host memory, Node runtime and upstream/model limits still apply. Image-upload and MCP limits are unchanged.
- **Portable CLI version detection.** Stable versions such as `v2.1.303` and `Claude Code 2.1.303`, startup notices and ANSI colors are recognized. Windows script probes use CMD or PowerShell as appropriate, with the configured environment and working directory. Failed probes are not cached; the detection timeout is 15 seconds.
- **Actionable compatibility notices.** Deduplicated notifications distinguish an old CLI, failed detection and an unsupported context window, showing the actual executable path with recheck/selection actions. Changes continue to use the safe restart flow without interrupting an active task. Windows command construction is covered by tests; real Windows-machine acceptance remains pending.

## What's New in 3.2.72

- **Responses thinking summaries stream live.** With model reasoning passthrough enabled, Responses requests include `reasoning.summary=auto`, while effort selection remains unchanged. Visible summary deltas use the existing thinking-block typewriter rather than waiting for the full response.
- **Deduplicated completion.** Summary text/part events and item/response snapshots share per-item, per-summary state. Only a matching, unsent suffix is appended; repeated completion events do not duplicate text or close blocks twice. Encrypted reasoning is never displayed. Summaries first appearing in snapshots after ordinary output are skipped to preserve ordering.
- **Existing behavior preserved.** Turning reasoning passthrough off retains previous request/response output. Tool argument streaming, prefix validation and error snapshots remain intact. Local converter/HTTP tests and a real CLI 2.1.280 probe with a synthetic Responses upstream verified early summary delivery without paid API requests.
- **Known issue not fixed in this release.** Some gateways reuse response IDs such as `resp_stream`, which can prevent per-message usage association even when token totals are logged. This release addresses thinking-summary display, not that separate usage-binding issue.

## What's New in 3.2.71

- **Native auto-compaction during long tool loops.** Auto compact delegates execution to the CLI, no longer waiting for the full-turn result before sending an extension-generated command. Summaries are still generated by the selected model from the complete CLI conversation; the extension does not extract/truncate local chat text.
- **Model-window policy.** A valid configured `contextLength` takes precedence over the existing model table, then a 200,000-token default. Windows ≤200K use 90%; larger windows use 80%. The full window is passed once to `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, with the usage ratio in `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. The CLI additionally reserves output/summary space, so the meter labels the trigger as an estimate rather than exactly 90%/80% of total capacity.
- **Important off-switch change.** `chat.autoCompact.enabled` remains off by default, but off now disables CLI automatic compaction with subprocess-only `DISABLE_AUTO_COMPACT`. Manual `/compact` remains available unless separately disabled by your own native settings. Upgrade users who relied on the previous native fallback while this switch was off should enable Auto compact.
- **Safe application.** Idle changes resume-restart the same session. During generation, tools, permissions, compaction or recovery, changes display Pending until a safe restart; current work is not killed. Normal/task-flow model switches and recovery recompute the strategy from raw configuration each start.
- **Compatibility and diagnosis.** Managed mode requires the selected CLI executable to report 2.1.280+ and a 100K–1M window. Unsupported ranges are not silently enlarged. Explicit environment/native-setting conflicts are shown without overriding user disables. The seven-language UI exposes configured capacity, usage ratio, estimated trigger, pending state and smaller summary-model capacity.
- **Verification.** Real CLI 2.1.280 against local synthetic upstreams completed native compaction before full-turn result at 200K/500K/1M, routed the summary through the selected model, saved dated snapshots and continued the task. No paid provider requests were used. Opt-in acceptance tests use `CCAI_NATIVE_TEST_CLI`; default regression runs skip real-CLI tests. See [the implementation plan](NATIVE_AUTO_COMPACTION_PLAN.md).

## What's New in 3.2.70

- **Workspace Code preview switch.** The switch sits after Auto compact, defaults to off, and supports all seven interface languages. It writes `claudeCodeConfigHelper.editor.codePreview.enabled` to workspace settings and takes effect without restarting the CLI, including while a task is running.
- **Less editor switching.** Off prevents file tools from automatically displaying non-Markdown files; `.md` / `.markdown` keep their existing behavior. Browser tools still reveal browser tabs, and manual file-link clicks are unchanged. On restores normal automatic file display.
- **Existing safeguards preserved.** The master `editor.autoOpenReadWriteFiles` setting can still disable all automatic file opening, including Markdown. Only workspace files are eligible; toggling does not close existing tabs or restrict the tools' actual read/write operations.

## What's New in 3.2.69

- **Paste webpage text and images together.** Cmd/Ctrl+V preserves native text insertion and adds image attachments separately. If the clipboard has no image files, HTML `img` sources are imported by the extension host instead of being lost in the plain-text textarea.
- **Bounded image import.** Supports embedded PNG/JPEG/GIF/WebP/BMP/TIFF data and public HTTP(S) images, with five HTML images per paste, 20 MiB per image and a 15-second download deadline. Duplicate URLs are skipped. Relative URLs need a clipboard source URL or HTML base; `blob:`/local/private images, unsupported formats and login-protected downloads may require copying the image directly or using a screenshot. Downloads do not send browser cookies or authentication headers.
- **Visible progress and failures.** Image placeholders block sending until ready. Failed imports show warnings in all seven interface languages and are removed from attachments. The Webview CSP remains unchanged.

## What's New in 3.2.68

- **Browser automation reveals its target tab.** Page tools bring the tracked browser page into view in the editor area before running, while preserving chat keyboard focus. Opening or reusing a page also reveals that page's tab. This does not navigate or reload the page just to display it.
- **Best-effort compatibility.** The reveal path targets VS Code's integrated-browser editor by page ID. If that editor is unavailable, the automation still runs and a warning is logged. Background login-state saves do not switch tabs again.

## What's New in 3.2.67

- **UTF-8-safe streaming.** Anthropic, OpenAI Chat and Responses now preserve multibyte characters across network chunks. Chinese text and emoji no longer become replacement characters in tool arguments; the typewriter effect remains enabled.
- **Validated argument suffixes.** Responses only appends the untransmitted suffix when a final argument snapshot matches the exact prefix already sent. Conflicting snapshots and post-close argument fragments fail explicitly and retain diagnostic evidence instead of corrupting JSON with extra trailing characters.

## What's New in 3.2.66

- **Extension identity on upstream requests.** Chat, model-list and standalone compaction requests now include `claude-code-config-helper/3.2.66` in `User-Agent`. Existing CLI or custom UA values are retained, with the extension identifier appended once; requests without a UA receive the extension identifier alone.
- **Version follows the installed package.** The identifier reads its name/version from the root `package.json`, including inside the VSIX. Future version bumps no longer require a separate UA change.

## What's New in 3.2.65

- **Workspace reasoning effort, without CLI restarts.** A selector beside the task-flow model offers Auto, Low, Medium, High and XHigh. It saves `claudeCodeConfigHelper.chat.reasoningEffort` to workspace settings and is read on each request. Auto adds no override, preserving existing client/model handling; explicit selections apply to subsequent requests only and take priority over the model-level reasoning policy.
- **Protocol-aware parameters.** OpenAI Chat sends `reasoning_effort`; Responses sends `reasoning.effort`; Anthropic sends `output_config.effort`, with XHigh mapped to `max`. The selected level must be supported by the upstream model or the upstream may reject the request.
- **Seven-language controls.** Options, tooltips, accessibility labels and save-failure notifications follow English, Simplified Chinese, Traditional Chinese, Korean, Japanese, French or German. Protocol values remain `auto`, `low`, `medium`, `high` and `xhigh` regardless of display language.
- **Date-organized debug records.** Compaction request snapshots and optional daily message logs are written to `.LLSOAI/chat/YYYY-MM-DD/`; upstream error snapshots go to `.LLSOAI/error/YYYY-MM-DD/`. Directories are created automatically using the local date. The error snapshot limit remains 20 files across all date directories. Existing files are not migrated, and session/configuration files stay in their original locations.

## What's New in 3.2.59

- **Auto-compaction waits for the CLI turn to finish.** Crossing the token threshold queues compaction without writing `/compact` during a tool loop. The command is sent after an explicit CLI `result`, preventing it from being absorbed as a mid-turn prompt. Pending compaction continues to hold new sends; relay request endings and `message_stop` do not release the command.

## What's New in 3.2.58

- **Task-flow repeat-update guidance.** The service remembers the latest task ID and status across continuation turns. No-op updates now report that nothing changed instead of claiming progress. Consecutive identical updates add a continuation reminder naming the next actionable task and requiring actual work before another status update. Legitimate transitions for the same task remain allowed, unfinished work is not skipped, and creating or clearing a workflow resets the in-memory record.

## What's New in 3.2.57

- **Accurate compaction status.** Automatic compaction no longer shows “compacting” merely because `/compact` was queued. The indicator starts when the CLI reports compaction or the relay detects the summary request. Resetting compaction state also clears the UI and releases waiting senders. The existing 30-minute stale-marker window and 60-minute send-wait cap are unchanged.

## What's New in 3.2.56

- **Patient compaction wait.** Queued sends now keep waiting while a compaction is genuinely running (re-checked every minute, 60-minute cap) instead of giving up after 3 minutes, so slow compaction models no longer get raced by task-flow continuations.

## What's New in 3.2.55

- **Sends wait for compaction.** Task-flow continuation, self-healing resends and timeout Continues now hold until an in-flight compaction finishes instead of racing the summary request. Stale in-flight markers are reset automatically so nothing gets stuck.

## What's New in 3.2.54

- **Fewer spurious restarts.** The self-healing watchdog now waits 120 seconds (was 20) for the CLI to reach the relay after you send a message before restarting and resending.

## What's New in 3.2.53

- **Auto compact switch.** A new toggle next to Subagents under the input box (backed by `chat.autoCompact.enabled`, default off) makes the extension send `/compact` automatically when the session's real context usage reaches the model's context length minus 50K tokens. Estimates never trigger it, in-flight compactions are respected, and a 60-second debounce avoids repeat sends. Off by default, so existing behaviour is unchanged unless you opt in.
- **No more flash-reload of the chat area.** Long sessions that exceeded the 160-message in-memory window caused every panel open (task-flow continuation, sending a message) to rebuild the whole message list and scroll top-to-bottom. The webview now stays in sync with the trimmed list and appends incrementally, so the view keeps its position.

## What's New in 3.2.52

- **Compaction model routing works with Claude CLI 2.1.260+.** Newer CLI builds append a `role: "system"` reminder after the `/compact` summary request, so the summary prompt is no longer the last message in the request. The relay now skips trailing system messages when detecting compaction, so `/compact` reaches the configured compaction model again, compaction snapshots are written and the token meter's in-flight state arms as expected. Older CLI versions are unaffected.

## What's New in 3.2.51

- **Model-level Explicit Prompt Cache** is available in the Add/Edit Model dialog for compatible OpenAI Chat and Responses gateways. It defaults to off, survives model refreshes and config import/export, and takes priority over the saved cache mode while enabled. Anthropic providers retain the saved value but cannot activate it.
- **Protocol-specific caching:** Chat uses the session ID as `prompt_cache_key`, explicit 30-minute options and a system-message breakpoint; Responses uses `instructions` plus the key/options, without `cache_control` breakpoints. Upstream support is required, and missing session IDs or static prefixes skip cache injection.
- **Low cache-hit guidance:** usage footers below 80% show an underlined Solution link. The localized dialog explains how to enable caching and includes an Open extension settings link directly to provider/model configuration. No model-specific gateway warning is shown.
- **Provider settings guidance** now explains that fetching models or changing provider/model settings takes effect immediately in the current workspace; other workspaces need a window reload or close/reopen. All new guidance supports seven languages.
- **Responses usage normalization** now shares one non-negative calculation for JSON and SSE responses. Cache-write mapping remains deferred until its accounting semantics can be verified; cache-read tokens are counted only once.

## What's New in 3.2.50

- **A localized Subagents switch now appears after the footer token meter.** Its label and tooltip support all seven interface languages, including Simplified Chinese.
- **The switch defaults to off and is saved per workspace** using extension `workspaceState`, not global settings. Each workspace keeps its own choice across reloads; legacy global values are not inherited.
- **Off removes `Agent`, `SendMessage` and `ListAgents` from every subsequent Relay request's `tools` list; on preserves them.** This applies to ordinary chat, task-flow creation/execution and title-generation side requests across all three protocol adapters. The existing task-flow `AskUserQuestion` rule is unchanged. Changing the switch does not stop agents already running or disable other orchestration entry points such as `Workflow`.

## What's New in 3.2.49

- **The footer token meter now reflects the latest completed response without changing when a new message is sent.** The previous confirmed snapshot stays visible while the response is pending, then input, output, cache-write and cache-read values are replaced atomically when new usage arrives. Cache-read tokens are included in context usage, and stale cache-write values can no longer leak across responses.
- **Long-running tool heartbeats no longer create empty waiting cards.** `tool_progress` events marked as heartbeats are ignored for both Bash and Agent tools.
- **Nested Agent results no longer create rows of orphaned `tool_result` success cards.** Results that have no matching tool call in the main conversation are hidden, while paired and top-level results still render normally.

## What's New in 3.2.48

- **Switching sessions can no longer race the next message send.** VS Code does not await one Webview message handler before dispatching the next, so `session/resume` could still be loading history and restarting the CLI when `user/send` wrote to the old or temporarily-cleared process. Session-changing Webview operations now run in arrival order; cancel and question-answer messages remain immediate.
- **Concurrent CLI start/restart requests are serialized.** Session switching, model switching, auto-continue and self-healing can all request a restart. A shared startup queue now prevents two start flows from terminating or replacing each other's newly-created process.

## What's New in 3.2.47

- **Fixed the false "Chat CLI process is not running; cannot write to stdin" error while the CLI is actually running.** After a CLI restart (model switch, auto-continue model swap, manual restart), the old child's late `exit` event could flip the shared `childExited` flag to `true` even though the new process was already running — so the next message was rejected with "process not running". Exit events now only affect shared state when they come from the current process.
- **`send()` now waits up to 1s for a briefly-unwritable stdin instead of failing instantly** right after startup, and the rejection message now distinguishes *no process handle*, *process exited*, and *stdin never became writable*.

## What's New in 3.2.46

- **The `[claude-code:unrecognized_model]` notice no longer shows up as a red error before every request.** When you run the built-in Chat on a custom gateway (a model id the CLI does not officially know), the Claude CLI writes an internal debug line like `[claude-code:unrecognized_model] {"model":"...","query_source":"sdk"}` to stderr — and the adapter used to surface every stderr line as an error segment. Lines starting with `[claude-code:` are now treated as internal CLI diagnostics and dropped; real stderr errors still show up as before.

## What's New in 3.2.45

This release is a hardening pass over the Chat CLI, the relay server, and shutdown — no behavior changes unless something was leaking or hanging.

- **A hung Chat CLI is really killed now.** Liveness used to be judged by `child.killed`, which only reports "a signal was sent" — so after cancelling a wedged process, later input was silently written to a dead child's stdin. An explicit exit flag now gates `send()` / `cancel()`, and shutdown escalates `SIGTERM → SIGKILL` after 1.5s.
- **Reloading or closing VS Code frees the relay port immediately.** Stopping the relay waited on `server.close()`, which never returns while an SSE stream is open; existing connections are now disconnected right away.
- **Cancelling a request stops the upstream call too.** Closing the connection mid-stream used to leave the upstream request running to completion (and billing); the client disconnect is now propagated and destroy the upstream request. The deprecated `req.on('aborted')` listener, which never fired under keep-alive, was removed.
- **`deactivate()` flushes the chat session to disk** and clears auto-continue timers / pending question waiters instead of leaking them.
- **The task-flow CLI exit notice is localized in 7 languages** and degrades to a toast with a silent restart while a task flow is running, so it can no longer block the flow with a modal.
- **New `claudeCodeConfigHelper.relay.debugRecord` setting (off by default).** Relay request recording used to run unconditionally, rewriting the whole daily log per request and storing base64 images; it is now opt-in, append-only, image-stripped, and upstream error snapshots are capped at 20 files.
- **The test suite is wired to a glob instead of a hardcoded file list**, which brought three previously-skipped test files back and grew the suite from 283 to 308 tests.

## What's New in 3.2.44

- **Fixed the startup "resume task flow?" dialog popping up mid-flow.** The dialog is meant for a fresh window with an unfinished workflow on disk — but the Chat webview is lazy-loaded, so when the first thing to open it was a mid-flow auto-continue, the leftover restore flag fired the modal right on top of the running flow. The dialog is now skipped whenever the auto-continue scheduler still has pending work, and any manual continue clears the flag for good.
- **The restore dialog now has a 10-second countdown.** If nobody clicks, the Continue button counts down and auto-selects *continue*, so even a mis-timed dialog can no longer park a task flow indefinitely.
- **Switching to the task flow model resets the missing-tool strike count.** Strikes accumulated on the main model no longer carry over, so the circuit breaker can't trip right after a successful switch and silently stall auto-continue.

## What's New in 3.2.43

- **The task flow model is now used for continuation, not for creation.** Previously, starting a task flow switched the main model permanently and it was never switched back. The main model now always creates the workflow; before each auto-continue the extension checks the current model and, only when it differs, switches the main CLI to the configured task flow model and restarts it (the session is resumed with `--resume`, so context and session id are preserved). When the workflow completes or is cleared, the original main model is restored.
- The check is idempotent: no task flow model configured, or already on it, means no restart at all — a whole run restarts the CLI twice at most, and only the switching restart waits a short settle delay before the continue prompt is sent. The original model is stored in `workspaceState`, so a crash mid-flow still restores on the next activation.

## What's New in 3.2.42

- **Fixed task flow auto-continuing forever on a blocked or failed task.** The loop only stopped when every task was `completed`, yet a continue prompt was still generated when nothing was `pending` or `in_progress`, so a stuck workflow was re-pushed indefinitely. No actionable task now means no continue prompt.
- **`blocked` is gone as a writable status.** Tasks can only be `pending`, `in_progress` or `completed`. When something truly cannot be done, the model is instructed to append the reason to `.LLSOAI/task_error.md`, mark the task completed and move on — so failures are recorded instead of stalling the workflow. Existing `.LLSOAI/task-flow.json` files containing `blocked` still load fine.

## What's New in 3.2.41

- **Assistant body text now renders as a whole block instead of line by line.** The streaming chunker used to emit every buffered line as its own markdown segment, so multi-line structures — tables, nested lists, multi-line quotes — were split across separate render roots and each row was parsed on its own (a table came out as a stack of one-cell boxes). Text deltas are now accumulated and parsed in a single pass when the content block ends.

## What's New in 3.2.40

- **Task flow guide card on an empty chat.** A brand-new conversation now opens with a card that walks you through the recommended plan-first workflow: let the main model write a plan document, add it to context with the ＋ button above the input, click `CC task flow` at the bottom of the composer, then send. It follows your configured UI language and links to the full [Task Flow usage guide](./docs/taskflow-usage-guide.md); dismiss it and it stays hidden for the session.
- **Fixed streaming long text stacking duplicate 「Long text output」 blocks.** Thinking blocks stream as full accumulated text under one stable segment id, but the collapsible long-text branch dropped its DOM node instead of returning it, so the id was never stamped and each delta appended yet another collapsed block. Long text is now patched in place, and a block you expanded stays open while it keeps growing.
- **Task flow model replaces the expert / plan / review modes.** The model picker is now a three-way **Normal / Task flow / Compaction** choice. A task-flow prompt can switch the main model to a dedicated model right before sending, and internal routing collapses to just `normal` and `taskFlow`.

## Highlights

- Plan-driven **Task Flow** mode: the model writes a plan document first, then drives it to completion step by step with automatic continuation, live status-bar progress, restart-safe persistence, and a circuit breaker that pauses the loop if the model stops calling tools. See [`docs/taskflow-usage-guide.md`](./docs/taskflow-usage-guide.md).
- Fixed compaction still firing at around 166k tokens after it was made manual: the Claude CLI was compacting on its own because it never saw the model's configured context length and fell back to its built-in 200k default. The context length from the model config panel is now passed to the CLI as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so the CLI and the token meter share one limit, and nothing is injected when the field is empty.
- Made context compaction **manual only**: the token budget no longer fires `/compact` by itself once a session crosses its threshold, since that competed with the CLI's own compaction and could compact a conversation still in progress. Token metering is unchanged — the meter, threshold, and per-session accounting all keep working; compaction now happens only via the compact button on the token meter or a `/compact` you type yourself.
- Fixed the built-in **`browser_*` MCP tools disappearing entirely**: the MCP server runs as a standalone Node child process without the `vscode` module, but it statically imported `browserToolHost` (which chains into `require('vscode')`), so it crashed on startup and the whole browser tool group silently vanished from the model's tool list. `BrowserToolHost` is now a type-only import, required lazily on the extension-host path.
- Added **click-to-copy inline code** in Chat: a single-backtick span (typically a one-line shell command) now shows a copy icon and copies the whole command on click, with a green confirmation flash. Also fixed multiple code blocks in one message stacking all their copy buttons in the message's top-right corner.
- Fixed context compaction running **twice in a row**: the compaction summary request is no longer re-measured against the threshold (its body is the whole conversation, so it always tripped), compaction started by the CLI or by a manually typed `/compact` now registers in-flight state so the in-progress check and 60-second debounce apply to it, and a stale in-progress flag is only reset instead of being treated as a reason to compact.
- Added **browser session persistence**: browser tools now keep you logged in across page closes and VS Code restarts. Cookies (including HttpOnly), `localStorage`, and `sessionStorage` are captured automatically once the page state settles and stored per origin in VS Code `SecretStorage`; `browser_open` re-injects them **before** navigating so the first screen's API calls are already authenticated. Cookies travel over raw CDP because Playwright's `storageState`/`addCookies` are blocked inside VS Code. Logging out on the site is recorded faithfully — the empty state overwrites the snapshot, so the next open stays logged out.
- Fixed a `browser_open` deadlock when VS Code replies "At least one similar page is already open": the page id in that listing is now parsed, instead of every following call failing with "Page not found".
- Fixed Mac Chinese (IME) Enter-to-select sending the message by mistake: when picking a candidate, macOS Pinyin commits per character and the confirming Enter arrives with `isComposing=false`, so the composer and resend editor now use an arrow-key state machine — an arrow key (paging through candidates) marks the next Enter as a candidate confirmation that does not send, and any other key resets the state so a plain Enter sends normally.
- Fixed compaction routing: `/compact` summary requests now reach the configured **compaction model** even when the Claude CLI omits the `<command-name>/compact</command-name>` marker (as happens with token-budget-triggered compaction and newer CLI versions), instead of falling back to the main model.
- Fixed the Anthropic prompt-cache **400** error (`a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`) in the built-in Chat CLI: the relay no longer force-rewrites outbound `cache_control` breakpoints to `1h`, which conflicted with `5m` breakpoints injected by an upstream gateway. The cache TTL now defaults to **Default (follow client)**, configurable through a new selector in the model-picker dialog (**Default / 5 minutes / 1 hour**) with a "switch back to Default on errors" hint, persisted in global state and applied to the relay without a reload.
- Added an in-Chat **"Skip browser confirmation"** hint after the CC task-flow button: when browser tools are usable but VS Code still prompts "Open Browser Page?" on every page, the hint offers a one-click, in-webview confirmation that enables `workbench.browser.enableChatTools` and `chat.tools.global.autoApprove` together — no blocking activation popup.
- Reworked the **browser tool suite** to call VS Code's built-in language-model browser tools via `vscode.lm.invokeTool` with page-id threading (`browser_open`, `browser_navigate`, `browser_get_content`, `browser_screenshot`, `browser_console`, `browser_eval`), exposed through the in-process `browser` MCP server.
- Added **task-flow persistence**: the CC task workflow snapshot is now cached to `.LLSOAI/task-flow.json` on every create/update, and is restored on the next VS Code launch with a "Resume unfinished task flow?" prompt so progress survives restarts.
- Added a **past conversations panel** in the Chat header: list previous sessions, resume one to reload its full message history into the webview, and the header now shows the resumed session's title.
- Replaced the Chat header **Copy source** and **Clear** buttons with a single **New chat** button that starts a fresh empty session.
- Made session list/content retrieval **Windows-compatible**: project directory names are encoded exactly like the official Claude CLI (no truncation), `CLAUDE_CONFIG_DIR` is honored, and the read path matches the CLI's write `cwd`.
- Fixed Chat model-picker refresh after adding or editing provider models: the normal, task-flow and compaction model dropdowns now update without requiring a VS Code restart.
- Anthropic direct providers no longer receive the OpenAI-style `stream_options.include_usage` request field; OpenAI-compatible streaming requests still keep usage options where supported.
- Added token budget context compression for the built-in Chat: the token meter can trigger compression, large contexts auto-trigger compression near the configured threshold, tool call/tool result blocks are removed from the summary input, and the compressed summary is injected into a fresh hidden CLI session.
- Native Claude `TodoWrite` todos now appear in a separate footer panel, independent from the CC task-flow Todo panel, so both can be shown and collapsed independently.
- Tool call cards are collapsed by default: only the summary row (icon + name + status badge + chevron) is shown; clicking the row toggles the body. Collapse state is preserved across tool status updates.
- Running state lockdown: while the chat is responding, the bottom composer controls (model select, permission mode, task-flow model select, CC task flow button) are disabled, and the comet-beam border animation stays visible even when the textarea is focused.
- Upstream CLI `system/taskstarted` and `system/tasknotification` JSON events are rendered as a compact task card (status icon + description + task type + status badge) instead of leaking raw JSON into the chat.
- Chat footer Todo card for LLS CCAI task workflows, with live status refresh and animated in-progress indicators.
- Improved LLS CCAI task menu behavior: completed workflows are cleared silently, while running workflows still require confirmation before replacement.
- Windows Claude CLI setup hints in the configuration panel, including the npm mirror install command and `%APPDATA%`-based executable path with copy buttons.
- Built-in Chat Webview backed by a long-running local Claude CLI process.
- Bidirectional stdio `stream-json` transport using `--output-format stream-json --verbose --input-format stream-json`.
- Markdown, code block, diff, tool card, error, permission fallback, and workspace file-reference rendering.
- Chat session restoration through VS Code `workspaceState`, with a one-time privacy notice and clear-session cleanup.
- Visual provider/model configuration utilities for Claude Code settings migration and compatibility.
- Secure API key storage through VS Code `SecretStorage` before activation.
- Task workflow support for planning, progress tracking, and automatic continuation.
- Import/export of provider configuration and shared prompts.
- Multi-language UI support.

## Setup and Parallel Tasks

1. Open **LLS CCAI** from the Activity Bar. When no explicit setup-completion record exists for this extension host, the same left-side view opens the setup wizard—even if an older installation already has a CLI path and providers.
2. **Language and CLI:** choose the language and installation source. Download a managed CLI or select an existing executable under Advanced options. Next verifies the selected path. Changing the download directory updates both its displayed destination and future installations; it does not move or overwrite an external CLI.
3. **Providers:** add/edit providers, save credentials, fetch models or add them manually. No paid inference test is required to proceed. Saved credentials stay in VS Code SecretStorage; the optional `*ABCD` key hint is generated only when a key longer than four characters is saved. Existing providers without a hint still show Saved key.
4. **Workspace models:** choose the Normal model, optional Task flow/Compaction models and reasoning effort. Finish saves the explicit completion record, replaces the wizard with settings in the same view and opens the right-side main chat. It does not send a message automatically.
5. Use **Check for updates** on the CLI version card for later updates. Merely checking or cancelling does not restart sessions. Accepting an update authorizes switching to its verified executable and restarting active extension-owned CLIs; interrupted work must be reviewed and resumed explicitly. Detached/remote processes can keep running.
6. Use the main chat's **Parallel session** button or native title-bar **＋** to open the left independent conversation directly. It reuses the active left session, otherwise restores its saved selection or earliest history; without history it creates one conversation. No intermediate list or editor tab is opened.
7. The left conversation initially copies the main chat's saved settings and then keeps its own models, reasoning, permissions, history and usage. Opening settings or hiding its view does not stop its task. The left native toolbar provides Edit title, Settings and Restart CLI, without a plus; restarting one side does not restart the other.

Independent conversation checkpoints remain under `<workspace>/.LLSOAI/editor-sessions/<conversationId>/`; the main chat retains its existing `.LLSOAI/chat-session.json` CLI identity. Each chat's **Conversation list** button opens native CLI histories for that conversation's working directory and CLI configuration; selecting an entry resumes it only on that side. Parallel session and the native plus action still open the left chat directly. The former editor multi-session implementation, saved histories and serializer are preserved, but its creation/history commands remain hidden from the usual UI. Restoring a conversation never resends its previous prompt.

Full development notes: [onboarding and CLI management](docs/onboarding-cli-install-left-chat-plan.md) and [independent editor sessions](docs/editor-chat-multi-session-plan.md).

## Task Flow Mode

Task Flow turns the built-in Chat into a plan-driven, self-continuing agent. Instead of one-shot prompts, the main model writes a plan document first, and the task-flow model then drives that plan to completion.

The recommended loop:

1. Ask the main model to write an implementation plan into a Markdown file (for example `docs/plan-x.md`). That file is the contract for everything that follows.
2. Add the plan file to context with the **＋** button in the file area above the input box (or drag it onto the chat).
3. Click **CC task flow** below the input box to insert the start prompt.
4. Send. From here the model executes each pending step and reports it back through the `update_llsccai_task_workflow` tool, while the extension keeps the loop going.

Progress is visible in the status bar (`completed/total`), the full task list opens from a QuickPick panel, and an unfinished workflow is persisted to `.LLSOAI/task-flow.json` so a VS Code restart offers to resume it. If the model keeps replying with plain text without calling any tool, a circuit breaker pauses auto-continuation instead of spamming the CLI.

A dedicated task-flow model can be picked by clicking either model chip in the composer or in setup step 3. It is saved only for the current workspace under `claudeCodeConfigHelper.chat.taskFlow.model`; leave it unset to reuse the normal model. `claudeCodeConfigHelper.taskFlow.target` chooses where task-flow prompts go — `builtinChat` or `externalClaudeCode`.

Full walkthrough: [`docs/taskflow-usage-guide.md`](./docs/taskflow-usage-guide.md).

## Model Roles

The model picker exposes three roles, accessible from either model chip in the composer; setup step 3 also configures these roles:

| Role | Setting | Used for |
| --- | --- | --- |
| Normal | `claudeCodeConfigHelper.chat.currentModel` | Everyday chat. |
| Task flow | `claudeCodeConfigHelper.chat.taskFlow.model` | Swapped in right before a task-flow prompt is sent; falls back to Normal when unset. |
| Compaction | `claudeCodeConfigHelper.chat.compactionMode.*` | The `/compact` summary request. |

This replaces the older on-demand expert / plan / review routing. The `chat.expertMode`, `chat.planMode`, `chat.reviewMode` and `chat.expert*` keys are no longer registered; if they linger in your `settings.json` they simply show up as unknown settings and can be deleted.

## Built-in Chat and Claude CLI Transport

The extension now uses an independent Chat Webview backed directly by the local Claude CLI. The detailed implementation plan and migration notes live in [`CHAT_WEBVIEW_PLAN.md`](./CHAT_WEBVIEW_PLAN.md).

The CLI communication findings used for this implementation are:

- The current verified Homebrew cask is `claude-code 2.1.141`.
- The cask exposes the executable as `/opt/homebrew/bin/claude`.
- If the direct Homebrew download is slow or blocked, the CLI can be installed through a local proxy, for example:

   ```bash
   HTTP_PROXY=http://127.0.0.1:3080 \
   HTTPS_PROXY=http://127.0.0.1:3080 \
   ALL_PROXY=http://127.0.0.1:3080 \
   http_proxy=http://127.0.0.1:3080 \
   https_proxy=http://127.0.0.1:3080 \
   all_proxy=http://127.0.0.1:3080 \
   HOMEBREW_NO_AUTO_UPDATE=1 \
   brew install --cask --verbose claude-code
   ```

- `claude --help` confirms `-p/--print`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--replay-user-messages`, and `--include-partial-messages` are available.
- After local Claude CLI authentication, real model-output probes succeeded for `text`, `json`, `stream-json`, and stdin text input.
- The official Claude Code VS Code extension `2.1.144` starts its native UI CLI process with `--output-format stream-json --verbose --input-format stream-json` over stdio pipes.
- Based on that finding, the Chat Webview primary transport is **long-running stdio with bidirectional `stream-json` JSON Lines**. `-p/--print` is retained only for single-shot probes and fallback behavior, while PTY remains an experimental last resort.
- The installed CLI exposes the same `stream-json` input/output flags needed for that long-running process, so this extension follows the official extension package's SDK-style stdio stream design.
- Do not enter tokens, passwords, or API keys through automation; complete authentication directly in the user's terminal.

The previous built-in HTTP relay module has been removed. During activation, the extension performs best-effort cleanup of legacy managed Claude Code settings such as local `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` entries that were created by older versions.

## Managed Claude Code Environment Variables

When you activate a provider/model configuration, the extension writes the required Claude Code settings through the official VS Code Configuration API:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_CUSTOM_HEADERS`
- `CLAUDE_CODE_SKIP_AUTH_LOGIN`

The extension marks managed entries with `__CLAUDE_ROUTER_MANAGED__` so that it can safely replace only its own environment variables during future activations.

## Commands

Available commands include:

- `LLS CCAI: Open Help` (`claudeRouter.help.open`) — opens https://www.zhineng.dev/ directly in the system browser.
- `Claude Code Config: Open Config Panel`
- `Claude Code Config: Open settings.json`
- `Claude Code Config: Open Global Shared Settings`
- `Claude Code Config: Open Workspace Shared Settings`
- `Claude Code Config: Open Built-in Chat`
- `Claude Code Config: Select Claude CLI for Built-in Chat`
- `Claude Code Config: Restart Built-in Chat CLI`
- `Claude Code Config: Reload Window`
- `Claude Code Config: New Provider`
- `Claude Code Config: Refresh Providers`
- `Claude Code Config: Set Current Model`
- `Claude Code Config: Clear Current Model`
- `Claude Code Config: Export Config`
- `Claude Code Config: Import Config`
- `Claude Code Config: Paste Task Flow to Claude`
- `Claude Code Config: LLS CCAI Task Menu`
- `Claude Code Config: Show Task Progress`
- `Claude Code Config: Continue Task`
- `Claude Code Config: Clear Task`

Command titles may be localized according to your configured UI language.

## Installation

### Option 1: Install from a local VSIX

Install the packaged `claude-code-config-helper-3.2.80.vsix` using VS Code's **Extensions → … → Install from VSIX…** action. Reload the window when ready to activate the installed build; reload interrupts currently running extension CLIs. To build a package yourself, install the repository dependencies, run `npm run compile`, then package with `@vscode/vsce`.

### CLI installation through setup

The first setup step can download and verify the native CLI without a global npm install. Official npm is the default; **China mirror · npmmirror** is an opt-in third-party source whose releases may lag the official registry. The selected extension host determines the platform and architecture, including Remote SSH/WSL/container hosts—not the desktop UI machine.

Managed executables use `<download directory>/claude-<version>` or `claude-<version>.exe`. The installer never overwrites the old executable or an external installation. You can instead select an existing executable in Advanced options and validate it. Source URLs, redirects, archive entries, package integrity and the reported CLI version are checked; SHA512 integrity is not an independent publisher signature.

### Option 2: Run in development mode

1. Open this repository in VS Code.
2. Press `F5` to start the Extension Development Host.
3. In the new VS Code window, open the Command Palette and run the extension commands.

## Basic Usage

1. Open **LLS CCAI** from the Activity Bar, or run **LLS CCAI: Open LLS CCAI Setting** from the Command Palette.
2. If installation is incomplete, finish **Language and CLI → Providers → Workspace models** in the same view. Existing users without a completion record also follow this flow; an already-installed CLI can be reused without downloading it again.
3. Add or edit a provider with its name, Base URL, API type (`anthropic`, `openai-compatible` or `v1-response`), authentication mode (`auth_token`, `api_key` or `none`) and key/token. Fetch the model list where supported, or add models manually.
4. Choose the normal model, optional task-flow and compaction models, and reasoning effort in step 3 or through the model chips in chat. Provider credentials remain shared; independent conversations retain their own saved model selections.
5. Send a message from the right main chat, or open the independent left conversation with **Parallel session** or the title-bar **＋**. Use **Restart CLI** for that conversation's restart-with-progress flow; it keeps history and never replays the last task.

The left settings view contains a compact CLI version/update card and full provider/model management. It does not require a reload for every edit; reload other workspaces when their shared-provider data needs refreshing. Upstream authentication and feature support still depend on the configured provider.

### Fetching models keeps your local settings

**Fetch Models** calls the provider's `GET {baseUrl}/models`, which normally returns
nothing but model ids. The upstream list decides which models exist, but it no longer
resets how they are configured:

- **Models still offered upstream keep every locally configured field** — display
  name, context length, max tokens, vision, tool calling, temperature, top_p,
  sampling mode, selectable, transform-think and preserve-reasoning are never reset
  by a fetch. The upstream display name is adopted only if you never renamed the model.
- **Models the upstream stopped returning are removed**, and if the removed model was
  your active selection the current model is cleared.
- **New ids are appended**, sorted by id, after your existing entries.

The success toast reports the outcome as
`Fetched N models: added A, preserved K existing configurations, removed R` (localized to the selected interface language).

## Built-in Chat Flow

When the built-in Chat is enabled and opened:

1. The extension resolves the configured or selected Claude-compatible CLI executable.
2. The extension starts a long-running process with `--output-format stream-json --verbose --input-format stream-json`.
3. User messages from the Webview are sent to CLI stdin as JSON Lines.
4. CLI stdout/stderr JSON Lines are parsed into Chat segments.
5. The Webview renders streaming markdown, code, diff, file references, tool cards, and errors.
6. Recent Chat messages are restored from VS Code `workspaceState` for the current workspace until the user clears the session.

## Context Compression

The built-in Chat tracks token usage against the selected model's configured context length. When the context approaches the compression threshold, or when the user clicks the token meter compression action, the extension sends an internal `@llsccai-summ` trigger through the CLI so relay receives the current conversation context.

The relay intercepts that trigger and runs a non-streaming summary request with a compacted single user message. Tool call and tool result blocks are removed from the summary input, keeping the generated summary focused on user goals, assistant decisions, touched files, constraints, and remaining work. After summary generation, the extension clears `.LLSOAI/chat-session.json`, restarts the CLI into a fresh session, and injects the compressed context internally without showing that seed message in the Chat transcript.

## Task Workflow Support

The extension includes an LLS CCAI task workflow system designed for long-running development tasks.

Task workflows help the model:

- Create a structured task plan from a larger user request.
- Track progress with task states such as pending, in progress, completed, and blocked.
- Continue unfinished work through the built-in Chat send chain or the legacy external-Claude clipboard path.
- Avoid exposing internal workflow tools directly to Claude Code as normal user-facing tools.
- Intercept local workflow tool calls such as creating or updating the workflow.
- Schedule automatic continuation when the model needs another turn to finish the task.

Typical workflow commands include:

- `Claude Code Config: Paste Task Flow to Claude`
- `Claude Code Config: LLS CCAI Task Menu`
- `Claude Code Config: Show Task Progress`
- `Claude Code Config: Continue Task`
- `Claude Code Config: Clear Task`

The Chat host injects workflow instructions and tools only when a workflow is active or when task creation is explicitly triggered. Workflow updates can be intercepted locally so that task progress is reflected in VS Code without requiring the model to execute external side effects.


## Shared Prompts

The extension supports global and workspace-level shared prompt settings. Shared prompts can be used to provide consistent system-level guidance across Claude Code sessions.

You can open these settings with:

- `Claude Code Config: Open Global Shared Settings`
- `Claude Code Config: Open Workspace Shared Settings`

## Import and Export

Use the import/export commands to move provider configuration and shared prompt data between environments:

- `Claude Code Config: Export Config`
- `Claude Code Config: Import Config`

Secrets are handled separately through VS Code `SecretStorage` and should be reviewed carefully when moving between machines.

## Security Notes

> **Activated tokens appear in VS Code settings.**
>
> Claude Code reads configuration from environment variables. Once a provider is activated, the selected token or API key must be written into Claude Code environment settings so that Claude Code can use it.

> **Inactive provider secrets are stored securely.**
>
> Before activation, provider tokens are stored in VS Code `SecretStorage`, backed by macOS Keychain, Windows Credential Manager, or Linux libsecret depending on your platform.

> **Managed settings should not be edited manually.**
>
> Environment variables placed after the `__CLAUDE_ROUTER_MANAGED__` marker are managed by this extension and may be replaced on the next activation. Put manually maintained variables outside the managed block.

> **Reload may be required after switching models or providers.**
>
> Claude Code reads environment variables when its process starts. Reloading the VS Code window ensures the new configuration is used immediately.

## Development

Useful development commands:

```bash
npm install
npm run typecheck
npm run compile
```

Run selected lightweight tests after compiling:

```bash
npm test
```

### Built-in MCP bridges

The extension ships three built-in MCP servers — `llsccaiBrowser`, `llsccaiVscode` and `llsccaiWakeup` — that the Claude CLI launches as Node subprocesses. Those subprocesses have no `vscode` runtime, so tool calls are forwarded over HTTP to a relay inside the extension host.

Their shared machinery (stdio JSON-RPC server, HTTP relay handler, tool-name guards, CLI injection and startup logging) lives in `src/mcpKit/`. Each bridge only declares a descriptor — server name, HTTP path, relay port environment variable and tool schemas — in its own `bridge.ts`.

Anything under `src/mcpKit/` is loaded by those subprocesses, so it may only statically import Node built-ins and `import type`. Importing `vscode` or any extension-host module there makes the subprocess crash at startup and the whole tool group vanish from the model's view with no visible error; `src/mcpKit/__tests__/noHostImports.test.ts` fails the build if that happens.

## Repository

GitHub: <https://github.com/liliangshan/claude-code-config-helper.git>

## License

MIT
