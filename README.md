# Claude Code Config Helper

**Version:** 0.1.4

Claude Code Config Helper is a VS Code extension for managing, routing, and enhancing the official Anthropic Claude Code extension. It provides a visual configuration panel, a local relay server, provider/model management, task workflow assistance, and VS Code diagnostics injection for Claude Code sessions.

## Highlights

- Visual provider and model configuration for Claude Code.
- One-click activation of Claude Code environment variables.
- Local relay server for routing Claude Code `/v1/messages` requests.
- Support for Anthropic-compatible, OpenAI Chat Completions-compatible, and OpenAI Responses-compatible upstream APIs.
- The relay normalizes Claude Code built-in tool schemas for OpenAI-compatible upstreams so `Read`, `Write`, and `Agent` calls avoid provider-induced invalid arguments.
- Secure API key storage through VS Code `SecretStorage` before activation.
- Task workflow support for planning, progress tracking, and automatic continuation.
- VS Code Problems diagnostics retrieval for model-assisted error fixing.
- Import/export of provider configuration and shared prompts.
- Multi-language UI support.

## Supported Upstream API Types

The extension can route Claude Code requests through the local relay and forward them to different upstream protocol types:

| API Type | Description | Forwarding Target |
| --- | --- | --- |
| `anthropic` | Anthropic Messages API compatible upstreams. | `{baseUrl}/messages` |
| `openai-compatible` | OpenAI Chat Completions compatible upstreams. | `{baseUrl}/chat/completions` |
| `v1-response` | OpenAI Responses API compatible upstreams. | `{baseUrl}/responses` |

For `v1-response`, the relay converts Anthropic Messages requests to OpenAI Responses requests and converts JSON/SSE Responses output back to Anthropic-compatible responses for Claude Code.

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
- `Claude Code Config: Restart Relay`
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
code --install-extension claude-code-config-helper-0.1.4.vsix
```

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

## Provider Routing Flow

After activation, Claude Code talks to the local relay instead of the remote upstream directly:

1. Claude Code sends an Anthropic `/v1/messages` request to the local relay.
2. The relay resolves the selected provider and model.
3. The relay rewrites the model ID and injects task/diagnostics tools when needed.
4. The relay converts the request if the upstream is OpenAI-compatible or Responses-compatible.
5. The relay forwards the request to the upstream service.
6. The relay converts the upstream response back to Anthropic format when required.
7. Claude Code receives a normal Anthropic-compatible response.

## Task Workflow Support

The extension includes an LLS CCAI task workflow system designed for long-running development tasks.

Task workflows help the model:

- Create a structured task plan from a larger user request.
- Track progress with task states such as pending, in progress, completed, and blocked.
- Continue unfinished work across relay turns.
- Avoid exposing internal workflow tools directly to Claude Code as normal user-facing tools.
- Intercept local workflow tool calls such as creating or updating the workflow.
- Schedule automatic continuation when the model needs another turn to finish the task.

Typical workflow commands include:

- `Claude Code Config: Paste Task Flow to Claude`
- `Claude Code Config: LLS CCAI Task Menu`
- `Claude Code Config: Show Task Progress`
- `Claude Code Config: Continue Task`
- `Claude Code Config: Clear Task`

The relay injects workflow instructions and tools only when a workflow is active or when task creation is explicitly triggered. Workflow updates can be intercepted locally so that task progress is reflected in VS Code without requiring the upstream model provider to execute external side effects.

## VS Code Diagnostics Retrieval

The extension can expose current VS Code Problems diagnostics to the model through the internal diagnostics tool:

```text
get_llsccai_vscode_diagnostics
```

This helps the model fix real editor errors instead of guessing from stale build output.

The diagnostics flow is designed to be safe and explicit:

1. The model requests diagnostics through the internal tool.
2. The extension returns an acknowledgement and schedules an automatic continuation.
3. On the next relay turn, the request contains the trigger token:

   ```text
   @llsccai-get-errors
   ```

4. The relay scans the user messages for that trigger token.
5. The relay injects the latest VS Code Problems diagnostics into that user message before forwarding the request.

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
node out/relay/__tests__/taskRequestInjection.test.js
node out/relay/converters/__tests__/protocolConverters.test.js
node out/relay/converters/__tests__/streamConverters.test.js
```

## Repository

GitHub: <https://github.com/liliangshan/claude-code-config-helper.git>

## License

MIT
