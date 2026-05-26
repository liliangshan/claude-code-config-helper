# VS Code Diagnostics Tool Removal Plan

## Background

The extension currently exposes VS Code Problems diagnostics to Claude through an internal local tool and a continuation trigger:

- Tool name: `get_llsccai_vscode_diagnostics`
- Trigger token: `@llsccai-get-errors`

The flow lets the model request diagnostics, receives an accepted tool-call placeholder, schedules an auto-continue turn, and injects live VS Code Problems data into the next user message. This document records the removal scope and implementation steps.

## Current Flow

1. `src/relay/taskRequestInjection.ts` always injects the diagnostics tool schema and system rule into outbound Claude requests.
2. The model may call `get_llsccai_vscode_diagnostics`.
3. `src/llsTask/interceptor.ts` or `src/llsTask/streamingInterceptor.ts` intercepts that local tool call instead of forwarding it to Claude Code.
4. `src/llsTask/diagnostics.ts` reads `vscode.languages.getDiagnostics()` and formats a local tool result or injection block.
5. `src/llsTask/autoContinue.ts` schedules a follow-up prompt containing `@llsccai-get-errors`.
6. `src/relay/taskRequestInjection.ts` detects `@llsccai-get-errors`, injects the current diagnostics into the user message, and removes the trigger token.
7. `media/chat/main.js` renders a custom icon and label for the diagnostics tool card.

## Removal Scope

### Delete diagnostics implementation

- Remove `src/llsTask/diagnostics.ts` if no other diagnostics API is retained.
- Remove all imports of:
  - `GET_DIAGNOSTICS_TRIGGER_TOKEN`
  - `executeGetDiagnosticsTool`
  - `formatGetDiagnosticsToolMessage`
  - `formatGetDiagnosticsInjectionBlock`

### Remove tool definition and system prompt injection

Update `src/llsTask/tools.ts`:

- Delete `LLS_CCAI_GET_DIAGNOSTICS_TOOL_NAME`.
- Delete `buildGetLlsCcaiDiagnosticsTool()`.
- Delete `buildGetLlsCcaiDiagnosticsSystemRule()`.
- Remove diagnostics-related wording from module comments.

Update `src/relay/taskRequestInjection.ts`:

- Stop importing diagnostics helpers.
- Remove `shouldInjectDiagnostics` and the unconditional diagnostics tool/system rule insertion.
- Remove `maybeInjectDiagnosticsFromTrigger()`.
- Remove helper logic that scans the last user message for `@llsccai-get-errors`.
- Keep task workflow injection behavior unchanged.

### Remove local tool interception branch

Update `src/llsTask/interceptor.ts`:

- Remove the `diagnostics` local tool kind.
- Remove `handledDiagnosticsTool` from result state.
- Remove `isDiagnosticsToolName()`.
- Remove diagnostics handling in block and streaming local-tool execution.
- Ensure workflow tool interception still schedules `scheduleAfterWorkflowTool()` as before.

Update `src/llsTask/streamingInterceptor.ts`:

- Remove diagnostics state tracking.
- Remove diagnostics local tool classification.
- Remove diagnostics auto-continue scheduling.
- Keep workflow local tool handling unchanged.

### Simplify auto-continue logic

Update `src/llsTask/autoContinue.ts`:

- Remove diagnostics-specific constants:
  - `DIAGNOSTICS_CONTINUE_DELAY_MS`
  - `DIAGNOSTICS_CONTINUE_PROMPT`
- Remove `scheduleAfterDiagnosticsTool()`.
- Remove `pendingKind: 'workflow' | 'diagnostics'` if only workflow remains.
- Remove diagnostics-specific prompt selection.
- Keep workflow auto-continue behavior unchanged.

### Remove Chat UI labeling

Update `media/chat/main.js`:

- Remove the `get_llsccai_vscode_diagnostics` icon mapping.
- Remove the diagnostics-specific tool title formatting branch.

### Fix Chat footer responsive layout

Update the Chat footer layout so the model dropdown, bypass control, context area, and send button do not overlap or push each other out of view at narrow widths.

Expected behavior:

- At sufficient width, show the model dropdown, bypass control, context area, and send button on one row.
- At narrow width, wrap controls so each major control can occupy its own row instead of squeezing the send button out of the visible area.
- Keep the send button visible and reachable at all supported Webview widths.
- Prefer CSS flex wrapping or grid media/container queries in `media/chat/style.css` over JavaScript layout calculations.
- Verify the layout in the Chat Webview at both normal width and narrow sidebar width.

Likely files:

- `media/chat/index.html`
- `media/chat/main.js`
- `media/chat/style.css`

### Update tests

Update or remove diagnostics assertions in `src/relay/__tests__/taskRequestInjection.test.ts`:

- Remove tests that expect diagnostics system rules or tool schemas to be injected.
- Remove tests that use `@llsccai-get-errors` and expect `[get_llsccai_vscode_diagnostics]` injection blocks.
- Keep task workflow injection tests.

Add or adjust regression coverage to assert that outbound requests no longer contain:

- `get_llsccai_vscode_diagnostics`
- `@llsccai-get-errors`
- diagnostics tool schema entries
- diagnostics system rules

### Update documentation and release notes

Update `README.md`:

- Remove the feature bullet for VS Code Problems diagnostics retrieval.
- Remove the entire `VS Code Diagnostics Retrieval` section.

Update `CHANGELOG.md` only if this removal will be part of the next release entry.

## Suggested Implementation Order

1. Remove diagnostics injection from `src/relay/taskRequestInjection.ts` and update its tests.
2. Remove diagnostics tool schema/system rule from `src/llsTask/tools.ts`.
3. Remove diagnostics handling from `src/llsTask/interceptor.ts` and `src/llsTask/streamingInterceptor.ts`.
4. Simplify `src/llsTask/autoContinue.ts`.
5. Delete `src/llsTask/diagnostics.ts`.
6. Remove Chat UI icon/title handling from `media/chat/main.js`.
7. Update `README.md` and optionally `CHANGELOG.md`.
8. Run the test suite and TypeScript compile check.

## Validation Checklist

- `npm test` passes.
- TypeScript compile check passes.
- Starting a chat no longer injects the diagnostics tool into request bodies.
- A user message containing `@llsccai-get-errors` is treated as normal text or no longer has special behavior.
- Workflow task tools still execute locally and still auto-continue.
- Tool cards for existing supported tools still render correctly in the Chat Webview.

## Notes

- Removing this feature means the model can no longer read VS Code Problems automatically through this extension.
- Users can still paste error output manually into chat.
- If a future replacement is needed, prefer an explicit user action in the Chat UI over hidden trigger-token injection.
