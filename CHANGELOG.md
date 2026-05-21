# Changelog

All notable changes to this extension are documented in this file.

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
