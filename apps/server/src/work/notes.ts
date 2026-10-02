import type { OwnerNote, OwnerNoteSummary } from '@after-office/shared'
import { ownerNotesRepo, projectsRepo } from '../db'
import { AgentError } from '../agents/manager'
import { cleanTagIds } from './tags'
import { publishWork } from './work'

// The owner's own notes (Reports → Notes): rich text written in the dashboard (the same editor as a folder's notes),
// with a project and tags like a report. Kept in the dashboard's database only: no agent is given them.

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

export const noteSummaries = () => ownerNotesRepo.latest().map(summary)

interface NoteInput {
  title?: unknown
  html?: unknown
  projectId?: unknown
  tags?: unknown
}

function clean(input: NoteInput) {
  const out: Partial<Pick<OwnerNote, 'title' | 'html' | 'projectId' | 'tags'>> & { clearProject?: boolean; clearTags?: boolean } = {}
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') throw new AgentError('A title is text', 400)
    out.title = input.title.trim().slice(0, TITLE_MAX)
  }
  if (input.html !== undefined) {
    if (typeof input.html !== 'string') throw new AgentError('A note is text', 400)
    if (input.html.length > HTML_MAX) throw new AgentError(`A note is limited to ${HTML_MAX / 1000}k characters`, 400)
    out.html = input.html
  }
  if (input.projectId !== undefined) {
    if (input.projectId === null || input.projectId === '') out.clearProject = true
    else if (typeof input.projectId !== 'string' || !projectsRepo.all().some((p) => p.id === input.projectId)) throw new AgentError('No such project', 400)
    else out.projectId = input.projectId
  }
  if (input.tags !== undefined) {
    const tags = cleanTagIds(input.tags)
    if (tags) out.tags = tags
    else out.clearTags = true
  }
  return out
}

export function createNote(input: NoteInput) {
  const { clearProject: _p, clearTags: _t, ...c } = clean(input)
  const now = Date.now()
  const note: OwnerNote = { id: crypto.randomUUID(), title: c.title ?? '', html: c.html ?? '', ...(c.projectId ? { projectId: c.projectId } : {}), ...(c.tags ? { tags: c.tags } : {}), createdAt: now, updatedAt: now }
  ownerNotesRepo.put(note)
  publishWork('notes')
  return note
}

export function updateNote(id: string, input: NoteInput) {
  const prev = ownerNotesRepo.get(id)
  if (!prev) throw new AgentError('No such note', 404)
  const { clearProject, clearTags, ...c } = clean(input)
  const next: OwnerNote = { ...prev, ...c, updatedAt: Date.now() }
  if (clearProject) delete next.projectId
  if (clearTags) delete next.tags
  ownerNotesRepo.put(next)
  publishWork('notes')
  return next
}

export function deleteNote(id: string) {
  ownerNotesRepo.remove(id)
  publishWork('notes')
}
