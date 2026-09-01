# Task Flow Mode — Usage Guide

LLS CCAI's **Task Flow** mode turns the built-in Chat into a plan-driven, self-continuing
engineering agent. Instead of one-shot prompts, you let the main model write a plan
document first, then let the task-flow model drive that plan to completion step by step.

## Why Task Flow?

- **Plan first, execute second.** The model writes a real spec/plan file into
  `docs/` before touching any code, so every step is traceable.
- **Automatic continuation.** When the model pauses after finishing a step, the
  extension detects the unfinished workflow and sends the next continuation
  prompt for you — no manual "continue" typing.
- **A dedicated model.** Task Flow can use a different (e.g. cheaper or stronger)
  model than normal chat, configured in the model picker.
- **Progress you can see.** The status bar shows live progress
  (`completed/total`), a quick-pick panel lists every task and its state, and an
  unfinished workflow survives restarts with a resume dialog.

<!-- SEED: append sections below -->

## The Recommended Workflow

1. **Ask the main model to write a plan document first.**
   Open Chat and prompt something like *"write an implementation plan for X into
   `docs/plan-x.md`"*. The plan file is the contract for everything that follows.
2. **Attach the plan file as context.**
   In the file area above the input box, click **＋** and select the plan document
   (or just drag the file onto the chat). The current editor file is attached by
   default, so often nothing to do here at all.
3. **Click `CC task flow` below the input box.**
   This inserts the task-flow start prompt, which instructs the model to read the
   plan, break it into a structured workflow, and begin executing.
4. **Send.**
   From now on the task-flow model drives execution: each pending step must be
   carried out and reported back via the `update_llsccai_task_workflow` tool, and
   the extension keeps the loop going automatically.

## Starting, Continuing and Resuming

| Situation | What to do |
| --- | --- |
| Start a new task flow | Click **CC task flow** in the composer (fills the start prompt) and send. |
| Continue manually | Click the `CC Task Flow` status-bar item → *Continue* (or run the command). |
| Progress / task list | Click the progress text in the status bar to open the QuickPick panel. |
| VS Code restarted mid-workflow | The next time Chat is ready, a resume dialog appears: **Continue**, **Clear**, or **Later**. |

Automatic continuation runs by default; if the model keeps replying with plain
text without calling any tool, a circuit breaker pauses it and asks you to review
the workflow, so it never spams the CLI indefinitely.

## Configuring the Task Flow Model

Open the model picker (⚙ in the header, or click either model chip in the composer):

- **Normal task model** — used for everyday chat.
- **Task flow model** — switched in automatically right before a task-flow
  prompt is sent. Leave it unconfigured to simply reuse the normal model.
- **Compaction model** — used when the context window is compacted.

The choice is persisted under `claudeCodeConfigHelper.chat.taskFlow.model`
(workspace value first, global as fallback), so you can assign a heavy model to
plans and a fast one to chat.

## FAQ

**Does Task Flow replace normal chat?** No — the `CC task flow` button only seeds a
plan-driven prompt. Everything else about the chat is unchanged.

**What is `llsccai.taskFlow.target`?** Where task-flow prompts go: `builtinChat`
(the default, in-IDE webview) or `externalClaudeCode` (paste into the external
Claude Code terminal).

**My workflow was interrupted — will it resume?** Yes. Workflows are persisted to
the workspace state directory and reloaded on startup; the resume dialog offers
to continue where it stopped.

**How do I stop the auto-continuation loop?** Any of: finish the workflow, click
*Pause auto-continue* in the status-bar menu, or start a new chat session.

