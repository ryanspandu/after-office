import type { CronJob, FollowUpDecision, LiveFollowUp } from '@after-office/shared'
import { agentsRepo, cronsRepo, settingsRepo, triggersRepo } from '../db'
import { AgentError } from '../agents/errors'
import { addPending, getPending, resolvePending } from '../agents/registry'
import { bossMode, officeSettings } from './settings'
import { cleanCron } from './crons'
import { deliver, isReadingAgentOutput, notifyUser, publishWork } from './work'

// The manager's daily jobs (MCP: list/create/update/delete_daily_job). The same rules as its tasks (delegate_task):
// they apply right away, unless the owner asked to approve the manager's work first, or the manager asks right after
// reading an agent's report (what that report says could be steering it); Boss mode lifts both. A change that waits
// is a card under "For you" (kind 'daily'), kept in the settings table so it survives a restart.

export type CronChange =
  | { action: 'create'; cron: CronJob }
  | { action: 'update'; cron: CronJob; previous: CronJob }
  | { action: 'delete'; previous: CronJob }

interface PendingChange {
  id: string
  managerId: string
  change: CronChange
  reason?: string
  createdAt: number
}

const KEY = 'pendingCronChanges'
const load = (): PendingChange[] => {
  try {
    return JSON.parse(settingsRepo.get(KEY) ?? '[]')
  } catch {
    return []
  }
}
const save = (list: PendingChange[]) => settingsRepo.set(KEY, JSON.stringify(list))

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const when = (c: Pick<CronJob, 'times' | 'days'>) =>
  `${c.days.length === 7 ? 'every day' : c.days.map((d) => WEEKDAYS[d]).join(', ')} at ${c.times.join(', ')}`
const agentName = (id: string | null) => (id ? (agentsRepo.get(id)?.name ?? 'a removed agent') : 'nobody yet')

/** One line for the owner (the approval card, the report). */
function describe(c: CronChange) {
  if (c.action === 'delete') return `Delete the daily job "${c.previous.name}" (${agentName(c.previous.agentId)}, ${when(c.previous)})`
  const job = c.cron
  const verb = c.action === 'create' ? 'New daily job' : 'Change the daily job'
  return `${verb} "${job.name}" for ${agentName(job.agentId)}, ${when(job)}${job.enabled ? '' : ' (off)'}`
}

function apply(managerId: string, c: CronChange) {
  if (c.action === 'delete') {
    cronsRepo.remove(c.previous.id)
    triggersRepo.remove(c.previous.id)
  } else cronsRepo.put(c.cron)
  publishWork('crons')
  // a trace for the owner, like every change the manager makes on its own
  notifyUser(managerId, describe(c), c.action === 'delete' ? 'It no longer runs.' : `Prompt:\n\n${c.cron.prompt}`)
}

const cardId = (id: string) => `daily:${id}`

function show(p: PendingChange) {
  const c = p.change
  const job = c.action === 'delete' ? c.previous : c.cron
  addPending({
    id: cardId(p.id),
    agentId: p.managerId,
    kind: 'daily',
    tool: `${c.action}_daily_job`,
    message: describe(c),
    input: {
      action: c.action,
      name: job.name,
      agent: agentName(job.agentId),
      schedule: when(job),
      prompt: job.prompt,
      ...(c.action === 'update' && c.previous.prompt !== c.cron.prompt ? { previousPrompt: c.previous.prompt } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
    },
    createdAt: p.createdAt,
  })
}

/** Apply the manager's change now, or ask the owner first (the rules above). */
export function changeCron(managerId: string, change: CronChange): 'applied' | 'approval' {
  const boss = !!bossMode()
  const guarded = !boss && isReadingAgentOutput(managerId)
  if (boss || (!officeSettings().managerApproval && !guarded)) {
    apply(managerId, change)
    return 'applied'
  }
  const p: PendingChange = {
    id: crypto.randomUUID().slice(0, 12),
    managerId,
    change,
    ...(guarded ? { reason: "Asked right after an agent's report: check it isn't something that report slipped in." } : {}),
    createdAt: Date.now(),
  }
  save([...load(), p])
  show(p)
  return 'approval'
}

/** The manager's input → a checked daily job (a new one, or the existing one with these fields changed). */
export function cronFrom(input: Partial<CronJob> & { id?: string }, previous?: CronJob) {
  const id = previous?.id ?? `cron-${crypto.randomUUID().slice(0, 12)}`
  const merged = { ...previous, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }
  if (merged.agentId && !agentsRepo.get(merged.agentId)) throw new AgentError('No such agent; see list_agents', 404)
  return cleanCron(id, merged, previous ?? null)
}

/** The owner's answer to a waiting change. */
export async function decideCron(f: LiveFollowUp, d: FollowUpDecision) {
  const id = f.id.slice('daily:'.length)
  resolvePending(f.id)
  const list = load()
  const p = list.find((x) => x.id === id)
  save(list.filter((x) => x.id !== id))
  if (!p) return
  if (d.type === 'allow') {
    // what it changes may have moved meanwhile (edited or deleted in the dashboard): apply to what's there now
    if (p.change.action !== 'create' && !cronsRepo.get(p.change.previous.id)) return
    apply(p.managerId, p.change)
    return
  }
  if (d.type !== 'deny') throw new AgentError('Approve or reject this daily job')
  if (agentsRepo.get(p.managerId)) {
    const note = d.note?.trim()
    await deliver(p.managerId, `[After Office] The owner rejected this change: ${describe(p.change)}${note ? `. Their note: ${note}` : '.'} Nothing was changed.`)
  }
}

/** After a restart: the changes that were waiting are asked again. */
export function restoreCronChanges() {
  for (const p of load()) if (!getPending(cardId(p.id))) show(p)
}

/** Waiting changes (for the manager's list_daily_jobs). */
export const pendingCronChanges = () => load().map((p) => ({ waitingForOwner: describe(p.change), since: new Date(p.createdAt).toISOString() }))
