import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentsRepo, extraDirsOf, folderNotesRepo, ownerNotesRepo, reportsRepo, tasksRepo } from '../db'
import { AgentError } from '../agents/errors'
import { revokeFolder } from '../agents/manager'
import { runAsAgent } from '../agents/asagent'
import { AGENTS_DIR, PROJECTS_DIR } from '../fsroots'
import type { AgentRow } from '../db'

// Folders the office makes for work: <AGENTS_DIR>/project/<name> (the Folders tab → New folder). Only these (and the
// folders of removed agents) can be deleted from the dashboard; a task may also work in an agent's folder or a repo,
// which are never deleted from here.

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

/** A new, empty folder called `name` (seo, seo-2, … if taken). */
export function makeProjectFolder(name: string) {
  const base = slug(name) || 'folder'
  mkdirSync(PROJECTS_DIR, { recursive: true })
  for (let i = 1; i < 100; i++) {
    const path = join(PROJECTS_DIR, i === 1 ? base : `${base}-${i}`)
    if (existsSync(path)) continue
    mkdirSync(path)
    return path
  }
  throw new AgentError('Could not find a free folder name', 409)
}

/** The folder is one the office made: directly in PROJECTS_DIR, a real folder (not a symlink). */
export function isOwnProjectFolder(folder: string | undefined) {
  if (!folder) return false
  try {
    return !lstatSync(folder).isSymbolicLink() && lstatSync(folder).isDirectory() && dirname(realpathSync(folder)) === PROJECTS_DIR
  } catch {
    return false
  }
}

/**
 * Rename a folder in the office's own folder (the Folders tab): its tasks, reports and notes follow. Not while one of
 * its tasks is being worked on (the agent would lose its place).
 */
export function renameProjectFolder(folder: string, name: string) {
  if (!isOwnProjectFolder(folder)) throw new AgentError('Only folders in the projects folder can be renamed here', 403)
  const old = realpathSync(folder)
  const base = slug(name)
  if (!base) throw new AgentError('Give it a name (letters, numbers, dashes)')
  const next = join(PROJECTS_DIR, base)
  if (next === old) return { folder: old }
  if (existsSync(next)) throw new AgentError(`There is already a folder called ${base}`, 409)
  const inside = (f?: string) => !!f && (f === old || f === folder || f.startsWith(`${old}/`))
  const busy = tasksRepo.active().some((t) => t.status === 'in_progress' && inside(t.folder))
  if (busy) throw new AgentError('One of its tasks is being worked on right now: rename it once that is done', 409)
  renameSync(old, next)
  folderNotesRepo.move(old, next)
  ownerNotesRepo.moveFolder(old, next)
  const moved = (f: string) => next + (f.startsWith(old) ? f.slice(old.length) : '')
  for (const t of tasksRepo.all()) if (inside(t.folder)) tasksRepo.put({ ...t, folder: moved(t.folder!) })
  for (const r of reportsRepo.all()) if (inside(r.folder)) reportsRepo.put({ ...r, folder: moved(r.folder!) })
  return { folder: next }
}

/** How many files and folders are in it (shown before deleting), up to a limit. */
export function countEntries(folder: string, limit = 10_000) {
  let n = 0
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (++n >= limit) return
      if (d.isDirectory() && !d.isSymbolicLink()) walk(join(dir, d.name))
    }
  }
  try {
    walk(folder)
  } catch {
    // unreadable parts are not counted
  }
  return n
}

/**
 * An agent's own folder the office made, <AGENTS_DIR>/<name>: a real folder directly in the agents' folder, not the
 * projects folder, and nobody else works in it. Agents working in a repo or any other folder never qualify.
 */
export function isOwnAgentFolder(row: AgentRow) {
  try {
    if (lstatSync(row.cwd).isSymbolicLink() || !lstatSync(row.cwd).isDirectory()) return false
    const real = realpathSync(row.cwd)
    if (dirname(real) !== AGENTS_DIR || real === PROJECTS_DIR || real.split('/').pop()!.startsWith('.')) return false
    return !agentsRepo.all().some((a) => a.id !== row.id && (() => {
      try {
        return realpathSync(a.cwd) === real
      } catch {
        return false
      }
    })())
  } catch {
    return false
  }
}

/** Delete a removed agent's own folder (checked with isOwnAgentFolder before the agent went). */
export async function deleteAgentFolder(path: string) {
  const real = realpathSync(path)
  if (dirname(real) !== AGENTS_DIR || real === PROJECTS_DIR) throw new AgentError('Only agent folders in the agents folder can be deleted', 400)
  try {
    rmSync(real, { recursive: true, force: true })
  } catch {
    await runAsAgent(['rm', '-rf', '--', real], { cwd: AGENTS_DIR, timeoutMs: 60_000 })
  }
  if (existsSync(real)) throw new AgentError('Could not delete the whole folder; some files are still there', 500)
}

/** Delete a project folder the office made, after taking it away from agents that were given it. */
export async function deleteProjectFolder(folder: string) {
  if (!isOwnProjectFolder(folder)) throw new AgentError(`Only project folders in ${PROJECTS_DIR} can be deleted here`, 400)
  const path = realpathSync(folder)
  for (const a of agentsRepo.all()) {
    if (extraDirsOf(a).includes(path)) await revokeFolder(a.id, path).catch(() => {})
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // files the agents' user made (hardened VPS layout): remove them with its rights
    await runAsAgent(['rm', '-rf', '--', path], { cwd: PROJECTS_DIR, timeoutMs: 60_000 })
  }
  if (existsSync(path)) throw new AgentError('Could not delete the whole folder; some files are still there', 500)
}
