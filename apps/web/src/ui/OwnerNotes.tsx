import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LuArrowLeft, LuBookOpen, LuBookOpenCheck, LuBookPlus, LuCalendarDays, LuCheck, LuFolder, LuLoader, LuMinus, LuNotebookPen, LuPencil, LuPin, LuPinOff, LuUsers, LuPlus, LuListFilter, LuSearch, LuSettings2, LuTag, LuTrash2, LuX } from 'react-icons/lu'
import type { OwnerNote, OwnerNoteSummary } from '@after-office/shared'
import { api } from '../state/auth'
import { closestCenter, DndContext, MouseSensor, pointerWithin, TouchSensor, useDndContext, useSensor, useSensors, type CollisionDetection } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { useLive } from '../state/live'
import { openUrl, setUrl, useParam } from '../state/url'
import { NOTES, useMinimized } from '../state/minimized'
import { confirm } from './Confirm'
import { ago } from './FollowUps'
import { useModalMaximize } from './Maximize'
import { Modal } from './Modal'
import { Select } from './Select'
import { ProjectFolderPicker } from './ProjectFolderPicker'
import { TagChips, TagPicker } from './tags'
import { NoteDateButton, noteWhenLabel, type NoteWhen, type NoteWhenPatch } from './NoteDate'
import { inView, NotePageCards, NotePageChip, NotePageHeader, NotePageSelect, NoteTagCards, NoteTagHeader, PageNameModal, parentPage } from './NotePages'
import { lazyRetry } from '../pwa/lazyRetry'
import { NoteMenu, noteMenuAt, patchNote } from './NoteMenu'
import type { RichNotesApi } from './FolderNotes'
import { NoteAssistButton, NoteAssistFab, NoteAssistPanel, NoteAssistSheet } from './NoteAssist'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { useBackStep } from '../state/useBackStep'
import { usePresence } from '../state/usePresence'

// The owner's own notes (Reports → Notes): written in the dashboard with the same rich text editor as a folder's notes,
// with a folder and tags like a report. Only the owner writes them; no agent is given them.

// the editor (TipTap) loads only when a note is opened
const RichNotes = lazyRetry(() => import('./FolderNotes').then((m) => ({ default: m.RichNotes })))

const GROUP_KEY = 'after-office:notes-group'
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

/** A note in a list; dragged (anywhere on it, after a few pixels / a long press) to put it elsewhere (another place in
 *  the list, or, in the notes window, onto a page). */
export function NoteRow({ n, now, onOpen, sortable = false, showPage = false }: { n: OwnerNoteSummary; now: number; onOpen: () => void; sortable?: boolean; showPage?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: n.id, data: { kind: 'note', note: n }, disabled: !sortable })
  // over a page it can go to (ui/NotePages.tsx usePageDrop): says which
  const target = useDndContext().over?.data.current
  const moveTo = isDragging && target?.kind === 'page-target' && target.page !== (n.pageId ?? 'none') ? (target.name as string) : null
  // written (or last changed) by an agent: its name instead of "You"
  const by = useOffice((s) => {
    const id = n.editedBy ?? n.author
    return id ? (s.agents.find((a) => a.id === id)?.name ?? 'An agent') : 'You'
  })
  // right click: pin, share, page, tags, folder, delete (ui/NoteMenu.tsx)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
    <li
      ref={setNodeRef}
      className={`report-row${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...(sortable ? { ...attributes, ...listeners } : {})}
    >
      {moveTo && (
        <span className="note-row__move">
          <LuBookOpenCheck /> Move to <b className="truncate">{moveTo}</b>
        </span>
      )}
      <button className="report-row__main" onClick={onOpen} onContextMenu={(e) => setMenu(noteMenuAt(e))}>
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
            {n.date && (
              <span className="note-row__date">
                <LuCalendarDays /> {noteWhenLabel(n)}
              </span>
            )}
            {showPage && <NotePageChip pageId={n.pageId} />}
            <NotePlace folder={n.folder} />
            <TagChips ids={n.tags} max={1} />
          </span>
        </span>
      </button>
    </li>
    {/* beside the row, not in it: clicks in its menu and windows (portals) mustn't reach the row's drag */}
    <NoteMenu n={n} at={menu} onClose={() => setMenu(null)} onOpen={onOpen} />
    </>
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

const useNoteSensors = () =>
  useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }))

/** The notes, in their order; `sortable`: dragged into another order. `movable` (the notes window): in its drag
 *  (NoteMoves, not a DndContext of their own), dragged onto a page even where they can't be put in another order. */
function NoteItems({ notes, now, sortable, movable = false, onOpen, showPage }: { notes: OwnerNoteSummary[]; now: number; sortable: boolean; movable?: boolean; onOpen?: (id: string) => void; showPage?: boolean }) {
  const sensors = useNoteSensors()
  const rows = (
    // not to be put in another order: the others stay where they are while one is dragged (onto a page)
    <SortableContext items={notes.map((n) => n.id)} strategy={sortable ? verticalListSortingStrategy : () => null} disabled={!sortable && !movable}>
      {notes.map((n) => (
        <NoteRow key={n.id} n={n} now={now} sortable={sortable || movable} showPage={showPage} onOpen={() => (onOpen ? onOpen(n.id) : openUrl({ note: n.id }))} />
      ))}
    </SortableContext>
  )
  if (movable) return rows
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => moveNote(String(e.active.id), e.over ? String(e.over.id) : null)}>
      {rows}
    </DndContext>
  )
}

const kindOf = (c: { data: { current?: Record<string, unknown> } }) => c.data.current?.kind
/** A note: onto the page under the pointer (a card, a part of the header), else beside the nearest note; a page's card:
 *  among its sibling cards only. */
const noteOrPage: CollisionDetection = (args) => {
  const among = (kind: string) => args.droppableContainers.filter((c) => kindOf(c) === kind)
  if (kindOf(args.active) === 'page') return closestCenter({ ...args, droppableContainers: among('page') })
  const onPage = pointerWithin({ ...args, droppableContainers: among('page-target') })
  return onPage.length ? onPage : closestCenter({ ...args, droppableContainers: among('note') })
}

/**
 * The notes window's drag (a page's view): its notes, its header and its sub-pages' cards in one DndContext, so a note
 * is dropped onto a page (moved there) or among the notes (another order, when `sortable`); a sub-page's card sorts
 * among its siblings (NotePageCards). A move says so for a few seconds, with Undo.
 */
function NoteMoves({ sortable, children }: { sortable: boolean; children: ReactNode }) {
  const sensors = useNoteSensors()
  const [moved, setMoved] = useState<{ id: string; from: string | null; name: string; at: number } | { error: string; at: number } | null>(null)
  useEffect(() => {
    if (!moved) return
    const t = setTimeout(() => setMoved(null), 4000)
    return () => clearTimeout(t)
  }, [moved])
  const toPage = (n: OwnerNoteSummary, page: string, name: string) => {
    const pageId = page === 'none' ? null : page
    const from = n.pageId ?? null
    if (from === pageId) return
    patchNote(n, { pageId }).then(
      () => setMoved({ id: n.id, from, name, at: Date.now() }),
      (err: Error) => setMoved({ error: err.message, at: Date.now() }),
    )
  }
  const undo = () => {
    if (!moved || !('id' in moved)) return
    const n = useLive.getState().notes.find((x) => x.id === moved.id)
    setMoved(null)
    if (n) void patchNote(n, { pageId: moved.from }).catch((err: Error) => setMoved({ error: err.message, at: Date.now() }))
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={noteOrPage}
      onDragEnd={(e) => {
        const a = e.active.data.current
        if (a?.kind !== 'note') return
        const t = e.over?.data.current
        if (t?.kind === 'page-target') toPage(a.note as OwnerNoteSummary, t.page as string, t.name as string)
        else if (sortable) moveNote(String(e.active.id), e.over ? String(e.over.id) : null)
      }}
    >
      {children}
      {/* above the window (the app's toasts, styles/chat.css): out of it, so its scrolling and size don't move it */}
      {moved &&
        createPortal(
          <div className="sync-toast sync-toast--reply" role="status" key={moved.at}>
            <LuBookOpenCheck />
            {'error' in moved ? (
              <span>{moved.error}</span>
            ) : (
              <>
                <span>
                  Moved to <b>{moved.name}</b>
                </span>
                <button className="small" onClick={undo}>
                  Undo
                </button>
              </>
            )}
            <button className="icon-btn small ghost" data-tip="Dismiss" aria-label="Dismiss" onClick={() => setMoved(null)}>
              <LuX />
            </button>
          </div>,
          document.body,
        )}
    </DndContext>
  )
}

/** Reports card → Notes: pinned first, then in the owner's order (drag to change it). */
export function NotesList({ limit = 20 }: { limit?: number }) {
  const notes = useLive((s) => s.notes)
  const now = useNow(60_000).getTime()
  return (
    <ul className="list ui-switch">
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
 * A folder's details → Notes: that folder's notes (also in the Notes window, with the folder on them). One opens right
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
    <div className="fd__panel folder-notes ui-switch">
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

/** "View all" on the Notes tab: the pages as cards (ui/NotePages.tsx), then a page's notes (by search, folder and tag too). */
export function NotesModal({ onClose, onMinimize }: { onClose: () => void; onMinimize?: () => void }) {
  const notes = useLive((s) => s.notes)
  const now = useNow(60_000).getTime()
  // its view lives in the address bar (?notes=1&nq=…&nview=<page>|none|*), so a minimized one comes back as it was left
  const nq = useParam('nq') ?? ''
  const [q, setQ] = useState(nq)
  useEffect(() => setQ(nq), [nq])
  useEffect(() => {
    if (q === nq) return
    const t = setTimeout(() => setUrl({ nq: q.trim() || null }), 250)
    return () => clearTimeout(t)
  }, [q, nq])
  // open again: its chip goes
  useEffect(() => useMinimized.getState().remove(NOTES), [])
  // a folder's notes, or those about no folder ("none")
  const [place, setPlace] = useState('')
  // the pages as cards first; one opens its notes ('*': every note, 'none': those on no page). A search looks
  // through all of them (each row says its page).
  const nview = useParam('nview')
  const inPage = nview !== null
  const pages = useLive((s) => s.notePages)
  const view = nview === 'none' || pages.some((p) => p.id === nview) ? nview! : '*'
  // (replacing the entry: closing the window from inside a page must leave no copy of it behind for Back)
  const openPage = (id: string | null) => setUrl({ nview: id })
  // a page (not All notes / No page): its sub-pages show above its notes, a new page starts inside it
  const isPage = view !== '*' && view !== 'none'
  // back from a page: to the page it's in, then the cards
  const up = isPage ? parentPage(pages, view)?.id : undefined
  const goBack = () => (setTagFilter(''), openPage(up ?? null))
  // tags stay a filter inside a page
  const allTags = useDashboard((s) => s.tags)
  const [tagFilter, setTagFilter] = useState('')
  // the cards by page or by tag (remembered); inside a tag: ?nbytag=<tag>|none
  const [group, setGroup] = useState<'pages' | 'tags'>(() => {
    try {
      return localStorage.getItem(GROUP_KEY) === 'tags' ? 'tags' : 'pages'
    } catch {
      return 'pages'
    }
  })
  const pickGroup = (g: 'pages' | 'tags') => {
    setGroup(g)
    try {
      localStorage.setItem(GROUP_KEY, g)
    } catch {
      /* not remembered */
    }
  }
  const ntag = useParam('nbytag')
  const [addingPage, setAddingPage] = useState(false)
  // phones: the folder and tag filters shown (folded away to start with)
  const [filtering, setFiltering] = useState(false)
  const inTag = ntag !== null && !inPage
  const openTag = (id: string | null) => setUrl({ nbytag: id, nview: id ? null : '*' })
  const atCards = !inPage && !inTag && !q.trim()
  // phones: Back inside a page (or a tag) goes back to the page it's in, then the cards, not out of the window (a
  // step up to a parent page keeps the step: false)
  const phone = useMediaQuery(MOBILE)
  useBackStep(() => (inTag ? setUrl({ nbytag: null }) : (goBack(), up ? false : undefined)), phone && (inPage || inTag))
  const folders = [...new Set(notes.map((n) => n.folder).filter((f): f is string => !!f))]
  // full size (remembered), like the dock's sheets
  const max = useModalMaximize(720, 'after-office:sheet-max:Notes list')
  const shown = pinnedFirst(notes).filter(
    (n) =>
      (!q.trim() || matches(n, q)) &&
      (!place || (place === 'none' ? !n.folder : n.folder === place)) &&
      (!inPage || q.trim() || inView(n, view)) &&
      (!inTag || q.trim() || (ntag === 'none' ? !n.tags?.length : !!n.tags?.includes(ntag!))) &&
      (!tagFilter || !!n.tags?.includes(tagFilter)),
  )
  return (
    <Modal
      open
      onClose={onClose}
      title="Notes"
      description="Your own notes. Shared ones (Share with agents) can be read and changed by the agents; the rest only by you."
      {...max.modalProps}
      // a click beside it puts it aside (a chip brings it back as it was)
      onBackdrop={onMinimize}
      actions={
        <>
          {onMinimize && (
            <button className="icon-btn small ghost" data-tip="Minimize" aria-label="Minimize" onClick={onMinimize}>
              <LuMinus />
            </button>
          )}
          {max.modalProps.actions}
        </>
      }
    >
      <div className="modal__body reports-modal notes-modal" ref={max.bodyRef}>
        <div className={`reports-modal__bar notes-modal__bar${filtering ? ' is-filtering' : ''}`}>
          <label className="search-box">
            <LuSearch />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" maxLength={200} />
            {q && (
              <button className="icon-btn small ghost" onClick={() => setQ('')} aria-label="Clear search" data-tip="Clear">
                <LuX />
              </button>
            )}
          </label>
          {!atCards && (
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
          )}
          {!atCards && !inTag && allTags.length > 0 && (
            <Select
              ariaLabel="Tag"
              searchable
              className="reports-modal__project"
              value={tagFilter}
              options={[{ value: '', label: 'All tags' }, ...allTags.map((t) => ({ value: t.id, label: t.name }))]}
              onChange={setTagFilter}
            />
          )}
          <span className="grow notes-modal__gap" />
          {/* phones: the folder and tag filters fold away behind this, left of the add buttons (a dot: one is set) */}
          {!atCards && (
            <button
              type="button"
              className={`small notes-modal__new notes-modal__filter${filtering ? ' is-on' : ''}`}
              aria-label="Filters"
              aria-expanded={filtering}
              onClick={() => setFiltering(!filtering)}
            >
              <LuListFilter />
              {(place || tagFilter) && <span className="notes-modal__filter-dot" aria-hidden />}
            </button>
          )}
          {/* like Tasks: search on the left, New note on the right (inside a page, the new note starts on it) */}
          {/* the cards: a new page beside New note (inside a page: a new page in it, by default) */}
          {(atCards || (inPage && isPage && !q.trim())) && (
            <button className="small notes-modal__new" aria-label="New page" {...(max.full ? {} : { 'data-tip': 'New page' })} onClick={() => setAddingPage(true)}>
              <LuBookPlus /> <span className="notes-modal__new-label">New page</span>
            </button>
          )}
          {addingPage && <PageNameModal parent={inPage && isPage ? view : undefined} onClose={() => setAddingPage(false)} onSaved={(id) => (pickGroup('pages'), openPage(id))} />}
          {/* desktop, not full size: one row, the button just its + (styles/notes.css) */}
          <button
            className="small primary notes-modal__new"
            aria-label="New note"
            {...(max.full ? {} : { 'data-tip': 'New note' })}
            onClick={() => openUrl({ note: 'new', npage: inPage && view !== '*' && view !== 'none' ? view : null, ntag: inTag && ntag !== 'none' ? ntag : null })}
          >
            <LuPlus /> <span className="notes-modal__new-label">New note</span>
          </button>
        </div>
        {atCards && (
          <div className="seg-toggle notes-modal__group" role="tablist" aria-label="Notes by page or by tag">
            <button role="tab" aria-selected={group === 'pages'} className={group === 'pages' ? 'active' : ''} onClick={() => pickGroup('pages')}>
              <LuBookOpen /> By page
            </button>
            <button role="tab" aria-selected={group === 'tags'} className={group === 'tags' ? 'active' : ''} onClick={() => pickGroup('tags')}>
              <LuTag /> By tag
            </button>
          </div>
        )}
        {atCards ? (
          group === 'tags' ? <NoteTagCards notes={notes} onOpen={(id) => openTag(id ?? null)} /> : <NotePageCards notes={notes} onOpen={(id) => openPage(id)} />
        ) : (
        <NoteMoves sortable={shown.length === notes.length}>
        <div className="tag-detail">
        {!q.trim() &&
          (inTag ? (
            <NoteTagHeader notes={shown} tag={ntag!} onBack={() => setUrl({ nbytag: null })} />
          ) : (
            <NotePageHeader notes={notes} view={view} onBack={goBack} onOpen={(id) => (setTagFilter(''), openPage(id))} />
          ))}
        {/* inside a page: its sub-pages as cards, then its own notes */}
        {!q.trim() && !inTag && isPage && <NotePageCards notes={notes} parent={view} noteDrop onOpen={(id) => (setTagFilter(''), openPage(id))} />}
        <ul className="list reports-modal__list">
          {/* dragged into another order only when every note is shown (not while searching or filtering); onto a page
              (the header's way there, a sub-page's card) when the header shows */}
          <NoteItems notes={shown} now={now} sortable={shown.length === notes.length} movable={!q.trim() && !inTag} showPage={!!q.trim() || view === '*'} />
          {!shown.length && <li className="empty">{notes.length ? 'No notes match.' : 'No notes yet.'}</li>}
        </ul>
        </div>
        </NoteMoves>
        )}
      </div>
    </Modal>
  )
}

type Draft = Pick<OwnerNote, 'title' | 'html'> & { tags: string[]; shared: boolean; pinned: boolean; folder?: string | null; pageId?: string | null } & NoteWhenPatch

/**
 * One note being edited (a window, or a folder's details): loaded, saved as it changes (one save at a time, in order:
 * the first makes a new note, the rest change it). A new one is stored on its first change; left empty, it's dropped.
 */
function useNote({ id, defaults, onCreated }: { id: string; defaults?: { folder?: string; tags?: string[]; pageId?: string }; onCreated?: (id: string) => void }) {
  const noteId = useRef<string | null>(id === 'new' ? null : id)
  const [loaded, setLoaded] = useState<OwnerNote | null>(id === 'new' ? { id: '', title: '', html: '', createdAt: 0, updatedAt: 0 } : null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<string[]>(defaults?.tags ?? [])
  const [folder, setFolder] = useState<string | undefined>(defaults?.folder)
  // the page it's on (ui/NotePages.tsx); a note made inside a page starts on it
  const [pageId, setPageId] = useState<string | undefined>(defaults?.pageId)
  // optional for each note, off to start with: the agents may read and change it
  const [shared, setShared] = useState(false)
  const [pinned, setPinned] = useState(false)
  // its day on the calendar (ui/NoteDate.tsx)
  const [when, setWhen] = useState<NoteWhen>({})
  const draft = useRef<Draft>({
    title: '',
    html: '',
    tags: defaults?.tags ?? [],
    shared: false,
    pinned: false,
    ...(defaults?.folder ? { folder: defaults.folder } : {}),
    ...(defaults?.pageId ? { pageId: defaults.pageId } : {}),
  })
  // the editor has text (typed, maybe not saved yet)
  const editorEmpty = useRef(true)
  const closed = useRef(false)
  // its editor, once loaded: Ask Marcus's Insert / Replace note go through it (and save like typing)
  const editor = useRef<RichNotesApi | null>(null)

  /** the newest version this window has (opened on, or its own last save) */
  const known = useRef(0)
  const saving = useRef(0)
  const typedAt = useRef(0)
  /** bumped when the note changed elsewhere (an agent, another tab): the editor starts over on the new text */
  const [rev, setRev] = useState(0)
  const apply = (n: OwnerNote) => {
    known.current = Math.max(known.current, n.updatedAt)
    setLoaded(n)
    setTitle(n.title)
    setTags(n.tags ?? [])
    setFolder(n.folder)
    setPageId(n.pageId)
    setShared(!!n.shared)
    setPinned(!!n.pinned)
    setWhen({ date: n.date, dateEnd: n.dateEnd, time: n.time })
    editorEmpty.current = !n.html.trim()
    draft.current = { title: n.title, html: n.html, folder: n.folder ?? null, pageId: n.pageId ?? null, tags: n.tags ?? [], shared: !!n.shared, pinned: !!n.pinned }
  }
  const fetchNote = (noteKey: string) =>
    api(`/api/notes/${encodeURIComponent(noteKey)}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not open this note')
      return (await r.json()) as OwnerNote
    })

  useEffect(() => {
    if (id === 'new') return
    let gone = false
    fetchNote(id)
      .then((n) => !gone && apply(n))
      .catch((e: Error) => !gone && setError(e.message))
    return () => void (gone = true)
    // the note it was opened on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Changed by someone else while open (an agent wrote it, another tab): show their version, unless the owner is in
  // the middle of typing here (theirs is saved in a moment and would be overwritten by the reload).
  const remoteAt = useLive((s) => (noteId.current ? s.notes.find((n) => n.id === noteId.current)?.updatedAt : undefined))
  useEffect(() => {
    const key = noteId.current
    if (!key || !remoteAt || !known.current || remoteAt <= known.current) return
    if (saving.current || titleTimer.current || Date.now() - typedAt.current < 3000) return
    let gone = false
    fetchNote(key)
      .then((n) => {
        if (gone || saving.current || n.updatedAt <= known.current) return
        apply(n)
        setRev((r) => r + 1)
      })
      .catch(() => {})
    return () => void (gone = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteAt])

  const chain = useRef<Promise<number | null>>(Promise.resolve(null))
  const persist = (patch: Partial<Draft>) => {
    draft.current = { ...draft.current, ...patch }
    const run = async (): Promise<number | null> => {
      saving.current++
      try {
        return await save()
      } finally {
        saving.current--
      }
    }
    const save = async (): Promise<number | null> => {
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
      known.current = Math.max(known.current, n.updatedAt)
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
    titleTimer.current = setTimeout(() => {
      titleTimer.current = null
      persistQuietly({ title: v.trim() })
    }, 600)
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
    editor,
    persist,
    leave,
    remove,
    togglePin,
    rev,
    typedAt,
    /** its folder (none: cleared) */
    setPlace: (f: string | null) => {
      setFolder(f ?? undefined)
      persistQuietly({ folder: f ?? null })
    },
    setTags: (t: string[]) => (setTags(t), persistQuietly({ tags: t })),
    setShared: (v: boolean) => (setShared(v), persistQuietly({ shared: v })),
    pageId,
    /** its page (null: no page) */
    setPage: (p: string | null) => (setPageId(p ?? undefined), persistQuietly({ pageId: p })),
    when,
    /** a new day, range or time (null clears one; no day: none of it), shown at once and saved */
    setWhen: (patch: NoteWhenPatch) => {
      setWhen((w) => {
        const next = { ...w }
        for (const k of ['date', 'dateEnd', 'time'] as const) if (patch[k] !== undefined) next[k] = patch[k] ?? undefined
        if (!next.date) return {}
        if (next.dateEnd) next.time = undefined
        return next
      })
      persistQuietly(patch)
    },
  }
}
type NoteState = ReturnType<typeof useNote>

/** How much wider the note's window grows for Ask Marcus's panel (its column and the gap before it). */
const ASSIST_WIDTH = 376

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

/**
 * The note's name: shown in full (up to three lines, then "…") with a pencil to rename it; a new or untitled note
 * starts in the box. Enter or leaving the box puts it back.
 */
function NoteTitle({ note, autoFocus }: { note: NoteState; autoFocus: boolean }) {
  const [editing, setEditing] = useState(autoFocus || !note.title.trim())
  // opened by the pencil: the box takes the focus once it's there, the cursor at the end
  const box = useRef<HTMLTextAreaElement>(null)
  const [renaming, setRenaming] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!renaming || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [renaming])
  const done = () => {
    note.flushTitle()
    if (!note.title.trim()) return
    setEditing(false)
    setRenaming(false)
  }
  if (editing)
    return (
      <div className="note-modal__name note-modal__name--editing">
      <textarea
        ref={box}
        className="note-modal__title"
        value={note.title}
        onChange={(e) => note.changeTitle(e.target.value.replace(/\n/g, ' '))}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          done()
        }}
        placeholder="Title"
        aria-label="Title"
        maxLength={200}
        rows={1}
        autoFocus={autoFocus}
      />
      {/* ✓ keeps the name (as Enter does); pressed before the box loses its focus, so the click lands */}
      <button
        type="button"
        className="icon-btn small ghost note-modal__name-save"
        data-tip="Save title"
        aria-label="Save title"
        disabled={!note.title.trim()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={done}
      >
        <LuCheck />
      </button>
      </div>
    )
  return (
    <div className="note-modal__name">
      <h2 className="note-modal__name-text" title={note.title}>
        {note.title}
      </h2>
      <button type="button" className="icon-btn small ghost" data-tip="Rename" aria-label="Rename" onClick={() => (setEditing(true), setRenaming(true))}>
        <LuPencil />
      </button>
    </div>
  )
}

/** The note itself: title, folder, tags, Share with agents, and the rich text (`overEditor`: e.g. Ask Marcus's ✨ on it). */
function NoteFields({ note, autoFocus, overEditor }: { note: NoteState; autoFocus: boolean; overEditor?: ReactNode }) {
  // phones: its folder, page, date, tags and sharing fold away behind a settings button by the title
  const [settings, setSettings] = useState(false)
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
        <div className="note-modal__titlerow">
          <NoteTitle note={note} autoFocus={autoFocus} />
          <button
            type="button"
            className={`icon-btn small ghost note-modal__settings${settings ? ' is-on' : ''}`}
            aria-label="Note settings"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <LuSettings2 />
            {/* a dot: something is set (folder, page, date, tags or shared) */}
            {(note.folder || note.pageId || note.when.date || note.tags.length > 0 || note.shared) && <span className="note-modal__settings-dot" aria-hidden />}
          </button>
        </div>
        <div className={`note-modal__meta${settings ? ' is-open' : ''}`}>
          <NotePlaceButton note={note} />
          <NotePageSelect value={note.pageId} onChange={note.setPage} />
          <NoteDateButton value={note.when} onChange={note.setWhen} />
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
      <div className="note-modal__editor">
      <Suspense
        fallback={
          <div className="muted">
            <LuLoader className="spin" />
          </div>
        }
      >
        <RichNotes
          key={note.rev}
          initial={note.loaded.html}
          initialAt={note.loaded.updatedAt || null}
          autofocus={false}
          viewFirst
          placeholder="Write your note: ideas, decisions, todos, links…"
          save={(html) => note.persist({ html })}
          onEdit={(empty) => ((note.editorEmpty.current = empty), (note.typedAt.current = Date.now()))}
          onReady={(api) => void (note.editor.current = api)}
        />
      </Suspense>
      {overEditor}
      </div>
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
  /** a new note made from somewhere: its folder (a folder's details), its page (inside a page in Notes) */
  defaults?: { folder?: string; tags?: string[]; pageId?: string }
  onClose: () => void
  onCreated: (id: string) => void
  /** put aside (a chip brings it back) */
  onMinimize?: (id: string, title: string) => void
  /** minimized: kept mounted, not shown */
  hidden?: boolean
}) {
  const max = useModalMaximize(760)
  const note = useNote({ id, defaults, onCreated })
  const mobile = useMediaQuery(MOBILE)
  // Ask Marcus (?nai=1, ui/NoteAssist.tsx): only for a note that's stored (a new one gets its id on its first save)
  const saved = id !== 'new' ? id : null
  const assist = useParam('nai') === '1' && !hidden && !!saved
  const toggleAssist = () => (assist ? setUrl({ nai: null }) : openUrl({ nai: 1 }))
  const panel = assist && !mobile
  // the panel slides in as the window widens, and out before it goes (styles/note-assist.css)
  const panelShown = usePresence(panel, 200)

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
      hideTitle
      {...max.modalProps}
      // the chat on the right: the window widens for it
      width={panel && !max.full ? 760 + ASSIST_WIDTH : max.modalProps.width}
      className={`note-window${max.modalProps.className ? ` ${max.modalProps.className}` : ''}`}
      hidden={hidden}
      // a click beside it puts it aside instead of closing it (like a folder's window)
      onBackdrop={onMinimize ? () => void minimize() : undefined}
      actions={
        <>
          {!mobile && <NoteAssistButton saved={!!saved} on={assist} onToggle={toggleAssist} />}
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
      <div className={`modal__body note-modal note-modal--window${panel ? ' note-modal--assist' : ''}`} ref={max.bodyRef}>
        <div className="note-modal__main">
        <NoteFields note={note} autoFocus={id === 'new'} overEditor={mobile && note.loaded ? <NoteAssistFab saved={!!saved} onOpen={toggleAssist} /> : null} />
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
        {panelShown.mounted && saved && <NoteAssistPanel noteId={saved} editor={note.editor} closing={panelShown.closing} onClose={() => setUrl({ nai: null })} />}
      </div>
      {assist && mobile && <NoteAssistSheet noteId={saved} editor={note.editor} onClose={() => setUrl({ nai: null })} />}
    </Modal>
  )
}

/** A folder's note opened right in its details (no window of its own): Back goes to the folder's notes. */
function InlineNote({ id, folder, onBack }: { id: string; folder: string; onBack: () => void }) {
  // Ask Marcus: a sheet over the folder's window (no address of its own here); a new note has none until it's stored
  const [assist, setAssist] = useState(false)
  const [savedId, setSavedId] = useState(id === 'new' ? null : id)
  const note = useNote({ id, defaults: { folder }, onCreated: setSavedId })
  const back = () => {
    note.leave()
    onBack()
  }
  return (
    <div className="fd__panel note-inline note-modal ui-switch">
      <div className="note-inline__bar">
        <button className="small ghost" onClick={back}>
          <LuArrowLeft /> Notes
        </button>
        <span className="grow" />
        {note.loaded && (
          <>
            <NoteAssistButton saved={!!savedId} on={assist} onToggle={() => setAssist((v) => !v)} />
            <PinButton note={note} />
            <button className="icon-btn small ghost" data-tip="Delete" aria-label="Delete" onClick={async () => (await note.remove()) && onBack()}>
              <LuTrash2 />
            </button>
          </>
        )}
      </div>
      <NoteFields note={note} autoFocus={id === 'new'} />
      {assist && savedId && <NoteAssistSheet noteId={savedId} editor={note.editor} onClose={() => setAssist(false)} />}
    </div>
  )
}
