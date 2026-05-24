# Claude Code Config Helper

**Version:** 2.0.0

Claude Code Config Helper is a VS Code extension for enhancing Claude Code workflows inside VS Code. It provides a built-in Chat Webview backed by the local Claude CLI, provider/model configuration utilities, task workflow assistance, shared prompts, and VS Code diagnostics injection for model-assisted development.

## Highlights

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
- VS Code Problems diagnostics retrieval for model-assisted error fixing.
- Import/export of provider configuration and shared prompts.
- Multi-language UI support.

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

## VS Code Diagnostics Retrieval

The extension can expose current VS Code Problems diagnostics to the model through the internal diagnostics tool:

```text
get_llsccai_vscode_diagnostics
```

This helps the model fix real editor errors instead of guessing from stale build output.

The diagnostics flow is designed to be safe and explicit:

1. The model requests diagnostics through the internal tool.
2. The extension returns an acknowledgement and schedules an automatic continuation.
3. On the next Chat turn, the request contains the trigger token:

   ```text
   @llsccai-get-errors
   ```

4. The Chat host scans the user messages for that trigger token.
5. The Chat host injects the latest VS Code Problems diagnostics into that user message before sending it to the CLI.

The tool instruction itself is injected as a system rule, not as normal user content. Only the actual diagnostics result is added to the next user turn when the trigger token is present.

Diagnostics may include:

- File path.
- Line and column.
- Severity.
- Source.
- Error or warning message.
- Related information when available.

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
