import type { OwnerNote, OwnerNoteSummary } from '@after-office/shared'
import { agentsRepo, folderNotesRepo, ownerNotesRepo } from '../db'
import { AgentError } from '../agents/manager'
import { cleanTagIds, tagNames } from './tags'
import { folderOf } from './workspaces'
import { htmlToMarkdown, markdownToHtml } from './noteText'
import { publishWork } from './work'
import { cleanFolder } from './folders'

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
}

function clean(input: NoteInput) {
  const out: Partial<Pick<OwnerNote, 'title' | 'html' | 'tags' | 'shared' | 'pinned' | 'folder'>> & { clearTags?: boolean; clearFolder?: boolean } = {}
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
    out.html = input.html
  }
  if (input.tags !== undefined) {
    const tags = cleanTagIds(input.tags)
    if (tags) out.tags = tags
    else out.clearTags = true
  }
  return out
}

export function createNote(input: NoteInput) {
  const { clearTags: _t, clearFolder: _f, ...c } = clean(input)
  const now = Date.now()
  const note: OwnerNote = {
    id: crypto.randomUUID(),
    title: c.title ?? '',
    html: c.html ?? '',
    ...(c.tags ? { tags: c.tags } : {}),
    ...(c.shared ? { shared: true } : {}),
    ...(c.pinned ? { pinned: true } : {}),
    ...(c.folder ? { folder: c.folder } : {}),
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
  const { clearTags, clearFolder, ...c } = clean(input)
  const next: OwnerNote = { ...prev, ...c, updatedAt: Date.now() }
  // the owner's change: no agent is the last to have edited it
  if (c.title !== undefined || c.html !== undefined) delete next.editedBy
  if (clearTags) delete next.tags
  if (clearFolder) delete next.folder
  if (next.shared === false) delete next.shared
  if (next.pinned === false) delete next.pinned
  ownerNotesRepo.put(next)
  publishWork('notes')
  return next
}

export function deleteNote(id: string) {
  ownerNotesRepo.remove(id)
  publishWork('notes')
}

// ── the agents' side (their MCP tools): shared notes only, read and written as Markdown ──

const sharedNote = (id: string) => {
  const n = ownerNotesRepo.get(id.trim())
  if (!n || !n.shared) throw new AgentError(`No shared note "${id}"; see list_notes`, 404)
  return n
}

/** The notes the owner shared with the agents, pinned first, newest first. */
export function agentNotes(opts: { query?: string; folder?: string } = {}) {
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return ownerNotesRepo
    .all()
    .filter((n) => n.shared)
    .filter((n) => !opts.folder || n.folder === opts.folder || !!n.folder?.startsWith(`${opts.folder}/`))
    .filter((n) => {
      const hay = `${n.title} ${plainText(n.html)}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort(listOrder)
}

export const agentReadNote = (id: string) => sharedNote(id)

/** An agent writes a note: shared (it's theirs as much as the owner's), Markdown turned into the editor's rich text. */
export function agentWriteNote(agentId: string, input: { title: string; markdown: string; folder?: string; tags?: string[] }) {
  const markdown = input.markdown ?? ''
  if (markdown.length > HTML_MAX / 2) throw new AgentError(`A note is limited to ${HTML_MAX / 2000}k characters`, 400)
  const now = Date.now()
  const note: OwnerNote = {
    id: crypto.randomUUID(),
    title: input.title.trim().slice(0, TITLE_MAX) || 'Untitled',
    html: markdownToHtml(markdown),
    ...(cleanFolder(input.folder) ? { folder: cleanFolder(input.folder) } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
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
export function agentEditNote(agentId: string, id: string, edit: { title?: string; markdown?: string; append?: string; folder?: string | null; tags?: string[] }) {
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
  if (next.html.length > HTML_MAX) throw new AgentError(`A note is limited to ${HTML_MAX / 1000}k characters`, 400)
  ownerNotesRepo.put(next)
  publishWork('notes')
  return next
}

export function agentDeleteNote(id: string) {
  const n = sharedNote(id)
  ownerNotesRepo.remove(n.id)
  publishWork('notes')
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
    ...(withText ? { markdown: htmlToMarkdown(n.html) } : { preview: plainText(n.html).slice(0, 160) }),
  }
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
