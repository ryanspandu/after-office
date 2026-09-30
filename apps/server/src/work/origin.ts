import type { ActivityOrigin } from '@after-office/shared'
import { agentsRepo, tasksRepo } from '../db'
import { bossMode } from './settings'
import { clearReads, originOfTurn, setTurnOrigin, takeManagerMessage, takeOwnerMessage } from './activity'
import { active } from './work'

// Why an agent is doing what it does: the origin of each turn (the owner's chat, a task and who made it, a daily job,
// a webhook, the manager), for the Activity log (activity.ts).

/** webhook runs of daily jobs: who called (IP), until the run's prompt arrives */
export const webhookCalls = new Map<string, ActivityOrigin>()

/** An origin with at most `depth` steps behind it (a chain can't grow forever). */
function shallow(o: ActivityOrigin | undefined, depth = 2): ActivityOrigin | undefined {
  if (!o) return undefined
  const { via, ...rest } = o
  return depth > 0 && via ? { ...rest, via: shallow(via, depth - 1) } : rest
}

/** The manager (and what started its current turn), as the origin of what it asks for. */
export function managerOrigin(managerId: string): ActivityOrigin {
  const m = agentsRepo.get(managerId)
  return { kind: 'manager', label: m?.name ?? 'The manager', at: Date.now(), ...(bossMode() ? { boss: true } : {}), ...(originOfTurn(managerId) ? { via: shallow(originOfTurn(managerId)) } : {}) }
}

/** A turn started: remember what started it, followed back as far as the office knows. */
export function trackTurnOrigin(agentId: string, prompt: string) {
  // a background subagent reporting back: the same work goes on
  if (/^\s*<task-notification>/.test(prompt)) return
  clearReads(agentId)
  const owner = takeOwnerMessage(agentId)
  const a = active.get(agentId)
  let o: ActivityOrigin
  if (owner) o = owner
  else if (a?.taskId) {
    const t = tasksRepo.get(a.taskId)
    o = { kind: 'task', label: t?.title ?? a.title, ...(t?.origin ? { via: shallow(t.origin) } : {}) }
  } else if (a?.cronId) {
    const hook = webhookCalls.get(a.cronId)
    webhookCalls.delete(a.cronId)
    o = hook ? { ...hook, label: a.title } : { kind: 'cron', label: a.title }
  } else if (prompt.includes('<<<REPORT')) o = { kind: 'report', label: prompt.split('\n')[0].replace(/^\[After Office\]\s*/, '').slice(0, 140) }
  else if (prompt.startsWith('[From the manager]')) {
    const m = takeManagerMessage(agentId) ?? agentsRepo.manager()?.id
    o = m ? managerOrigin(m) : { kind: 'manager', label: 'The manager' }
  } else if (prompt.startsWith('[After Office]') || prompt.startsWith('[From the owner')) o = { kind: 'agent', label: 'A message from After Office' }
  else o = { kind: 'agent', label: 'Its own follow-up' }
  setTurnOrigin(agentId, { ...o, at: o.at ?? Date.now() })
}
