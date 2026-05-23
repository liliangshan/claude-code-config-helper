# Changelog

All notable changes to this extension are documented in this file.

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
