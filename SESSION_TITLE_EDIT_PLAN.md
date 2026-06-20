# Session Title Edit Plan

## Goal

Allow users to (1) see the session title truncated to 25 characters in the Chat header, and (2) click the title to open a popup dialog for editing it, with write-back to the session JSONL file.

## Frontend: Title Truncation

**File:** `media/chat/main.js` — `applySessionTitle(title)`

- Truncate `title` to 25 characters, appending `…` if it exceeds 25.
- Set the truncated text as the `<h1>` text content.
- Store the full title in module state for the edit dialog.

## Frontend: Popup Editing

**File:** `media/chat/main.js`

- Clicking the `<h1 data-role="session-title">` opens a popup dialog (`beginSessionTitleEdit`):
  - A dynamically created native `<dialog>` (`showModal`) with a label, an `<input>` pre-filled with the full title, and Cancel / OK buttons.
  - The input auto-focuses and selects all text.
- Pressing Enter or clicking OK confirms the edit.
  - Send a `{ type: 'session/set-title', title: <new value>, sessionId: <id> }` message to the extension host.
  - Re-render the title in read mode with truncation.
- Pressing Escape or clicking Cancel discards the edit; the dialog is removed from the DOM on close.

**File:** `media/chat/style.css`

- Style the editable title: `cursor: pointer` and dotted underline on hover.
- Style the dialog: backdrop, input, and Cancel/OK buttons using VS Code theme variables.

## Extension Host: Write Session Title

**File:** `src/extension.ts`

- Add a handler for `session/set-title` messages in the chat webview message listener.
- The handler:
  1. Receives `{ type: 'session/set-title', title: string, sessionId: string }`.
  2. Reads the session JSONL file at `<configDir>/projects/<projectKey>/<sessionId>.jsonl`.
  3. Removes any existing `{type:"custom-title", ...}` meta record.
  4. If the new title is non-empty, appends a fresh `{type:"custom-title", customTitle, sessionId}` meta record. `extractSessionTitle` reads `customTitle` with top priority, so it becomes the display title immediately.
  5. Writes the entire JSONL file back (preserving original EOL style).
  6. Broadcasts the new title to the webview via `pushSessionTitleToWebview`.

This appends a dedicated meta record rather than mutating an existing message, matching how Claude CLI already stores `ai-title` / `last-prompt` / `summary` meta records. An empty title removes the custom-title record and falls back to the auto-derived title.

**File:** `src/chat/protocol.ts`

- Add `session/set-title` to the `WebviewToExtension` message type union:
  ```typescript
  { type: 'session/set-title'; title: string; sessionId: string }
  ```

## Files to Modify

1. `media/chat/main.js` — truncation + inline edit
2. `media/chat/main.css` — edit mode styles
3. `src/extension.ts` — write-back handler
4. `src/chat/protocol.ts` — new message type

## Edge Cases

- **Empty title**: If the user clears the title and confirms, treat it as delete custom title → revert to auto-derived title. The extension handler should set `customTitle` to `undefined` (delete the field) and re-derive the display title from `aiTitle`/`lastPrompt`/`summary`.
- **Session not found**: If the JSONL file doesn't exist at write time, log a warning and don't crash.
- **Rapid editing**: Each edit writes the full file. For now this is acceptable since sessions are single-user and edits are infrequent.
- **JSONL write failure**: Catch write errors and log them; the UI already shows the optimistic title.
- **Multiple webviews**: Broadcast the title change so all open webviews stay in sync.
- **Whitespace-only title**: Treat as empty title (delete customTitle field).
