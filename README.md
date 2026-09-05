# Claude Code Config Helper

**Version:** 3.2.51

Claude Code Config Helper is a VS Code extension for enhancing Claude Code workflows inside VS Code. It provides a built-in Chat Webview backed by the local Claude CLI, provider/model configuration utilities, task workflow assistance, shared prompts, and VS Code diagnostics injection for model-assisted development.

## What's New in 3.2.51

- **Model-level Explicit Prompt Cache** is available in the Add/Edit Model dialog for compatible OpenAI Chat and Responses gateways. It defaults to off, survives model refreshes and config import/export, and takes priority over the saved cache mode while enabled. Anthropic providers retain the saved value but cannot activate it.
- **Protocol-specific caching:** Chat uses the session ID as `prompt_cache_key`, explicit 30-minute options and a system-message breakpoint; Responses uses `instructions` plus the key/options, without `cache_control` breakpoints. Upstream support is required, and missing session IDs or static prefixes skip cache injection.
- **Low cache-hit guidance:** usage footers below 80% show an underlined Solution link. The localized dialog explains how to enable caching and includes an Open extension settings link directly to provider/model configuration. No model-specific gateway warning is shown.
- **Provider settings guidance** now explains that fetching models or changing provider/model settings takes effect immediately in the current workspace; other workspaces need a window reload or close/reopen. All new guidance supports seven languages.
- **Responses usage normalization** now shares one non-negative calculation for JSON and SSE responses. Cache-write mapping remains deferred until its accounting semantics can be verified; cache-read tokens are counted only once.

## What's New in 3.2.50

- **A localized Subagents switch now appears after the footer token meter.** Its label and tooltip support all seven interface languages, including “子智能体” in Simplified Chinese.
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

- **Fixed the false "Chat CLI 进程未运行，无法写入 stdin" error while the CLI is actually running.** After a CLI restart (model switch, auto-continue model swap, manual restart), the old child's late `exit` event could flip the shared `childExited` flag to `true` even though the new process was already running — so the next message was rejected with "process not running". Exit events now only affect shared state when they come from the current process.
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

## Task Flow Mode

Task Flow turns the built-in Chat into a plan-driven, self-continuing agent. Instead of one-shot prompts, the main model writes a plan document first, and the task-flow model then drives that plan to completion.

The recommended loop:

1. Ask the main model to write an implementation plan into a Markdown file (for example `docs/plan-x.md`). That file is the contract for everything that follows.
2. Add the plan file to context with the **＋** button in the file area above the input box (or drag it onto the chat).
3. Click **CC task flow** below the input box to insert the start prompt.
4. Send. From here the model executes each pending step and reports it back through the `update_llsccai_task_workflow` tool, while the extension keeps the loop going.

Progress is visible in the status bar (`completed/total`), the full task list opens from a QuickPick panel, and an unfinished workflow is persisted to `.LLSOAI/task-flow.json` so a VS Code restart offers to resume it. If the model keeps replying with plain text without calling any tool, a circuit breaker pauses auto-continuation instead of spamming the CLI.

A dedicated task-flow model can be picked from the model bar's gear button and is persisted under `claudeCodeConfigHelper.chat.taskFlow.model` (workspace value first, global as fallback); leave it unset to reuse the normal model. `claudeCodeConfigHelper.taskFlow.target` chooses where task-flow prompts go — `builtinChat` (default) or `externalClaudeCode`.

Full walkthrough: [`docs/taskflow-usage-guide.md`](./docs/taskflow-usage-guide.md).

## Model Roles

The model picker exposes three roles, all switchable from the header gear button or by clicking either model chip in the composer:

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
code --install-extension claude-code-config-helper-3.2.48.vsix
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
`已拉取 N 个模型：新增 A，保留原有配置 K，移除 R`.

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
