import { agentsRepo, queueRepo, sideSessionsRepo, tasksRepo } from '../db'
import { AgentError } from './errors'
import { closeSideSession, reviveAgent } from './manager'
import { runtimeOf, sideRuntimeOf, updateRuntime } from './registry'
import { tmux } from './tmux'

// Sleep: an agent's Claude Code process is stopped so its memory comes back (each one holds 200–450 MB even when it
// does nothing). Everything else stays: folder, notes, secrets, tasks and the conversation. The reconciler doesn't
// start it again; work that comes in for it (a task, a daily job, a chat message, the manager) wakes it up: the session
// starts again with --resume, ready in about 5–15 s. Idle agents go to sleep by themselves after the hours picked in
// Office settings (autoSleepMinutes). Never the manager: everyone's reports arrive there.

export const isAsleep = (agentId: string) => !!agentsRepo.get(agentId)?.asleep_at

/** Why this agent can't be put to sleep now (null: it can). */
export function sleepBlocker(agentId: string): string | null {
  const row = agentsRepo.get(agentId)
  if (!row) return 'no such agent'
  if (row.kind === 'manager') return "the manager doesn't sleep: everyone's reports arrive there"
  if (row.asleep_at) return 'already asleep'
  if (waking.has(agentId)) return 'waking up'
  const rt = runtimeOf(agentId)
  if (rt.status === 'working' || rt.status === 'waiting') return `${row.name} is ${rt.status === 'working' ? 'working' : 'waiting for you'}`
  if (rt.compactingSince) return `${row.name} is compacting its conversation`
  if (queueRepo.countFor(agentId)) return `${row.name} has work waiting in its queue`
  if (tasksRepo.active().some((t) => t.agentId === agentId && t.status === 'in_progress')) return `${row.name} has a task in progress`
  const busySide = sideSessionsRepo.forAgent(agentId).find((s) => !s.closed_at && ['working', 'waiting'].includes(sideRuntimeOf(agentId, s.key).status))
  if (busySide) return `one of ${row.name}'s other sessions (${busySide.key}) is busy`
  return null
}

/** Put an agent to sleep: its sessions stop (side sessions close; all conversations are kept). */
export async function sleepAgent(agentId: string, by: 'owner' | 'auto' = 'owner') {
  const why = sleepBlocker(agentId)
  if (why) throw new AgentError(`Can't put it to sleep: ${why}`, 409)
  const row = agentsRepo.get(agentId)!
  // first: the reconciler mustn't start it again in between
  agentsRepo.update(agentId, { asleep_at: Date.now() })
  for (const side of sideSessionsRepo.forAgent(agentId)) if (!side.closed_at) await closeSideSession(agentId, side.key).catch(() => {})
  await tmux.killSession(row.tmux_session).catch(() => {})
  idleSince.delete(agentId)
  updateRuntime(agentId, (rt) => ({ ...rt, status: 'offline', waitingFor: undefined, tool: undefined, task: undefined }))
  log(agentId, by === 'auto' ? 'Went to sleep (idle for a while): its session stopped, the conversation is kept.' : 'Put to sleep by the owner: its session stopped, the conversation is kept.')
  console.log(`[sleep] ${row.name} is asleep (${by})`)
}

const waking = new Map<string, Promise<void>>()
/** Was asleep and is starting up right now. */
export const isWaking = (agentId: string) => waking.has(agentId)

/** Wake an asleep agent: its session starts again in the same conversation. Resolves once it's started (not ready:
 *  see untilAwake). Nothing for an agent that's awake. */
export function wakeAgent(agentId: string, why: string): Promise<void> {
  const busy = waking.get(agentId)
  if (busy) return busy
  const row = agentsRepo.get(agentId)
  if (!row?.asleep_at) return Promise.resolve()
  agentsRepo.update(agentId, { asleep_at: null })
  idleSince.delete(agentId)
  updateRuntime(agentId, (rt) => ({ ...rt, status: 'offline' }))
  const p = reviveAgent(agentsRepo.get(agentId)!)
    .then(() => {
      log(agentId, `Woke up: ${why}.`)
      console.log(`[sleep] ${row.name} woke up (${why})`)
    })
    // the reconciler starts it again on its next round
    .catch((e) => console.error(`[sleep] could not wake ${row.name}:`, e instanceof Error ? e.message : e))
    .finally(() => waking.delete(agentId))
  waking.set(agentId, p)
  return p
}

/** Wait until a (just woken) agent's session is up and at its prompt. */
export async function untilAwake(agentId: string, ms = 45_000) {
  const row = agentsRepo.get(agentId)
  if (!row) return false
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (runtimeOf(agentId).status === 'idle' && (await tmux.hasSession(row.tmux_session))) return true
    await Bun.sleep(500)
  }
  return false
}

/** Since when each awake agent (and all its sessions) has been idle without a break; reset on a server restart. */
const idleSince = new Map<string, number>()

/** Put agents to sleep that have been idle longer than the office allows. Runs every minute. */
export async function autoSleep(minutes: number, now = Date.now()) {
  for (const row of agentsRepo.all()) {
    if (row.kind === 'manager' || row.asleep_at) continue
    const sides = sideSessionsRepo.forAgent(row.id).filter((s) => !s.closed_at)
    const idle = runtimeOf(row.id).status === 'idle' && sides.every((s) => sideRuntimeOf(row.id, s.key).status === 'idle')
    if (!idle) {
      idleSince.delete(row.id)
      continue
    }
    const since = idleSince.get(row.id) ?? now
    idleSince.set(row.id, since)
    if (!minutes || now - since < minutes * 60_000 || sleepBlocker(row.id)) continue
    await sleepAgent(row.id, 'auto').catch((e) => console.warn(`[sleep] ${row.name}:`, e instanceof Error ? e.message : e))
  }
}

const log = (agentId: string, message: string) =>
  void import('../work/activity').then((m) => m.logSystem(agentId, message)).catch(() => {})
