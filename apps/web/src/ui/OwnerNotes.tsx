import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { LuLoader, LuMinus, LuNotebookPen, LuPlus, LuSearch, LuTrash2, LuX } from 'react-icons/lu'
import type { OwnerNote, OwnerNoteSummary } from '@after-office/shared'
import { api } from '../state/auth'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useLive } from '../state/live'
import { openUrl } from '../state/url'
import { confirm } from './Confirm'
import { ago } from './FollowUps'
import { useModalMaximize } from './Maximize'
import { Modal } from './Modal'
import { Select } from './Select'
import { ProjectFolderButton } from './agent/chatContext'
import { TagChips, TagFilter, TagPicker } from './tags'

// The owner's own notes (Reports → Notes): written in the dashboard with the same rich text editor as a folder's notes,
// with a project and tags like a report. Only the owner writes them; no agent is given them.

// the editor (TipTap) loads only when a note is opened
const RichNotes = lazy(() => import('./FolderNotes').then((m) => ({ default: m.RichNotes })))

export function NoteRow({ n, now, onOpen }: { n: OwnerNoteSummary; now: number; onOpen: () => void }) {
  const project = useDashboard((s) => (n.projectId ? s.projects.find((p) => p.id === n.projectId) : undefined))
  return (
    <li className="report-row">
      <button className="report-row__main" onClick={onOpen}>
        <LuNotebookPen className="report__icon" />
        <span className="report-row__body">
          <span className="report-row__title truncate">{n.title || 'Untitled'}</span>
          <span className="report-row__text truncate">{n.excerpt || 'Empty note'}</span>
          <span className="report-row__meta">
            <span className="truncate">You · {ago(now - n.updatedAt)}</span>
            {project && (
              <span className="report-row__project" data-tip={`Project “${project.name}”`}>
                <span className="chip__dot" style={{ background: project.color }} />
                <span className="truncate">{project.name}</span>
              </span>
            )}
            <TagChips ids={n.tags} />
          </span>
        </span>
      </button>
    </li>
  )
}

/** Reports card → Notes: the newest notes. */
export function NotesList({ limit = 20 }: { limit?: number }) {
  const notes = useLive((s) => s.notes)
  const now = useNow(60_000).getTime()
  return (
    <ul className="list">
      {notes.slice(0, limit).map((n) => (
        <NoteRow key={n.id} n={n} now={now} onOpen={() => openUrl({ note: n.id })} />
      ))}
      {!notes.length && (
        <li className="empty">
          Your own notes: ideas, decisions, todos.{' '}
          <button type="button" className="link" onClick={() => openUrl({ note: 'new' })}>
            Write one
          </button>
        </li>
      )}
    </ul>
  )
}

const matches = (n: OwnerNoteSummary, q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${n.title} ${n.excerpt}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** "View all" on the Notes tab: every note, by search, project and tags. */
export function NotesModal({ onClose }: { onClose: () => void }) {
  const notes = useLive((s) => s.notes)
  const projects = useDashboard((s) => s.projects)
  const now = useNow(60_000).getTime()
  const [q, setQ] = useState('')
  const [project, setProject] = useState('')
  const [tags, setTags] = useState<string[]>([])
  // full size (remembered), like the dock's sheets
  const max = useModalMaximize(720, 'after-office:sheet-max:Notes list')
  const shown = notes.filter(
    (n) =>
      (!q.trim() || matches(n, q)) &&
      (!project || (project === 'none' ? !n.projectId : n.projectId === project)) &&
      (!tags.length || tags.some((t) => n.tags?.includes(t))),
  )
  return (
    <Modal
      open
      onClose={onClose}
      title="Notes"
      description="Your own notes. Only you write them, and they're never given to the agents."
      {...max.modalProps}
      actions={
        <>
          <button className="small" onClick={() => openUrl({ note: 'new' })}>
            <LuPlus /> New note
          </button>
          {max.modalProps.actions}
        </>
      }
    >
      <div className="modal__body reports-modal notes-modal" ref={max.bodyRef}>
        <div className="reports-modal__bar notes-modal__bar">
          <label className="search-box grow">
            <LuSearch />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" maxLength={200} />
            {q && (
              <button className="icon-btn small ghost" onClick={() => setQ('')} aria-label="Clear search" data-tip="Clear">
                <LuX />
              </button>
            )}
          </label>
          <Select
            ariaLabel="Project"
            searchable
            className="reports-modal__project"
            value={project}
            options={[{ value: '', label: 'All projects' }, { value: 'none', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={setProject}
          />
          <TagFilter className="reports-modal__tags" value={tags} onChange={setTags} />
        </div>
        <ul className="list reports-modal__list">
          {shown.map((n) => (
            <NoteRow key={n.id} n={n} now={now} onOpen={() => openUrl({ note: n.id })} />
          ))}
          {!shown.length && <li className="empty">{notes.length ? 'No notes match.' : 'No notes yet.'}</li>}
        </ul>
      </div>
    </Modal>
  )
}

type Draft = Pick<OwnerNote, 'title' | 'html'> & { projectId: string | null; tags: string[] }

/**
 * One note (?note=<id>, or ?note=new). A new one is stored on its first change; empty when closed, it's dropped.
 * Title, project and tags save on change, the text as you type (like a folder's notes).
 */
export function NoteModal({
  id,
  onClose,
  onCreated,
  onMinimize,
  hidden,
}: {
  id: string
  onClose: () => void
  onCreated: (id: string) => void
  /** put aside (a chip brings it back) */
  onMinimize?: (id: string, title: string) => void
  /** minimized: kept mounted, not shown */
  hidden?: boolean
}) {
  const projects = useDashboard((s) => s.projects)
  const max = useModalMaximize(760)
  const noteId = useRef<string | null>(id === 'new' ? null : id)
  const [loaded, setLoaded] = useState<OwnerNote | null>(id === 'new' ? { id: '', title: '', html: '', createdAt: 0, updatedAt: 0 } : null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const draft = useRef<Draft>({ title: '', html: '', projectId: null, tags: [] })

  useEffect(() => {
    if (id === 'new') return
    let gone = false
    api(`/api/notes/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not open this note')
        return (await r.json()) as OwnerNote
      })
      .then((n) => {
        if (gone) return
        setLoaded(n)
        setTitle(n.title)
        setProjectId(n.projectId ?? null)
        setTags(n.tags ?? [])
        editorEmpty.current = !n.html.trim()
        draft.current = { title: n.title, html: n.html, projectId: n.projectId ?? null, tags: n.tags ?? [] }
      })
      .catch((e: Error) => !gone && setError(e.message))
    return () => void (gone = true)
    // the note this window was opened on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // one save at a time, in order: the first one makes the note, the rest change it
  const chain = useRef<Promise<number | null>>(Promise.resolve(null))
  const closed = useRef(false)
  // the editor has text (typed, maybe not saved yet)
  const editorEmpty = useRef(true)
  const persist = (patch: Partial<Draft>) => {
    draft.current = { ...draft.current, ...patch }
    const run = async (): Promise<number | null> => {
      const made = noteId.current
      const r = made
        ? await api(`/api/notes/${encodeURIComponent(made)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        : await api('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft.current) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save')
      const n = (await r.json()) as OwnerNote
      if (!made) {
        noteId.current = n.id
        // closed before its first save landed: that window is gone, nothing to follow
        if (!closed.current) onCreated(n.id)
      }
      return n.updatedAt
    }
    const next = chain.current.catch(() => null).then(run)
    chain.current = next
    return next
  }
  const persistQuietly = (patch: Partial<Draft>) => void persist(patch).catch((e: Error) => setError(e.message))

  // the title saves a moment after typing stops
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const changeTitle = (v: string) => {
    setTitle(v)
    if (titleTimer.current) clearTimeout(titleTimer.current)
    titleTimer.current = setTimeout(() => persistQuietly({ title: v.trim() }), 600)
  }

  // closing: a title still being typed is saved; a note left empty goes
  const close = () => {
    closed.current = true
    if (titleTimer.current) {
      clearTimeout(titleTimer.current)
      persistQuietly({ title: title.trim() })
    }
    onClose()
    // after the editor has handed over what was typed last (it saves on its way out)
    setTimeout(
      () =>
        void chain.current
          .catch(() => null)
          .then(() => {
            const d = draft.current
            if (noteId.current && !d.title.trim() && !d.html.trim()) return api(`/api/notes/${encodeURIComponent(noteId.current)}`, { method: 'DELETE' })
          }),
      0,
    )
  }

  // put aside: a title still being typed is saved first. Not stored yet (nothing written): there's nothing to keep
  const minimize = async () => {
    if (!onMinimize) return close()
    if (titleTimer.current) {
      clearTimeout(titleTimer.current)
      titleTimer.current = null
      persistQuietly({ title: title.trim() })
    }
    // a new note not stored yet: stored now (what's typed in the editor follows on its own), unless there's nothing
    if (!noteId.current && (title.trim() || !editorEmpty.current)) await persist({ title: title.trim() }).catch(() => null)
    if (!noteId.current) return close()
    onMinimize(noteId.current, title.trim())
  }

  const remove = async () => {
    if (!noteId.current) return onClose()
    if (!(await confirm({ title: 'Delete this note?', message: <>“{title || 'Untitled'}” is deleted for good.</>, confirmLabel: 'Delete note' }))) return
    await api(`/api/notes/${encodeURIComponent(noteId.current)}`, { method: 'DELETE' })
    onClose()
  }

  return (
    <Modal
      open
      onClose={close}
      title={title.trim() || (id === 'new' ? 'New note' : 'Note')}
      {...max.modalProps}
      hidden={hidden}
      // a click beside it puts it aside instead of closing it (like a folder's window)
      onBackdrop={onMinimize ? () => void minimize() : undefined}
      actions={
        <>
          {onMinimize && (
            <button className="icon-btn small ghost" data-tip="Minimize" aria-label="Minimize" onClick={() => void minimize()}>
              <LuMinus />
            </button>
          )}
          {max.modalProps.actions}
        </>
      }
    >
      <div className="modal__body note-modal" ref={max.bodyRef}>
        {error && <div className="row__error">{error}</div>}
        {!loaded ? (
          !error && (
            <div className="muted">
              <LuLoader className="spin" />
            </div>
          )
        ) : (
          <>
            <div className="note-modal__fields">
              <input className="note-modal__title" value={title} onChange={(e) => changeTitle(e.target.value)} placeholder="Title" aria-label="Title" maxLength={200} autoFocus={id === 'new'} />
              <div className="note-modal__meta">
                {/* a folder, however deep (like the chat's): the project linked to it, or a new one named after it */}
                <ProjectFolderButton
                  value={projectId ?? ''}
                  tip="Choose the folder this note is about"
                  onChange={(v) => {
                    setProjectId(v || null)
                    persistQuietly({ projectId: v || null })
                  }}
                />
                <TagPicker
                  size="sm"
                  value={tags}
                  onChange={(t) => {
                    setTags(t)
                    persistQuietly({ tags: t })
                  }}
                />
              </div>
            </div>
            <Suspense
              fallback={
                <div className="muted">
                  <LuLoader className="spin" />
                </div>
              }
            >
              <RichNotes
                initial={loaded.html}
                initialAt={loaded.updatedAt || null}
                autofocus={false}
                placeholder="Write your note: ideas, decisions, todos, links…"
                save={(html) => persist({ html })}
                onEdit={(empty) => (editorEmpty.current = empty)}
              />
            </Suspense>
            <footer className="modal__foot">
              <button className="ghost" onClick={() => void remove()}>
                <LuTrash2 /> Delete
              </button>
              <span className="grow" />
              <button className="small" onClick={close}>
                Done
              </button>
            </footer>
          </>
        )}
      </div>
    </Modal>
  )
}
