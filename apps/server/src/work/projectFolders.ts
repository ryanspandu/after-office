import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentsRepo, extraDirsOf, projectsRepo, tasksRepo } from '../db'
import { AgentError } from '../agents/errors'
import { revokeProjectDir } from '../agents/manager'
import { runAsAgent } from '../agents/asagent'
import { AGENTS_DIR, PROJECTS_DIR } from '../fsroots'
import type { AgentRow } from '../db'

// Project folders the office makes: <AGENTS_DIR>/project/<name>. Only these can be deleted from the dashboard; a
// project may also point at an agent's folder or a repo, which are never deleted from here.

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

/** A new, empty folder for a project called `name` (seo, seo-2, … if taken). */
export function makeProjectFolder(name: string) {
  const base = slug(name) || 'project'
  mkdirSync(PROJECTS_DIR, { recursive: true })
  for (let i = 1; i < 100; i++) {
    const path = join(PROJECTS_DIR, i === 1 ? base : `${base}-${i}`)
    if (existsSync(path)) continue
    mkdirSync(path)
    return path
  }
  throw new AgentError('Could not find a free folder name for this project', 409)
}

/** The folder is one the office made for a project: directly in PROJECTS_DIR, a real folder (not a symlink). */
export function isOwnProjectFolder(folder: string | undefined) {
  if (!folder) return false
  try {
    return !lstatSync(folder).isSymbolicLink() && lstatSync(folder).isDirectory() && dirname(realpathSync(folder)) === PROJECTS_DIR
  } catch {
    return false
  }
}

/**
 * Rename a folder in the projects folder (the Projects tab): the dashboard project linked to it follows (its folder,
 * and its name: the folder's). Not while one of its tasks is being worked on (the agent would lose its place).
 */
export function renameProjectFolder(folder: string, name: string) {
  if (!isOwnProjectFolder(folder)) throw new AgentError('Only folders in the projects folder can be renamed here', 403)
  const old = realpathSync(folder)
  const base = slug(name)
  if (!base) throw new AgentError('Give it a name (letters, numbers, dashes)')
  const next = join(PROJECTS_DIR, base)
  if (next === old) return { folder: old }
  if (existsSync(next)) throw new AgentError(`There is already a folder called ${base}`, 409)
  const linked = projectsRepo.all().filter((p) => p.folder && (p.folder === folder || p.folder === old))
  const busy = tasksRepo.active().some((t) => t.status === 'in_progress' && linked.some((p) => p.id === t.projectId))
  if (busy) throw new AgentError('One of its tasks is being worked on right now: rename it once that is done', 409)
  renameSync(old, next)
  for (const p of linked) projectsRepo.put({ ...p, folder: next, name: base })
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
    if (extraDirsOf(a).includes(path)) await revokeProjectDir(a.id, path).catch(() => {})
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // files the agents' user made (hardened VPS layout): remove them with its rights
    await runAsAgent(['rm', '-rf', '--', path], { cwd: PROJECTS_DIR, timeoutMs: 60_000 })
  }
  if (existsSync(path)) throw new AgentError('Could not delete the whole folder; some files are still there', 500)
}
