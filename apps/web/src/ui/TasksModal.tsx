import { useEffect, useMemo, useState } from 'react'
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
import { LuArchive, LuCalendar, LuFolderKanban, LuKanban, LuList, LuPlus, LuSearch, LuSlidersHorizontal, LuX, LuGripVertical, LuChevronLeft, LuChevronRight } from 'react-icons/lu'
import type { OfficeTask, TaskStatus } from '@after-office/shared'
import { useClock, useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice, avatarStyle } from '../state/store'
import { useLive } from '../state/live'
import { Modal } from './Modal'
import { openUrl, setUrl, useParam } from '../state/url'
import { confirm } from './Confirm'
import { Select } from './Select'
import { AgentSelect, BlockedBadge, CheckBadge, dueInfo, PRIORITY_OPTIONS, PRIORITY_RANK, ProjectSelect, ProjectTag, STATUSES, StatusSelect } from './taskMeta'
import { TagChips } from './tags'

// All tasks, as a grouped list or a Trello-style board. Grouping (status / agent / project) drives both
// the list sections and the board columns; dragging a card to another column rewrites that field.

type View = 'list' | 'board'
type GroupBy = 'status' | 'agent' | 'project'

interface Group {
  key: string
  label: string
  color: string
}

const PREFS_KEY = 'after-office:tasks-view'

function loadPrefs(): { view: View; groupBy: GroupBy } {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) return { view: 'board', groupBy: 'status', ...JSON.parse(raw) }
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

const keyOf = (t: OfficeTask, groupBy: GroupBy) => (groupBy === 'status' ? t.status : groupBy === 'agent' ? (t.agentId ?? '') : (t.projectId ?? ''))

function patchFor(groupBy: GroupBy, key: string): Partial<OfficeTask> {
  if (groupBy === 'status') return { status: key as TaskStatus }
  if (groupBy === 'agent') return { agentId: key || null }
  return { projectId: key || null }
}

export function TasksModal({ onClose }: { onClose: () => void }) {
  const { tasks, projects, updateTask } = useDashboard(useShallow((s) => ({ tasks: s.tasks, projects: s.projects, updateTask: s.updateTask })))
  const agents = useOffice((s) => s.agents)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [agentFilter, setAgentFilter] = useState('*')
  const [projectFilter, setProjectFilter] = useState('*')
  const [tagFilter, setTagFilter] = useState('*')
  // the list: one status only (done tasks show when picked, whatever "Show done" says), and a page of it
  const [statusFilter, setStatusFilter] = useState<'*' | TaskStatus>('*')
  const [page, setPage] = useState(0)
  const tags = useDashboard((s) => s.tags)
  const [showDone, setShowDone] = useState(true)
  // phones: grouping, filters and the other actions fold away behind a button in the search box
  const [filtersOpen, setFiltersOpen] = useState(false)
  const activeFilters = [statusFilter !== '*', agentFilter !== '*', projectFilter !== '*', tagFilter !== '*' && tags.some((t) => t.id === tagFilter), !showDone].filter(Boolean).length
  // search: title, description, agent and project names; kept in the address bar (?tasks=1&tq=…)
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
    openUrl({ newtask: '1', nt_agent: d.agentId ?? null, nt_project: d.projectId ?? null, nt_status: d.status ?? null })
  const setOpenId = (id: string) => openUrl({ task: id })
  const live = useOffice((s) => s.source === 'live')
  const archived = useLive((s) => s.archivedTasks)

  const setPref = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    savePrefs(next)
  }

  const groups: Group[] = useMemo(() => {
    if (prefs.groupBy === 'status') return STATUSES.map((s) => ({ key: s.value, label: s.label, color: s.color }))
    if (prefs.groupBy === 'agent')
      return [{ key: '', label: 'Unassigned', color: '#9a9a96' }, ...agents.map((a) => ({ key: a.id, label: a.name, color: a.look.shirt }))]
    return [{ key: '', label: 'No project', color: '#9a9a96' }, ...projects.map((p) => ({ key: p.id, label: p.name, color: p.color }))]
  }, [prefs.groupBy, agents, projects])

  const visible = tasks
    .filter((t) => showDone || t.status !== 'done' || statusFilter === 'done')
    .filter((t) => prefs.view !== 'list' || statusFilter === '*' || t.status === statusFilter)
    .filter((t) => (agentFilter === '*' ? true : agentFilter === '' ? !t.agentId : t.agentId === agentFilter))
    .filter((t) => (projectFilter === '*' ? true : projectFilter === '' ? !t.projectId : t.projectId === projectFilter))
    .filter((t) => (tagFilter === '*' || !tags.some((x) => x.id === tagFilter) ? true : !!t.tags?.includes(tagFilter)))
    .filter(
      (t) =>
        !needle ||
        `${t.title}\n${t.description ?? ''}\n${agents.find((a) => a.id === t.agentId)?.name ?? ''}\n${projects.find((p) => p.id === t.projectId)?.name ?? ''}`
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) => a.deadline - b.deadline || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  const byGroup = (key: string) => visible.filter((t) => keyOf(t, prefs.groupBy) === key)
  // the list: one list, the newest task first (a task just made locally: now)
  const newestFirst = [...visible].sort((a, b) => (b.createdAt ?? Date.now()) - (a.createdAt ?? Date.now()))
  // pages of the list; a change of filter or search goes back to the first page
  const pages = Math.max(1, Math.ceil(newestFirst.length / PAGE_SIZE))
  const pageNow = Math.min(page, pages - 1)
  const filterKey = `${statusFilter}|${agentFilter}|${projectFilter}|${tagFilter}|${needle}|${showDone}`
  useEffect(() => setPage(0), [filterKey])

  return (
    <Modal open onClose={onClose} title="Tasks" description={`${tasks.length} tasks · ${tasks.filter((t) => t.status !== 'done').length} open`} width={1180}>
      <div className="modal__body tasks-modal">
        <div className={`toolbar${filtersOpen ? '' : ' toolbar--folded'}`}>
          <div className="seg" role="tablist" aria-label="View">
            <button className={prefs.view === 'list' ? 'active' : ''} onClick={() => setPref({ view: 'list' })}>
              <LuList /> List
            </button>
            <button className={prefs.view === 'board' ? 'active' : ''} onClick={() => setPref({ view: 'board' })}>
              <LuKanban /> Board
            </button>
          </div>
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
          {prefs.view === 'board' && (
          <div className="toolbar__field">
            <span className="muted">Group by</span>
            <Select
              ariaLabel="Group by"
              size="sm"
              value={prefs.groupBy}
              options={[
                { value: 'status', label: 'Status' },
                { value: 'agent', label: 'Agent' },
                { value: 'project', label: 'Project' },
              ]}
              onChange={(groupBy) => setPref({ groupBy })}
            />
          </div>
          )}
          {prefs.view === 'list' && (
            <div className="toolbar__filter">
              <Select
                ariaLabel="Filter by status"
                size="sm"
                value={statusFilter}
                options={[{ value: '*' as const, label: 'All statuses' }, ...STATUSES.map((s) => ({ value: s.value, label: s.label }))]}
                onChange={(v) => setStatusFilter(v as '*' | TaskStatus)}
              />
            </div>
          )}
          <div className="toolbar__filter">
            <Select
              ariaLabel="Filter by agent"
              searchable
              size="sm"
              value={agentFilter}
              options={[{ value: '*', label: 'All agents' }, { value: '', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
              onChange={setAgentFilter}
            />
          </div>
          <div className="toolbar__filter">
            <Select
              ariaLabel="Filter by project"
              searchable
              size="sm"
              value={projectFilter}
              options={[{ value: '*', label: 'All projects' }, { value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              onChange={setProjectFilter}
            />
          </div>
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
          <div className="toolbar__actions">
            <button className="small" data-tip="Brief and quality check per project" onClick={() => openUrl({ projects: '1' })}>
              <LuFolderKanban /> Projects
            </button>
            {live && (
              <button className="small" data-tip="Old finished tasks" onClick={() => openUrl({ archive: '1' })}>
                <LuArchive /> Archive{archived ? ` (${archived})` : ''}
              </button>
            )}
            <label className="check">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done
            </label>
          </div>
        </div>

        {prefs.view === 'list' ? (
          <>
            {needle && !visible.length && <div className="empty">No tasks match “{search.trim()}”.</div>}
            <ListView tasks={newestFirst.slice(pageNow * PAGE_SIZE, (pageNow + 1) * PAGE_SIZE)} onOpen={setOpenId} />
            {pages > 1 && (
              <div className="task-pager">
                <span className="muted">
                  {pageNow * PAGE_SIZE + 1}–{Math.min(newestFirst.length, (pageNow + 1) * PAGE_SIZE)} of {newestFirst.length}
                </span>
                <span className="grow" />
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
            onMove={(taskId, key) => updateTask(taskId, patchFor(prefs.groupBy, key))}
            onAdd={(key) => setCreating(patchFor(prefs.groupBy, key))}
            onOpen={setOpenId}
          />
        )}
      </div>
    </Modal>
  )
}

// ── List ─────────────────────────────────────────────────────────────

/** Tasks per page of the list. */
const PAGE_SIZE = 25

function ListView({ tasks, onOpen }: { tasks: OfficeTask[]; onOpen: (id: string) => void }) {
  return (
    <div className="task-list">
      <div className="task-table__head">
        <span />
        <span>Task</span>
        <span>Status</span>
        <span>Project</span>
        <span>Deadline</span>
        <span>Priority</span>
        <span>Agent</span>
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
  return (
    <div className={`task-table__row${done ? ' task--done' : ''}`}>
      <input type="checkbox" checked={done} onChange={() => toggleTask(t.id)} aria-label={done ? 'Mark not done' : 'Mark done'} />
      <button className="row__title truncate task-table__title" data-tip="Open task" onClick={onOpen}>
        <BlockedBadge task={t} />
        <CheckBadge task={t} /> <span className="truncate">{t.title}</span>
        <TagChips ids={t.tags} />
      </button>
      <StatusSelect size="sm" value={t.status} onChange={(status) => updateTask(t.id, { status })} />
      <ProjectSelect size="sm" value={t.projectId ?? ''} onChange={(id) => updateTask(t.id, { projectId: id || null })} />
      <Deadline ms={t.deadline} due={done ? null : due} />
      <Select ariaLabel="Priority" size="sm" value={t.priority} options={PRIORITY_OPTIONS} onChange={(priority) => updateTask(t.id, { priority })} />
      <AgentSelect size="sm" value={t.agentId ?? ''} onChange={(id) => updateTask(t.id, { agentId: id || null })} />
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
}: {
  groups: Group[]
  tasksFor: (key: string) => OfficeTask[]
  onMove: (taskId: string, key: string) => void
  onAdd: (key: string) => void
  onOpen: (id: string) => void
}) {
  const tasks = useDashboard((s) => s.tasks)
  const [dragging, setDragging] = useState<string | null>(null)
  // cards move by their grip only (the rest of the card opens it and scrolls the board): a short move starts the drag
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onStart = (e: DragStartEvent) => setDragging(String(e.active.id))
  const onEnd = (e: DragEndEvent) => {
    setDragging(null)
    if (e.over) onMove(String(e.active.id), String(e.over.id).replace(/^col:/, ''))
  }
  const draggingTask = tasks.find((t) => t.id === dragging)

  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
      <div className="board">
        {groups.map((g) => (
          <Column key={g.key} group={g} tasks={tasksFor(g.key)} onAdd={() => onAdd(g.key)} onOpen={onOpen} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>{draggingTask && <Card task={draggingTask} overlay />}</DragOverlay>
    </DndContext>
  )
}

function Column({ group, tasks, onAdd, onOpen }: { group: Group; tasks: OfficeTask[]; onAdd: () => void; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${group.key}` })
  return (
    <section ref={setNodeRef} className={`board__col${isOver ? ' board__col--over' : ''}`}>
      <header className="board__head">
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
          <ProjectTag projectId={t.projectId} />
          <TagChips ids={t.tags} />
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
          {agent ? (
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
