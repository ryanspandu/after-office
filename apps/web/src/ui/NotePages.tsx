import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LuArrowLeft, LuArrowRight, LuBookOpen, LuCheck, LuEllipsis, LuInbox, LuLayers, LuPencil, LuPlus, LuTag, LuTrash2 } from 'react-icons/lu'
import type { NotePage, OwnerNoteSummary } from '@after-office/shared'
import { closestCenter, DndContext, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
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

// Notes → View all: the notes kept on pages (notebooks, one level), shown as cards like the tasks' tag cards
// (styles/tasks-modal.css .tag-card): All notes, each page, No page, and a new one. A card opens its notes; a note's
// window picks its page (NotePageSelect). Deleting a page keeps its notes, on no page (the server moves them).

/** Which notes a view shows: '*' every note, 'none' those on no page, else a page's id. */
export type PageView = string
export const inView = (n: OwnerNoteSummary, view: PageView) => (view === '*' ? true : view === 'none' ? !n.pageId : n.pageId === view)

const send = async (path: string, method: string, body?: unknown) => {
  const r = await api(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save')
  return r.json()
}

/** Delete a page after asking; its notes stay, on no page. True when it's gone. */
export async function deletePage(page: NotePage, count: number) {
  const ok = await confirm({
    title: `Delete the page “${page.name}”?`,
    message: count ? `Its ${count} note${count === 1 ? '' : 's'} stay, on no page.` : 'It has no notes.',
    confirmLabel: 'Delete page',
  })
  if (!ok) return false
  await send(`/api/note-pages/${encodeURIComponent(page.id)}`, 'DELETE')
  return true
}

/** New page, or a page renamed: its name. `onSaved` gets the page's id. */
export function PageNameModal({ page, onClose, onSaved }: { page?: NotePage; onClose: () => void; onSaved?: (id: string) => void }) {
  const [name, setName] = useState(page?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const saved = (await (page
        ? send(`/api/note-pages/${encodeURIComponent(page.id)}`, 'PUT', { name })
        : send('/api/note-pages', 'POST', { name }))) as NotePage
      // shown right away: the live update can come after the page is opened (which would show All notes meanwhile)
      useLive.setState((s) => ({ notePages: s.notePages.some((p) => p.id === saved.id) ? s.notePages.map((p) => (p.id === saved.id ? saved : p)) : [...s.notePages, saved] }))
      onSaved?.(saved.id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={page ? 'Rename page' : 'New page'} width={400}>
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
function NoteCard({ i, id, title, icon, color, list, updatedAt, now, on, onFocus, onOpen, onMenu, sortable = false }: {
  i: number
  id: string
  title: string
  icon: ReactNode
  color: string
  list: OwnerNoteSummary[]
  updatedAt?: number
  now: number
  on: boolean
  onFocus: () => void
  onOpen: () => void
  onMenu?: (at: { x: number; y: number }) => void
  /** a page's card: dragged into another place among the pages */
  sortable?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !sortable })
  const latest = byLatest(list)
  const last = Math.max(updatedAt ?? 0, latest[0]?.updatedAt ?? 0)
  return (
    <div
      key={id}
      ref={setNodeRef}
      {...(sortable ? { ...attributes, ...listeners } : {})}
      role="option"
      aria-selected={on}
      className={`tag-card tag-card--static page-card${on ? ' is-on' : ''}${isDragging ? ' is-dragging' : ''}`}
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
          {last ? <span className="muted"> · {ago(now - last)}</span> : null}
        </span>
        <span className="tag-card__go" aria-hidden>
          <LuArrowRight />
        </span>
      </button>
    </div>
  )
}

/** A page's right-click menu (its card, or its header inside it): open, rename, delete. */
function PageMenu({ page, count, at, onClose, onOpen, onGone }: { page: NotePage; count: number; at: { x: number; y: number; above?: number }; onClose: () => void; onOpen?: () => void; onGone?: () => void }) {
  const [renaming, setRenaming] = useState(false)
  // a pick closes the menu first, then runs: Rename keeps this mounted for its window
  const [shown, setShown] = useState(true)
  useEffect(() => {
    if (!shown && !renaming) onClose()
  }, [shown, renaming, onClose])
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
            { icon: <LuPencil />, label: 'Rename', run: () => setRenaming(true) },
            { icon: <LuTrash2 />, label: 'Delete page', danger: true, run: () => void deletePage(page, count).then((gone) => gone && onGone?.()) },
          ]}
        />
      )}
      {renaming && <PageNameModal page={page} onClose={() => setRenaming(false)} />}
    </>
  )
}

/** `onOpen`: a card's footer clicked (that page's notes). */
export function NotePageCards({ notes, onOpen }: { notes: OwnerNoteSummary[]; onOpen: (view: PageView) => void }) {
  const pages = useLive((s) => s.notePages)
  const now = useNow(60_000).getTime()
  const { focus, setFocus, box } = useCardFocus()
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<{ page: NotePage; x: number; y: number } | null>(null)
  const loose = notes.filter((n) => !n.pageId)
  // the pages' order: dragged (a held finger on a phone), shown at once, stored on the server
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }))
  const move = (from: string, to: string | null) => {
    const a = pages.findIndex((p) => p.id === from)
    const b = to ? pages.findIndex((p) => p.id === to) : -1
    if (a < 0 || b < 0 || a === b) return
    const next = arrayMove(pages, a, b).map((p, n) => ({ ...p, order: n }))
    useLive.setState({ notePages: next })
    void send('/api/note-pages/order', 'PUT', { ids: next.map((p) => p.id) }).catch(() => useLive.setState({ notePages: pages }))
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
      updatedAt={page?.updatedAt}
      now={now}
      on={focus === id}
      onFocus={() => setFocus(id)}
      onOpen={() => onOpen(id)}
      onMenu={page && ((at) => setMenu({ page, ...at }))}
      sortable={!!page}
    />
  )
  return (
    <div className="tag-cards" role="listbox" aria-label="Notes by page" ref={box}>
      {card(0, '*', 'All notes', <LuLayers />, notes)}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => move(String(e.active.id), e.over ? String(e.over.id) : null)}>
        <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
          {pages.map((p, n) => card(n + 1, p.id, p.name, <LuBookOpen />, notes.filter((x) => x.pageId === p.id), p))}
        </SortableContext>
      </DndContext>
      {loose.length > 0 && card(pages.length + 1, 'none', 'No page', <LuInbox />, loose)}
      <button type="button" className="tag-card tag-card--new" onClick={() => setAdding(true)}>
        <span className="tag-card__plus">
          <LuPlus />
        </span>
        New page
      </button>
      {adding && <PageNameModal onClose={() => setAdding(false)} onSaved={(id) => onOpen(id)} />}
      {menu && (
        <PageMenu
          page={menu.page}
          count={notes.filter((x) => x.pageId === menu.page.id).length}
          at={menu}
          onClose={() => setMenu(null)}
          onOpen={() => onOpen(menu.page.id)}
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
      <button type="button" className="small tag-head__back" onClick={onBack}>
        <LuArrowLeft /> Tags
      </button>
      <span className="tag-card__icon">{t ? <TagIcon tag={t} /> : <LuTag />}</span>
      <span className="tag-head__title">{t?.name ?? 'No tag'}</span>
      <span className="tag-head__stats muted">
        {notes.length} note{notes.length === 1 ? '' : 's'} · {shared} shared
      </span>
    </div>
  )
}

/** Inside a page: back to the cards, its name, how many notes; a page of the owner's: rename / delete in a ⋯ menu. */
export function NotePageHeader({ notes, view, onBack }: { notes: OwnerNoteSummary[]; view: PageView; onBack: () => void }) {
  const page = useLive((s) => s.notePages.find((p) => p.id === view))
  const [menu, setMenu] = useState<{ x: number; y: number; above: number } | null>(null)
  const list = notes.filter((n) => inView(n, view))
  const shared = list.filter((n) => n.shared).length
  return (
    <div className="tag-head" style={{ ['--c' as string]: page ? 'var(--hl)' : 'var(--text)' }}>
      <button type="button" className="small tag-head__back" onClick={onBack}>
        <LuArrowLeft /> Pages
      </button>
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
      {page && menu && <PageMenu page={page} count={list.length} at={menu} onClose={() => setMenu(null)} onGone={onBack} />}
    </div>
  )
}

/** The page a note is on (a note's window): its pages, "No page", or "New page…" (named, then picked). */
export function NotePageSelect({ value, onChange }: { value?: string; onChange: (pageId: string | null) => void }) {
  const pages = useLive((s) => s.notePages)
  const [adding, setAdding] = useState(false)
  const NEW = '__new__'
  return (
    <>
      <Select
        size="sm"
        ariaLabel="Page"
        className="note-page-select"
        value={value && pages.some((p) => p.id === value) ? value : ''}
        options={[{ value: '', label: 'No page' }, ...pages.map((p) => ({ value: p.id, label: p.name })), { value: NEW, label: 'New page…' }]}
        display={(o) => (
          <span className="note-page-select__value">
            <LuBookOpen /> <span className="truncate">{o.label}</span>
          </span>
        )}
        onChange={(v) => (v === NEW ? setAdding(true) : onChange(v || null))}
      />
      {adding && <PageNameModal onClose={() => setAdding(false)} onSaved={(id) => onChange(id)} />}
    </>
  )
}

/** A note's page by name, small (lists that mix pages: All notes, a search). */
export function NotePageChip({ pageId }: { pageId?: string }) {
  const page = useLive((s) => (pageId ? s.notePages.find((p) => p.id === pageId) : undefined))
  if (!page) return null
  return (
    <span className="note-row__page">
      <LuBookOpen /> <span className="truncate">{page.name}</span>
    </span>
  )
}
