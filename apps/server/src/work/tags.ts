import type { Tag } from '@after-office/shared'
import { ownerNotesRepo, reportsRepo, settingsRepo, tasksRepo } from '../db'
import { AgentError } from '../agents/errors'

// Tags: the owner's own coloured labels for tasks and reports (e.g. "SEO", "Urgent"), to find them again and filter
// by. The list lives in the settings table; a task or report holds the ids of its tags. Deleting a tag takes it off
// everything that had it.

const KEY = 'tags'
const COLOR_RE = /^#[0-9a-f]{6}$/i
const ID_RE = /^[\w-]{1,64}$/
export const MAX_TAGS_PER_ITEM = 10

export function listTags(): Tag[] {
  try {
    const v = JSON.parse(settingsRepo.get(KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
const save = (tags: Tag[]) => settingsRepo.set(KEY, JSON.stringify(tags))

/** Create or change a tag (the dashboard makes the id). Names are unique, case-insensitively. */
export function putTag(id: string, b: { name?: unknown; color?: unknown }): Tag {
  if (!ID_RE.test(id)) throw new AgentError('Invalid tag id', 400)
  const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim().slice(0, 32) : ''
  if (!name) throw new AgentError('Give the tag a name', 400)
  const color = typeof b.color === 'string' && COLOR_RE.test(b.color) ? b.color : '#9a9a96'
  const tags = listTags()
  if (tags.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new AgentError(`There is already a tag called ${name}`, 409)
  const tag: Tag = { id, name, color }
  const at = tags.findIndex((t) => t.id === id)
  if (at === -1) tags.push(tag)
  else tags[at] = tag
  save(tags)
  return tag
}

/** Remove a tag, and take it off every task and report that had it. */
export function deleteTag(id: string) {
  save(listTags().filter((t) => t.id !== id))
  for (const t of tasksRepo.all()) if (t.tags?.includes(id)) tasksRepo.put({ ...t, tags: t.tags.filter((x) => x !== id) })
  for (const r of reportsRepo.all()) if (r.tags?.includes(id)) reportsRepo.put({ ...r, tags: r.tags.filter((x) => x !== id) })
  for (const n of ownerNotesRepo.all()) if (n.tags?.includes(id)) ownerNotesRepo.put({ ...n, tags: n.tags.filter((x) => x !== id) })
}

/** Tag ids as sent by a client: only existing tags, each once, at most MAX_TAGS_PER_ITEM. */
export function cleanTagIds(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new AgentError('Invalid tags', 400)
  const known = new Set(listTags().map((t) => t.id))
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && known.has(x)))].slice(0, MAX_TAGS_PER_ITEM)
  return ids.length ? ids : undefined
}

/** Tag names (as the manager writes them) → ids; unknown names are an error that lists the existing ones. */
export function tagIdsByName(names: string[] | undefined): string[] | undefined {
  if (!names?.length) return undefined
  const tags = listTags()
  const ids = names.map((n) => {
    const t = tags.find((x) => x.name.toLowerCase() === n.trim().toLowerCase())
    if (!t) throw new AgentError(`No tag called "${n}". Existing tags: ${tags.map((x) => x.name).join(', ') || 'none (the owner makes them in the dashboard)'}`, 400)
    return t.id
  })
  return [...new Set(ids)].slice(0, MAX_TAGS_PER_ITEM)
}

export const tagNames = (ids: string[] | undefined) => {
  if (!ids?.length) return []
  const byId = new Map(listTags().map((t) => [t.id, t.name]))
  return ids.map((id) => byId.get(id)).filter((n): n is string => !!n)
}
