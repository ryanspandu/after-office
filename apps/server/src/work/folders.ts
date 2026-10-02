import type { OfficeTask, OwnerNote, WorkReport } from '@after-office/shared'
import { existsSync, statSync } from 'node:fs'
import { legacyProjectsRepo, ownerNotesRepo, reportsRepo, tasksRepo } from '../db'
import { AgentError, resolveCwd } from '../agents/manager'

// Tasks used to belong to a dashboard project (a name, a colour, a brief, a check and a folder); now a task just has
// the folder its agent works in, and tags do the grouping. Each task, report and note of a project gets that project's
// folder (when it had one; a note keeps a folder of its own). Then the old projects go for good. Runs at every start; only
// touches what still has a project.

type Legacy<T> = T & { projectId?: string | null }

export function moveProjectsToFolders() {
  for (const t of tasksRepo.all() as Legacy<OfficeTask>[]) {
    if (!('projectId' in t)) continue
    const { projectId, ...rest } = t
    const folder = projectId ? legacyProjectsRepo.folderOf(projectId) : null
    tasksRepo.put(folder && !rest.folder ? { ...rest, folder } : rest)
  }
  for (const r of reportsRepo.all() as Legacy<WorkReport>[]) {
    if (!('projectId' in r)) continue
    const { projectId, ...rest } = r
    const folder = projectId ? legacyProjectsRepo.folderOf(projectId) : null
    reportsRepo.put(folder && !rest.folder ? { ...rest, folder } : rest)
  }
  for (const n of ownerNotesRepo.all() as Legacy<OwnerNote>[]) {
    if (!('projectId' in n)) continue
    const { projectId, ...rest } = n
    const folder = projectId ? legacyProjectsRepo.folderOf(projectId) : null
    ownerNotesRepo.put(folder && !rest.folder ? { ...rest, folder } : rest)
  }
  // nothing points at the old projects any more: gone, with their names, briefs and checks
  if (legacyProjectsRepo.exists()) legacyProjectsRepo.drop()
}

/**
 * A task's folder as sent by the owner or the manager: a folder agents may work in (inside OFFICE_ROOT, links
 * resolved) that exists. Empty / null: none (the agent's own folder).
 */
export function cleanFolder(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || v.length > 1000) throw new AgentError('A folder is a path', 400)
  const path = resolveCwd(v)
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new AgentError(`No folder at ${v}`, 400)
  return path
}
