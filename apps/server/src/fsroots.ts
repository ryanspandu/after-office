import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

// Where agent folders may live. OFFICE_ROOT can list several folders separated by ":". Default: the folder that
// contains this After Office checkout (your projects) and $HOME. The folder picker opens at the checkout itself.

/** The agents' home: another user's in the hardened VPS setup (OFFICE_AGENT_HOME), else this user's. `~` means it. */
export const AGENT_HOME = process.env.OFFICE_AGENT_HOME || homedir()

/**
 * The Claude Code config folder agents use (settings, skills, login, transcripts). OFFICE_CLAUDE_CONFIG_DIR picks
 * one account's folder when this machine has several (e.g. ~/.claude-work, the same as `CLAUDE_CONFIG_DIR=… claude`);
 * unset: Claude Code's default, ~/.claude.
 */
export const CLAUDE_CONFIG_DIR = (() => {
  const raw = process.env.OFFICE_CLAUDE_CONFIG_DIR?.trim()
  return raw ? resolve(raw.replace(/^~(?=$|\/)/, AGENT_HOME)) : null
})()

/** Where Claude Code keeps its per-project transcripts. */
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_CONFIG_DIR ?? join(AGENT_HOME, '.claude'), 'projects')

/** The After Office checkout (…/after-office). */
export const PROJECT_DIR = resolve(import.meta.dir, '../../..')

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

function computeRoots() {
  const listed = process.env.OFFICE_ROOT?.split(':').map((p) => p.trim()).filter(Boolean)
  const candidates = (listed?.length ? listed : [dirname(PROJECT_DIR), AGENT_HOME]).map((p) => real(resolve(p.replace(/^~(?=$|\/)/, AGENT_HOME))))
  // drop duplicates and roots nested in another root
  return candidates.filter((r, i) => candidates.findIndex((x) => x === r) === i && !candidates.some((o) => o !== r && inside(r, o)))
}

/** The path with symlinks resolved; for a path that doesn't exist yet, its deepest existing parent is resolved. */
export function real(path: string): string {
  const abs = resolve(path)
  if (existsSync(abs)) return realpathSync(abs)
  const parent = dirname(abs)
  return parent === abs ? abs : join(real(parent), abs.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
}

export const ROOTS = computeRoots()

/** The root that contains `path`, if any. */
export const rootOf = (path: string) => ROOTS.find((r) => inside(path, r))

/** Where the folder picker starts: OFFICE_DEFAULT_DIR, else this checkout, else the first root. */
/** Where new agents live: <AGENTS_DIR>/<agent name>. OFFICE_AGENTS_DIR, default ~/after-office (created at start). */
export const AGENTS_DIR = (() => {
  const dir = resolve((process.env.OFFICE_AGENTS_DIR ?? '~/after-office').trim().replace(/^~(?=$|\/)/, AGENT_HOME))
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // not ours to create (e.g. the hardened VPS layout, made by setup-vps.sh)
  }
  return real(dir)
})()

/** Where new projects get their folder: <AGENTS_DIR>/project/<project name> (created at start). */
export const PROJECTS_DIR = (() => {
  const dir = join(AGENTS_DIR, 'project')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // made by setup-vps.sh on the hardened layout
  }
  return real(dir)
})()

/** Where agents put the plans and proposals they're asked for (outside plan mode): out of the projects' folders, like
 *  the trash (.trash). */
export const PLANS_DIR = join(AGENTS_DIR, '.plan')

/** Where the folder picker starts: OFFICE_DEFAULT_DIR, else the agents' folder, else the first root. */
export const DEFAULT_DIR = (() => {
  const wanted = real(process.env.OFFICE_DEFAULT_DIR ?? AGENTS_DIR)
  return rootOf(wanted) ? wanted : ROOTS[0]
})()

/** "~/x" → home, relative → against `base` (default: DEFAULT_DIR). */
export function expandPath(input: string, base = DEFAULT_DIR) {
  const expanded = input.trim().replace(/^~(?=$|\/)/, AGENT_HOME)
  return resolve(isAbsolute(expanded) ? expanded : join(base, expanded))
}
