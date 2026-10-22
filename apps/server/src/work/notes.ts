import type { NotePage, OwnerNote, OwnerNoteSummary } from '@after-office/shared'
import { agentsRepo, folderNotesRepo, notePagesRepo, ownerNotesRepo } from '../db'
import { AgentError } from '../agents/manager'
import { cleanTagIds, tagNames } from './tags'
import { folderOf } from './workspaces'
import { htmlToMarkdown, markdownToHtml } from './noteText'
import { publishWork } from './work'
import { cleanFolder } from './folders'
import { forgetNoteHelper } from './noteAssist'
import { keepOwnImages } from './noteImages'

// The owner's own notes (Reports → Notes): rich text written in the dashboard (the same editor as a folder's notes),
// with a folder and tags like a report. Kept in the dashboard's database only: no agent is given them.

const TITLE_MAX = 200
const HTML_MAX = 200_000

/** The note's words, without the markup (for the list's preview line and the search). */
export function plainText(html: string) {
  return html
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/summary)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const summary = ({ html, ...n }: OwnerNote): OwnerNoteSummary => ({ ...n, excerpt: plainText(html).slice(0, 200) })

/** The list's order: pinned first, then the owner's order (a new note on top). */
export const listOrder = (a: OwnerNote, b: OwnerNote) => Number(!!b.pinned) - Number(!!a.pinned) || (a.rank ?? -a.createdAt) - (b.rank ?? -b.createdAt)

export const noteSummaries = () => ownerNotesRepo.all().sort(listOrder).slice(0, 500).map(summary)

/** The owner dragged notes into a new order: the ids in that order (any left out keep their place after them). */
export function reorderNotes(ids: unknown) {
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new AgentError('Send the note ids in their new order', 400)
  ;(ids as string[]).forEach((id, i) => {
    const n = ownerNotesRepo.get(id)
    if (n && n.rank !== i) ownerNotesRepo.put({ ...n, rank: i })
  })
  publishWork('notes')
}

interface NoteInput {
  title?: unknown
  html?: unknown
  tags?: unknown
  shared?: unknown
  pinned?: unknown
  folder?: unknown
  pageId?: unknown
  date?: unknown
  dateEnd?: unknown
  time?: unknown
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
/** A real calendar day as "YYYY-MM-DD" (no 2026-02-30). */
const isDay = (v: string) => {
  if (!DAY.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

type NoteDate = Pick<OwnerNote, 'date' | 'dateEnd' | 'time'>

/**
 * Its day (or days) on the calendar, checked against what it had: a day, an end day after it for a range, a time
 * only on a single day. null / '' clears a field; clearing the day clears the rest with it.
 */
function cleanDate(input: NoteInput, prev: NoteDate = {}): NoteDate | undefined {
  if (input.date === undefined && input.dateEnd === undefined && input.time === undefined) return undefined
  const pick = (v: unknown, cur: string | undefined, ok: (s: string) => boolean, what: string) => {
    if (v === undefined) return cur
    if (v === null || v === '') return undefined
    if (typeof v !== 'string' || !ok(v)) throw new AgentError(what, 400)
    return v
  }
  const date = pick(input.date, prev.date, isDay, 'A date is YYYY-MM-DD')
  let dateEnd = pick(input.dateEnd, prev.dateEnd, isDay, 'An end date is YYYY-MM-DD')
  let time = pick(input.time, prev.time, (s) => HHMM.test(s), 'A time is HH:MM')
  if (!date) return {}
  if (dateEnd === date) dateEnd = undefined
  if (dateEnd && dateEnd < date) throw new AgentError('The end date comes after the start', 400)
  // a time belongs to one day; a range is all-day
  if (dateEnd) {
    if (input.time !== undefined && time) throw new AgentError('A time goes with a single day, not a range', 400)
    time = undefined
  }
  return { date, ...(dateEnd ? { dateEnd } : {}), ...(time ? { time } : {}) }
}

function clean(input: NoteInput) {
  const out: Partial<Pick<OwnerNote, 'title' | 'html' | 'tags' | 'shared' | 'pinned' | 'folder' | 'pageId'>> & { clearTags?: boolean; clearFolder?: boolean; clearPage?: boolean } = {}
  // its page: one that exists; none: "No page"
  if (input.pageId === null || input.pageId === '') out.clearPage = true
  else if (input.pageId !== undefined) {
    if (typeof input.pageId !== 'string' || !notePagesRepo.get(input.pageId)) throw new AgentError('No such page', 400)
    out.pageId = input.pageId
  }
  // its folder: only one the dashboard shows (its real path); none: cleared
  if (input.folder === null || input.folder === '') out.clearFolder = true
  else if (input.folder !== undefined) {
    if (typeof input.folder !== 'string') throw new AgentError('A folder is a path', 400)
    out.folder = folderOf(input.folder)
  }
  for (const k of ['shared', 'pinned'] as const) {
    if (input[k] === undefined) continue
    if (typeof input[k] !== 'boolean') throw new AgentError(`${k} is true or false`, 400)
    out[k] = input[k] as boolean
  }
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') throw new AgentError('A title is text', 400)
    out.title = input.title.trim().slice(0, TITLE_MAX)
  }
  if (input.html !== undefined) {
    if (typeof input.html !== 'string') throw new AgentError('A note is text', 400)
    if (input.html.length > HTML_MAX) throw new AgentError(`A note is limited to ${HTML_MAX / 1000}k characters`, 400)
    // its own pictures only (work/noteImages.ts): no outside images, no data: URIs
    out.html = keepOwnImages(input.html)
  }
  if (input.tags !== undefined) {
    const tags = cleanTagIds(input.tags)
    if (tags) out.tags = tags
    else out.clearTags = true
  }
  return out
}

export function createNote(input: NoteInput) {
  const { clearTags: _t, clearFolder: _f, clearPage: _p, ...c } = clean(input)
  const when = cleanDate(input)
  const now = Date.now()
  const note: OwnerNote = {
    id: crypto.randomUUID(),
    title: c.title ?? '',
    html: c.html ?? '',
    ...(c.tags ? { tags: c.tags } : {}),
    ...(c.shared ? { shared: true } : {}),
    ...(c.pinned ? { pinned: true } : {}),
    ...(c.folder ? { folder: c.folder } : {}),
    ...(c.pageId ? { pageId: c.pageId } : {}),
    ...when,
    rank: -now,
    createdAt: now,
    updatedAt: now,
  }
  ownerNotesRepo.put(note)
  publishWork('notes')
  return note
}

export function updateNote(id: string, input: NoteInput) {
  const prev = ownerNotesRepo.get(id)
  if (!prev) throw new AgentError('No such note', 404)
  const { clearTags, clearFolder, clearPage, ...c } = clean(input)
  const when = cleanDate(input, prev)
  const next: OwnerNote = { ...prev, ...c, updatedAt: Date.now() }
  if (when) {
    delete next.date
    delete next.dateEnd
    delete next.time
    Object.assign(next, when)
  }
  // the owner's change: no agent is the last to have edited it
  if (c.title !== undefined || c.html !== undefined) delete next.editedBy
  if (clearTags) delete next.tags
  if (clearFolder) delete next.folder
  if (clearPage) delete next.pageId
  if (next.shared === false) delete next.shared
  if (next.pinned === false) delete next.pinned
  ownerNotesRepo.put(next)
  publishWork('notes')
  return next
}

export function deleteNote(id: string) {
  ownerNotesRepo.remove(id)
  publishWork('notes')
  dropHelper(id)
}

/** A note gone: its writing helper (work/noteAssist.ts) goes with it, in the background. */
const dropHelper = (id: string) => void forgetNoteHelper(id).catch((e) => console.warn('[notes] could not remove the note helper:', e instanceof Error ? e.message : e))

// ── pages: the notebooks the owner keeps notes on (pages in pages, any depth) ──

const PAGE_NAME_MAX = 80

/** In their order: the placed ones first, then by when they were made (order counts among siblings). */
export const listNotePages = () =>
  notePagesRepo.all().sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt)

function pageName(v: unknown) {
  if (typeof v !== 'string' || !v.trim()) throw new AgentError('A page needs a name', 400)
  return v.trim().slice(0, PAGE_NAME_MAX)
}
function pageOrder(v: unknown) {
  if (v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new AgentError('order is a number', 400)
  return v
}
/** A parent page: one that exists; null or "" is the top level. */
function pageParent(v: unknown) {
  if (v === null || v === '') return undefined
  if (typeof v !== 'string' || !notePagesRepo.get(v)) throw new AgentError('No such parent page', 400)
  return v
}
/** True when `id` is `ancestor` or sits somewhere under it (a stored loop can't hang the walk). */
function isWithin(id: string, ancestor: string) {
  const seen = new Set<string>()
  for (let cur: string | undefined = id; cur && !seen.has(cur); cur = notePagesRepo.get(cur)?.parentId) {
    if (cur === ancestor) return true
    seen.add(cur)
  }
  return false
}

export function createPage(input: { name?: unknown; order?: unknown; parentId?: unknown }) {
  const now = Date.now()
  const order = input.order === undefined ? undefined : pageOrder(input.order)
  const parentId = input.parentId === undefined ? undefined : pageParent(input.parentId)
  const page: NotePage = {
    id: crypto.randomUUID(),
    name: pageName(input.name),
    ...(parentId ? { parentId } : {}),
    ...(order !== undefined ? { order } : {}),
    createdAt: now,
    updatedAt: now,
  }
  notePagesRepo.put(page)
  publishWork('notePages')
  return page
}

/** Pages in the owner's order (dragged on the Notes cards, siblings of one parent): each gets its place. */
export function reorderPages(ids: unknown) {
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new AgentError('Send the page ids in their new order', 400)
  ;(ids as string[]).forEach((id, i) => {
    const p = notePagesRepo.get(id)
    if (p && p.order !== i) notePagesRepo.put({ ...p, order: i })
  })
  publishWork('notePages')
}

export function updatePage(id: string, input: { name?: unknown; order?: unknown; parentId?: unknown }) {
  const prev = notePagesRepo.get(id)
  if (!prev) throw new AgentError('No such page', 404)
  const next: NotePage = { ...prev, updatedAt: Date.now() }
  if (input.name !== undefined) next.name = pageName(input.name)
  if (input.order !== undefined) {
    const order = pageOrder(input.order)
    if (order === undefined) delete next.order
    else next.order = order
  }
  if (input.parentId !== undefined) {
    const parentId = pageParent(input.parentId)
    // not under itself or one of its own sub-pages
    if (parentId && isWithin(parentId, id)) throw new AgentError("A page can't go inside itself or its sub-pages", 400)
    if (parentId !== prev.parentId) delete next.order // a new place: after its new siblings
    if (parentId) next.parentId = parentId
    else delete next.parentId
  }
  notePagesRepo.put(next)
  publishWork('notePages')
  return next
}

/** A page goes; its notes and sub-pages move up to its parent (the top level / no page if none). */
export function deletePage(id: string) {
  const page = notePagesRepo.get(id)
  if (!page) throw new AgentError('No such page', 404)
  const up = page.parentId
  let moved = 0
  for (const n of ownerNotesRepo.all()) {
    if (n.pageId !== id) continue
    const { pageId: _gone, ...rest } = n
    ownerNotesRepo.put(up ? { ...rest, pageId: up } : rest)
    moved++
  }
  let pages = 0
  for (const p of notePagesRepo.all()) {
    if (p.parentId !== id) continue
    const { parentId: _gone, order: _place, ...rest } = p
    notePagesRepo.put(up ? { ...rest, parentId: up } : rest)
    pages++
  }
  notePagesRepo.remove(id)
  publishWork('notePages', 'notes')
  return { moved, pages }
}

// ── the agents' side (their MCP tools): shared notes only, read and written as Markdown ──

const sharedNote = (id: string) => {
  const n = ownerNotesRepo.get(id.trim())
  if (!n || !n.shared) throw new AgentError(`No shared note "${id}"; see list_notes`, 404)
  return n
}

/** The notes the owner shared with the agents, pinned first, newest first. */
export function agentNotes(opts: { query?: string; folder?: string; page?: string } = {}) {
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  // a page: its notes and its sub-pages' ("none": the notes on no page)
  const page = opts.page?.trim() ? (opts.page.trim().toLowerCase() === 'none' ? null : findPage(opts.page).id) : undefined
  return ownerNotesRepo
    .all()
    .filter((n) => n.shared)
    .filter((n) => !opts.folder || n.folder === opts.folder || !!n.folder?.startsWith(`${opts.folder}/`))
    .filter((n) => page === undefined || (page === null ? !n.pageId : !!n.pageId && isWithin(n.pageId, page)))
    .filter((n) => {
      const hay = `${n.title} ${plainText(n.html)}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort(listOrder)
}

export const agentReadNote = (id: string) => sharedNote(id)

/** An agent writes a note: shared (it's theirs as much as the owner's), Markdown turned into the editor's rich text. */
export function agentWriteNote(agentId: string, input: { title: string; markdown: string; folder?: string; tags?: string[]; page?: string }) {
  const markdown = input.markdown ?? ''
  if (markdown.length > HTML_MAX / 2) throw new AgentError(`A note is limited to ${HTML_MAX / 2000}k characters`, 400)
  const now = Date.now()
  const note: OwnerNote = {
    id: crypto.randomUUID(),
    title: input.title.trim().slice(0, TITLE_MAX) || 'Untitled',
    html: markdownToHtml(markdown),
    ...(cleanFolder(input.folder) ? { folder: cleanFolder(input.folder) } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.page?.trim() ? { pageId: findPage(input.page).id } : {}),
    shared: true,
    author: agentId,
    rank: -now,
    createdAt: now,
    updatedAt: now,
  }
  ownerNotesRepo.put(note)
  publishWork('notes')
  return note
}

/** An agent changes a shared note: its title, its whole text, or a part added at the end (keeps the owner's formatting). */
export function agentEditNote(agentId: string, id: string, edit: { title?: string; markdown?: string; append?: string; folder?: string | null; tags?: string[]; page?: string | null }) {
  const prev = sharedNote(id)
  const next: OwnerNote = { ...prev, updatedAt: Date.now(), editedBy: agentId }
  if (edit.title !== undefined) next.title = edit.title.trim().slice(0, TITLE_MAX) || prev.title
  if (edit.markdown !== undefined) next.html = markdownToHtml(edit.markdown)
  if (edit.append?.trim()) next.html = `${next.html}${markdownToHtml(edit.append)}`
  if (edit.folder !== undefined) {
    const folder = cleanFolder(edit.folder)
    if (folder) next.folder = folder
    else delete next.folder
  }
  if (edit.tags) {
    if (edit.tags.length) next.tags = edit.tags
    else delete next.tags
  }
  // onto a page (its id or name), or off every page ("" / null)
  if (edit.page !== undefined) {
    if (edit.page?.trim()) next.pageId = findPage(edit.page).id
    else delete next.pageId
  }
  if (next.html.length > HTML_MAX) throw new AgentError(`A note is limited to ${HTML_MAX / 1000}k characters`, 400)
  ownerNotesRepo.put(next)
  publishWork('notes')
  return next
}

export function agentDeleteNote(id: string) {
  const n = sharedNote(id)
  ownerNotesRepo.remove(n.id)
  publishWork('notes')
  dropHelper(n.id)
  return n
}

/** A note as an agent sees it. */
export function noteForAgent(n: OwnerNote, withText: boolean) {
  const who = (id?: string) => (id ? (agentsRepo.get(id)?.name ?? 'an agent') : 'the owner')
  return {
    id: n.id,
    title: n.title || 'Untitled',
    tags: n.tags?.length ? tagNames(n.tags) : undefined,
    pinned: n.pinned || undefined,
    writtenBy: who(n.author),
    lastEditedBy: n.editedBy ? who(n.editedBy) : n.author ? undefined : 'the owner',
    updatedAt: new Date(n.updatedAt).toISOString(),
    folder: n.folder,
    page: n.pageId && notePagesRepo.get(n.pageId) ? pagePath(n.pageId) : undefined,
    ...(withText ? { markdown: htmlToMarkdown(n.html) } : { preview: plainText(n.html).slice(0, 160) }),
  }
}

// ── pages for the agents: named by their id, their path ("Poplink / Research") or a name only one page has ──

/** A page's place: its parents' names and its own, "Poplink / Research / Ideas". */
export function pagePath(id: string) {
  const names: string[] = []
  const seen = new Set<string>()
  for (let cur = notePagesRepo.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? notePagesRepo.get(cur.parentId) : null) {
    names.unshift(cur.name)
    seen.add(cur.id)
  }
  return names.join(' / ')
}

/** The page an agent means: its id, its whole path, or its name when only one page has it. */
export function findPage(ref: string) {
  const want = ref.trim()
  const byId = notePagesRepo.get(want)
  if (byId) return byId
  const norm = (v: string) => v.toLowerCase().split('/').map((x) => x.trim()).filter(Boolean).join(' / ')
  const all = notePagesRepo.all()
  const byPath = all.filter((p) => norm(pagePath(p.id)) === norm(want))
  if (byPath.length === 1) return byPath[0]
  const byName = all.filter((p) => p.name.trim().toLowerCase() === want.toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byPath.length > 1 || byName.length > 1)
    throw new AgentError(`More than one page is called "${want}": ${[...byPath, ...byName].map((p) => `${pagePath(p.id)} (${p.id})`).join(', ')}. Use its id or whole path.`, 409)
  throw new AgentError(`No page "${want}"; see list_note_pages`, 404)
}

/** Every page, as a tree in the owner's order: id, name, path, and how many shared notes sit right on it. */
export function agentPages() {
  const pages = listNotePages()
  const shared = ownerNotesRepo.all().filter((n) => n.shared)
  const of = (parent?: string): unknown[] =>
    pages
      .filter((p) => (p.parentId ?? undefined) === parent)
      .map((p) => {
        const subPages = of(p.id)
        return { id: p.id, name: p.name, path: pagePath(p.id), notes: shared.filter((n) => n.pageId === p.id).length, ...(subPages.length ? { subPages } : {}) }
      })
  return { pages: of(undefined), notesOnNoPage: shared.filter((n) => !n.pageId || !notePagesRepo.get(n.pageId)).length }
}

/** An agent makes a page (on the top level, or inside another one: a sub-page). */
export const agentCreatePage = (name: string, parent?: string) => createPage({ name, ...(parent?.trim() ? { parentId: findPage(parent).id } : {}) })

/** An agent renames a page or moves it (into another page, or "" to the top level). */
export function agentUpdatePage(ref: string, edit: { name?: string; parent?: string | null }) {
  const page = findPage(ref)
  return updatePage(page.id, {
    ...(edit.name !== undefined ? { name: edit.name } : {}),
    ...(edit.parent !== undefined ? { parentId: edit.parent?.trim() ? findPage(edit.parent).id : null } : {}),
  })
}

export const agentDeletePage = (ref: string) => {
  const page = findPage(ref)
  return { page, ...deletePage(page.id) }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A folder used to have one note (folder_notes); now it has any number, with the rest of the owner's notes. Each old
 * one becomes a note of its folder, titled "Notes" (its text and time kept), once.
 */
export function moveFolderNotes() {
  const rows = folderNotesRepo.all()
  if (!rows.length) return
  for (const r of rows) {
    if (r.text.trim()) {
      // written before the rich text editor: one paragraph per line
      const html = r.text.trimStart().startsWith('<') ? r.text : r.text.split('\n').map((l) => `<p>${esc(l)}</p>`).join('')
      ownerNotesRepo.put({ id: crypto.randomUUID(), title: 'Notes', html, folder: r.path, rank: -r.updated_at, createdAt: r.updated_at, updatedAt: r.updated_at })
    }
    folderNotesRepo.remove(r.path)
  }
  publishWork('notes')
}
