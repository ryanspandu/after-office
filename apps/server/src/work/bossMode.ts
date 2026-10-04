import { tasksRepo } from '../db'
import { AgentError } from '../agents/manager'
import { getPending } from '../agents/registry'
import { bossMode, bossModeState, saveBossMode } from './settings'
import { publishWork } from './work'
import { approvalId, decideDelegation } from './managerTasks'

// Boss mode (the state: settings.ts): turning it on and off, with a report of what the manager did meanwhile.

// ── Boss mode (the state: settings.ts) ──


/** The longest a Boss mode may last. */
export const BOSS_MAX_MS = 7 * 24 * 3_600_000

/**
 * Turn Boss mode on until `until` (the route checked the owner's 2FA code). With `runWaiting`, the manager's tasks
 * already waiting for approval start too. No report: the navbar badge shows it while it's on.
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
  // (no report: the navbar badge shows it while it's on)
  return { until, started }
}

/** Boss mode off (the owner, or its time ran out): back to approvals, with a short report of what happened. */
export function endBossMode(why: 'owner' | 'expired') {
  const b = bossModeState()
  if (!b) return false
  saveBossMode(null)
  publishWork('bossMode')
  // (no report: what the manager did meanwhile is on the tasks themselves)
  console.log(`[boss] off (${why}): ${b.tasks} tasks, ${b.messages} messages, ${b.sendBacks} send-backs`)
  return true
}
