import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LuArrowLeft, LuArrowRight, LuBookOpen, LuBookPlus, LuCheck, LuChevronRight, LuEllipsis, LuFolderInput, LuInbox, LuLayers, LuPencil, LuPlus, LuTag, LuTrash2 } from 'react-icons/lu'
import type { NotePage, OwnerNoteSummary } from '@after-office/shared'
import { closestCenter, DndContext, MouseSensor, TouchSensor, useDndMonitor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../state/auth'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useLive } from '../state/live'
import { ActionMenu } from './ActionMenu'
import { confirm } from './Confirm'
import { ago } from './FollowUps'
import { Field, Modal } from './Modal'
import { Select } from './Select'
import { TagIcon } from './tagIcons'

// Notes → View all: the notes kept on pages (notebooks; pages hold sub-pages, any depth), shown as cards like the
// tasks' tag cards (styles/tasks-modal.css .tag-card): All notes, each top-level page, No page, and a new one. A card
// opens its page: its sub-pages as cards, then its own notes. A note's window picks its page (NotePageSelect, the
// tree). Deleting a page keeps its notes and sub-pages: they move up to its parent (the server moves them).

/** Which notes a view shows: '*' every note, 'none' those on no page, else a page's id. */
export type PageView = string
export const inView = (n: OwnerNoteSummary, view: PageView) => (view === '*' ? true : view === 'none' ? !n.pageId : n.pageId === view)

/**
 * A page a note can be dropped on while it's dragged in the notes window (a sub-page's card, a part of the header's
 * way there): `page` its id, or 'none' (no page). `slot` keeps the ids apart (the same page as Back and as a crumb).
 * Its class: lit up while a note from another page is dragged, more over it. (The drag: OwnerNotes.tsx NoteMoves.)
 */
export function usePageDrop(slot: string, page: string, name: string, enabled = true) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `page:${slot}:${page}`, data: { kind: 'page-target', page, name }, disabled: !enabled })
  const note = active?.data.current?.kind === 'note' ? (active.data.current.note as OwnerNoteSummary) : null
  // its own page: nothing to move
  const live = !!note && (note.pageId ?? 'none') !== page
  return { ref: setNodeRef, cls: live ? (isOver ? ' is-drop-over' : ' is-drop-target') : '' }
}

const NO_ORDER = Number.MAX_SAFE_INTEGER
/** The pages' order among siblings (as the server lists them): the placed ones first, then by when they were made. */
const byOrder = (a: NotePage, b: NotePage) => (a.order ?? NO_ORDER) - (b.order ?? NO_ORDER) || a.createdAt - b.createdAt

/** Each page's sub-pages, in order; `undefined`: the top level (a page whose parent is gone counts as top level). */
export function pageKids(pages: NotePage[]) {
  const ids = new Set(pages.map((p) => p.id))
  const kids = new Map<string | undefined, NotePage[]>()
  for (const p of pages) {
    const up = p.parentId && ids.has(p.parentId) ? p.parentId : undefined
    kids.set(up, [...(kids.get(up) ?? []), p])
  }
  for (const list of kids.values()) list.sort(byOrder)
  return (parentId?: string) => kids.get(parentId) ?? []
}

/** The pages as a tree, flattened: each right after its parent, with how deep it sits. `skip`: a page left out with
 *  everything under it (a page being moved can't go under itself). */
export function pageTree(pages: NotePage[], skip?: string) {
  const kidsOf = pageKids(pages)
  const out: { page: NotePage; depth: number }[] = []
  const walk = (parentId: string | undefined, depth: number) => {
    for (const p of kidsOf(parentId)) {
      if (p.id === skip) continue
      out.push({ page: p, depth })
      walk(p.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** A page and the pages it's in, from the top: [top, …, the page]. Empty: no such page. */
export function pagePath(pages: NotePage[], id?: string) {
  const path: NotePage[] = []
  const seen = new Set<string>()
  for (let p = pages.find((x) => x.id === id); p && !seen.has(p.id); p = pages.find((x) => x.id === p!.parentId)) {
    seen.add(p.id)
    path.unshift(p)
  }
  return path
}

/** The page it's in (unset: the top level, or no such page). */
export const parentPage = (pages: NotePage[], id?: string) => pagePath(pages, id).at(-2)

/** A saved page in the live list at once (its update can come after it's opened or shown). */
const keep = (saved: NotePage) =>
  useLive.setState((s) => ({ notePages: s.notePages.some((p) => p.id === saved.id) ? s.notePages.map((p) => (p.id === saved.id ? saved : p)) : [...s.notePages, saved] }))

const send = async (path: string, method: string, body?: unknown) => {
  const r = await api(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save')
  return r.json()
}

/** Delete a page after asking; its notes and sub-pages stay, moved up to its parent (or no page / the top level). */
export async function deletePage(page: NotePage, count: number) {
  const pages = useLive.getState().notePages
  const up = parentPage(pages, page.id)
  const subs = pageKids(pages)(page.id).length
  const notes = count ? `${count} note${count === 1 ? '' : 's'}` : ''
  const kids = subs ? `${subs} sub-page${subs === 1 ? '' : 's'}` : ''
  const message = up
    ? notes || kids
      ? `Its ${[notes, kids].filter(Boolean).join(' and ')} stay, moved to “${up.name}”.`
      : 'It has no notes.'
    : [notes && `Its ${notes} stay, on no page.`, kids && `Its ${kids} move up to the top level.`].filter(Boolean).join(' ') || 'It has no notes.'
  const ok = await confirm({
    title: `Delete the page “${page.name}”?`,
    message,
    confirmLabel: 'Delete page',
  })
  if (!ok) return false
  await send(`/api/note-pages/${encodeURIComponent(page.id)}`, 'DELETE')
  return true
}

/** New page, or a page renamed: its name. A new one inside `parent` (by default; it can go to the top level instead).
 *  `onSaved` gets the page's id. */
export function PageNameModal({ page, parent, onClose, onSaved }: { page?: NotePage; parent?: string; onClose: () => void; onSaved?: (id: string) => void }) {
  const parentOne = useLive((s) => (parent ? s.notePages.find((p) => p.id === parent) : undefined))
  const [inside, setInside] = useState(true)
  const [name, setName] = useState(page?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const saved = (await (page
        ? send(`/api/note-pages/${encodeURIComponent(page.id)}`, 'PUT', { name })
        : send('/api/note-pages', 'POST', { name, ...(parentOne && inside ? { parentId: parentOne.id } : {}) }))) as NotePage
      // shown right away: the live update can come after the page is opened (which would show All notes meanwhile)
      keep(saved)
      onSaved?.(saved.id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={page ? 'Rename page' : parentOne && inside ? 'New sub-page' : 'New page'} width={400}>
      <form
        className="modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label="Name">
          <input autoFocus onFocus={(e) => e.currentTarget.select()} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marketing, Ideas, Home" />
        </Field>
        {/* inside the page it was asked from (by default), or on its own at the top level */}
        {!page && parentOne && (
          <p className="page-name__where">
            <LuBookOpen />
            <span className="truncate">{inside ? <>Inside: <b>{parentOne.name}</b></> : 'At the top level'}</span>
            <button type="button" className="small ghost" onClick={() => setInside(!inside)}>
              {inside ? 'Make it top level' : 'Put it inside'}
            </button>
          </p>
        )}
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <button type="submit" className="primary" disabled={!name.trim() || saving}>
            <LuCheck /> {page ? 'Save' : 'Create page'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** The card that has the focus (as on the tag cards): a click elsewhere takes it away; only a card's footer opens it. */
function useCardFocus() {
  const [focus, setFocus] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus === null) return
    const away = (e: PointerEvent) => {
      const card = (e.target as HTMLElement).closest?.('.tag-card')
      if (!card || !box.current?.contains(card)) setFocus(null)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [focus])
  return { focus, setFocus, box }
}

const byLatest = (notes: OwnerNoteSummary[]) => [...notes].sort((a, b) => b.updatedAt - a.updatedAt)

/** One card: a page's (or a tag's) notes, by name, and how many; its footer opens them. */
function NoteCard({ i, id, title, icon, color, list, subs = 0, updatedAt, now, on, onFocus, onOpen, onMenu, sortable = false, noteDrop = false }: {
  i: number
  id: string
  title: string
  icon: ReactNode
  color: string
  list: OwnerNoteSummary[]
  /** a page's sub-pages, how many */
  subs?: number
  updatedAt?: number
  now: number
  on: boolean
  onFocus: () => void
  onOpen: () => void
  onMenu?: (at: { x: number; y: number }) => void
  /** a page's card: dragged into another place among the pages */
  sortable?: boolean
  /** a sub-page's card in the notes window: a note dragged onto it goes to that page */
  noteDrop?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data: { kind: 'page' }, disabled: !sortable })
  const drop = usePageDrop('card', id, title, noteDrop)
  // one node, both: its place among the pages, and a page notes are dropped on (the same function each render)
  const dropRef = drop.ref
  const ref = useCallback((el: HTMLElement | null) => (setNodeRef(el), dropRef(el)), [setNodeRef, dropRef])
  const latest = byLatest(list)
  const last = Math.max(updatedAt ?? 0, latest[0]?.updatedAt ?? 0)
  return (
    <div
      key={id}
      ref={ref}
      {...(sortable ? { ...attributes, ...listeners } : {})}
      role="option"
      aria-selected={on}
      className={`tag-card tag-card--static page-card${on ? ' is-on' : ''}${isDragging ? ' is-dragging' : ''}${drop.cls}`}
      // moved by a drag: its way in (a transform that stays) gives way to the drag's
      style={{ ['--c' as string]: color, ['--i' as string]: Math.min(i, 12), transform: CSS.Transform.toString(transform), transition, ...(transform ? { animation: 'none' } : {}) }}
      onClick={onFocus}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault()
          onFocus()
          onMenu({ x: e.clientX, y: e.clientY })
        })
      }
    >
      <span className="tag-card__top">
        <span className="tag-card__icon">{icon}</span>
        <span className={`tag-card__badge${list.length ? ' tag-card__badge--active' : ''}`}>
          {list.length ? `${list.length} note${list.length === 1 ? '' : 's'}` : 'empty'}
        </span>
      </span>
      <span className="tag-card__title">{title}</span>
      {/* its latest notes, by name */}
      <span className="tag-card__next page-card__titles">
        {latest.length
          ? latest.slice(0, 3).map((n) => (
              <span key={n.id} className="truncate">
                {n.title || 'Untitled'}
              </span>
            ))
          : 'No notes yet'}
      </span>
      <button type="button" className="tag-card__foot tag-card__open" onClick={onOpen} aria-label={`Open ${title}`}>
        <span className="tag-card__count">
          <b>{list.length}</b> note{list.length === 1 ? '' : 's'}
          {subs > 0 && (
            <span className="page-card__subs">
              {' '}
              · {subs} sub-page{subs === 1 ? '' : 's'}
            </span>
          )}
          {last ? <span className="muted"> · {ago(now - last)}</span> : null}
        </span>
        <span className="tag-card__go" aria-hidden>
          <LuArrowRight />
        </span>
      </button>
    </div>
  )
}

/** A page's right-click menu (its card, or its header inside it): open, new sub-page, rename, move, delete. `onGo`:
 *  a page to open (a new sub-page, once made). */
function PageMenu({ page, count, at, onClose, onOpen, onGo, onGone }: {
  page: NotePage
  count: number
  at: { x: number; y: number; above?: number }
  onClose: () => void
  onOpen?: () => void
  onGo?: (id: string) => void
  onGone?: () => void
}) {
  // a pick closes the menu first, then runs: these keep it mounted for their window
  const [open, setOpen] = useState<'rename' | 'sub' | 'move' | null>(null)
  const [shown, setShown] = useState(true)
  useEffect(() => {
    if (!shown && !open) onClose()
  }, [shown, open, onClose])
  return (
    <>
      {shown && (
        <ActionMenu
          x={at.x}
          y={at.y}
          above={at.above}
          title={page.name}
          onClose={() => setShown(false)}
          actions={[
            ...(onOpen ? [{ icon: <LuArrowRight />, label: 'Open', run: onOpen }] : []),
            { icon: <LuBookPlus />, label: 'New sub-page', run: () => setOpen('sub') },
            { icon: <LuPencil />, label: 'Rename', run: () => setOpen('rename') },
            { icon: <LuFolderInput />, label: 'Move to…', run: () => setOpen('move') },
            { icon: <LuTrash2 />, label: 'Delete page', danger: true, run: () => void deletePage(page, count).then((gone) => gone && onGone?.()) },
          ]}
        />
      )}
      {open === 'rename' && <PageNameModal page={page} onClose={() => setOpen(null)} />}
      {open === 'sub' && <PageNameModal parent={page.id} onClose={() => setOpen(null)} onSaved={onGo} />}
      {open === 'move' && <MovePageModal page={page} onClose={() => setOpen(null)} />}
    </>
  )
}

/** Move a page: into another page (the tree, without itself and its sub-pages) or to the top level. */
function MovePageModal({ page, onClose }: { page: NotePage; onClose: () => void }) {
  const pages = useLive((s) => s.notePages)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const here = parentPage(pages, page.id)?.id ?? ''
  const pick = async (parentId: string) => {
    if (saving) return
    if (parentId === here) return onClose()
    setSaving(true)
    try {
      keep((await send(`/api/note-pages/${encodeURIComponent(page.id)}`, 'PUT', { parentId: parentId || null })) as NotePage)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }
  const row = (id: string, name: string, depth: number, icon: ReactNode) => (
    <li key={id || 'top'}>
      <button
        type="button"
        className={`page-tree__item${id === here ? ' is-on' : ''}`}
        style={{ ['--depth' as string]: depth }}
        disabled={saving}
        aria-current={id === here || undefined}
        onClick={() => void pick(id)}
      >
        {icon}
        <span className="truncate">{name}</span>
        {id === here && <LuCheck className="page-tree__here" aria-label="Here now" />}
      </button>
    </li>
  )
  return (
    <Modal open onClose={onClose} title="Move page" description={`“${page.name}” and its sub-pages go with it.`} width={400}>
      <div className="modal__body">
        <ul className="page-tree" aria-label="Move to">
          {row('', 'Top level', 0, <LuLayers />)}
          {pageTree(pages, page.id).map(({ page: p, depth }) => row(p.id, p.name, depth + 1, <LuBookOpen />))}
        </ul>
        {error && <p className="danger-text">{error}</p>}
      </div>
    </Modal>
  )
}

/** Their order changed by a drag in the DndContext around them (a page's card dropped among its siblings). */
function PageOrder({ onMove }: { onMove: (from: string, to: string | null) => void }) {
  useDndMonitor({ onDragEnd: (e) => e.active.data.current?.kind === 'page' && onMove(String(e.active.id), e.over ? String(e.over.id) : null) })
  return null
}

/** The cards of the top level (All notes, its pages, No page, a new one), or, with `parent`, of that page's sub-pages
 *  (and a new sub-page). `onOpen`: a card's footer clicked (that page's notes). `noteDrop`: inside the notes window's
 *  drag (its DndContext, not one of their own): notes dropped on a card go to that page, the cards still sort. */
export function NotePageCards({ notes, parent, onOpen, noteDrop = false }: { notes: OwnerNoteSummary[]; parent?: string; onOpen: (view: PageView) => void; noteDrop?: boolean }) {
  const allPages = useLive((s) => s.notePages)
  const kidsOf = pageKids(allPages)
  const pages = kidsOf(parent)
  const now = useNow(60_000).getTime()
  const { focus, setFocus, box } = useCardFocus()
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<{ page: NotePage; x: number; y: number } | null>(null)
  const loose = parent ? [] : notes.filter((n) => !n.pageId)
  // the pages' order among their siblings: dragged (a held finger on a phone), shown at once, stored on the server
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }))
  const move = (from: string, to: string | null) => {
    const a = pages.findIndex((p) => p.id === from)
    const b = to ? pages.findIndex((p) => p.id === to) : -1
    if (a < 0 || b < 0 || a === b) return
    const next = arrayMove(pages, a, b)
    const place = new Map(next.map((p, n) => [p.id, n]))
    useLive.setState({ notePages: allPages.map((p) => (place.has(p.id) ? { ...p, order: place.get(p.id) } : p)) })
    void send('/api/note-pages/order', 'PUT', { ids: next.map((p) => p.id) }).catch(() => useLive.setState({ notePages: allPages }))
  }
  const card = (i: number, id: PageView, title: string, icon: ReactNode, list: OwnerNoteSummary[], page?: NotePage) => (
    <NoteCard
      key={id}
      i={i}
      id={id}
      title={title}
      icon={icon}
      color={id === '*' ? 'var(--text)' : id === 'none' ? 'var(--muted)' : 'var(--hl)'}
      list={list}
      subs={page ? kidsOf(page.id).length : 0}
      updatedAt={page?.updatedAt}
      now={now}
      on={focus === id}
      onFocus={() => setFocus(id)}
      onOpen={() => onOpen(id)}
      onMenu={page && ((at) => setMenu({ page, ...at }))}
      sortable={!!page}
      noteDrop={noteDrop && !!page}
    />
  )
  // inside a page without sub-pages: just a small way to add one, above its notes
  if (parent && !pages.length)
    return (
      <>
        <button type="button" className="small ghost page-subs__add" onClick={() => setAdding(true)}>
          <LuBookPlus /> New sub-page
        </button>
        {adding && <PageNameModal parent={parent} onClose={() => setAdding(false)} onSaved={(id) => onOpen(id)} />}
      </>
    )
  const first = parent ? 0 : 1
  const sorted = (
    <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
      {pages.map((p, n) => card(n + first, p.id, p.name, <LuBookOpen />, notes.filter((x) => x.pageId === p.id), p))}
    </SortableContext>
  )
  return (
    <div className={`tag-cards${parent ? ' page-subs' : ''}`} role="listbox" aria-label={parent ? 'Sub-pages' : 'Notes by page'} ref={box}>
      {!parent && card(0, '*', 'All notes', <LuLayers />, notes)}
      {noteDrop ? (
        <>
          {sorted}
          <PageOrder onMove={move} />
        </>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => move(String(e.active.id), e.over ? String(e.over.id) : null)}>
          {sorted}
        </DndContext>
      )}
      {loose.length > 0 && card(pages.length + 1, 'none', 'No page', <LuInbox />, loose)}
      <button type="button" className="tag-card tag-card--new" onClick={() => setAdding(true)}>
        <span className="tag-card__plus">
          <LuPlus />
        </span>
        {parent ? 'New sub-page' : 'New page'}
      </button>
      {adding && <PageNameModal parent={parent} onClose={() => setAdding(false)} onSaved={(id) => onOpen(id)} />}
      {menu && (
        <PageMenu
          page={menu.page}
          count={notes.filter((x) => x.pageId === menu.page.id).length}
          at={menu}
          onClose={() => setMenu(null)}
          onOpen={() => onOpen(menu.page.id)}
          onGo={onOpen}
        />
      )}
    </div>
  )
}

/** Notes by tag: a card per tag the notes have (and No tag); `onOpen` gets the tag's id, or 'none'. */
export function NoteTagCards({ notes, onOpen }: { notes: OwnerNoteSummary[]; onOpen: (tag: string | null) => void }) {
  const tags = useDashboard((s) => s.tags)
  const now = useNow(60_000).getTime()
  const { focus, setFocus, box } = useCardFocus()
  const used = tags.filter((t) => notes.some((n) => n.tags?.includes(t.id)))
  const loose = notes.filter((n) => !n.tags?.length)
  const card = (i: number, id: string, title: string, icon: ReactNode, color: string, list: OwnerNoteSummary[]) => (
    <NoteCard key={id} i={i} id={id} title={title} icon={icon} color={color} list={list} now={now} on={focus === id} onFocus={() => setFocus(id)} onOpen={() => onOpen(id === '*' ? null : id)} />
  )
  return (
    <div className="tag-cards" role="listbox" aria-label="Notes by tag" ref={box}>
      {card(0, '*', 'All notes', <LuLayers />, 'var(--text)', notes)}
      {used.map((t, n) => card(n + 1, t.id, t.name, <TagIcon tag={t} />, t.color, notes.filter((x) => x.tags?.includes(t.id))))}
      {loose.length > 0 && card(used.length + 1, 'none', 'No tag', <LuTag />, 'var(--muted)', loose)}
      {!used.length && <p className="muted note-tags__empty">No tags on your notes yet: right-click a note → Tags… to add some.</p>}
    </div>
  )
}

/** Inside a tag (notes by tag): back to the cards, its name, how many notes. */
export function NoteTagHeader({ notes, tag, onBack }: { notes: OwnerNoteSummary[]; tag: string; onBack: () => void }) {
  const t = useDashboard((s) => s.tags.find((x) => x.id === tag))
  const shared = notes.filter((n) => n.shared).length
  return (
    <div className="tag-head" style={{ ['--c' as string]: t?.color ?? 'var(--muted)' }}>
      <button type="button" className="small tag-head__back" aria-label="Back to the tags" onClick={onBack}>
        <LuArrowLeft /> <span className="tag-head__back-label">Tags</span>
      </button>
      <span className="tag-card__icon">{t ? <TagIcon tag={t} /> : <LuTag />}</span>
      <span className="tag-head__title">{t?.name ?? 'No tag'}</span>
      <span className="tag-head__stats muted">
        {notes.length} note{notes.length === 1 ? '' : 's'} · {shared} shared
      </span>
    </div>
  )
}

/** Inside a page: back (to the page it's in, else the cards), where it is (Pages › its parents › it; phones: just its
 *  name), how many notes; a page of the owner's: new sub-page / rename / move / delete in a ⋯ menu. `onOpen`: a part of
 *  the way there clicked (null: the cards). */
export function NotePageHeader({ notes, view, onBack, onOpen }: { notes: OwnerNoteSummary[]; view: PageView; onBack: () => void; onOpen: (view: PageView | null) => void }) {
  const pages = useLive((s) => s.notePages)
  const path = pagePath(pages, view)
  const page = path.at(-1)
  const up = path.at(-2)
  const [menu, setMenu] = useState<{ x: number; y: number; above: number } | null>(null)
  const list = notes.filter((n) => inView(n, view))
  const shared = list.filter((n) => n.shared).length
  // a note dragged onto Back goes where Back goes: the page it's in, or no page ("Pages")
  const back = usePageDrop('back', up?.id ?? 'none', up?.name ?? 'No page')
  return (
    <div className="tag-head" style={{ ['--c' as string]: page ? 'var(--hl)' : 'var(--text)' }}>
      <button type="button" ref={back.ref} className={`small tag-head__back${back.cls}`} aria-label={up ? `Back to ${up.name}` : 'Back to the pages'} onClick={onBack}>
        <LuArrowLeft /> <span className="tag-head__back-label">{up ? 'Back' : 'Pages'}</span>
      </button>
      {/* the way there (desktop): each part opens its page */}
      {up && (
        <nav className="page-crumbs" aria-label="Pages">
          <PageCrumb page="none" name="No page" onClick={() => onOpen(null)}>
            Pages
          </PageCrumb>
          {path.slice(0, -1).map((p) => (
            <span key={p.id} className="page-crumbs__step">
              <LuChevronRight aria-hidden />
              <PageCrumb page={p.id} name={p.name} onClick={() => onOpen(p.id)}>
                {p.name}
              </PageCrumb>
            </span>
          ))}
          <LuChevronRight aria-hidden />
        </nav>
      )}
      <span className="tag-card__icon">{page ? <LuBookOpen /> : view === 'none' ? <LuInbox /> : <LuLayers />}</span>
      <span className="tag-head__title">{page?.name ?? (view === 'none' ? 'No page' : 'All notes')}</span>
      <span className="tag-head__stats muted">
        {list.length} note{list.length === 1 ? '' : 's'} · {shared} shared
      </span>
      {page && (
        <button
          type="button"
          className="icon-btn small ghost page-head__more"
          aria-label={`Actions for ${page.name}`}
          aria-expanded={!!menu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { x: r.right, y: r.bottom + 4, above: r.top - 4 })
          }}
        >
          <LuEllipsis />
        </button>
      )}
      {page && menu && <PageMenu page={page} count={list.length} at={menu} onClose={() => setMenu(null)} onGo={onOpen} onGone={onBack} />}
    </div>
  )
}

/** A part of the way there (the header): opens its page; a note dropped on it goes there ("Pages": no page). */
function PageCrumb({ page, name, onClick, children }: { page: string; name: string; onClick: () => void; children: ReactNode }) {
  const drop = usePageDrop('crumb', page, name)
  return (
    <button type="button" ref={drop.ref} className={`page-crumbs__part${page === 'none' ? '' : ' truncate'}${drop.cls}`} onClick={onClick}>
      {children}
    </button>
  )
}

/** A page's name with the pages it's in: "Parent / Child". */
const pathLabel = (path: NotePage[]) => path.map((p) => p.name).join(' / ')

/** The page a note is on (a note's window): its pages as a tree (sub-pages indented, shown picked with their
 *  parents), "No page", or "New page…" (named, then picked). */
export function NotePageSelect({ value, onChange }: { value?: string; onChange: (pageId: string | null) => void }) {
  const pages = useLive((s) => s.notePages)
  const tree = pageTree(pages)
  const depth = new Map(tree.map((t) => [t.page.id, t.depth]))
  const [adding, setAdding] = useState(false)
  const NEW = '__new__'
  return (
    <>
      <Select
        size="sm"
        ariaLabel="Page"
        className="note-page-select"
        value={value && pages.some((p) => p.id === value) ? value : ''}
        options={[{ value: '', label: 'No page' }, ...tree.map(({ page: p }) => ({ value: p.id, label: pathLabel(pagePath(pages, p.id)) })), { value: NEW, label: 'New page…' }]}
        display={(o) => (
          <span className="note-page-select__value">
            <LuBookOpen /> <span className="truncate">{o.label}</span>
          </span>
        )}
        // in the open list: the tree, each by its own name, indented under its parent
        optionLabel={(o) => {
          const p = depth.has(o.value) ? pages.find((x) => x.id === o.value) : undefined
          if (!p) return o.label
          return (
            <span className="page-option" style={{ ['--depth' as string]: depth.get(o.value) }}>
              <span className="truncate">{p.name}</span>
            </span>
          )
        }}
        onChange={(v) => (v === NEW ? setAdding(true) : onChange(v || null))}
      />
      {adding && <PageNameModal onClose={() => setAdding(false)} onSaved={(id) => onChange(id)} />}
    </>
  )
}

/** A note's page by name, small (lists that mix pages: All notes, a search); a sub-page with its parent ("Parent ›
 *  Child", deeper ones start with "…"), the whole way in its tip. */
export function NotePageChip({ pageId }: { pageId?: string }) {
  const pages = useLive((s) => s.notePages)
  const path = pageId ? pagePath(pages, pageId) : []
  if (!path.length) return null
  const shown = path.slice(-2).map((p) => p.name)
  return (
    <span className="note-row__page" data-tip={path.length > 1 ? path.map((p) => p.name).join(' › ') : undefined}>
      <LuBookOpen /> <span className="truncate">{(path.length > 2 ? '… › ' : '') + shown.join(' › ')}</span>
    </span>
  )
}
