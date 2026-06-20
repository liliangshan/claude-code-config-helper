# Claude Code Config Helper

**Version:** 3.2.9

Claude Code Config Helper is a VS Code extension for enhancing Claude Code workflows inside VS Code. It provides a built-in Chat Webview backed by the local Claude CLI, provider/model configuration utilities, task workflow assistance, shared prompts, and VS Code diagnostics injection for model-assisted development.

## Highlights

- Fixed Mac Chinese (IME) Enter-to-select sending the message by mistake: when picking a candidate, macOS Pinyin commits per character and the confirming Enter arrives with `isComposing=false`, so the composer and resend editor now use an arrow-key state machine — an arrow key (paging through candidates) marks the next Enter as a candidate confirmation that does not send, and any other key resets the state so a plain Enter sends normally.
- Fixed compaction routing: `/compact` summary requests now reach the configured **compaction model** even when the Claude CLI omits the `<command-name>/compact</command-name>` marker (as happens with token-budget-triggered compaction and newer CLI versions), instead of falling back to the main model.
- Fixed the Anthropic prompt-cache **400** error (`a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`) in the built-in Chat CLI: the relay no longer force-rewrites outbound `cache_control` breakpoints to `1h`, which conflicted with `5m` breakpoints injected by an upstream gateway. The cache TTL now defaults to **Default (follow client)**, configurable through a new selector in the model-picker dialog (**Default / 5 minutes / 1 hour**) with a "switch back to Default on errors" hint, persisted in global state and applied to the relay without a reload.
- Added an in-Chat **"Skip browser confirmation"** hint after the CC task-flow button: when browser tools are usable but VS Code still prompts "Open Browser Page?" on every page, the hint offers a one-click, in-webview confirmation that enables `workbench.browser.enableChatTools` and `chat.tools.global.autoApprove` together — no blocking activation popup.
- Reworked the **browser tool suite** to call VS Code's built-in language-model browser tools via `vscode.lm.invokeTool` with page-id threading (`browser_open`, `browser_navigate`, `browser_get_content`, `browser_screenshot`, `browser_console`, `browser_eval`), exposed through the in-process `browser` MCP server.
- Added **task-flow persistence**: the CC task workflow snapshot is now cached to `.LLSOAI/task-flow.json` on every create/update, and is restored on the next VS Code launch with a "Resume unfinished task flow?" prompt so progress survives restarts.
- Added a **past conversations panel** in the Chat header: list previous sessions, resume one to reload its full message history into the webview, and the header now shows the resumed session's title.
- Replaced the Chat header **Copy source** and **Clear** buttons with a single **New chat** button that starts a fresh empty session.
- Made session list/content retrieval **Windows-compatible**: project directory names are encoded exactly like the official Claude CLI (no truncation), `CLAUDE_CONFIG_DIR` is honored, and the read path matches the CLI's write `cwd`.
- Fixed Chat model-picker refresh after adding or editing provider models: normal, expert, plan, review, and compaction model dropdowns now update without requiring a VS Code restart.
- Anthropic direct providers no longer receive the OpenAI-style `stream_options.include_usage` request field; OpenAI-compatible streaming requests still keep usage options where supported.
- Added token budget context compression for the built-in Chat: the token meter can trigger compression, large contexts auto-trigger compression near the configured threshold, tool call/tool result blocks are removed from the summary input, and the compressed summary is injected into a fresh hidden CLI session.
- Native Claude `TodoWrite` todos now appear in a separate footer panel, independent from the CC task-flow Todo panel, so both can be shown and collapsed independently.
- Tool call cards are collapsed by default: only the summary row (icon + name + status badge + chevron) is shown; clicking the row toggles the body. Collapse state is preserved across tool status updates.
- Running state lockdown: while the chat is responding, the bottom composer controls (model select, permission mode, expert model select, CC task flow button) are disabled, and the comet-beam border animation stays visible even when the textarea is focused.
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

## On-Demand Expert (v2.1.0+)

The built-in Chat now runs a **single** long-lived Claude CLI that handles everything by default. A separate expert model is only invoked **on demand**, with no expert CLI kept resident:

- When an expert task model is configured, the main CLI is given an `ask_expert` MCP tool. The main model decides on its own whether to delegate — typically for a non-trivial architecture trade-off, an unfamiliar high-blast-radius subsystem, or when the user explicitly asks for the expert.
- The expert sub-turn starts a **fresh request with no conversation history**: it receives only the self-contained `question` plus a read-only tool whitelist (`read_file`, `grep_search`, `get_errors`). Its result is returned to the main model as a `tool_result`, so the dispatcher writes the final reply.
- Users can force the expert directly by prefixing a message with `@llsExpert …` or `/expert …`; the prefix is stripped before the question is sent. `chat.expert.userTriggerMode` controls whether that answer is shown directly (`direct`) or written back to the main CLI as a `tool_result`.
- The whole expert sub-turn (its tool calls and final conclusion) streams into the Chat panel as an expert card, but never enters the main conversation context.

The Chat header shows `Normal: <main model> · Expert: <expert model / Not configured>`. There is **no route badge** anymore — routing decisions are made by the model via `ask_expert`, not by an in-extension route state.

Pick both models from the header model bar's gear button. User-overridable system prompts are exposed as `claudeCodeConfigHelper.chat.dispatcher.appendSystemPrompt` and `claudeCodeConfigHelper.chat.expert.appendSystemPrompt`; leaving either blank uses the built-in default. Sub-turn limits are tunable via `chat.expert.maxSteps`, `chat.expert.stepTimeoutMs`, `chat.expert.totalTimeoutMs`, and `chat.expert.maxCallsPerTurn`. Design and migration notes live in [`EXPERT_ON_DEMAND_PLAN.md`](./EXPERT_ON_DEMAND_PLAN.md).

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

```bash
npm install
npm run compile
npx @vscode/vsce package
code --install-extension claude-code-config-helper-2.0.0.vsix
```

### Windows Claude CLI install hint

On Windows, the configuration panel can show and copy a Claude CLI npm install command:

```powershell
npm install -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com/
```

When the extension host is running on Windows, the panel also builds the common Claude CLI executable path from the host `%APPDATA%` environment variable, for example:

```text
C:\Users\lls\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
```

Use the copy button next to the path if you need to paste it into the built-in Chat CLI path setting.

### Option 2: Run in development mode

1. Open this repository in VS Code.
2. Press `F5` to start the Extension Development Host.
3. In the new VS Code window, open the Command Palette and run the extension commands.

## Basic Usage

1. Open the Command Palette with `Cmd/Ctrl+Shift+P`.
2. Run `Claude Code Config: Open Config Panel`.
3. Create or edit a provider:
   - **Name**: A display name for the provider.
   - **Base URL**: The upstream endpoint root.
   - **API Type**: `anthropic`, `openai-compatible`, or `v1-response`.
   - **Auth Mode**:
     - `auth_token`: writes `ANTHROPIC_AUTH_TOKEN` for Claude Code.
     - `api_key`: writes `ANTHROPIC_API_KEY` for Claude Code.
     - `none`: writes no authentication secret.
   - **Custom Headers**: Optional headers, one `Key: Value` pair per line.
   - **Models**: Add models manually or fetch them from the provider when supported.
4. Select a model and activate the configuration.
5. Reload the VS Code window when prompted so Claude Code can pick up the new environment variables.

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

## Repository

GitHub: <https://github.com/liliangshan/claude-code-config-helper.git>

## License

MIT
