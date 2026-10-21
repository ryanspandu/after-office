import type { OfficeThread, OwnerNote } from '@after-office/shared'
import { agentsRepo, ownerNotesRepo, threadsRepo } from '../db'
import { AgentError } from '../agents/errors'
import { htmlToMarkdown } from './noteText'
import { createThread, deleteThread, sendToThread } from './threads'

// "Ask Marcus" while writing a note: one hidden thread per note (OfficeThread.noteId), in a side session of the
// manager's like any thread (queue, idle close, reopen: work/threads.ts), never listed with the owner's threads. The
// manager only suggests text (```note blocks the owner inserts); the note itself isn't shared with the agents.

/** How much of the note goes with a message, at most. */
export const NOTE_SNAPSHOT_MAX = 8000

/** How a note's helper thread is made (tests make one without starting a real session). */
export const helperThreads = { create: createThread }

/** The note's text as last sent to its helper (by thread): sent again only once it has changed. */
const sentHash = new Map<string, string>()

export const noteHelperOf = (noteId: string): OfficeThread | null => threadsRepo.all().find((t) => t.noteId === noteId) ?? null

/** The note as the manager reads it: Markdown-ish, cut short when long. Always between markers (the dashboard folds it). */
export function noteSnapshot(n: OwnerNote) {
  const md = htmlToMarkdown(n.html)
  const text = md.length > NOTE_SNAPSHOT_MAX ? `${md.slice(0, NOTE_SNAPSHOT_MAX)}\n… (cut short: the note goes on)` : md
  // with a reminder of how to change it (helpers made before ```note-edit existed learn it here)
  return `[The note now: "${n.title.trim() || 'Untitled'}"] (\`\`\`note-edit block: your edit, replaces it at once; \`\`\`note block: a suggestion)\n<<<NOTE\n${text || '(empty)'}\nNOTE>>>`
}

/** Edit mode (the panel's switch): the owner wants the note changed, not suggestions. Goes with each such message. */
export const EDIT_MODE_LINE =
  '[Note helper: edit mode] Make the change in the note yourself: answer with ONE fenced block that starts with ```note-edit and holds the WHOLE new note (Markdown), and at most one short line saying what you changed. No ```note suggestions in this mode.'

/**
 * The owner's message to the note's helper: its thread is made on the first one; the note's text goes along when it
 * changed. `mode` 'edit': he changes the note himself (EDIT_MODE_LINE); else he may suggest.
 */
export async function askAboutNote(noteId: string, text: string, mode: 'edit' | 'suggest' = 'suggest') {
  const n = ownerNotesRepo.get(noteId)
  if (!n) throw new AgentError('This note no longer exists', 404)
  if (!agentsRepo.manager()) throw new AgentError('Ask Marcus needs the manager: add one to the office first', 409)
  const t = noteHelperOf(noteId) ?? (await helperThreads.create({ title: `Note: ${n.title.trim() || 'Untitled'}`.slice(0, 80), noteId }))
  const snap = noteSnapshot(n)
  const hash = String(Bun.hash(snap))
  const changed = !t.started || sentHash.get(t.id) !== hash
  // the office's part before the owner's words (folded away in the chat): the mode, the note's text
  const before = [mode === 'edit' ? EDIT_MODE_LINE : null, changed ? snap : null].filter(Boolean).join('\n\n')
  const result = await sendToThread(t.id, text, before || undefined)
  sentHash.set(t.id, hash)
  return { threadId: t.id, sessionKey: t.sessionKey, queued: result === 'queued' }
}

/** The note is gone: so is its helper (its session and conversation). */
export async function forgetNoteHelper(noteId: string) {
  const t = noteHelperOf(noteId)
  if (!t) return
  sentHash.delete(t.id)
  await deleteThread(t.id)
}
