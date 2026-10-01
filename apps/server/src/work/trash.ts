import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { agentsRepo } from '../db'
import { AgentError } from '../agents/errors'
import { AGENTS_DIR, PROJECTS_DIR } from '../fsroots'
import { entryIn } from './workspaces'

// The office's trash: files and folders deleted from the dashboard's file manager go to <agents dir>/.trash, one folder
// per deletion (the item, and meta.json saying where it came from). Never inside a project (that would end up in its
// git). Restore puts it back where it was; emptying the trash (or one item) deletes for good.

export const TRASH_DIR = join(AGENTS_DIR, '.trash')

export interface TrashItem {
  id: string
  name: string
  /** where it was (its full path) */
  original: string
  dir: boolean
  size: number
  deletedAt: number
}

const ID_RE = /^[0-9a-z-]{8,64}$/

/** Move, also across disks (an agent's folder may be on another drive than the trash). */
function move(from: string, to: string) {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    rmSync(from, { recursive: true, force: true })
  }
}

function sizeOf(path: string, limit = 20_000) {
  let total = 0
  let n = 0
  const walk = (p: string) => {
    if (n++ > limit) return
    const st = lstatSync(p)
    if (st.isDirectory()) for (const d of readdirSync(p)) walk(join(p, d))
    else total += st.size
  }
  try {
    walk(path)
  } catch {
    // partly unreadable: what was counted
  }
  return total
}

/** Move these entries of the folder `root` (paths inside it) to the trash. */
export function trashEntries(root: string, rels: string[]) {
  if (!rels.length || rels.length > 200) throw new AgentError('Pick what to delete (at most 200 at once)')
  const items = rels.map((rel) => entryIn(root, rel))
  mkdirSync(TRASH_DIR, { recursive: true })
  const out: TrashItem[] = []
  for (const { abs, st } of items) {
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
    const box = join(TRASH_DIR, id)
    mkdirSync(box)
    const item: TrashItem = { id, name: basename(abs), original: abs, dir: st.isDirectory(), size: st.isDirectory() ? sizeOf(abs) : st.size, deletedAt: Date.now() }
    writeFileSync(join(box, 'meta.json'), JSON.stringify(item))
    try {
      move(abs, join(box, 'item'))
    } catch (e) {
      rmSync(box, { recursive: true, force: true })
      throw new AgentError(`Could not move ${item.name} to the trash: ${(e as Error).message}`, 500)
    }
    out.push(item)
  }
  return out
}

function readItem(id: string): TrashItem | null {
  if (!ID_RE.test(id)) return null
  try {
    const item = JSON.parse(readFileSync(join(TRASH_DIR, id, 'meta.json'), 'utf8')) as TrashItem
    // the item may be a link (moved as itself): look at it without following it
    return lstatSync(join(TRASH_DIR, id, 'item'), { throwIfNoEntry: false }) ? { ...item, id } : null
  } catch {
    return null
  }
}

/** What's in the trash, newest first; `under`: only what came from inside that folder. */
export function listTrash(under?: string): TrashItem[] {
  let ids: string[] = []
  try {
    ids = readdirSync(TRASH_DIR)
  } catch {
    return []
  }
  const items = ids.map(readItem).filter((x): x is TrashItem => !!x)
  const scoped = under ? items.filter((i) => i.original.startsWith(under.endsWith(sep) ? under : under + sep)) : items
  return scoped.sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Folders a restored item may go back into: the projects folder and the agents' folders (and anything in them). */
function restorable(path: string) {
  const roots = [AGENTS_DIR, PROJECTS_DIR, ...agentsRepo.all().map((a) => a.cwd)]
  return !path.startsWith(TRASH_DIR + sep) && roots.some((r) => path.startsWith(r + sep))
}

/** Put it back where it was (under a free name if something new is there now). */
export function restoreTrash(id: string) {
  const item = readItem(id)
  if (!item) throw new AgentError('Not in the trash any more', 404)
  if (!restorable(item.original)) throw new AgentError('It came from outside the office folders: download it instead', 403)
  mkdirSync(dirname(item.original), { recursive: true })
  let to = item.original
  for (let n = 2; existsSync(to) && n < 100; n++) {
    const dot = item.dir ? -1 : item.name.lastIndexOf('.')
    const stem = dot > 0 ? item.name.slice(0, dot) : item.name
    const ext = dot > 0 ? item.name.slice(dot) : ''
    to = join(dirname(item.original), `${stem} (restored${n > 2 ? ` ${n - 1}` : ''})${ext}`)
  }
  move(join(TRASH_DIR, id, 'item'), to)
  rmSync(join(TRASH_DIR, id), { recursive: true, force: true })
  return { path: to }
}

/** Delete one item for good. */
export function purgeTrash(id: string) {
  if (!readItem(id)) throw new AgentError('Not in the trash any more', 404)
  rmSync(join(TRASH_DIR, id), { recursive: true, force: true })
}

/** Empty the trash (`under`: only what came from that folder). */
export function emptyTrash(under?: string) {
  const items = listTrash(under)
  for (const i of items) rmSync(join(TRASH_DIR, i.id), { recursive: true, force: true })
  return { removed: items.length }
}
