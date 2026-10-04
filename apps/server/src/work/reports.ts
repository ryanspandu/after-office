import type { ReportOutcome, WorkJob, WorkReport } from '@after-office/shared'
import { agentsRepo, reportsRepo } from '../db'
import { AgentError } from '../agents/manager'
import { agentFiles } from '../agents/files'
import { mentionedPaths } from '@after-office/shared'
import { publishWork } from './work'
import { MAX_TAGS_PER_ITEM } from './tags'

// Reports: the manager's notes to the owner, and marking reports read or tagged.

/** Something the manager wants the user to see outside the chat: filed as an unread report. */
export function notifyUser(managerId: string, title: string, text: string, tags?: string[], folder?: string, job?: WorkJob, outcome?: ReportOutcome) {
  const now = Date.now()
  const report: WorkReport = {
    id: crypto.randomUUID(),
    kind: 'note',
    refId: managerId,
    title: title.trim().slice(0, 200) || 'Note from the manager',
    agentId: managerId,
    text: text.trim().slice(0, 20_000),
    ok: true,
    startedAt: now,
    finishedAt: now,
    read: false,
    ...(tags?.length ? { tags } : {}),
    ...(folder ? { folder } : {}),
    ...(job ? { job } : {}),
    ...(outcome ? { outcome } : {}),
  }
  // files it points at (its team's work, the office's folders) become the note's attachments
  const row = agentsRepo.get(managerId)
  const files = row ? agentFiles(row, mentionedPaths(report.text)) : []
  if (files.length) report.files = files
  reportsRepo.put(report)
  reportsRepo.prune()
  publishWork('reports')
  return report
}

/** The owner changed a report's tags. */
export function setReportTags(id: string, tags: string[] | undefined) {
  const r = reportsRepo.get(id)
  if (!r) throw new AgentError('No such report', 404)
  const { tags: _, ...rest } = r
  reportsRepo.put(tags?.length ? { ...rest, tags } : rest)
  publishWork('reports')
}

/**
 * Tags added to / taken off reports already filed (a task's tags are copied onto its reports when they're filed, so a
 * tag given to the task later doesn't reach the old ones): one broadcast for all. Returns how many changed.
 */
export function retagReports(ids: string[], add: string[], remove: string[]) {
  let n = 0
  for (const id of ids) {
    const r = reportsRepo.get(id)
    if (!r) continue
    const before = r.tags ?? []
    const after = [...new Set([...before.filter((t) => !remove.includes(t)), ...add])].slice(0, MAX_TAGS_PER_ITEM)
    if (after.length === before.length && after.every((t) => before.includes(t))) continue
    const { tags: _, ...rest } = r
    reportsRepo.put(after.length ? { ...rest, tags: after } : rest)
    n++
  }
  if (n) publishWork('reports')
  return n
}

export function markReport(id: string, read: boolean) {
  const r = reportsRepo.get(id)
  if (!r) throw new AgentError('No such report', 404)
  reportsRepo.put({ ...r, read })
  publishWork('reports')
}

/** Several at once (Reports → pick → Read / Unread / Delete): one broadcast, not one per report. Unknown ids are
 *  skipped (another tab may have deleted them already). Returns how many were changed. */
const MAX_BULK = 500
export const bulkIds = (ids: unknown): string[] => {
  if (!Array.isArray(ids) || ids.length > MAX_BULK || ids.some((x) => typeof x !== 'string')) throw new AgentError(`ids: a list of at most ${MAX_BULK} report ids`, 400)
  return [...new Set(ids as string[])]
}
export function markReports(ids: unknown, read: boolean) {
  let n = 0
  for (const id of bulkIds(ids)) {
    const r = reportsRepo.get(id)
    if (r && r.read !== read) (reportsRepo.put({ ...r, read }), n++)
  }
  if (n) publishWork('reports')
  return n
}
export function removeReports(ids: unknown) {
  let n = 0
  for (const id of bulkIds(ids)) if (reportsRepo.get(id)) (reportsRepo.remove(id), n++)
  if (n) publishWork('reports')
  return n
}

export function markAllReportsRead() {
  for (const r of reportsRepo.latest(1000)) if (!r.read) reportsRepo.put({ ...r, read: true })
  publishWork('reports')
}
