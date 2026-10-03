import { OwnerAvatar } from './EditProfile'
import { useModalMaximize } from './Maximize'
import { TASKS, useMinimized } from '../state/minimized'
import { TagCards, TagHeader } from './TagCards'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { useEffect, useMemo, useRef, useState } from 'react'
import { dateTime } from './when'
import { useShallow } from 'zustand/react/shallow'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { LuArchive, LuMinus, LuArrowDown, LuArrowUp, LuArrowUpDown, LuColumns3, LuCalendar, LuKanban, LuList, LuPlus, LuSearch, LuSlidersHorizontal, LuX, LuGripVertical, LuChevronLeft, LuChevronRight } from 'react-icons/lu'
import type { OfficeTask, TaskStatusDef } from '@after-office/shared'
import { useClock, useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice, avatarStyle } from '../state/store'
import { liveApi, useLive } from '../state/live'
import { Modal } from './Modal'
import { openUrl, setUrl, useParam } from '../state/url'
import { confirm } from './Confirm'
import { Select } from './Select'
import { AgentSelect, assigneeOf, assigneePatch, OWNER, useStatusDef, useStatuses, statusDefOf, statusPatch, withBases, BlockedBadge, CheckBadge, dueInfo, PRIORITY_OPTIONS, PRIORITY_RANK, StatusSelect } from './taskMeta'
import { TagChips } from './tags'

// All tasks, as a grouped list or a Trello-style board. Grouping (status / agent) drives both
// the list sections and the board columns; dragging a card to another column rewrites that field.

type View = 'list' | 'board'
type GroupBy = 'status' | 'agent'

interface Group {
  key: string
  label: string
  color: string
}

const PREFS_KEY = 'after-office:tasks-view'

function loadPrefs(): { view: View; groupBy: GroupBy } {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = { view: 'board' as View, groupBy: 'status' as GroupBy, ...JSON.parse(raw) }
      // grouping by project (before tasks had folders instead): by status
      return p.groupBy === 'agent' ? p : { ...p, groupBy: 'status' }
    }
  } catch {
    // storage unavailable
  }
  return { view: 'board', groupBy: 'status' }
}

function savePrefs(p: { view: View; groupBy: GroupBy }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // ignore
  }
}

const keyOf = (t: OfficeTask, groupBy: GroupBy, defs: TaskStatusDef[]) => (groupBy === 'status' ? statusDefOf(t, defs).id : (t.agentId ?? ''))

function patchFor(groupBy: GroupBy, key: string, defs: TaskStatusDef[]): Partial<OfficeTask> {
  if (groupBy === 'status') {
    const d = defs.find((x) => x.id === key)
    return d ? statusPatch(d) : {}
  }
  return { agentId: key || null }
}

export function TasksModal({ onClose, onMinimize }: { onClose: () => void; onMinimize?: () => void }) {
  // full size (remembered), and its chip goes once it's open again
  const max = useModalMaximize(1180, 'after-office:tasks-full')
  useEffect(() => useMinimized.getState().remove(TASKS), [])
  const { tasks, updateTask } = useDashboard(useShallow((s) => ({ tasks: s.tasks, updateTask: s.updateTask })))
  const agents = useOffice((s) => s.agents)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [agentFilter, setAgentFilter] = useState('*')
  const [tagFilter, setTagFilter] = useState('*')
  // the list (live): opens on all the tasks (All tags); "← Tags" shows the tags as cards, one opens its tasks
  const [inTag, setInTag] = useState(true)
  // the list: one status only (done tasks show when picked, whatever "Show done" says), and a page of it
  const [statusFilter, setStatusFilter] = useState<string>('*')
  // the owner's statuses: the board's columns, the filter's choices
  const statusDefs = useStatuses()
  // the list's page and its size, in the address bar too (?tpage=2&tper=50; page 1 and 15 a page are left out)
  const tpage = useParam('tpage')
  const tper = useParam('tper')
  const perPage = PER_PAGE.includes(Number(tper)) ? Number(tper) : DEFAULT_PER
  const page = Math.max(0, (Number(tpage) || 1) - 1)
  const setPage = (n: number) => setUrl({ tpage: n > 0 ? n + 1 : null })
  const tags = useDashboard((s) => s.tags)
  const [showDone, setShowDone] = useState(true)
  // phones: grouping, filters and the other actions fold away behind a button in the search box
  const [filtersOpen, setFiltersOpen] = useState(false)
  const activeFilters = [statusFilter !== '*', agentFilter !== '*', tagFilter !== '*' && tags.some((t) => t.id === tagFilter), !showDone].filter(Boolean).length
  // search: title, description and agent names; kept in the address bar (?tasks=1&tq=…)
  const tq = useParam('tq') ?? ''
  const [search, setSearch] = useState(tq)
  useEffect(() => setSearch(tq), [tq])
  useEffect(() => {
    if (search === tq) return
    const t = setTimeout(() => setUrl({ tq: search.trim() || null }), 250)
    return () => clearTimeout(t)
  }, [search, tq])
  const needle = search.trim().toLowerCase()
  // what it opens goes in the address bar (ui/UrlModals.tsx), on top of this list
  const setCreating = (d: Partial<OfficeTask>) =>
    openUrl({ newtask: '1', nt_agent: d.agentId ?? null, nt_status: d.customStatus ?? d.status ?? null, nt_tag: live && inTag && tags.some((t) => t.id === tagFilter) ? tagFilter : null })
  const setOpenId = (id: string) => openUrl({ task: id })
  const live = useOffice((s) => s.source === 'live')
  const archived = useLive((s) => s.archivedTasks)
  // live: the tags as cards first; List / Board is picked inside one (a search looks through every tag's tasks)
  const atCards = live && !inTag && !needle

  const setPref = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    savePrefs(next)
  }
  const viewTabs = (className = '') => (
    <div className={`seg ${className}`} role="tablist" aria-label="View">
      <button className={prefs.view === 'list' ? 'active' : ''} onClick={() => setPref({ view: 'list' })}>
        <LuList /> List
      </button>
      <button className={prefs.view === 'board' ? 'active' : ''} onClick={() => setPref({ view: 'board' })}>
        <LuKanban /> Board
      </button>
    </div>
  )

  const groups: Group[] = useMemo(() => {
    if (prefs.groupBy === 'status') return statusDefs.map((s) => ({ key: s.id, label: s.label, color: s.color }))
    return [{ key: '', label: 'Unassigned', color: '#9a9a96' }, ...agents.map((a) => ({ key: a.id, label: a.name, color: a.look.shirt }))]
  }, [prefs.groupBy, agents, statusDefs])

  const visible = tasks
    .filter((t) => showDone || t.status !== 'done' || (statusFilter !== '*' && statusDefs.find((d) => d.id === statusFilter)?.base === 'done'))
    .filter((t) => prefs.view !== 'list' || statusFilter === '*' || statusDefOf(t, statusDefs).id === statusFilter)
    .filter((t) => (agentFilter === '*' ? true : agentFilter === OWNER ? !!t.forOwner : agentFilter === '' ? !t.agentId && !t.forOwner : t.agentId === agentFilter))
    .filter((t) => (tagFilter === '*' || !tags.some((x) => x.id === tagFilter) ? true : !!t.tags?.includes(tagFilter)))
    .filter(
      (t) =>
        !needle ||
        `${t.title}\n${t.description ?? ''}\n${agents.find((a) => a.id === t.agentId)?.name ?? ''}`
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) => a.deadline - b.deadline || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  const byGroup = (key: string) => visible.filter((t) => keyOf(t, prefs.groupBy, statusDefs) === key)
  // the list: one list, the newest task first (a task just made locally: now)
  // a column's order when one was clicked (remembered in this browser), else the newest task first
  // in the address bar: ?tsort=deadline&tdir=asc (none: newest first)
  const sort = sortFromUrl(useParam('tsort'), useParam('tdir'))
  const setSort = (next: ListSort | null) => setUrl({ tsort: next?.key ?? null, tdir: next?.dir ?? null, tpage: null })
  const sorter = sort ? compareBy(sort, statusDefs, agents) : null
  const newestFirst = [...visible].sort((a, b) => (sorter ? sorter(a, b) : 0) || (b.createdAt ?? Date.now()) - (a.createdAt ?? Date.now()))
  // pages of the list; a change of filter or search goes back to the first page
  const pages = Math.max(1, Math.ceil(newestFirst.length / perPage))
  const pageNow = Math.min(page, pages - 1)
  const filterKey = `${statusFilter}|${agentFilter}|${tagFilter}|${needle}|${showDone}`
  const lastFilters = useRef(filterKey)
  useEffect(() => {
    if (lastFilters.current === filterKey) return
    lastFilters.current = filterKey
    setPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  return (
    <Modal
      open
      onClose={onClose}
      title="Tasks"
      description={`${tasks.length} tasks · ${tasks.filter((t) => t.status !== 'done').length} open`}
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
      <div className="modal__body tasks-modal" ref={max.bodyRef}>
        <div className={`toolbar${filtersOpen ? '' : ' toolbar--folded'}`}>
          {/* live: List / Board is inside a tag (its header); on phones it sits up here, beside New task */}
          {!live ? viewTabs() : !atCards && viewTabs('toolbar__view-m')}
          <label className="search-box toolbar__search">
            <LuSearch />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" maxLength={200} />
            {search && (
              <button className="icon-btn small ghost" onClick={() => setSearch('')} aria-label="Clear search" data-tip="Clear">
                <LuX />
              </button>
            )}
            <button
              type="button"
              className={`icon-btn small ghost toolbar__fold${filtersOpen ? ' is-on' : ''}`}
              aria-expanded={filtersOpen}
              aria-label={filtersOpen ? 'Hide filters' : 'Filters'}
              onClick={(e) => {
                e.preventDefault()
                setFiltersOpen((v) => !v)
              }}
            >
              {filtersOpen ? <LuX /> : <LuSlidersHorizontal />}
              {!filtersOpen && activeFilters > 0 && <span className="toolbar__fold-count">{activeFilters}</span>}
            </button>
          </label>
          <button className="small primary" onClick={() => setCreating({})}>
            <LuPlus /> New task
          </button>
          {/* the view, search and New task on top; grouping, filters and the other actions below */}
          <span className="toolbar__break" aria-hidden />
          {/* grouping is the board's columns; the list is one list, newest first */}
          {prefs.view === 'board' && !atCards && (
          <div className="toolbar__field">
            <span className="muted">Group by</span>
            <Select
              ariaLabel="Group by"
              size="sm"
              value={prefs.groupBy}
              options={[
                { value: 'status', label: 'Status' },
                { value: 'agent', label: 'Agent' },
              ]}
              onChange={(groupBy) => setPref({ groupBy })}
            />
          </div>
          )}
          {prefs.view === 'list' && !atCards && (
            <div className="toolbar__filter">
              <Select
                ariaLabel="Filter by status"
                size="sm"
                value={statusFilter}
                options={[{ value: '*', label: 'All statuses' }, ...statusDefs.map((s) => ({ value: s.id, label: s.label }))]}
                onChange={setStatusFilter}
              />
            </div>
          )}
          {!atCards && (
          <div className="toolbar__filter">
            <Select
              ariaLabel="Filter by agent"
              searchable
              size="sm"
              value={agentFilter}
              options={[{ value: '*', label: 'All agents' }, { value: OWNER, label: 'Mine' }, { value: '', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
              onChange={setAgentFilter}
            />
          </div>
          )}
          {/* live: the tag is picked from its card (and shown in the header above its tasks) */}
          {!live && (
          <div className="toolbar__filter toolbar__filter--tags">
            <Select
              ariaLabel="Filter by tag"
              searchable
              size="sm"
              value={tags.some((t) => t.id === tagFilter) ? tagFilter : '*'}
              options={[{ value: '*', label: 'All tags' }, ...tags.map((t) => ({ value: t.id, label: t.name }))]}
              onChange={setTagFilter}
            />
          </div>
          )}
          <div className="toolbar__actions">
            {live && (
              <button className="small" data-tip="The board's columns: rename, add, reorder" onClick={() => openUrl({ statuses: '1' })}>
                <LuColumns3 /> Statuses
              </button>
            )}
            {live && (
              <button className="small" data-tip="Old finished tasks" onClick={() => openUrl({ archive: '1' })}>
                <LuArchive /> Archive{archived ? ` (${archived})` : ''}
              </button>
            )}
            {!atCards && (
              <label className="check">
                <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done
              </label>
            )}
          </div>
        </div>

        {atCards ? (
          // the tags as project cards; one opens its tasks (as a list or a board, picked in there)
          <TagCards onChange={(id) => (setTagFilter(id), setInTag(true))} />
        ) : (
        // a tag's tasks slide in over where its card was (styles: .tag-detail)
        <div className={live ? 'tag-detail' : undefined}>
          {live && (
            <TagHeader
              tagId={tags.some((t) => t.id === tagFilter) ? tagFilter : '*'}
              onBack={() => {
                setInTag(false)
                setSearch('')
              }}
            >
              {viewTabs()}
            </TagHeader>
          )}
        {prefs.view === 'list' ? (
          <>
            {needle && !visible.length && <div className="empty">No tasks match “{search.trim()}”.</div>}
            <ListView tasks={newestFirst.slice(pageNow * perPage, (pageNow + 1) * perPage)} onOpen={setOpenId} sort={sort} onSort={setSort} />
            {newestFirst.length > 0 && (
              <div className="task-pager">
                <span className="muted">
                  {pageNow * perPage + 1}–{Math.min(newestFirst.length, (pageNow + 1) * perPage)} of {newestFirst.length}
                </span>
                <span className="grow" />
                <span className="muted">Per page</span>
                <Select
                  ariaLabel="Tasks per page"
                  size="sm"
                  value={String(perPage)}
                  options={PER_PAGE.map((n) => ({ value: String(n), label: String(n) }))}
                  onChange={(v) => setUrl({ tper: Number(v) === DEFAULT_PER ? null : v, tpage: null })}
                />
                <button className="icon-btn small ghost" onClick={() => setPage(pageNow - 1)} disabled={pageNow === 0} aria-label="Previous page">
                  <LuChevronLeft />
                </button>
                <span className="task-pager__page">
                  {pageNow + 1} / {pages}
                </span>
                <button className="icon-btn small ghost" onClick={() => setPage(pageNow + 1)} disabled={pageNow >= pages - 1} aria-label="Next page">
                  <LuChevronRight />
                </button>
              </div>
            )}
          </>
        ) : (
          <BoardView
            groups={groups}
            tasksFor={byGroup}
            onMove={(taskId, key) => updateTask(taskId, patchFor(prefs.groupBy, key, statusDefs))}
            onAdd={(key) => setCreating(patchFor(prefs.groupBy, key, statusDefs))}
            onOpen={setOpenId}
            onReorder={
              prefs.groupBy === 'status' && live
                ? (keys) => {
                    // the owner's statuses in the board's new order (own ones work like the built-in one left of them)
                    const next = withBases(keys.map((k) => statusDefs.find((d) => d.id === k)!).filter(Boolean))
                    useLive.setState({ statuses: next })
                    void liveApi.saveStatuses(next).catch(() => useLive.setState({ statuses: statusDefs }))
                  }
                : undefined
            }
          />
        )}
        </div>
        )}
      </div>
    </Modal>
  )
}

// ── List ─────────────────────────────────────────────────────────────

/** Tasks per page of the list. */
/** How many tasks a page of the list shows: the choices, and the one to start with. */
const PER_PAGE = [5, 10, 15, 25, 50, 75, 100]
const DEFAULT_PER = 15

// ── the list's columns: a click sorts by it (again: the other way; a third time: back to newest first) ──

type SortKey = 'title' | 'deadline' | 'status' | 'priority' | 'agent'
interface ListSort {
  key: SortKey
  dir: 'asc' | 'desc'
}
const SORT_KEYS: SortKey[] = ['title', 'deadline', 'status', 'priority', 'agent']
/** The list's order from the address bar (?tsort=…&tdir=asc|desc). */
function sortFromUrl(key: string | null, dir: string | null): ListSort | null {
  return key && SORT_KEYS.includes(key as SortKey) ? { key: key as SortKey, dir: dir === 'desc' ? 'desc' : 'asc' } : null
}

/** Tasks in a column's order: status by the board's order, agent by name (yours first, then nobody's last). */
function compareBy(sort: ListSort, defs: TaskStatusDef[], agents: { id: string; name: string }[]) {
  const sign = sort.dir === 'asc' ? 1 : -1
  const who = (t: OfficeTask) => (t.forOwner ? ' ' : (agents.find((a) => a.id === t.agentId)?.name ?? '\uffff'))
  const value = (t: OfficeTask): number | string => {
    switch (sort.key) {
      case 'title':
        return t.title.toLowerCase()
      case 'deadline':
        return t.deadline
      case 'status':
        return defs.findIndex((d) => d.id === statusDefOf(t, defs).id)
      case 'priority':
        return PRIORITY_RANK[t.priority]
      case 'agent':
        return who(t).toLowerCase()
    }
  }
  return (a: OfficeTask, b: OfficeTask) => {
    const x = value(a)
    const y = value(b)
    return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)))
  }
}

const COLUMNS: { key: SortKey; label: string; first: 'asc' | 'desc' }[] = [
  { key: 'title', label: 'Task', first: 'asc' },
  { key: 'deadline', label: 'Deadline', first: 'asc' },
  { key: 'status', label: 'Status', first: 'asc' },
  // high first
  { key: 'priority', label: 'Priority', first: 'asc' },
  { key: 'agent', label: 'Agent', first: 'asc' },
]

function ListView({ tasks, onOpen, sort, onSort }: { tasks: OfficeTask[]; onOpen: (id: string) => void; sort: ListSort | null; onSort: (s: ListSort | null) => void }) {
  const click = (key: SortKey, first: 'asc' | 'desc') => {
    if (sort?.key !== key) return onSort({ key, dir: first })
    if (sort.dir === first) return onSort({ key, dir: first === 'asc' ? 'desc' : 'asc' })
    onSort(null)
  }
  return (
    <div className="task-list">
      <div className="task-table__head">
        <span />
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`task-sort${sort?.key === c.key ? ' is-on' : ''}`}
            onClick={() => click(c.key, c.first)}
            aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            data-tip={sort?.key === c.key ? (sort.dir === c.first ? 'Sorted · click for the other way' : 'Sorted · click to go back to newest first') : `Sort by ${c.label.toLowerCase()}`}
          >
            {c.label}
            {sort?.key === c.key ? sort.dir === 'asc' ? <LuArrowUp /> : <LuArrowDown /> : <LuArrowUpDown className="task-sort__idle" />}
          </button>
        ))}
        <span />
      </div>
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} onOpen={() => onOpen(t.id)} />
      ))}
      {!tasks.length && <div className="task-group__empty">No tasks</div>}
    </div>
  )
}

function TaskRow({ task: t, onOpen }: { task: OfficeTask; onOpen: () => void }) {
  const { toggleTask, updateTask, removeTask } = useDashboard(useShallow((s) => ({ toggleTask: s.toggleTask, updateTask: s.updateTask, removeTask: s.removeTask })))
  const now = useNow(60_000).getTime()
  const due = dueInfo(t.deadline, now)
  const done = t.status === 'done'
  const mobile = useMediaQuery(MOBILE)
  const statusDef = useStatusDef(t)
  const agent = useOffice((s) => s.agents.find((a) => a.id === t.agentId))
  const timezone = useClock((s) => s.timezone)
  // phones: one line to read, one to glance at; changing it happens in the task (a tap opens it)
  if (mobile) {
    const status = statusDef
    return (
      <div className={`task-m${done ? ' task--done' : ''}`}>
        <input type="checkbox" checked={done} onChange={() => toggleTask(t.id)} aria-label={done ? 'Mark not done' : 'Mark done'} />
        <button className="task-m__main" onClick={onOpen}>
          <span className="task-m__title">
            <BlockedBadge task={t} />
            {t.title}
          </span>
          <span className="task-m__meta">
            {!done && <span className="task-m__status" style={{ ['--c' as string]: status.color }}>{status.label}</span>}
            <span className={done ? '' : `due due--${due.level}`}>{done ? dateTime(t.deadline, timezone) : due.text}</span>
            <TagChips ids={t.tags} max={1} />
          </span>
        </button>
        {t.forOwner ? (
          <OwnerAvatar className="avatar--xs" />
        ) : agent ? (
          <span className="avatar avatar--xs" style={avatarStyle(agent.look.shirt)} aria-label={agent.name}>
            {agent.name[0]}
          </span>
        ) : (
          <span className="task-m__none" aria-label="Unassigned">
            —
          </span>
        )}
      </div>
    )
  }
  return (
    <div className={`task-table__row${done ? ' task--done' : ''}`}>
      <input type="checkbox" checked={done} onChange={() => toggleTask(t.id)} aria-label={done ? 'Mark not done' : 'Mark done'} />
      <button className="row__title truncate task-table__title" data-tip="Open task" onClick={onOpen}>
        <BlockedBadge task={t} />
        <CheckBadge task={t} /> <span className="truncate">{t.title}</span>
        <TagChips ids={t.tags} max={2} />
      </button>
      <Deadline ms={t.deadline} due={done ? null : due} />
      <StatusSelect size="sm" value={statusDef.id} onChange={(p) => updateTask(t.id, p)} />
      <Select ariaLabel="Priority" size="sm" value={t.priority} options={PRIORITY_OPTIONS} onChange={(priority) => updateTask(t.id, { priority })} />
      <AgentSelect size="sm" withOwner value={assigneeOf(t)} onChange={(id) => updateTask(t.id, assigneePatch(id))} />
      <button
        className="icon-btn small ghost"
        data-tip="Delete task"
        aria-label="Delete task"
        onClick={async () => {
          if (await confirm({ title: 'Delete this task?', message: <>“{t.title}”, its timeline and reports go. This can't be undone.</> })) removeTask(t.id)
        }}
      >
        <LuX />
      </button>
    </div>
  )
}

function Deadline({ ms, due }: { ms: number; due: { level: string; text: string } | null }) {
  const timezone = useClock((s) => s.timezone)
  const text = dateTime(ms, timezone)
  return (
    <div className="task-table__due">
      <span>{text}</span>
      {due && <span className={`due due--${due.level}`}>{due.text}</span>}
    </div>
  )
}

// ── Board ────────────────────────────────────────────────────────────

function BoardView({
  groups,
  tasksFor,
  onMove,
  onAdd,
  onOpen,
  onReorder,
}: {
  groups: Group[]
  tasksFor: (key: string) => OfficeTask[]
  onMove: (taskId: string, key: string) => void
  onAdd: (key: string) => void
  onOpen: (id: string) => void
  /** the columns can be put in another order (by status: the owner's statuses) */
  onReorder?: (keys: string[]) => void
}) {
  const tasks = useDashboard((s) => s.tasks)
  const [dragging, setDragging] = useState<string | null>(null)
  // cards move by their grip only (the rest of the card opens it and scrolls the board): a short move starts the drag
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onStart = (e: DragStartEvent) => setDragging(String(e.active.id))
  const onEnd = (e: DragEndEvent) => {
    setDragging(null)
    if (!e.over) return
    const target = String(e.over.id).replace(/^col:/, '')
    const id = String(e.active.id)
    // a column, by its header: it goes where the column it was dropped on is
    if (id.startsWith(COLUMN)) {
      const key = id.slice(COLUMN.length)
      const keys = groups.map((g) => g.key)
      const from = keys.indexOf(key)
      const to = keys.indexOf(target)
      if (from < 0 || to < 0 || from === to) return
      keys.splice(to, 0, keys.splice(from, 1)[0])
      return onReorder?.(keys)
    }
    onMove(id, target)
  }
  const draggingTask = tasks.find((t) => t.id === dragging)
  const draggingColumn = dragging?.startsWith(COLUMN) ? groups.find((g) => g.key === dragging.slice(COLUMN.length)) : undefined

  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
      <div className="board ui-switch">
        {groups.map((g) => (
          <Column key={g.key} group={g} tasks={tasksFor(g.key)} onAdd={() => onAdd(g.key)} onOpen={onOpen} movable={!!onReorder} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {draggingTask && <Card task={draggingTask} overlay />}
        {draggingColumn && (
          <div className="board__col-ghost">
            <span className="chip__dot" style={{ background: draggingColumn.color }} /> {draggingColumn.label}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

const COLUMN = 'column:'

function Column({ group, tasks, onAdd, onOpen, movable }: { group: Group; tasks: OfficeTask[]; onAdd: () => void; onOpen: (id: string) => void; movable?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${group.key}` })
  // the header moves the column (by status: the order of the owner's statuses)
  const head = useDraggable({ id: `${COLUMN}${group.key}`, disabled: !movable })
  return (
    <section ref={setNodeRef} className={`board__col${isOver ? ' board__col--over' : ''}${head.isDragging ? ' board__col--moving' : ''}`}>
      <header className={`board__head${movable ? ' board__head--movable' : ''}`} ref={head.setNodeRef} {...(movable ? { ...head.attributes, ...head.listeners } : {})}>
        <span className="chip__dot" style={{ background: group.color }} />
        <span className="truncate">{group.label}</span>
        <span className="muted">{tasks.length}</span>
      </header>
      <div className="board__cards">
        {tasks.map((t) => (
          <DraggableCard key={t.id} task={t} onOpen={() => onOpen(t.id)} />
        ))}
      </div>
      <button className="board__add" onClick={onAdd}>
        <LuPlus /> Add card
      </button>
    </section>
  )
}

function DraggableCard({ task, onOpen }: { task: OfficeTask; onOpen: () => void }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id: task.id })
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.35 : 1 }}>
      <Card task={task} onOpen={onOpen} grip={{ ...attributes, ...listeners }} />
    </div>
  )
}

/** `grip`: what makes the card's grip button drag it (the board); the overlay while dragging shows the grip too. */
function Card({ task: t, overlay, onOpen, grip }: { task: OfficeTask; overlay?: boolean; onOpen?: () => void; grip?: Record<string, unknown> }) {
  const agent = useOffice((s) => s.agents.find((a) => a.id === t.agentId))
  const now = useNow(60_000).getTime()
  const done = t.status === 'done'
  const due = dueInfo(t.deadline, now)
  const timezone = useClock((s) => s.timezone)
  const date = dateTime(t.deadline, timezone)

  return (
    <article className={`card-task card-task--grip${done ? ' card-task--done' : ''}${overlay ? ' card-task--overlay' : ''}`}>
      {(grip || overlay) && (
        <button type="button" className="card-task__grip" aria-label={`Move “${t.title}”`} {...grip}>
          <LuGripVertical />
        </button>
      )}
      <button className="card-task__main" onClick={onOpen}>
        <div className="card-task__top">
          <TagChips ids={t.tags} max={2} />
          {/* only a high priority is worth a mark (medium is the default, low needs none) */}
          {t.priority === 'high' && <span className="prio-high">High</span>}
        </div>
        <div className="card-task__title">
          <BlockedBadge task={t} />
          <CheckBadge task={t} /> {t.title}
        </div>
        {t.description && <div className="card-task__desc">{t.description}</div>}
        <div className="card-task__meta">
          <span className={`card-task__due${done ? '' : ` due--${due.level}`}`}>
            <LuCalendar /> {date}
          </span>
          {t.forOwner ? (
                <span className="task-me" data-tip="Your own task">
                  <OwnerAvatar className="avatar--xs" />
                </span>
              ) : agent ? (
            <span className="avatar avatar--xs" style={avatarStyle(agent.look.shirt)} data-tip={agent.name}>
              {agent.name[0]}
            </span>
          ) : (
            <span className="muted">Unassigned</span>
          )}
        </div>
      </button>
    </article>
  )
}
