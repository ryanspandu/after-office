import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from 'hono'
import type { FollowUpDecision, LiveFollowUp, RateLimits } from '@after-office/shared'
import { agentsRepo, sideSessionsRepo } from '../db'
import { answerPermissionByKeys, answerPlan, AgentError, applyDeferredMode, readDialogOptions, sendPrompt, sessionKeyOf, takeDeferredMode } from './manager'
import { addPending, clearPendingFor, currentRateLimits, getPending, patchPending, resolvePending, runtimeOf, setRateLimits, sideRuntimeOf, updateRuntime, updateSideRuntime } from './registry'
import { applyHook, applyStatusline, type HookPayload, type Runtime, type StatuslinePayload } from './state'
import { decideCheck, decideCron, decideDelegation, deliver, handleStop, noteFileWritten, onPromptSubmitted, onSidePromptSubmitted, onSideStopped } from '../work/work'
import { writtenFile } from './files'
import { decideHire } from '../work/hires'
import { connectorWriteGate } from './connectors'
import { toolDecided, toolFinished, toolStarting, toolWaiting } from '../work/activity'

// Receives what Claude Code sends us: hook events (POST /hook) and statusline snapshots (POST /statusline).
// Both are authenticated with HOOK_TOKEN (see auth.ts) and name their agent in X-AO-Agent.

/** Answer held requests a little before Claude Code's 600 s hook timeout, falling back to the TUI prompt. */
const HOLD_MS = 580_000
const DEBUG_LOG = resolve(process.env.OFFICE_DATA_DIR ?? resolve(import.meta.dir, '../../data'), 'hooks-debug.jsonl')

const agentIdOf = (c: Context) => {
  const id = c.req.header('x-ao-agent')
  return id && agentsRepo.get(id) ? id : null
}

const noDecision = {}

/**
 * Which of the agent's sessions sent it (X-AO-Session): '' for its main session, s2, s3… for a side session. A side
 * session that isn't open (closed, unknown) is null: its events are ignored.
 */
function sessionOf(c: Context, agentId: string) {
  const key = sessionKeyOf(c.req.header('x-ao-session'))
  if (!key) return ''
  const side = sideSessionsRepo.get(agentId, key)
  return side && !side.closed_at ? key : null
}

/** The runtime of that session changes (the agent's own for the main session). */
const updateSession = (agentId: string, key: string, fn: (rt: Runtime) => Runtime) => (key ? updateSideRuntime(agentId, key, fn) : updateRuntime(agentId, fn))

function summarize(tool: string, input: Record<string, unknown>) {
  if (tool === 'Bash') return String(input.command ?? '')
  if (tool === 'ExitPlanMode') return String(input.plan ?? '').split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? 'Plan ready'
  if (tool === 'AskUserQuestion') return String((input.questions as { question?: string }[] | undefined)?.[0]?.question ?? 'Question')
  const file = input.file_path ?? input.path ?? input.url
  // MCP tools: "mcp__claude_ai_Apify_Trending_Now__get-dataset-items" → "Apify Trending Now · get-dataset-items"
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  const name = mcp ? `${mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')} · ${mcp[2]}` : tool
  return file ? `${name} ${file}` : name
}

export async function handleHook(c: Context) {
  const agentId = agentIdOf(c)
  const e = (await c.req.json().catch(() => null)) as (HookPayload & { tool_use_id?: string; permission_suggestions?: unknown; tool_response?: unknown }) | null
  if (!agentId || !e?.hook_event_name) return c.json(noDecision)
  const key = sessionOf(c, agentId)
  if (key === null) return c.json(noDecision)

  // anything that shows the agent moved on means a pending prompt was answered elsewhere (e.g. in the terminal). A tool
  // that finished only settles its own prompt: tools run side by side, and another one's permission can still be open
  const finished = ['PostToolUse', 'PostToolUseFailure'].includes(e.hook_event_name)
  if (finished && e.tool_use_id) clearPendingFor(agentId, (f) => !f.id.endsWith(`:${e.tool_use_id}`), key)
  else if (finished || ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(e.hook_event_name)) clearPendingFor(agentId, undefined, key)

  // OFFICE_DEBUG_HOOKS=true appends every raw hook payload to data/hooks-debug.jsonl (for reverse-engineering fields)
  if (process.env.OFFICE_DEBUG_HOOKS === 'true') appendFileSync(DEBUG_LOG, JSON.stringify({ t: Date.now(), agentId, key, e }) + '\n')
  // was it in the middle of a turn when this prompt came in (a prompt added to the running turn, not a new one)
  const midTurn = (key ? sideRuntimeOf(agentId, key) : runtimeOf(agentId)).status === 'working'
  updateSession(agentId, key, (rt) => applyHook(rt, e))
  // /clear starts a new conversation (new session id): a later restart must --resume that one, not the old one
  if (e.hook_event_name === 'UserPromptSubmit' && e.session_id && /^[0-9a-f-]{36}$/i.test(e.session_id)) {
    if (key) {
      if (sideSessionsRepo.get(agentId, key)?.session_id !== e.session_id) sideSessionsRepo.update(agentId, key, { session_id: e.session_id })
    } else if (agentsRepo.get(agentId)?.session_id !== e.session_id) agentsRepo.update(agentId, { session_id: e.session_id })
  }

  // files the agent writes during a task become the report's attachments
  // a tool that failed: Claude Code sends PostToolUseFailure instead
  if (e.hook_event_name === 'PostToolUseFailure')
    toolFinished(agentId, e.tool_name, e.tool_input, { isError: true, content: [{ text: String((e as { error?: unknown }).error ?? 'Failed') }] }, e.tool_use_id)
  if (e.hook_event_name === 'PostToolUse') {
    const file = writtenFile(e.tool_name, e.tool_input)
    if (file) noteFileWritten(agentId, file, key)
    // the Activity log: what a connector tool returned (and pages read before a write)
    toolFinished(agentId, e.tool_name, e.tool_input, e.tool_response, e.tool_use_id)
  }
  // a side session's turns are the owner's chats: no task, queue or manager reply is theirs (work.ts onSideStopped)
  if (e.hook_event_name === 'Stop' || e.hook_event_name === 'StopFailure') {
    if (key) onSideStopped(agentId, key, e.last_assistant_message, e.hook_event_name === 'StopFailure')
    else void handleStop(agentId, e.last_assistant_message, e.hook_event_name === 'StopFailure').catch((err) => console.error('[stop]', err))
  }
  if (e.hook_event_name === 'UserPromptSubmit') {
    if (key) onSidePromptSubmitted(agentId, key, e.prompt)
    else onPromptSubmitted(agentId, e.prompt, midTurn)
  }
  // a mode change asked for while a dialog was open can go through now
  if (['PostToolUse', 'Stop', 'StopFailure', 'UserPromptSubmit'].includes(e.hook_event_name)) void applyDeferredMode(agentId, key)
  // a read-only connector's tool that changes something: ask the owner (a permission prompt, also in Auto)
  if (e.hook_event_name === 'PreToolUse' && e.tool_name?.startsWith('mcp__')) {
    const row = agentsRepo.get(agentId)
    const reason = row ? connectorWriteGate(row, e.tool_name) : null
    toolStarting(agentId, e.tool_name, e.tool_input, e.tool_use_id, !!reason)
    if (reason) return c.json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })
  }
  if (e.hook_event_name !== 'PermissionRequest') return c.json(noDecision)

  const tool = e.tool_name ?? 'Tool'
  const input = e.tool_input ?? {}
  const kind: LiveFollowUp['kind'] = tool === 'ExitPlanMode' ? 'plan' : tool === 'AskUserQuestion' ? 'question' : 'permission'
  const base: LiveFollowUp = {
    // namespaced: one agent's ids can never replace another agent's (or the office's own) follow-ups
    id: `${agentId}:${key ? `${key}:` : ''}${e.tool_use_id ?? crypto.randomUUID()}`,
    agentId,
    ...(key ? { sessionKey: key } : {}),
    kind,
    tool,
    message: summarize(tool, input),
    input,
    createdAt: Date.now(),
  }
  toolWaiting(agentId, e.tool_name, input, e.tool_use_id, base.id)

  // Plans are answered with keys in the TUI (spike #5), so don't hold the request.
  if (kind === 'plan') {
    addPending(base)
    // the dialog renders right after this hook returns; read its options so the dashboard offers exactly those
    void (async () => {
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(700)
        const options = await readDialogOptions(agentId, key)
        if (options.length) return patchPending(base.id, { input: { ...input, options: options.map((o) => o.label) } })
      }
    })()
    return c.json(noDecision)
  }

  // the reconciler may have picked this dialog up from the screen a moment before the hook arrived
  if (!key) resolvePending(`screen-${agentId}`)

  // Permissions and questions: hold the request until the dashboard decides (or time runs out).
  const out = await new Promise<unknown>((resolve) => {
    addPending({ ...base, respond: resolve, suggestions: e.permission_suggestions })
    // Out of time: let Claude Code show its own dialog, but keep the card. The dashboard then answers with keys.
    setTimeout(() => {
      const f = getPending(base.id)
      if (!f?.respond) return
      f.respond(noDecision)
      f.respond = undefined
    }, HOLD_MS)
  })
  return c.json(out ?? noDecision)
}

const permissionOutput = (decision: Record<string, unknown>) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
})

/** Apply a human decision to a pending follow-up. */
export async function decide(id: string, d: FollowUpDecision, who: { device: string; ip: string } = { device: 'unknown', ip: '' }) {
  const f = getPending(id)
  if (!f) throw new AgentError('This request was already answered or expired', 404)
  // a connector tool the owner let run (or not): on its Activity entry, with where they answered from
  if (f.kind === 'permission' && f.tool?.startsWith('mcp__') && (d.type === 'allow' || d.type === 'deny')) toolDecided(id, d.type === 'allow', who)

  if (f.kind === 'delegation') return decideDelegation(f, d)
  if (f.kind === 'hire') return decideHire(f, d)
  if (f.kind === 'check') return decideCheck(f, d)
  if (f.kind === 'daily') return decideCron(f, d)

  if (f.kind === 'plan') {
    if (d.type !== 'plan' || !d.option) throw new AgentError('Plans need one of the dialog options')
    await answerPlan(f.agentId, d.option, d.feedback, f.sessionKey)
    resolvePending(id)
    return
  }

  if (f.kind === 'question') {
    if (d.type === 'deny') return void resolvePending(id, permissionOutput({ behavior: 'deny', message: d.note || 'The user skipped this question.' }))
    if (d.type !== 'answer') throw new AgentError('Questions need answers')
    resolvePending(id, permissionOutput({ behavior: 'allow', updatedInput: { ...f.input, answers: d.answers } }))
    return
  }

  // a note with the answer: a hook can only carry it with a denial, so otherwise it follows as a message (queued
  // until the agent's turn ends)
  const sendNote = (note?: string) => {
    if (!note?.trim()) return
    const text = `[From the owner, about ${f.tool}] ${note.trim()}`
    // a side session has no queue: typed in (Claude Code holds it until the turn ends)
    if (f.sessionKey) void sendPrompt(f.agentId, text, f.sessionKey).catch(() => {})
    else void deliver(f.agentId, text).catch(() => {})
  }

  // not held any more (hold timed out, or the server restarted): answer the dialog on screen instead
  if (!f.respond) {
    if (d.type !== 'allow' && d.type !== 'deny') throw new AgentError('Permissions need allow or deny')
    await answerPermissionByKeys(f.agentId, d.type === 'deny' ? 'deny' : d.always ? 'always' : 'allow', f.sessionKey)
    resolvePending(id)
    sendNote(d.note)
    return
  }

  if (d.type === 'deny') {
    resolvePending(id, permissionOutput({ behavior: 'deny', message: d.note?.trim() || 'Denied from After Office.' }))
  } else if (d.type === 'allow') {
    // "Allow always": keep Claude Code's rule/directory suggestions but never its setMode suggestion (that would
    // silently switch the agent to acceptEdits), and save them to the project's local settings instead of the session.
    const rules = Array.isArray(f.suggestions)
      ? (f.suggestions as { type?: string }[]).filter((s) => s.type !== 'setMode').map((s) => ({ ...s, destination: 'localSettings' }))
      : []
    const updates: unknown[] = d.always ? [...rules] : []
    // a mode change picked while this dialog was open goes out with the answer (Shift+Tab can't reach the footer now)
    const mode = takeDeferredMode(f.agentId, f.sessionKey)
    if (mode) updates.push({ type: 'setMode', mode, destination: 'session' })
    resolvePending(id, permissionOutput({ behavior: 'allow', ...(updates.length ? { updatedPermissions: updates } : {}) }))
    sendNote(d.note)
  } else {
    throw new AgentError('Permissions need allow or deny')
  }
}

type WindowIn = { used_percentage?: number; resets_at?: number } | undefined

/**
 * Every session reports the plan usage of its own latest API reply, so an idle one keeps sending older numbers than a
 * busy one. Within a window (same reset time) usage only goes up: the higher number wins, and a report from an earlier
 * window is ignored. A status line may carry only one of the two windows (5-hour, weekly): the other keeps its last
 * value until it resets, instead of flickering to "no data". resets_at is in seconds.
 */
export function mergeRateLimits(prev: RateLimits | null, rl: { five_hour?: WindowIn; seven_day?: WindowIn }, now = Date.now()): RateLimits {
  const live = (at: number | null | undefined) => !!at && at * 1000 > now
  const pick = (next: WindowIn, pct: number | null | undefined, at: number | null | undefined) => {
    const kept = live(at) ? { pct: pct ?? null, at: at ?? null } : { pct: null, at: null }
    if (!next) return kept
    const fresh = { pct: next.used_percentage ?? null, at: next.resets_at ?? null }
    if (!kept.at || !fresh.at) return fresh.at || fresh.pct != null ? fresh : kept
    // an earlier window (a session that hasn't talked to the API since): old news
    if (fresh.at < kept.at - 60) return kept
    // the same window: whichever saw more usage
    if (Math.abs(fresh.at - kept.at) <= 60) return { pct: Math.max(fresh.pct ?? 0, kept.pct ?? 0), at: Math.max(fresh.at, kept.at) }
    return fresh
  }
  const five = pick(rl.five_hour, prev?.fiveHourPct, prev?.fiveHourResetsAt)
  const week = pick(rl.seven_day, prev?.sevenDayPct, prev?.sevenDayResetsAt)
  return { fiveHourPct: five.pct, sevenDayPct: week.pct, fiveHourResetsAt: five.at, sevenDayResetsAt: week.at, checkedAt: prev?.checkedAt ?? null }
}

export async function handleStatusline(c: Context) {
  const agentId = agentIdOf(c)
  const s = (await c.req.json().catch(() => null)) as StatuslinePayload | null
  if (!agentId || !s) return c.text('After Office')
  const key = sessionOf(c, agentId)
  if (key === null) return c.text('After Office')
  updateSession(agentId, key, (rt) => applyStatusline(rt, s))
  const rl = s.rate_limits
  if (rl?.five_hour || rl?.seven_day) {
    const prev = currentRateLimits()
    const next = mergeRateLimits(prev, rl)
    // fresh: the numbers moved, or a session that is working (just talked to the API) reported them; a working one
    // at most once a minute, to keep it quiet
    const now = Date.now()
    const moved = !prev || prev.fiveHourPct !== next.fiveHourPct || prev.sevenDayPct !== next.sevenDayPct
    if (moved || ((key ? sideRuntimeOf(agentId, key) : runtimeOf(agentId)).status === 'working' && now - (next.checkedAt ?? 0) > 60_000)) next.checkedAt = now
    setRateLimits(next)
  }
  // What the TUI's status bar shows: the curl in the statusline command prints our response.
  const row = agentsRepo.get(agentId)!
  const rt = key ? sideRuntimeOf(agentId, key) : runtimeOf(agentId)
  const ctx = rt.contextPct != null ? ` · ${Math.round(rt.contextPct)}% context` : ''
  return c.text(`After Office · ${row.name}${key ? ` · session ${key.slice(1)}` : ''} · ${rt.modelName ?? row.model}${ctx}`)
}
