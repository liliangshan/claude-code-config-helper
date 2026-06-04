# Changelog

All notable changes to this extension are documented in this file.

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
