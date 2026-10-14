import { useEffect, useState, type ReactNode } from 'react'
import { closestCenter, DndContext, MouseSensor, TouchSensor, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { LuArchive, LuArchiveRestore, LuChevronDown, LuCornerDownRight, LuFolder, LuGitBranch, LuListTodo, LuMessagesSquare, LuPencil, LuPin, LuPinOff, LuPlus, LuSearch, LuTrash2, LuX } from 'react-icons/lu'
import { create } from 'zustand'
import { ActionMenu } from './ActionMenu'
import { confirm } from './Confirm'
import type { OfficeThread } from '@after-office/shared'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { liveApi, useLive, useWorkReady } from '../state/live'
import { useOffice } from '../state/store'
import { openUrl, setUrl } from '../state/url'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { ago } from './FollowUps'
import { Modal } from './Modal'
import { ScrollTabs } from './ScrollTabs'
import { FolderSelect } from './taskMeta'
import { TagChips, TagPicker } from './tags'
import { tip } from './Tooltip'

// Threads: the owner's topics with the manager, each in a session of its own (server: work/threads.ts). The panel
// lists them (latest activity first); a thread opens in ui/ThreadView.tsx (?thread=<id>), a new one at ?thread=new.

type Filter = 'active' | 'unread' | 'archived'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'unread', label: 'Unread' },
  { id: 'archived', label: 'Archived' },
]
const TAB_KEY = 'after-office:threads-tab'
const rememberedTab = (): Filter => {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'unread' || v === 'archived' ? v : 'active'
  } catch {
    return 'active'
  }
}

// right-click on a thread in the list: open, rename, a sub-thread, archive, delete
const useThreadMenu = create<{ at: { id: string; x: number; y: number } | null; renaming: string | null }>(() => ({ at: null, renaming: null }))

/** The menu and the rename window: mounted once, with the list. */
export function ThreadMenuLayer() {
  const at = useThreadMenu((s) => s.at)
  const renaming = useThreadMenu((s) => s.renaming)
  const t = useLive((s) => (at ? s.threads.find((x) => x.id === at.id) : undefined))
  const renamed = useLive((s) => (renaming ? s.threads.find((x) => x.id === renaming) : undefined))
  const close = () => useThreadMenu.setState({ at: null })
  const remove = async (x: OfficeThread) => {
    const kids = useLive.getState().threads.filter((k) => k.parentId === x.id).length
    if (!(await confirm({ title: `Delete the thread “${x.title}”?`, message: `Its conversation with the manager is forgotten. Its tasks and reports stay (in Tasks and Reports).${kids ? ` Its ${kids} sub-thread${kids === 1 ? '' : 's'} stay as threads of their own.` : ''}`, confirmLabel: 'Delete thread' }))) return
    await liveApi.deleteThread(x.id).catch((e) => confirm({ title: 'Could not delete it', message: (e as Error).message, confirmLabel: 'OK', danger: false }))
  }
  return (
    <>
      {at && t && (
        <ActionMenu
          x={at.x}
          y={at.y}
          title={t.title}
          onClose={close}
          actions={[
            { icon: <LuMessagesSquare />, label: 'Open', run: () => (close(), openUrl({ thread: t.id })) },
            { icon: <LuPencil />, label: 'Rename', run: () => useThreadMenu.setState({ at: null, renaming: t.id }) },
            { icon: t.pinned ? <LuPinOff /> : <LuPin />, label: t.pinned ? 'Unpin' : 'Pin to the top', run: () => (close(), void liveApi.updateThread(t.id, { pinned: !t.pinned })) },
            ...(t.parentId ? [] : [{ icon: <LuGitBranch />, label: 'New sub-thread', run: () => (close(), openUrl({ thread: 'new', tparent: t.id })) }]),
            { icon: t.archivedAt ? <LuArchiveRestore /> : <LuArchive />, label: t.archivedAt ? 'Back to active' : 'Archive', run: () => (close(), void liveApi.archiveThread(t.id, !t.archivedAt)) },
            { icon: <LuTrash2 />, label: 'Delete', danger: true, run: () => (close(), void remove(t)) },
          ]}
        />
      )}
      {renamed && <RenameThread t={renamed} onClose={() => useThreadMenu.setState({ renaming: null })} />}
    </>
  )
}

function RenameThread({ t, onClose }: { t: OfficeThread; onClose: () => void }) {
  const [title, setTitle] = useState(t.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    const next = title.trim()
    if (!next || next === t.title) return onClose()
    setBusy(true)
    try {
      await liveApi.updateThread(t.id, { title: next })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename it')
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t.parentId ? 'Rename sub-thread' : 'Rename thread'} width={400}>
      <form
        className="modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="field">
          <span className="field__label">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} autoFocus onFocus={(e) => e.target.select()} />
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** Threads with a reply the owner hasn't seen. */
/** The manager's replies not seen yet, across the active threads and sub-threads (the Threads badge, the phones' button). */
export const useThreadUnread = () => useLive((s) => s.threads.reduce((n, t) => n + (t.archivedAt ? 0 : (t.unread ?? 0)), 0))

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** The manager's state in a thread: working on it, waiting for the owner, or nothing (resting / idle). */
export function useThreadState(t: OfficeThread) {
  return useOffice((s) => {
    const side = s.agents.find((a) => a.id === t.managerId)?.sessions?.find((x) => x.key === t.sessionKey && x.open)
    return side?.waitingFor || side?.status === 'waiting' ? 'waiting' : side?.status === 'working' ? 'working' : side ? 'idle' : 'resting'
  })
}

function ThreadRow({ t, now, sub, kids, kidsUnread = 0, folded, onFold, parentTitle }: { t: OfficeThread; now: number; sub?: boolean; kids?: number; kidsUnread?: number; folded?: boolean; onFold?: () => void; parentTitle?: string }) {
  const state = useThreadState(t)
  const running = useDashboard((s) => s.tasks.filter((x) => x.threadId === t.id && x.status === 'in_progress').length)
  const own = t.unread ?? 0
  // a thread counts its sub-threads' unread replies too (they also show their own under it)
  const unread = own + kidsUnread
  // phones: a tap on a thread with sub-threads shows or hides them (like its chevron); its chat opens from its menu
  // (a long press: Open)
  const phone = useMediaQuery(MOBILE)
  const foldOnTap = phone && !!kids && !!onFold
  return (
    <div className={`report-row thread-row${unread ? ' report-row--unread' : ''}${sub ? ' thread-row--sub' : ''}${kids ? ' thread-row--parent' : ''}`}>
      {!!kids && (
        <button className={`thread-row__fold${folded ? ' is-folded' : ''}`} onClick={onFold} aria-expanded={!folded} {...tip(folded ? `Show its ${kids} sub-thread${kids === 1 ? '' : 's'}` : 'Hide its sub-threads')}>
          <LuChevronDown />
        </button>
      )}
      <button
        className="report-row__main"
        onClick={() => (foldOnTap ? onFold() : openUrl({ thread: t.id }))}
        aria-expanded={foldOnTap ? !folded : undefined}
        onContextMenu={(e) => {
          e.preventDefault()
          useThreadMenu.setState({ at: { id: t.id, x: e.clientX, y: e.clientY } })
        }}
      >
        <span className={`thread-row__icon thread-row__icon--${state}`} aria-hidden>
          <LuMessagesSquare />
        </span>
        <span className="report-row__body">
          <span className="report-row__title-line">
            {t.pinned && (
              <span className="thread-row__pin" {...tip('Pinned')}>
                <LuPin />
              </span>
            )}
            <span className="report-row__title clamp2">{t.title}</span>
            {state === 'working' && <span className="thread-row__state">typing…</span>}
            {state === 'waiting' && <span className="thread-row__state thread-row__state--waiting">needs you</span>}
          </span>
          {t.lastMessage && <span className="report-row__text clamp2">{plain(t.lastMessage)}</span>}
          <span className="report-row__meta">
            <span className="truncate">{ago(now - t.lastActivityAt)}</span>
            {parentTitle && (
              <span className="report-row__job truncate">
                <LuCornerDownRight /> {parentTitle}
              </span>
            )}
            {!!kids && <span className="report-row__job">{kids} sub-thread{kids === 1 ? '' : 's'}</span>}
            {t.folder && (
              <span className="report-row__job truncate" data-tip={t.folder}>
                <LuFolder /> {folderName(t.folder)}
              </span>
            )}
            {running > 0 && (
              <span className="report-row__job" {...tip(`${running} task${running === 1 ? '' : 's'} in progress`)}>
                <LuListTodo /> {running}
              </span>
            )}
            <TagChips ids={t.tags} max={1} />
          </span>
        </span>
        {unread > 0 && (
          <span className="thread-row__count" {...(kidsUnread ? tip(own ? `${own} here, ${kidsUnread} in its sub-threads` : `${kidsUnread} in its sub-threads`) : {})}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </div>
  )
}

/** A reply's start as plain text: no Markdown marks (**bold**, `code`, # headings, [links](…)). */
const plain = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*>]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The list's order: pinned first; then the ones never dragged, latest activity first (so a new thread shows up on
 * top); then the dragged ones in their order.
 */
export function threadOrder(a: OfficeThread, b: OfficeThread, latest: (t: OfficeThread) => number = (t) => t.lastActivityAt) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
  const ao = a.order
  const bo = b.order
  if (ao === undefined && bo === undefined) return latest(b) - latest(a)
  if (ao === undefined) return -1
  if (bo === undefined) return 1
  return ao - bo
}

/** One place in the list that can be dragged: a thread (with its sub-threads under it), or a sub-thread. */
function Draggable({ id, disabled, className, children }: { id: string; disabled: boolean; className: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  return (
    <li
      ref={setNodeRef}
      className={`${className}${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      // the row's own buttons keep the keyboard; dragging is by pointer
      tabIndex={-1}
    >
      {children}
    </li>
  )
}

const FOLDED_KEY = 'after-office:threads-folded'
/** Threads whose sub-threads are hidden in the list (this browser). */
function useFolded(): [Set<string>, (id: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggle = (id: string) =>
    setSet((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]))
      } catch {
        // private mode: not remembered
      }
      return next
    })
  return [set, toggle]
}

/** The threads under the panel's (or sheet's) tabs. */
function ThreadList({ filter, q = '' }: { filter: Filter; q?: string }) {
  const ready = useWorkReady()
  const threads = useLive((s) => s.threads)
  const now = useNow(60_000).getTime()
  const [folded, fold] = useFolded()
  const titleOf = (id?: string) => (id ? threads.find((x) => x.id === id)?.title : undefined)
  // the search: its title, latest reply, folder, or (a sub-thread) its thread's title
  const needle = q.trim().toLowerCase()
  const found = (t: OfficeThread) => !needle || [t.title, t.lastMessage, t.folder, titleOf(t.parentId)].some((v) => v?.toLowerCase().includes(needle))
  const shown = threads
    .filter((t) => (filter === 'archived' ? !!t.archivedAt : !t.archivedAt && (filter !== 'unread' || (t.unread ?? 0) > 0)))
    .filter(found)
    .sort((a, b) => threadOrder(a, b))
  // Active: each thread with its sub-threads under it (a thread is as recent as its latest sub-thread); the other
  // tabs are flat, each sub-thread saying whose it is
  const tree = filter === 'active' && !needle
  const kidsOf = (id: string) => shown.filter((x) => x.parentId === id)
  const latest = (t: OfficeThread) => Math.max(t.lastActivityAt, ...kidsOf(t.id).map((k) => k.lastActivityAt))
  const roots = tree ? shown.filter((t) => !t.parentId || !shown.some((p) => p.id === t.parentId)).sort((a, b) => threadOrder(a, b, latest)) : shown
  // dragging (Active, no search): a thread among the threads, a sub-thread among its thread's sub-threads. A mouse
  // drags after moving a little (a click still opens), a finger after holding a moment (a swipe still scrolls).
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }))
  // where it can land: only next to its siblings (a sub-thread never lands on its own thread's row, which holds it)
  const groupOf = (id: string) => {
    const t = threads.find((x) => x.id === id)
    return t ? `${t.parentId ?? ''}|${t.pinned ? 1 : 0}` : null
  }
  const amongSiblings: CollisionDetection = (args) => {
    const g = groupOf(String(args.active.id))
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => groupOf(String(c.id)) === g) })
  }
  const drop = (e: DragEndEvent) => {
    const from = String(e.active.id)
    const to = e.over ? String(e.over.id) : null
    if (!to || from === to) return
    const moved = threads.find((x) => x.id === from)
    const target = threads.find((x) => x.id === to)
    // only among siblings, and pinned ones among the pinned (they stay on top anyway)
    if (!moved || !target || (moved.parentId ?? null) !== (target.parentId ?? null) || !!moved.pinned !== !!target.pinned) return
    const siblings = (moved.parentId ? kidsOf(moved.parentId) : roots).filter((x) => !!x.pinned === !!moved.pinned)
    const ids = siblings.map((x) => x.id)
    const next = arrayMove(ids, ids.indexOf(from), ids.indexOf(to))
    // shown right away; the server keeps it (every device)
    useLive.setState((st) => ({ threads: st.threads.map((x) => (next.includes(x.id) ? { ...x, order: next.indexOf(x.id) } : x)) }))
    void liveApi.reorderThreads(next).catch(() => {})
  }
  return (
    <DndContext sensors={sensors} collisionDetection={amongSiblings} onDragEnd={drop}>
      <SortableContext items={roots.map((t) => t.id)} strategy={verticalListSortingStrategy} disabled={!tree}>
        <ul key={filter} className="list reports-panel__list threads-panel__list ui-switch">
          {roots.map((t) => {
            const kids = tree ? kidsOf(t.id) : []
            const isFolded = folded.has(t.id)
            return (
              <Draggable key={t.id} id={t.id} disabled={!tree} className="thread-group">
                <ThreadRow t={t} now={now} kids={kids.length} kidsUnread={kids.reduce((n, k) => n + (k.unread ?? 0), 0)} folded={isFolded} onFold={() => fold(t.id)} parentTitle={tree ? undefined : titleOf(t.parentId)} />
                {!isFolded && kids.length > 0 && (
                  <SortableContext items={kids.map((k) => k.id)} strategy={verticalListSortingStrategy}>
                    <ul className="thread-group__kids">
                      {kids.map((k) => (
                        <Draggable key={k.id} id={k.id} disabled={false} className="thread-group__kid">
                          <ThreadRow t={k} now={now} sub />
                        </Draggable>
                      ))}
                    </ul>
                  </SortableContext>
                )}
              </Draggable>
            )
          })}
      {!shown.length && ready && (
        <li className="empty">
          {needle ? (
            'No thread matches that.'
          ) : filter === 'active' ? (
            <>
              One topic per thread: the manager leads it, and its tasks, reports and files stay together.{' '}
              <button type="button" className="link link--inline" onClick={() => openUrl({ thread: 'new' })}>
                Start one
              </button>
            </>
          ) : filter === 'unread' ? (
            'All caught up.'
          ) : (
            'No archived threads.'
          )}
        </li>
      )}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

/** The Threads section of the dashboard (below Reports by default), and the phones' Threads sheet. */
export function ThreadsPanel() {
  const [filter, setFilter] = useState<Filter>(rememberedTab)
  const pick = (f: Filter) => {
    setFilter(f)
    try {
      localStorage.setItem(TAB_KEY, f)
    } catch {
      // private mode: not remembered
    }
  }
  const unread = useThreadUnread()
  const hasManager = useOffice((s) => s.agents.some((a) => a.kind === 'manager'))
  const [q, setQ] = useState('')
  const any = useLive((s) => s.threads.length > 0)
  return (
    <section className="card card--reports card--threads">
      <header className="card__head">
        <h2>
          <LuMessagesSquare /> Threads
          {unread > 0 && <span className="badge badge--accent reports-tabs__count">{unread}</span>}
        </h2>
        <span className="grow" />
        <span className="card__actions">
          <button className="icon-btn small" onClick={() => openUrl({ thread: 'new' })} disabled={!hasManager} {...tip(hasManager ? 'New thread' : 'Threads are led by the manager: add one first')}>
            <LuPlus />
          </button>
        </span>
      </header>
      <div className="reports-panel__tabs threads-tabs">
        <ScrollTabs className="reports-panel__tabrow" label="Which threads" active={filter}>
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => pick(f.id)}>
              {f.id === 'archived' && <LuArchive />}
              {f.label}
              {f.id === 'unread' && unread > 0 && <span className="reports-panel__tabcount">{unread}</span>}
            </button>
          ))}
        </ScrollTabs>
        {/* phones' sheet: the + sits here, on the tabs' row (the card's own head is hidden there) */}
        <button className="icon-btn small threads-tabs__add" onClick={() => openUrl({ thread: 'new' })} disabled={!hasManager} {...tip('New thread')}>
          <LuPlus />
        </button>
      </div>
      {any && (
        <label className="search-box threads-search">
          <LuSearch />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threads" aria-label="Search threads" />
          {q && (
            <button className="icon-btn small ghost" onClick={() => setQ('')} aria-label="Clear search" data-tip="Clear">
              <LuX />
            </button>
          )}
        </label>
      )}
      <ThreadList filter={filter} q={q} />
      <ThreadMenuLayer />
    </section>
  )
}

/** ?thread=new: a title, the folder and tags its work goes to, and (optionally) the first message to the manager. */
export function NewThreadModal({ onClose, parentId }: { onClose: () => void; parentId?: string }) {
  // a sub-thread (?thread=new&tparent=<id>): it starts in its parent's folder and tags
  const parent = useLive((s) => (parentId ? s.threads.find((t) => t.id === parentId) : undefined))
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState<string | undefined>(parent?.folder)
  const [tags, setTags] = useState<string[]>(parent?.tags ?? [])
  // opened straight from a link: the parent arrives with the first snapshot, after the form
  const parentKnown = !!parent
  useEffect(() => {
    if (!parent) return
    setFolder((f) => f ?? parent.folder)
    setTags((t) => (t.length ? t : (parent.tags ?? [])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentKnown])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const create = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const t = await liveApi.createThread({ title: title.trim(), ...(parent ? { parentId: parent.id } : {}), ...(folder ? { folder } : {}), ...(tags.length ? { tags } : {}), ...(text.trim() ? { text: text.trim() } : {}) })
      // the new thread instead of this form (the same history entry)
      setUrl({ thread: t.id, tparent: null }, 'replace')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the thread')
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={parent ? 'New sub-thread' : 'New thread'}
      description={parent ? `A part of “${parent.title}”, in a session of its own (the manager starts with a summary of it).` : 'One topic, led by the manager in a session of its own.'}
      width={520}
    >
      <form
        className="modal__body new-thread"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="field">
          <span className="field__label">{parent ? 'Part' : 'Topic'}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={parent ? 'e.g. QR code page' : 'e.g. Poplink'} maxLength={80} autoFocus />
        </label>
        <div className="new-thread__row">
          <label className="field">
            <span className="field__label">Folder</span>
            <FolderSelect value={folder} onChange={setFolder} none="None" />
          </label>
          <label className="field">
            <span className="field__label">Tags</span>
            <TagPicker value={tags} onChange={setTags} />
          </label>
        </div>
        <label className="field">
          <span className="field__label">First message (optional)</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="What do you want done? The manager picks it up from here." />
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? (text.trim() ? 'Starting… (about 15 s)' : 'Starting…') : parent ? 'Start sub-thread' : 'Start thread'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** Phones: the round Threads button on the stage, above the menu button (and the minimized folders' one, if any). */
export function ThreadsFab() {
  const unread = useThreadUnread()
  const hasManager = useOffice((s) => s.agents.some((a) => a.kind === 'manager'))
  if (!hasManager) return null
  return (
    <button className="threads-fab" aria-label={unread ? `Threads: ${unread} unread` : 'Threads'} onClick={() => openUrl({ sheet: 'threads' })}>
      <LuMessagesSquare />
      {unread > 0 && <span className="fmin-fab__count">{unread > 9 ? '9+' : unread}</span>}
    </button>
  )
}
