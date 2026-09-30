import { isEffort, type AgentInfo, type LiveFollowUp, type OfficeEvent, type RateLimits, type WorkState } from '@after-office/shared'
import { connectorsReadAskOf, connectorsWriteOf, agentsRepo, settingsRepo, type AgentRow, connectorsOf, extraDirsOf } from '../db'
import { DEFAULT_SETTINGS } from '../work/settings'
import { applyTick, initialRuntime, type Runtime } from './state'
import { gitIdentitiesRepo } from '../db'
import { toIdentity } from './git'

// In-memory live state (runtime per agent, pending follow-ups, subscription rate limits) plus a tiny pub/sub that
// feeds the SSE stream. Persistent agent config lives in SQLite (db.ts).

const runtimes = new Map<string, Runtime>()
/** Last AgentInfo broadcast per agent, to skip no-op updates (and still catch DB-side changes like a rename). */
const lastSent = new Map<string, AgentInfo>()
const listeners = new Set<(e: OfficeEvent) => void>()
// last known plan limits survive a server restart (they only arrive with the next statusline otherwise)
let rateLimits: RateLimits | null = (() => {
  try {
    return JSON.parse(settingsRepo.get('rateLimits') ?? 'null') as RateLimits | null
  } catch {
    return null
  }
})()

/** A follow-up waiting for a human, optionally holding an open hook request. */
export interface Pending extends LiveFollowUp {
  /** Resolves the held PermissionRequest HTTP response (permission / question). Plans are answered by keys. */
  respond?: (hookOutput: unknown) => void
  /** Claude Code's own "always allow" rule suggestions, echoed back on "Allow always". Server-side only. */
  suggestions?: unknown
}

const toWire = ({ respond: _r, suggestions: _s, ...wire }: Pending): LiveFollowUp => wire
const pending = new Map<string, Pending>()

export function subscribe(fn: (e: OfficeEvent) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function publish(e: OfficeEvent) {
  for (const fn of listeners) {
    try {
      fn(e)
    } catch {
      // a broken SSE client must not break the others
    }
  }
}

// Unread replies outlive a server restart (the rest of the runtime is rebuilt from the sessions' hooks)
const UNREAD_KEY = 'unreadChats'
const storedUnread = (): Record<string, number> => {
  try {
    return JSON.parse(settingsRepo.get(UNREAD_KEY) ?? '{}')
  } catch {
    return {}
  }
}
function storeUnread(id: string, n: number) {
  const all = storedUnread()
  if ((all[id] ?? 0) === n) return
  if (n) all[id] = n
  else delete all[id]
  settingsRepo.set(UNREAD_KEY, JSON.stringify(all))
}

export function runtimeOf(id: string) {
  let rt = runtimes.get(id)
  if (!rt) {
    const unread = storedUnread()[id]
    runtimes.set(id, (rt = { ...initialRuntime(), ...(unread ? { unread } : {}) }))
  }
  return rt
}

export function toInfo(row: AgentRow, rt = runtimeOf(row.id)): AgentInfo {
  const extraDirs = extraDirsOf(row)
  return {
    id: row.id,
    name: row.name,
    kind: row.kind ?? 'worker',
    ...(row.figure === 'man' || row.figure === 'woman' ? { figure: row.figure } : {}),
    ...(typeof row.style === 'number' ? { style: row.style } : {}),
    ...(isEffort(row.effort) ? { effort: row.effort } : {}),
    ...(row.git_name || row.git_email ? { git: { ...(row.git_name ? { name: row.git_name } : {}), ...(row.git_email ? { email: row.git_email } : {}) } } : {}),
    ...(row.ssh_public && row.ssh_fingerprint ? { sshKey: { publicKey: row.ssh_public, fingerprint: row.ssh_fingerprint } } : {}),
    ...((ids) => (ids.length ? { gitIdentities: ids.map(toIdentity) } : {}))(gitIdentitiesRepo.forAgent(row.id)),
    connectors: connectorsOf(row),
    connectorsWrite: connectorsWriteOf(row),
    connectorsReadAsk: connectorsReadAskOf(row),
    ...(row.pinned ? { pinned: true } : {}),
    role: row.role,
    desk: row.desk,
    cwd: row.cwd,
    ...(extraDirs.length ? { extraDirs } : {}),
    tmuxSession: row.tmux_session,
    status: rt.status,
    waitingFor: rt.waitingFor,
    task: rt.task,
    tool: rt.tool,
    lastMessage: rt.lastMessage,
    model: rt.model ?? row.model,
    modelName: rt.modelName,
    permissionMode: rt.permissionMode ?? row.permission_mode,
    sessionId: rt.sessionId ?? row.session_id,
    title: rt.title,
    costUsd: rt.costUsd,
    contextPct: rt.contextPct,
    contextTokens: rt.contextTokens,
    contextSize: rt.contextSize,
    error: rt.error,
    unread: rt.unread || undefined,
    updatedAt: rt.lastEventAt,
  }
}

/** Apply a change to an agent's runtime and broadcast it if anything visible changed. */
export function updateRuntime(id: string, fn: (rt: Runtime) => Runtime) {
  const row = agentsRepo.get(id)
  if (!row) return
  const before = runtimeOf(id)
  const after = fn(before)
  runtimes.set(id, after)
  if ((before.unread ?? 0) !== (after.unread ?? 0)) storeUnread(id, after.unread ?? 0)
  const a = lastSent.get(id)
  const b = toInfo(row, after)
  lastSent.set(id, b)
  // lastEventAt/updatedAt alone isn't worth a broadcast
  if (!a || JSON.stringify({ ...a, updatedAt: 0 }) !== JSON.stringify({ ...b, updatedAt: 0 })) publish({ type: 'agent', agent: b })
}

export function forgetAgent(id: string) {
  storeUnread(id, 0)
  runtimes.delete(id)
  lastSent.delete(id)
  for (const [fid, f] of pending) if (f.agentId === id) resolvePending(fid, {})
  publish({ type: 'remove', id })
}

export function addPending(f: Pending) {
  pending.set(f.id, f)
  publish({ type: 'followup', followUp: toWire(f) })
}

/** Patch a pending follow-up (e.g. attach the plan dialog's options once it's on screen) and re-broadcast it. */
export function patchPending(id: string, patch: Partial<Pending>) {
  const f = pending.get(id)
  if (!f) return
  const next = { ...f, ...patch }
  pending.set(id, next)
  publish({ type: 'followup', followUp: toWire(next) })
}

export function getPending(id: string) {
  return pending.get(id)
}

/** Drop a follow-up; if it holds a hook request, answer it with `hookOutput` ({} = "no decision, ask in the TUI"). */
export function resolvePending(id: string, hookOutput?: unknown) {
  const f = pending.get(id)
  if (!f) return false
  pending.delete(id)
  if (hookOutput !== undefined) f.respond?.(hookOutput)
  publish({ type: 'followup-resolved', id })
  return true
}

/** Follow-ups of one agent that are no longer relevant once it moves on (e.g. answered in the terminal). */
export const pendingFor = (agentId: string) => [...pending.values()].filter((f) => f.agentId === agentId)

export function clearPendingFor(agentId: string, keep?: (f: Pending) => boolean) {
  // a delegation waiting for the owner isn't about the manager's screen: it stays until the owner decides
  for (const [id, f] of pending) if (f.agentId === agentId && !['delegation', 'hire', 'check', 'daily'].includes(f.kind) && !keep?.(f)) resolvePending(id, {})
}

export const currentRateLimits = () => rateLimits

export function setRateLimits(r: RateLimits) {
  if (JSON.stringify(r) === JSON.stringify(rateLimits)) return
  rateLimits = r
  settingsRepo.set('rateLimits', JSON.stringify(r))
  publish({ type: 'rate-limits', rateLimits: r })
}

/** Filled in by work.ts (avoids an import cycle: work → manager → registry). */
let workProvider: () => WorkState = () => ({ tasks: [], projects: [], crons: [], timezone: 'UTC', queued: {}, reports: [], archivedTasks: 0, settings: DEFAULT_SETTINGS, automation: { channels: [], quotaPaused: null }, tags: [], bossMode: null, publicAccess: { supported: false, public: false } })
export const setWorkProvider = (fn: () => WorkState) => void (workProvider = fn)

export function snapshot(): OfficeEvent {
  return {
    type: 'snapshot',
    agents: agentsRepo.all().map((row) => toInfo(row)),
    followUps: [...pending.values()].map(toWire),
    rateLimits,
    work: workProvider(),
  }
}

/** Periodic housekeeping: stale "working" agents fall back to idle. */
export function tickAll(now = Date.now()) {
  for (const row of agentsRepo.all()) updateRuntime(row.id, (rt) => applyTick(rt, now))
}
