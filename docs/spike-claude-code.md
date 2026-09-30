# Spike: driving Claude Code in tmux (2026-09-26)

Claude Code v2.1.283 on macOS, run as `claude --model haiku --permission-mode default` inside tmux 3.7c. The sandbox's `.claude/settings.local.json` pointed every hook (`type: "http"`) and the statusline at a local recorder.

## Confirmed

| # | Question | Result |
|---|---|---|
| 1 | First run in a new folder | Shows the **"trust this folder" dialog**, with **"No, exit"** preselected. The manager must answer it (Down, Enter) or pre-trust the folder. |
| 2 | Statusline JSON | Contains `session_id`, `transcript_path`, `model.id` / `display_name`, `cost.total_cost_usd`, `context_window.*` (incl. `used_percentage`, `current_usage`), and `rate_limits.five_hour` / `seven_day.used_percentage` (after the first API call). **No permission mode.** The header `X-AO-Agent: $AO_AGENT_ID` (via tmux `-e`) works for both hooks and the curl statusline. |
| 3 | Chat input | `tmux load-buffer` + `paste-buffer` + `Enter` submits prompts reliably, including quotes and backticks. |
| 4 | `PermissionRequest` (http, held open) for Bash | **Works.** Reply with `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`: the TUI shows "Allowed by PermissionRequest hook". A deny with `message` also works, and Claude reads the message. The TUI shows its own prompt at the same time; whichever answers first wins. |
| 5 | Plan approval (`ExitPlanMode`) | `PermissionRequest` **fires** with `tool_input.plan` (full markdown) and `planFilePath`. **Hook decisions are ignored** for it in the interactive TUI, both plain allow and allow + `setMode`. Answer by keys: `1` = auto-accept edits, `2` = manual, `3` = feedback. After `1`, the next hooks report `permission_mode: "acceptEdits"`. |
| 6 | `AskUserQuestion` | `PermissionRequest` fires with `tool_input.questions[]`. **Answering works via the hook**: `decision: { behavior: "allow", updatedInput: { questions, answers: { "<question>": "<label>" } } }`. |
| 7 | Mode switch | Shift+Tab (`tmux send-keys BTab`) cycles **manual → accept edits → plan → manual** (auto/bypass only when enabled). The current mode is shown in the TUI footer, in `permission_mode` on every hook, and in `{"type":"permission-mode"}` transcript lines. |
| 8 | Model switch | `/model sonnet` mid-conversation shows a **"Switch model?" confirm** (answered with `1`). ⚠️ This **also rewrote the user-global default** (`~/.claude/settings.json` → `"model": "sonnet"`). The manager must set the model per agent another way (see below). The statusline reflects the new `model.id`. |
| 9 | Hooks seen | UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification (`permission_prompt`), Stop (includes `last_assistant_message`), SubagentStop. **SessionStart (http) never arrived.** Use a `command` hook with curl for SessionStart/SessionEnd, or rely on the statusline's first report. |
| 10 | Noise | Claude Code runs internal subagents (e.g. the prompt suggestion "commit this") that emit `SubagentStop`. Ignore subagent events for animation unless they come from a real `Agent` tool call. |
| 11 | Transcript | `~/.claude/projects/<cwd-slug>/<session>.jsonl`. Assistant lines have `requestId` and `message.{id, model, usage}`. There are also `permission-mode`, `ai-title` (session title) and `agent-name` lines. |

## Consequences for the implementation
- **Approvals from the dashboard:**
  - Permission prompts: hook decision (structured).
  - Questions: hook `updatedInput.answers` (structured).
  - Plans: send TUI keys `1` / `2` / `3` + feedback text. The plan content itself comes from the hook.
- **Model per agent without touching global settings:**
  - Start with `claude --model X`.
  - To change it, restart via `claude --continue --model Y`, or write `"model"` into the agent's `.claude/settings.local.json` before starting.
  - Never send `/model` from automation.
- **Folder trust:** pre-trust new agent folders, or have the manager answer the dialog right after `new-session`.
- **State machine inputs:** `permission_mode` from hooks; model / cost / context / rate limits from the statusline.
