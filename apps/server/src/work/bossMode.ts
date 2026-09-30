import { agentsRepo, tasksRepo } from '../db'
import { AgentError } from '../agents/manager'
import { getPending } from '../agents/registry'
import { bossMode, bossModeState, saveBossMode } from './settings'
import { publishWork, timezone } from './work'
import { approvalId, decideDelegation } from './managerTasks'
import { notifyUser } from './reports'

// Boss mode (the state: settings.ts): turning it on and off, with a report of what the manager did meanwhile.

// ── Boss mode (the state: settings.ts) ──

const clock = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone(), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms)

/** The longest a Boss mode may last. */
export const BOSS_MAX_MS = 7 * 24 * 3_600_000

/**
 * Turn Boss mode on until `until` (the route checked the owner's 2FA code). With `runWaiting`, the manager's tasks
 * already waiting for approval start too. Filed as a report, so there's a trace of when it was on.
 */
export async function startBossMode(until: number, runWaiting = false) {
  const now = Date.now()
  if (!Number.isFinite(until) || until <= now + 60_000 || until > now + BOSS_MAX_MS) throw new AgentError('Pick an end between a minute and 7 days from now')
  const cur = bossMode()
  saveBossMode({ since: cur?.since ?? now, until, tasks: cur?.tasks ?? 0, messages: cur?.messages ?? 0, sendBacks: cur?.sendBacks ?? 0 })
  publishWork('bossMode')
  let started = 0
  if (runWaiting)
    for (const t of tasksRepo.active().filter((x) => x.awaitingApproval)) {
      const f = getPending(approvalId(t.id))
      if (!f) continue
      await decideDelegation(f, { type: 'allow' })
      started++
    }
  const manager = agentsRepo.manager()
  if (manager && !cur)
    notifyUser(
      manager.id,
      `Boss mode on until ${clock(until)}`,
      `${manager.name} delegates, messages agents and sends work back without your approval until ${clock(until)}.${started ? ` ${started} waiting task${started > 1 ? 's' : ''} started.` : ''} Hires, connector writes and quality checks still ask you.`,
    )
  return { until, started }
}

/** Boss mode off (the owner, or its time ran out): back to approvals, with a short report of what happened. */
export function endBossMode(why: 'owner' | 'expired') {
  const b = bossModeState()
  if (!b) return false
  saveBossMode(null)
  publishWork('bossMode')
  const manager = agentsRepo.manager()
  if (manager) {
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`
    notifyUser(
      manager.id,
      why === 'expired' ? 'Boss mode ended' : 'Boss mode turned off',
      `From ${clock(b.since)} to ${clock(Math.min(Date.now(), b.until))}: ${manager.name} started ${n(b.tasks, 'task')}, sent ${n(b.messages, 'message')} to agents and sent work back ${n(b.sendBacks, 'time')} without approval. Approvals apply again.`,
    )
  }
  return true
}
