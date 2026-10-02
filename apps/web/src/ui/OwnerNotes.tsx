import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { LuArrowLeft, LuFolder, LuLoader, LuMinus, LuNotebookPen, LuPin, LuPinOff, LuUsers, LuPlus, LuSearch, LuTrash2, LuX } from 'react-icons/lu'
import type { OwnerNote, OwnerNoteSummary } from '@after-office/shared'
import { api } from '../state/auth'
import { closestCenter, DndContext, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { useLive } from '../state/live'
import { openUrl } from '../state/url'
import { confirm } from './Confirm'
import { ago } from './FollowUps'
import { useModalMaximize } from './Maximize'
import { Modal } from './Modal'
import { Select } from './Select'
import { ProjectFolderPicker } from './ProjectFolderPicker'
import { TagChips, TagFilter, TagPicker } from './tags'

// The owner's own notes (Reports → Notes): written in the dashboard with the same rich text editor as a folder's notes,
// with a folder and tags like a report. Only the owner writes them; no agent is given them.

// the editor (TipTap) loads only when a note is opened
const RichNotes = lazy(() => import('./FolderNotes').then((m) => ({ default: m.RichNotes })))

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, '~')

/** The folder a note is about, as a chip. */
function NotePlace({ folder }: { folder?: string }) {
  if (!folder) return null
  return (
    <span className="report-row__project" data-tip={tilde(folder)}>
      <LuFolder className="note-row__folder" />
      <span className="truncate">{folderName(folder)}</span>
    </span>
  )
}

/** A note's folder: picked with the folder picker, however deep. */
function NotePlaceButton({ note }: { note: NoteState }) {
  const [browsing, setBrowsing] = useState(false)
  return (
    <>
      {browsing && <ProjectFolderPicker onPick={(f) => note.setPlace(f)} onClose={() => setBrowsing(false)} />}
      <span className="chat-ctx__project">
        <button type="button" className="chat-ctx__pick" onClick={() => setBrowsing(true)} data-tip={note.folder ? tilde(note.folder) : 'Choose the folder this note is about'}>
          {note.folder ? (
            <>
              <LuFolder className="note-row__folder" />
              <span className="truncate">{folderName(note.folder)}</span>
            </>
          ) : (
            <span className="muted">Choose a folder…</span>
          )}
        </button>
        {note.folder && (
          <button type="button" className="chat-ctx__unpick" aria-label="No folder" onClick={() => note.setPlace(null)}>
            <LuX />
          </button>
        )}
      </span>
    </>
  )
}

/** Pinned first, then as the server orders them (the owner's order). */
const pinnedFirst = (notes: OwnerNoteSummary[]) => [...notes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))

/** A note in a list; dragged (anywhere on it, after a few pixels / a long press) to put it elsewhere. */
export function NoteRow({ n, now, onOpen, sortable = false }: { n: OwnerNoteSummary; now: number; onOpen: () => void; sortable?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: n.id, disabled: !sortable })
  // written (or last changed) by an agent: its name instead of "You"
  const by = useOffice((s) => {
    const id = n.editedBy ?? n.author
    return id ? (s.agents.find((a) => a.id === id)?.name ?? 'An agent') : 'You'
  })
  return (
    <li
      ref={setNodeRef}
      className={`report-row${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...(sortable ? { ...attributes, ...listeners } : {})}
    >
      <button className="report-row__main" onClick={onOpen}>
        <LuNotebookPen className="report__icon" />
        <span className="report-row__body">
          <span className="report-row__title-line">
            <span className="report-row__title truncate">{n.title || 'Untitled'}</span>
            {n.pinned && <LuPin className="note-row__flag" aria-label="Pinned" />}
            {n.shared && <LuUsers className="note-row__flag" aria-label="Shared with the agents" data-tip="Shared with the agents" />}
          </span>
          <span className="report-row__text truncate">{n.excerpt || 'Empty note'}</span>
          <span className="report-row__meta">
            <span className="truncate">
              {by} · {ago(now - n.updatedAt)}
            </span>
            <NotePlace folder={n.folder} />
            <TagChips ids={n.tags} />
          </span>
        </span>
      </button>
    </li>
  )
}

/** Put a note where another one is (drag and drop): shown at once, stored on the server. */
function moveNote(activeId: string, overId: string | null) {
  if (!overId || activeId === overId) return
  const all = pinnedFirst(useLive.getState().notes)
  const from = all.findIndex((n) => n.id === activeId)
  const to = all.findIndex((n) => n.id === overId)
  if (from < 0 || to < 0) return
  const next = arrayMove(all, from, to)
  useLive.setState({ notes: next })
  void api('/api/notes/order', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: next.map((n) => n.id) }) })
}

/** The notes, in their order; `sortable`: dragged into another order. */
function NoteItems({ notes, now, sortable, onOpen }: { notes: OwnerNoteSummary[]; now: number; sortable: boolean; onOpen?: (id: string) => void }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  )
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => moveNote(String(e.active.id), e.over ? String(e.over.id) : null)}>
      <SortableContext items={notes.map((n) => n.id)} strategy={verticalListSortingStrategy} disabled={!sortable}>
        {notes.map((n) => (
          <NoteRow key={n.id} n={n} now={now} sortable={sortable} onOpen={() => (onOpen ? onOpen(n.id) : openUrl({ note: n.id }))} />
        ))}
      </SortableContext>
    </DndContext>
  )
}

/** Reports card → Notes: pinned first, then in the owner's order (drag to change it). */
export function NotesList({ limit = 20 }: { limit?: number }) {
  const notes = useLive((s) => s.notes)
  const now = useNow(60_000).getTime()
  return (
    <ul className="list">
      <NoteItems notes={pinnedFirst(notes).slice(0, limit)} now={now} sortable />
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

/**
 * A folder's details → Notes: that folder's notes (also in Docs → Notes, with the folder on them). One opens right
 * here, with Back to the list.
 */
export function FolderNoteList({ folder }: { folder: string }) {
  const notes = useLive((s) => s.notes)
  const now = useNow(60_000).getTime()
  // a note opened right here (no window): its id, or 'new'
  const [open, setOpen] = useState<string | null>(null)
  const [opened, setOpened] = useState(0)
  const mine = pinnedFirst(notes).filter((n) => n.folder === folder)
  const show = (id: string) => (setOpen(id), setOpened((k) => k + 1))
  const add = () => show('new')
  if (open) return <InlineNote key={opened} id={open} folder={folder} onBack={() => setOpen(null)} />
  return (
    <div className="fd__panel folder-notes">
      <div className="folder-notes__head">
        <span className="muted">{mine.length ? `${mine.length} note${mine.length === 1 ? '' : 's'} on this folder` : 'Notes on this folder'}</span>
        <span className="grow" />
        <button className="small" onClick={add}>
          <LuPlus /> New note
        </button>
      </div>
      <ul className="list">
        <NoteItems notes={mine} now={now} sortable onOpen={show} />
        {!mine.length && (
          <li className="empty">
            Ideas, todos, links about this folder. They're kept in the dashboard, not in the folder.{' '}
            <button type="button" className="link" onClick={add}>
              Write one
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

const matches = (n: OwnerNoteSummary, q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${n.title} ${n.excerpt}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** "View all" on the Notes tab: every note, by search, folder and tags. */
export function NotesModal({ onClose }: { onClose: () => void }) {
  const notes = useLive((s) => s.notes)
  const now = useNow(60_000).getTime()
  const [q, setQ] = useState('')
  // a folder's notes, or those about no folder ("none")
  const [place, setPlace] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const folders = [...new Set(notes.map((n) => n.folder).filter((f): f is string => !!f))]
  // full size (remembered), like the dock's sheets
  const max = useModalMaximize(720, 'after-office:sheet-max:Notes list')
  const shown = pinnedFirst(notes).filter(
    (n) =>
      (!q.trim() || matches(n, q)) &&
      (!place || (place === 'none' ? !n.folder : n.folder === place)) &&
      (!tags.length || tags.some((t) => n.tags?.includes(t))),
  )
  return (
    <Modal
      open
      onClose={onClose}
      title="Notes"
      description="Your own notes. Shared ones (Share with agents) can be read and changed by the agents; the rest only by you."
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
            ariaLabel="Folder"
            searchable
            className="reports-modal__project"
            value={place}
            options={[
              { value: '', label: 'All folders' },
              { value: 'none', label: 'No folder' },
              ...folders.map((f) => ({ value: f, label: folderName(f) })),
            ]}
            onChange={setPlace}
          />
          <TagFilter className="reports-modal__tags" value={tags} onChange={setTags} />
        </div>
        <ul className="list reports-modal__list">
          {/* dragged into another order only when every note is shown (not while searching or filtering) */}
          <NoteItems notes={shown} now={now} sortable={shown.length === notes.length} />
          {!shown.length && <li className="empty">{notes.length ? 'No notes match.' : 'No notes yet.'}</li>}
        </ul>
      </div>
    </Modal>
  )
}

type Draft = Pick<OwnerNote, 'title' | 'html'> & { tags: string[]; shared: boolean; pinned: boolean; folder?: string | null }

/**
 * One note being edited (a window, or a folder's details): loaded, saved as it changes (one save at a time, in order:
 * the first makes a new note, the rest change it). A new one is stored on its first change; left empty, it's dropped.
 */
function useNote({ id, defaults, onCreated }: { id: string; defaults?: { folder?: string }; onCreated?: (id: string) => void }) {
  const noteId = useRef<string | null>(id === 'new' ? null : id)
  const [loaded, setLoaded] = useState<OwnerNote | null>(id === 'new' ? { id: '', title: '', html: '', createdAt: 0, updatedAt: 0 } : null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [folder, setFolder] = useState<string | undefined>(defaults?.folder)
  // optional for each note, off to start with: the agents may read and change it
  const [shared, setShared] = useState(false)
  const [pinned, setPinned] = useState(false)
  const draft = useRef<Draft>({
    title: '',
    html: '',
    tags: [],
    shared: false,
    pinned: false,
    ...(defaults?.folder ? { folder: defaults.folder } : {}),
  })
  // the editor has text (typed, maybe not saved yet)
  const editorEmpty = useRef(true)
  const closed = useRef(false)

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
        setTags(n.tags ?? [])
        setFolder(n.folder)
        setShared(!!n.shared)
        setPinned(!!n.pinned)
        editorEmpty.current = !n.html.trim()
        draft.current = { title: n.title, html: n.html, folder: n.folder ?? null, tags: n.tags ?? [], shared: !!n.shared, pinned: !!n.pinned }
      })
      .catch((e: Error) => !gone && setError(e.message))
    return () => void (gone = true)
    // the note it was opened on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chain = useRef<Promise<number | null>>(Promise.resolve(null))
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
        if (!closed.current) onCreated?.(n.id)
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
  /** a title still being typed: saved now */
  const flushTitle = () => {
    if (!titleTimer.current) return
    clearTimeout(titleTimer.current)
    titleTimer.current = null
    persistQuietly({ title: title.trim() })
  }

  /** Leaving it (closed, or back to the list): a title still being typed is saved; a note left empty goes. */
  const leave = () => {
    closed.current = true
    flushTitle()
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

  /** Deleted for good (after asking); true when it's gone. */
  const remove = async () => {
    if (!noteId.current) return true
    if (!(await confirm({ title: 'Delete this note?', message: <>“{title || 'Untitled'}” is deleted for good.</>, confirmLabel: 'Delete note' }))) return false
    closed.current = true
    await api(`/api/notes/${encodeURIComponent(noteId.current)}`, { method: 'DELETE' })
    return true
  }

  const togglePin = () => {
    setPinned(!pinned)
    persistQuietly({ pinned: !pinned })
  }

  return {
    noteId,
    loaded,
    error,
    title,
    changeTitle,
    flushTitle,
    tags,
    folder,
    shared,
    pinned,
    editorEmpty,
    persist,
    leave,
    remove,
    togglePin,
    /** its folder (none: cleared) */
    setPlace: (f: string | null) => {
      setFolder(f ?? undefined)
      persistQuietly({ folder: f ?? null })
    },
    setTags: (t: string[]) => (setTags(t), persistQuietly({ tags: t })),
    setShared: (v: boolean) => (setShared(v), persistQuietly({ shared: v })),
  }
}
type NoteState = ReturnType<typeof useNote>

function PinButton({ note }: { note: NoteState }) {
  return (
    <button
      className={`icon-btn small ghost${note.pinned ? ' is-on' : ''}`}
      data-tip={note.pinned ? 'Unpin' : 'Pin to the top'}
      aria-label={note.pinned ? 'Unpin' : 'Pin'}
      aria-pressed={note.pinned}
      onClick={note.togglePin}
    >
      {note.pinned ? <LuPinOff /> : <LuPin />}
    </button>
  )
}

/** The note itself: title, folder, tags, Share with agents, and the rich text. */
function NoteFields({ note, autoFocus }: { note: NoteState; autoFocus: boolean }) {
  if (note.error && !note.loaded) return <div className="row__error">{note.error}</div>
  if (!note.loaded)
    return (
      <div className="muted">
        <LuLoader className="spin" />
      </div>
    )
  return (
    <>
      {note.error && <div className="row__error">{note.error}</div>}
      <div className="note-modal__fields">
        <input
          className="note-modal__title"
          value={note.title}
          onChange={(e) => note.changeTitle(e.target.value)}
          placeholder="Title"
          aria-label="Title"
          maxLength={200}
          autoFocus={autoFocus}
        />
        <div className="note-modal__meta">
          <NotePlaceButton note={note} />
          <TagPicker size="sm" value={note.tags} onChange={note.setTags} />
          <label
            className="note-modal__share"
            data-tip={note.shared ? 'The agents can read and change it (the manager through its tools)' : 'Only you can see it'}
          >
            <span className="toggle">
              <input type="checkbox" role="switch" checked={note.shared} onChange={(e) => note.setShared(e.target.checked)} />
              <span />
            </span>
            <LuUsers /> <span className="hide-phone">Share with agents</span>
            <span className="show-phone">Agents</span>
          </label>
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
          initial={note.loaded.html}
          initialAt={note.loaded.updatedAt || null}
          autofocus={false}
          placeholder="Write your note: ideas, decisions, todos, links…"
          save={(html) => note.persist({ html })}
          onEdit={(empty) => (note.editorEmpty.current = empty)}
        />
      </Suspense>
    </>
  )
}

/**
 * One note in its own window (?note=<id>, or ?note=new). Title, folder and tags save on change, the text as you type.
 */
export function NoteModal({
  id,
  onClose,
  onCreated,
  onMinimize,
  hidden,
  defaults,
}: {
  id: string
  /** a new note made from somewhere: its folder (a folder's details) */
  defaults?: { folder?: string }
  onClose: () => void
  onCreated: (id: string) => void
  /** put aside (a chip brings it back) */
  onMinimize?: (id: string, title: string) => void
  /** minimized: kept mounted, not shown */
  hidden?: boolean
}) {
  const max = useModalMaximize(760)
  const note = useNote({ id, defaults, onCreated })

  const close = () => {
    note.leave()
    onClose()
  }

  // put aside: a title still being typed is saved first. Not stored yet (nothing written): there's nothing to keep
  const minimize = async () => {
    if (!onMinimize) return close()
    note.flushTitle()
    // a new note not stored yet: stored now (what's typed in the editor follows on its own), unless there's nothing
    if (!note.noteId.current && (note.title.trim() || !note.editorEmpty.current)) await note.persist({ title: note.title.trim() }).catch(() => null)
    if (!note.noteId.current) return close()
    onMinimize(note.noteId.current, note.title.trim())
  }

  return (
    <Modal
      open
      onClose={close}
      title={note.title.trim() || (id === 'new' ? 'New note' : 'Note')}
      {...max.modalProps}
      hidden={hidden}
      // a click beside it puts it aside instead of closing it (like a folder's window)
      onBackdrop={onMinimize ? () => void minimize() : undefined}
      actions={
        <>
          <PinButton note={note} />
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
        <NoteFields note={note} autoFocus={id === 'new'} />
        {note.loaded && (
          <footer className="modal__foot">
            <button className="ghost" onClick={async () => (await note.remove()) && onClose()}>
              <LuTrash2 /> Delete
            </button>
            <span className="grow" />
            <button className="small" onClick={close}>
              Done
            </button>
          </footer>
        )}
      </div>
    </Modal>
  )
}

/** A folder's note opened right in its details (no window of its own): Back goes to the folder's notes. */
function InlineNote({ id, folder, onBack }: { id: string; folder: string; onBack: () => void }) {
  const note = useNote({ id, defaults: { folder } })
  const back = () => {
    note.leave()
    onBack()
  }
  return (
    <div className="fd__panel note-inline note-modal">
      <div className="note-inline__bar">
        <button className="small ghost" onClick={back}>
          <LuArrowLeft /> Notes
        </button>
        <span className="grow" />
        {note.loaded && (
          <>
            <PinButton note={note} />
            <button className="icon-btn small ghost" data-tip="Delete" aria-label="Delete" onClick={async () => (await note.remove()) && onBack()}>
              <LuTrash2 />
            </button>
          </>
        )}
      </div>
      <NoteFields note={note} autoFocus={id === 'new'} />
    </div>
  )
}
