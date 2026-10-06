import type { AgentStatus, LiveMode } from '@after-office/shared'

// Pure reducer: Claude Code hook / statusline payloads → agent runtime state. No I/O, no LLM.
// See docs/spike-claude-code.md for which events arrive and what they contain.

export interface Runtime {
  status: AgentStatus
  waitingFor?: 'permission' | 'plan' | 'question'
  tool?: string
  task?: string
  lastMessage?: string
  permissionMode?: LiveMode
  model?: string
  modelName?: string
  sessionId?: string
  transcriptPath?: string
  title?: string
  costUsd?: number
  contextPct?: number | null
  contextTokens?: number
  contextSize?: number
  error?: string
  /** Finished turns (replies) the dashboard user hasn't looked at in the Chat tab */
  unread?: number
  /** ms: a /compact is running since then (agents/manager.ts compactSession) */
  compactingSince?: number
  /** ms timestamp of the last hook/statusline activity */
  lastEventAt: number
}

export const initialRuntime = (): Runtime => ({ status: 'offline', lastEventAt: 0 })

/** Minimal shape of a Claude Code hook payload (fields we use). */
export interface HookPayload {
  hook_event_name: string
  session_id?: string
  transcript_path?: string
  permission_mode?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  prompt?: string
  notification_type?: string
  last_assistant_message?: string
  error?: unknown
  agent_type?: string
  /** SessionEnd: why the session ended ("clear", "logout", "prompt_input_exit", …). */
  reason?: string
}

const MODES: LiveMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']
const asMode = (m?: string): LiveMode | undefined => (MODES.includes(m as LiveMode) ? (m as LiveMode) : undefined)

const oneLine = (s: string, max = 120) => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Tools that ask the human something rather than doing work. */
export function waitingKind(tool?: string): Runtime['waitingFor'] {
  if (tool === 'ExitPlanMode') return 'plan'
  if (tool === 'AskUserQuestion') return 'question'
  return 'permission'
}

export function applyHook(rt: Runtime, e: HookPayload, now = Date.now()): Runtime {
  const next: Runtime = { ...rt, lastEventAt: now, error: undefined }
  next.permissionMode = asMode(e.permission_mode) ?? rt.permissionMode
  if (e.session_id) next.sessionId = e.session_id
  if (e.transcript_path) next.transcriptPath = e.transcript_path

  switch (e.hook_event_name) {
    case 'SessionStart':
      return { ...next, status: 'idle', waitingFor: undefined, tool: undefined }
    case 'UserPromptSubmit':
      return { ...next, status: 'working', waitingFor: undefined, tool: undefined, task: e.prompt ? oneLine(e.prompt) : rt.task }
    case 'PreToolUse':
      // a pending question/plan stays "waiting" until it's answered; other tools mean work is happening
      if (e.tool_name === 'AskUserQuestion' || e.tool_name === 'ExitPlanMode') return next
      return { ...next, status: 'working', waitingFor: undefined, tool: e.tool_name }
    case 'PostToolUse':
      return { ...next, status: 'working', waitingFor: undefined, tool: e.tool_name ?? rt.tool }
    case 'PermissionRequest':
      return { ...next, status: 'waiting', waitingFor: waitingKind(e.tool_name), tool: e.tool_name }
    case 'Notification':
      if (e.notification_type === 'idle_prompt') return { ...next, status: 'idle', waitingFor: undefined, tool: undefined }
      if (e.notification_type === 'permission_prompt' && rt.status !== 'waiting')
        return { ...next, status: 'waiting', waitingFor: rt.waitingFor ?? 'permission' }
      return next
    case 'Stop':
      return {
        ...next,
        status: 'idle',
        waitingFor: undefined,
        tool: undefined,
        lastMessage: e.last_assistant_message ? oneLine(e.last_assistant_message, 240) : rt.lastMessage,
        unread: (rt.unread ?? 0) + 1,
      }
    case 'StopFailure':
      return { ...next, status: 'idle', waitingFor: undefined, tool: undefined, error: 'The last turn failed', unread: (rt.unread ?? 0) + 1 }
    case 'SessionEnd':
      // /clear ends the conversation but the CLI keeps running with a fresh one: still at the desk
      if (e.reason === 'clear') return { ...next, status: 'idle', waitingFor: undefined, tool: undefined, transcriptPath: undefined }
      return { ...next, status: 'offline', waitingFor: undefined, tool: undefined }
    // Subagent events include Claude Code's own background helpers (e.g. prompt suggestions): not visual state.
    default:
      return rt.status === 'offline' ? { ...next, status: 'idle' } : next
  }
}

/** Statusline JSON → runtime (model, cost, context). Also proves the session is alive. */
export interface StatuslinePayload {
  session_id?: string
  transcript_path?: string
  model?: { id?: string; display_name?: string }
  cost?: { total_cost_usd?: number }
  context_window?: {
    used_percentage?: number | null
    context_window_size?: number
    current_usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null
  }
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number }
    seven_day?: { used_percentage?: number; resets_at?: number }
  }
}

export function applyStatusline(rt: Runtime, s: StatuslinePayload, now = Date.now()): Runtime {
  return {
    ...rt,
    // first statusline after start = the session is up (SessionStart http hooks don't arrive, see spike #9)
    status: rt.status === 'offline' ? 'idle' : rt.status,
    lastEventAt: rt.status === 'offline' ? now : rt.lastEventAt,
    sessionId: s.session_id ?? rt.sessionId,
    transcriptPath: s.transcript_path ?? rt.transcriptPath,
    model: s.model?.id ?? rt.model,
    modelName: s.model?.display_name ?? rt.modelName,
    costUsd: s.cost?.total_cost_usd ?? rt.costUsd,
    contextPct: s.context_window?.used_percentage ?? rt.contextPct ?? null,
    contextTokens: contextTokens(s) ?? rt.contextTokens,
    contextSize: s.context_window?.context_window_size ?? rt.contextSize,
  }
}

/** Tokens in the context right now: the last request's input, cached or not. */
function contextTokens(s: StatuslinePayload) {
  const u = s.context_window?.current_usage
  if (!u) return undefined
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
}

/** A "working" agent with no activity for this long is treated as idle (e.g. it was interrupted with Esc). */
export const STALE_WORKING_MS = 10 * 60_000

export function applyTick(rt: Runtime, now = Date.now()): Runtime {
  if (rt.status === 'working' && now - rt.lastEventAt > STALE_WORKING_MS) return { ...rt, status: 'idle', tool: undefined }
  return rt
}
