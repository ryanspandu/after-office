import type { ActivityEntry, ActivityOrigin } from '@after-office/shared'
import { activityRepo, agentsRepo } from '../db'
import { publish } from '../agents/registry'
import { connectorLabel, OFFICE_TOOLS_PREFIX, toolReads } from '../agents/connectors'

// The Activity log: every connector tool an agent calls (Gmail, Drive, Railway…), with what it was called with (secrets
// masked), what came back, who let it run, and why the agent was doing it at all: the origin of its turn, followed
// back to the owner's chat (device, IP), a task (and who made it), a daily job, a webhook, or the manager (in Boss mode
// or not). Built from the hooks Claude Code calls (PreToolUse, PermissionRequest, PostToolUse), stored on the server
// where agents can't reach it, kept 90 days.

const KEEP_MS = 90 * 24 * 3_600_000

// ── what started each agent's turn ──
const turnOrigin = new Map<string, ActivityOrigin>()
/** the owner's last message to an agent from the dashboard (matched to the turn it starts) */
const ownerSent = new Map<string, ActivityOrigin>()

export const originOfTurn = (agentId: string) => turnOrigin.get(agentId)
/** which manager's message an agent will read next ([From the manager] …), in order, while queued */
const managerSent = new Map<string, string[]>()
export function noteManagerMessage(agentId: string, managerId: string) {
  managerSent.set(agentId, [...(managerSent.get(agentId) ?? []), managerId].slice(-20))
}
export function takeManagerMessage(agentId: string) {
  const list = managerSent.get(agentId)
  const id = list?.shift()
  if (list && !list.length) managerSent.delete(agentId)
  return id ?? null
}
export const setTurnOrigin = (agentId: string, o: ActivityOrigin) => void turnOrigin.set(agentId, o)

/** The owner typed to this agent in the dashboard (their device and IP). */
export function noteOwnerMessage(agentId: string, who: { device: string; ip: string }) {
  ownerSent.set(agentId, { kind: 'owner', label: 'Your chat', device: who.device, ip: who.ip, at: Date.now() })
}
/** The owner's message, if it's the one this turn is about (sent within the last two minutes). */
export function takeOwnerMessage(agentId: string) {
  const o = ownerSent.get(agentId)
  ownerSent.delete(agentId)
  return o && Date.now() - (o.at ?? 0) < 120_000 ? o : null
}

// ── what the agent read in this turn (shown next to a write: where an instruction could have come from) ──
const reads = new Map<string, string[]>()
export const clearReads = (agentId: string) => void reads.delete(agentId)

function noteRead(agentId: string, what: string) {
  const list = reads.get(agentId) ?? []
  list.push(what.slice(0, 200))
  reads.set(agentId, list.slice(-10))
}

// ── masking ──
const SECRET_KEY = /token|secret|passw|api[_-]?key|authori[sz]ation|cookie|credential|private[_-]?key|session/i
// known token shapes only (a long ID, e.g. a Drive file's, stays readable)
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|eyJ|ya29\.|glpat-|tk_)[\w.-]{8,}/

/** A tool's input for the log: long values cut, anything that looks secret masked, at most ~600 characters. */
export function maskInput(input: unknown): string {
  const walk = (v: unknown, key = '', depth = 0): unknown => {
    if (SECRET_KEY.test(key)) return '••••'
    if (typeof v === 'string') {
      if (SECRET_VALUE.test(v.trim())) return '••••'
      return v.length > 200 ? `${v.slice(0, 200)}… (${v.length} characters)` : v
    }
    if (depth > 4) return '…'
    if (Array.isArray(v)) return v.length > 10 ? [...v.slice(0, 10).map((x) => walk(x, key, depth + 1)), `… ${v.length - 10} more`] : v.map((x) => walk(x, key, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k, depth + 1)]))
    return v
  }
  const text = JSON.stringify(walk(input ?? {}))
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

/** The start of what a tool returned, masked like the input; and whether it was an error. */
function summarizeResult(response: unknown): { text: string; error: boolean } {
  const r = response as { isError?: boolean; is_error?: boolean; content?: unknown; error?: unknown } | string | null
  const error = typeof r === 'object' && !!r && (r.isError === true || r.is_error === true || !!r.error)
  let text = ''
  if (typeof r === 'string') text = r
  else if (Array.isArray(r)) text = r.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ')
  else if (r && Array.isArray(r.content)) text = (r.content as { text?: unknown }[]).map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
  else if (r) text = JSON.stringify(r)
  text = text.replace(/\s+/g, ' ').trim()
  const masked = text
    .split(' ')
    .map((w) => (SECRET_VALUE.test(w) ? '••••' : w))
    .join(' ')
  return { text: masked.length > 300 ? `${masked.slice(0, 300)}…` : masked, error: error || /^error\b/i.test(text) }
}

// ── entries ──
const split = (tool: string) => {
  const m = tool.match(/^(mcp__[^_].*?)__(.+)$/)
  return m ? { prefix: m[1], name: m[2] } : null
}
/** Only connectors: the office's own tools (the manager's) aren't activity with the outside world. */
const logged = (tool?: string) => !!tool && tool.startsWith('mcp__') && !tool.startsWith(`${OFFICE_TOOLS_PREFIX}__`)
const entryId = (agentId: string, toolUseId?: string) => `${agentId}:${toolUseId ?? crypto.randomUUID()}`

// PermissionRequest comes without the tool_use_id: match it to this agent's latest call of the same tool, and the
// owner's answer (by follow-up id) to that entry
const lastCall = new Map<string, string>()
const byFollowUp = new Map<string, string>()

let writes = 0
function save(e: ActivityEntry) {
  activityRepo.put(e)
  publish({ type: 'activity', entry: e })
  // forget what's older than 90 days, now and then
  if (++writes % 200 === 1) activityRepo.prune(Date.now() - KEEP_MS)
}

/** PreToolUse: the agent is about to call a connector tool (waiting: the owner is asked first). */
export function toolStarting(agentId: string, tool: string | undefined, input: unknown, toolUseId: string | undefined, waiting: boolean) {
  if (!logged(tool)) return
  const t = split(tool!)
  if (!t) return
  const access = toolReads(t.prefix, t.name) ? 'read' : 'write'
  const before = reads.get(agentId)
  const e: ActivityEntry = {
    id: entryId(agentId, toolUseId),
    at: Date.now(),
    agentId,
    agentName: agentsRepo.get(agentId)?.name ?? agentId,
    kind: 'tool',
    connector: connectorLabel(t.prefix),
    tool: t.name,
    access,
    input: maskInput(input),
    status: waiting ? 'waiting' : 'running',
    ...(waiting ? {} : { decision: { by: 'auto' as const, allowed: true, at: Date.now() } }),
    ...(turnOrigin.get(agentId) ? { origin: turnOrigin.get(agentId) } : {}),
    ...(access === 'write' && before?.length ? { readBefore: [...before] } : {}),
  }
  lastCall.set(`${agentId} ${tool}`, e.id)
  save(e)
}

/** PermissionRequest for a connector tool: it waits for the owner (their answer comes as `followUpId`). */
export function toolWaiting(agentId: string, tool: string | undefined, input: unknown, toolUseId: string | undefined, followUpId: string) {
  if (!logged(tool)) return
  const id = (toolUseId && entryId(agentId, toolUseId)) || lastCall.get(`${agentId} ${tool}`)
  const cur = id ? activityRepo.get(id) : null
  if (!cur || cur.doneAt) {
    toolStarting(agentId, tool, input, toolUseId, true)
    const made = lastCall.get(`${agentId} ${tool}`)
    if (made) byFollowUp.set(followUpId, made)
    return
  }
  byFollowUp.set(followUpId, cur.id)
  const { decision: _auto, ...rest } = cur
  save({ ...rest, status: 'waiting' })
}

/** The owner answered a connector tool's permission prompt (the follow-up id is agentId:toolUseId, as the entry's). */
export function toolDecided(followUpId: string, allowed: boolean, who: { device: string; ip: string }) {
  const id = byFollowUp.get(followUpId) ?? followUpId
  byFollowUp.delete(followUpId)
  const cur = activityRepo.get(id)
  if (!cur) return
  save({ ...cur, status: allowed ? 'running' : 'denied', decision: { by: 'owner', allowed, at: Date.now(), device: who.device, ip: who.ip }, ...(allowed ? {} : { doneAt: Date.now() }) })
}

/** PostToolUse: the tool ran. Reads count toward "what it read before" a later write in the same turn. */
export function toolFinished(agentId: string, tool: string | undefined, input: unknown, response: unknown, toolUseId: string | undefined) {
  if (tool === 'WebFetch') noteRead(agentId, `Web page: ${String((input as { url?: unknown })?.url ?? '')}`)
  if (tool === 'WebSearch') noteRead(agentId, `Web search: ${String((input as { query?: unknown })?.query ?? '')}`)
  if (!logged(tool)) return
  const cur = activityRepo.get(entryId(agentId, toolUseId))
  const r = summarizeResult(response)
  if (cur) {
    save({ ...cur, status: r.error ? 'error' : 'ok', result: r.text, doneAt: Date.now(), decision: cur.decision ?? { by: 'auto', allowed: true, at: cur.at } })
    if (cur.access === 'read') noteRead(agentId, `${cur.connector} · ${cur.tool}${cur.input && cur.input !== '{}' ? ` ${cur.input.slice(0, 120)}` : ''}`)
  }
}

/** Something about the log itself (e.g. an agent's hooks were changed and put back). */
export function logSystem(agentId: string, message: string) {
  save({ id: entryId(agentId), at: Date.now(), agentId, agentName: agentsRepo.get(agentId)?.name ?? agentId, kind: 'system', status: 'info', message })
}
