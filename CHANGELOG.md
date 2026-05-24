# Changelog

All notable changes to this extension are documented in this file.

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
