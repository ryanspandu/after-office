import type { WorkReport } from '@after-office/shared'
import { agentsRepo, reportsRepo } from '../db'
import { AgentError } from '../agents/manager'
import { agentFiles } from '../agents/files'
import { mentionedPaths } from '@after-office/shared'
import { publishWork } from './work'

// Reports: the manager's notes to the owner, and marking reports read or tagged.

/** Something the manager wants the user to see outside the chat: filed as an unread report. */
export function notifyUser(managerId: string, title: string, text: string, tags?: string[], folder?: string) {
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

export function markReport(id: string, read: boolean) {
  const r = reportsRepo.get(id)
  if (!r) throw new AgentError('No such report', 404)
  reportsRepo.put({ ...r, read })
  publishWork('reports')
}

export function markAllReportsRead() {
  for (const r of reportsRepo.latest(1000)) if (!r.read) reportsRepo.put({ ...r, read: true })
  publishWork('reports')
}
