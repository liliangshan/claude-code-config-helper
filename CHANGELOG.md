# Changelog

All notable changes to this extension are documented in this file.

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
