import { OwnerAvatar } from './EditProfile'
import { useState, type FormEvent, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { LuTag, LuFolderGit2, LuCalendarClock, LuCrown, LuListChecks, LuListTodo, LuPlay, LuPlus, LuSearch, LuTrash2, LuX, LuActivity } from 'react-icons/lu'
import { tip } from './Tooltip'
import { openUrl } from '../state/url'
import type { CronJob, OfficeTask, TaskPriority, TaskStatus } from '@after-office/shared'
import { describeDays, runCronNow } from '../state/cronRunner'
import { TaskRunFields, type TaskRun } from './TaskRun'
import { useClock, useNow, zonedParts } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice, type OfficeAgent, avatarStyle } from '../state/store'
import { CronTrigger } from './CronTrigger'
import { FoldersTab } from './ProjectsTab'
import { Field, Modal } from './Modal'
import { confirm } from './Confirm'
import { DateTimeField, TimeField } from './pickers'
import { Select } from './Select'
import { AgentSelect, assigneePatch, OWNER, useStatuses, dueInfo, HOUR, PRIORITY_OPTIONS, PRIORITY_RANK, FolderSelect, StatusSelect, WaitsForSelect, BlockedBadge, CheckBadge } from './taskMeta'
import { useLaunch } from '../pwa/launch'
import { MOBILE } from '../state/useMediaQuery'
import { useWorkReady } from '../state/live'
import { TagPicker } from './tags'
import { TagsTab } from './TagsTab'
import { TagModal } from './TagModal'
import { ActivitySidebar } from './Activity'
import { ScrollTabs } from './ScrollTabs'
import { matchesSearch, SearchBox } from './SearchBox'

export function LeftSidebar() {
  return (
    <aside className="side side--left">
      <CronPanel />
      <TaskPanel />
    </aside>
  )
}

function AgentChip({ agent, mine }: { agent?: OfficeAgent; mine?: boolean }) {
  if (mine) return <span className="chip chip--me">You</span>
  if (!agent) return <span className="chip chip--muted">unassigned</span>
  return (
    <span className="chip">
      <span className="chip__dot" style={{ background: agent.look.shirt }} />
      {agent.name}
    </span>
  )
}


// ── Cron ────────────────────────────────────────────────────────────────

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Minutes until this job's next time today (or tomorrow, +1440), for "next up first" sorting. */
function nextRunIn(cron: CronJob, nowMin: number) {
  const upcoming = cron.times.map(toMin).find((t) => t >= nowMin)
  return upcoming !== undefined ? upcoming - nowMin : 1440 - nowMin + Math.min(...cron.times.map(toMin))
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * When the server runs this job next on its own (in the office's time zone), as "Today 10:34 · in 2h",
 * "Tomorrow 09:00 · in 18h" or "Mon 5 Oct, 10:34 · in 6 days". Null when it won't run (off, no agent, no days).
 */
export function nextRunLabel(cron: Pick<CronJob, 'times' | 'days' | 'enabled' | 'agentId'>, now: Date, timezone: string) {
  if (!cron.enabled || !cron.agentId || !cron.days.length || !cron.times.length) return null
  const times = [...cron.times].sort()
  const nowMin = toMin(zonedParts(now, timezone).hhmm)
  for (let d = 0; d <= 7; d++) {
    const day = zonedParts(new Date(now.getTime() + d * 86_400_000), timezone)
    if (!cron.days.includes(WEEKDAYS[day.weekday])) continue
    const t = times.find((x) => d > 0 || toMin(x) > nowMin)
    if (!t) continue
    const mins = d * 1440 + toMin(t) - nowMin
    const inText = mins < 60 ? `in ${Math.max(1, mins)} min` : mins < 1440 ? `in ${Math.round(mins / 60)}h` : `in ${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'}`
    const [y, m, dd] = day.date.split('-').map(Number)
    const dayText = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `${day.weekday} ${new Date(y, m - 1, dd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })},`
    return `${dayText} ${t} · ${inText}`
  }
  return null
}

export function CronPanel() {
  const ready = useWorkReady()
  const { crons, updateCron, removeCron } = useDashboard(useShallow((s) => ({ crons: s.crons, updateCron: s.updateCron, removeCron: s.removeCron })))
  const agents = useOffice((s) => s.agents)
  const timezone = useClock((s) => s.timezone)
  const now = useNow(30_000)
  const { hhmm } = zonedParts(now, timezone)

  const nowMin = toMin(hhmm)
  const [q, setQ] = useState('')
  // the search stays folded behind its button until asked for
  const [searching, setSearching] = useState(false)
  const searchBox = useRef<HTMLDivElement>(null)
  const toggleSearch = () => {
    const next = !searching
    setSearching(next)
    if (next) setTimeout(() => searchBox.current?.querySelector('input')?.focus(), 60)
    else setQ('')
  }
  const sorted = [...crons]
    .filter((c) => matchesSearch(q, c.name, c.prompt, agents.find((a) => a.id === c.agentId)?.name))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || nextRunIn(a, nowMin) - nextRunIn(b, nowMin))

  return (
    <section className="card">
      <header className="card__head">
        <h2>
          <LuCalendarClock /> Daily
        </h2>
        <span className="muted">{crons.filter((c) => c.enabled).length} active</span>
        {crons.length > 0 && (
          <button className={`icon-btn small icon-btn--toggle`} aria-pressed={searching} aria-expanded={searching} {...tip(searching ? 'Close search' : 'Search daily jobs')} onClick={toggleSearch}>
            {searching ? <LuX /> : <LuSearch />}
          </button>
        )}
        <button className="icon-btn small" data-tip="New daily job" aria-label="New daily job" onClick={() => openUrl({ daily: 'new' })}>
          <LuPlus />
        </button>
      </header>
      {crons.length > 0 && (
        // folds open under the header (styles: .fold-search)
        <div ref={searchBox} className={`fold-search${searching ? ' is-open' : ''}`} inert={!searching || undefined}>
          <div>
            <SearchBox value={q} onChange={setQ} placeholder="Search daily jobs" className="side-search" />
          </div>
        </div>
      )}
      <ul className="list">
        {sorted.map((c) => (
          <CronRow
            key={c.id}
            cron={c}
            nowMin={nowMin}
            agent={agents.find((a) => a.id === c.agentId)}
            onToggle={() => updateCron(c.id, { enabled: !c.enabled })}
            onAssign={(agentId) => updateCron(c.id, { agentId: agentId || null })}
            onRemove={async () => {
              if (await confirm({ title: `Delete the daily job “${c.name}”?`, message: "It stops running. Its past reports stay. This can't be undone." })) removeCron(c.id)
            }}
            onEdit={() => openUrl({ daily: c.id })}
          />
        ))}
        {!crons.length && ready && <li className="empty">No daily jobs yet.</li>}
        {crons.length > 0 && !sorted.length && <li className="empty">No daily jobs match.</li>}
      </ul>
    </section>
  )
}

function CronRow({
  cron,
  nowMin,
  agent,
  onToggle,
  onAssign,
  onRemove,
  onEdit,
}: {
  cron: CronJob
  nowMin: number
  agent?: OfficeAgent
  onToggle: () => void
  onAssign: (id: string) => void
  onRemove: () => void
  onEdit: () => void
}) {
  const [flash, setFlash] = useState('')
  const next = cron.times.find((t) => toMin(t) >= nowMin) ?? cron.times[0]
  const timezone = useClock((s) => s.timezone)
  const nextLabel = nextRunLabel(cron, useNow(30_000), timezone)
  return (
    <li className={`row cron${cron.enabled ? '' : ' row--off'}`}>
      <div className="cron__time" data-tip={nextLabel ? `Runs on its own · next: ${nextLabel}` : cron.enabled ? 'Assign an agent to run it' : 'Off: turn it on to run on schedule'}>
        {next}
        {cron.times.length > 1 && <span className="cron__more">+{cron.times.length - 1}</span>}
      </div>
      <div className="row__body">
        <button className="cron__name" onClick={onEdit} data-tip="Edit daily job">
          {cron.name}
        </button>
        <div className="row__meta">
          <span className="muted truncate">
            {describeDays(cron.days)}
            {cron.times.length > 1 && ` · ${cron.times.join(', ')}`}
          </span>
          {flash && <span className="flash">{flash}</span>}
        </div>
        <div className="row__actions">
          <label className="toggle" data-tip={cron.enabled ? 'Disable' : 'Enable'}>
            <input type="checkbox" checked={cron.enabled} onChange={onToggle} />
            <span />
          </label>
          <AgentSelect size="sm" value={cron.agentId ?? ''} onChange={onAssign} />
          <button
            className="icon-btn small"
            data-tip="Run now"
            aria-label="Run now"
            disabled={!agent}
            onClick={async () => {
              setFlash(await runCronNow(cron))
              setTimeout(() => setFlash(''), 2500)
            }}
          >
            <LuPlay />
          </button>
          <button className="icon-btn small ghost" data-tip="Delete daily job" aria-label="Delete daily job" onClick={onRemove}>
            <LuX />
          </button>
        </div>
      </div>
    </li>
  )
}

// Monday-first, like most calendars here
const WEEK: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' },
]
const DAY_PRESETS: { label: string; days: number[] }[] = [
  { label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
  { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { label: 'Weekends', days: [0, 6] },
]
const sameDays = (a: number[], b: number[]) => [...a].sort().join() === [...b].sort().join()

/** Create or edit a daily job (a cron job underneath): several times per day, on chosen weekdays. */
export function CronModal({ cron, onClose }: { cron?: CronJob; onClose: () => void }) {
  const { addCron, updateCron, removeCron } = useDashboard(useShallow((s) => ({ addCron: s.addCron, updateCron: s.updateCron, removeCron: s.removeCron })))
  const timezone = useClock((s) => s.timezone)
  const [name, setName] = useState(cron?.name ?? '')
  const [prompt, setPrompt] = useState(cron?.prompt ?? '')
  const [times, setTimes] = useState<string[]>(cron?.times ?? ['09:00'])
  const [days, setDays] = useState<number[]>(cron?.days ?? [0, 1, 2, 3, 4, 5, 6])
  const [agentId, setAgentId] = useState(cron?.agentId ?? '')
  const [fresh, setFresh] = useState(cron?.fresh ?? false)
  const live = useOffice((s) => s.source === 'live')

  const uniqueTimes = [...new Set(times)].sort()
  const valid = name.trim() && prompt.trim() && uniqueTimes.length && days.length
  const nextLabel = nextRunLabel({ times: uniqueTimes, days, enabled: true, agentId: agentId || null }, useNow(30_000), timezone)

  const addTime = () => {
    // suggest an hour after the latest one
    const last = uniqueTimes[uniqueTimes.length - 1] ?? '08:00'
    const next = Math.min(toMin(last) + 60, 23 * 60 + 45)
    setTimes([...times, `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`])
  }
  const toggleDay = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    const data = { name: name.trim(), prompt: prompt.trim(), times: uniqueTimes, days: [...days].sort(), agentId: agentId || null, fresh }
    if (cron) updateCron(cron.id, data)
    else addCron({ ...data, enabled: true })
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={cron ? 'Edit daily job' : 'New daily job'} description="Sends a prompt to an agent on a schedule.">
      <form className="modal__body" onSubmit={submit}>
        <Field label="Name">
          <input placeholder="e.g. Dependency audit" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!cron} autoComplete="off" data-1p-ignore />
        </Field>
        <Field label="Prompt" hint="Typed into the agent's Claude Code session when the job runs.">
          <textarea placeholder="Run npm audit and open PRs for the fixes" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>

        <div className="field">
          <span className="field__label">Times</span>
          <div className="time-list">
            {times.map((t, i) => (
              <span key={i} className="time-chip">
                <TimeField size="sm" value={t} onChange={(v) => setTimes(times.map((x, j) => (j === i ? v : x)))} ariaLabel={`Time ${i + 1}`} />
                {times.length > 1 && (
                  <button type="button" className="icon-btn small ghost" data-tip="Remove time" aria-label="Remove time" onClick={() => setTimes(times.filter((_, j) => j !== i))}>
                    <LuX />
                  </button>
                )}
              </span>
            ))}
            <button type="button" className="small" onClick={addTime} disabled={times.length >= 24}>
              <LuPlus /> Add time
            </button>
          </div>
          <span className="field__hint">
            {uniqueTimes.length} run{uniqueTimes.length === 1 ? '' : 's'} per day · {timezone}
          </span>
        </div>

        <div className="field">
          <span className="field__label">Repeat on</span>
          <div className="day-picker">
            {WEEK.map(({ day, label }) => (
              <button type="button" key={day} className={`day-chip${days.includes(day) ? ' active' : ''}`} aria-pressed={days.includes(day)} onClick={() => toggleDay(day)}>
                {label}
              </button>
            ))}
          </div>
          <div className="day-presets">
            {DAY_PRESETS.map((p) => (
              <button type="button" key={p.label} className={`small${sameDays(days, p.days) ? ' active' : ''}`} onClick={() => setDays(p.days)}>
                {p.label}
              </button>
            ))}
            {!days.length && <span className="field__hint danger-text">Pick at least one day.</span>}
          </div>
        </div>

        <Field label="Agent">
          <AgentSelect value={agentId} onChange={setAgentId} />
        </Field>
        {/* it runs on its own: say when, so nobody waits for a "Run now" */}
        <p className={`cron-next${nextLabel ? '' : ' cron-next--off'}`}>
          <LuCalendarClock />
          {nextLabel ? (
            <span>
              Runs automatically on this schedule. Next run: <b>{nextLabel}</b>
            </span>
          ) : (
            <span>{!agentId ? 'Choose an agent: it runs automatically once one is assigned.' : 'Pick at least one day and time.'}</span>
          )}
        </p>
        <label className="switch-row">
          <span className="toggle">
            <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
            <span />
          </span>
          <span>
            <span className="switch-row__label">Fresh context</span>
            <span className="field__hint">Runs /clear before the prompt. Off: continues the agent's current conversation.</span>
          </span>
        </label>
        {cron && live && <CronTrigger cron={cron} />}
        <footer className="modal__foot">
          {cron && (
            <>
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  if (!(await confirm({ title: `Delete the daily job “${cron.name}”?`, message: "It stops running. Its past reports stay. This can't be undone." }))) return
                  removeCron(cron.id)
                  onClose()
                }}
              >
                <LuTrash2 /> Delete
              </button>
              <span className="grow" />
            </>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {cron ? 'Save changes' : 'Create daily job'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ── Tasks ───────────────────────────────────────────────────────────────


const TAB_KEY = 'after-office:task-panel-tab'

export function TaskPanel() {
  const ready = useWorkReady()
  const { tasks, toggleTask } = useDashboard(useShallow((s) => ({ tasks: s.tasks, toggleTask: s.toggleTask })))
  const agents = useOffice((s) => s.agents)
  const now = useNow(60_000).getTime()
  const [showDone, setShowDone] = useState(false)
  // app shortcut "Tasks" on a desktop: the full task list
  const launch = useLaunch((s) => s.open)
  useEffect(() => {
    if (launch !== 'tasks' || window.matchMedia(MOBILE).matches) return
    openUrl({ tasks: '1' })
    useLaunch.getState().done()
  }, [launch])
  const [tab, setTab] = useState<'tasks' | 'folders' | 'tags' | 'activity'>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY)
      // "projects": the same tab, from before it was called Folders
      if (saved === 'projects') return 'folders'
      return saved === 'folders' || saved === 'tags' || saved === 'activity' ? saved : 'tasks'
    } catch {
      return 'tasks'
    }
  })
  const pickTab = (t: 'tasks' | 'folders' | 'tags' | 'activity') => {
    setTab(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // private mode: not remembered
    }
  }

  // one search for whichever tab is open
  const [q, setQ] = useState('')
  const [newTag, setNewTag] = useState(false)
  const found = (t: OfficeTask) => matchesSearch(q, t.title, t.description, agents.find((a) => a.id === t.agentId)?.name)
  const open = tasks.filter((t) => t.status !== 'done' && found(t)).sort((a, b) => a.deadline - b.deadline || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
  const done = tasks.filter((t) => t.status === 'done' && found(t))
  const urgent = open.filter((t) => t.deadline - now < 24 * HOUR).length

  const row = (t: OfficeTask) => {
    const isDone = t.status === 'done'
    const due = dueInfo(t.deadline, now)
    const agent = agents.find((a) => a.id === t.agentId)
    return (
      <li key={t.id} className={`task-row${isDone ? ' task--done' : ''}`}>
        <input type="checkbox" checked={isDone} onChange={() => toggleTask(t.id)} aria-label={isDone ? 'Mark not done' : 'Mark done'} />
        <button className="task-row__main" onClick={() => openUrl({ task: t.id })} data-tip={t.title}>
          <span className="task-row__title">
            <span className={`prio prio--${t.priority}`} data-tip={`${t.priority[0].toUpperCase() + t.priority.slice(1)} priority`} aria-label={`${t.priority} priority`} />
            <BlockedBadge task={t} />
            <CheckBadge task={t} />
            <span className="truncate">{t.title}</span>
          </span>
          {!isDone && (
            <span className="task-row__meta">
              <span className={`due due--${due.level}`}>{due.text}</span>
              {t.delegatedBy && (
                <span className="by-manager" data-tip="Delegated by the manager">
                  <LuCrown />
                </span>
              )}
              <span className="grow" />
              {t.forOwner ? (
                <span className="task-me" data-tip="Your own task">
                  <OwnerAvatar className="avatar--xs" />
                </span>
              ) : agent ? (
                <span className="avatar avatar--xs" style={avatarStyle(agent.look.shirt)} data-tip={agent.name}>
                  {agent.name[0]}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </span>
          )}
        </button>
      </li>
    )
  }

  return (
    <section className="card card--grow">
      <header className="card__head">
        <ScrollTabs className="task-tabs" label="Tasks, folders, tags or activity" active={tab}>
          <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'active' : ''} onClick={() => pickTab('tasks')}>
            <LuListTodo /> Tasks
          </button>
          <button role="tab" aria-selected={tab === 'folders'} className={tab === 'folders' ? 'active' : ''} onClick={() => pickTab('folders')}>
            <LuFolderGit2 /> Folders
          </button>
          <button role="tab" aria-selected={tab === 'tags'} className={tab === 'tags' ? 'active' : ''} onClick={() => pickTab('tags')}>
            <LuTag /> Tags
          </button>
          <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => pickTab('activity')}>
            <LuActivity /> Activity
          </button>
        </ScrollTabs>
      </header>
      <div className="side-search-row">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder={tab === 'tasks' ? 'Search tasks' : tab === 'folders' ? 'Search folders' : tab === 'tags' ? 'Search tags' : 'Search activity'}
          className="side-search"
        />
        {/* Tags: a new one (name, colour, icon) in a modal */}
        {tab === 'tags' && (
          <button className="icon-btn small side-search-row__add" onClick={() => setNewTag(true)} {...tip('New tag')} aria-label="New tag">
            <LuPlus />
          </button>
        )}
      </div>
      {newTag && <TagModal onClose={() => setNewTag(false)} />}
      {/* its own row under the tabs, so nothing gets squeezed in a narrow column */}
      {tab === 'tasks' && (
        <div className="task-bar">
          {showDone ? (
            <span className="muted">{done.length} done</span>
          ) : urgent > 0 ? (
            <span className="badge badge--hot">{urgent} urgent</span>
          ) : (
            <span className="muted">{open.length} open</span>
          )}
          <span className="grow" />
          <button className="small" onClick={() => openUrl({ tasks: '1' })}>
            View all
          </button>
          {/* done tasks: a second view of the list, not a pile under the open ones */}
          <button
            className="icon-btn small icon-btn--toggle"
            aria-pressed={showDone}
            disabled={!done.length && !showDone}
            onClick={() => setShowDone((v) => !v)}
            {...tip(showDone ? 'Back to open tasks' : done.length ? `Show ${done.length} done task${done.length === 1 ? '' : 's'}` : 'No done tasks yet')}
          >
            <LuListChecks />
          </button>
          <button className="icon-btn small" data-tip="New task" aria-label="New task" onClick={() => openUrl({ newtask: '1' })}>
            <LuPlus />
          </button>
        </div>
      )}
      {tab === 'folders' ? (
        <div key="folders" className="side-pane ui-switch">
          <FoldersTab q={q} />
        </div>
      ) : tab === 'tags' ? (
        <div key="tags" className="side-pane ui-switch">
          <TagsTab q={q} />
        </div>
      ) : tab === 'activity' ? (
        <div key="activity" className="side-pane ui-switch">
          <ActivitySidebar q={q} />
        </div>
      ) : (
        <>
          <ul key={showDone ? 'done' : 'open'} className="list task-rows ui-switch">
            {showDone ? done.map(row) : open.map(row)}
            {!showDone && !open.length && ready && <li className="empty">{q.trim() ? 'No tasks match.' : 'All clear'}</li>}
            {showDone && !done.length && <li className="empty">No done tasks.</li>}
          </ul>
        </>
      )}
    </section>
  )
}


export function TaskModal({ onClose, defaults }: { onClose: () => void; defaults?: Partial<Pick<OfficeTask, 'agentId' | 'folder' | 'status' | 'customStatus' | 'description' | 'tags'>> }) {
  // started from one of the owner's own statuses (a board column): it counts as that status's built-in one
  const startDef = useStatuses().find((d) => d.id === defaults?.customStatus)
  const addTask = useDashboard((s) => s.addTask)
  const [title, setTitle] = useState('')
  const [deadline, setDeadline] = useState(() => Date.now() + 24 * HOUR)
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [status, setStatus] = useState<TaskStatus>(startDef?.base ?? defaults?.status ?? 'todo')
  const [customStatus, setCustomStatus] = useState<string | undefined>(startDef?.id)
  const [agentId, setAgentId] = useState(defaults?.agentId ?? '')
  const [folder, setFolder] = useState<string | undefined>(defaults?.folder)
  const [description, setDescription] = useState(defaults?.description ?? '')
  const [run, setRun] = useState<TaskRun>({})
  const [blockedBy, setBlockedBy] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>(defaults?.tags ?? [])
  const live = useOffice((s) => s.source === 'live')

  // your own task: none of an agent's run (folder, start, waits for); the form keeps only what you need
  const mine = agentId === OWNER

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    addTask({
      title: title.trim(),
      deadline,
      priority,
      status,
      ...(customStatus ? { customStatus } : {}),
      ...assigneePatch(agentId),
      description: description.trim() || undefined,
      ...(tags.length ? { tags } : {}),
      ...(mine ? {} : { ...(folder ? { folder } : {}), ...run, ...(blockedBy.length ? { blockedBy } : {}) }),
    })
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={mine ? 'New task for me' : 'New task'}>
      <form className="modal__body" onSubmit={submit}>
        <Field label="Title">
          <input placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus autoComplete="off" data-1p-ignore />
        </Field>
        <div className="field-row">
          <Field label="Who does it">
            <AgentSelect withOwner value={agentId} onChange={setAgentId} />
          </Field>
          <Field label="Status">
            <StatusSelect value={customStatus ?? status} onChange={(p) => (setStatus(p.status), setCustomStatus(p.customStatus))} />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Deadline">
            <DateTimeField value={deadline} onChange={setDeadline} ariaLabel="Deadline" />
          </Field>
          <Field label="Priority">
            <Select ariaLabel="Priority" value={priority} options={PRIORITY_OPTIONS} onChange={setPriority} />
          </Field>
        </div>
        {!mine && (
          <>
            <Field label="Folder" hint="Where the agent works. Empty: its own folder.">
              <FolderSelect value={folder} onChange={setFolder} />
            </Field>
            <TaskRunFields value={run} onChange={(p) => setRun({ ...run, ...p })} />
            {live && (
              <Field label="Waits for" hint="Starts on its own once these are finished (needs an agent).">
                <WaitsForSelect value={blockedBy} onChange={setBlockedBy} />
              </Field>
            )}
            {run.autoStart && !agentId && <p className="field__hint danger-text">Pick an agent so it can start automatically.</p>}
          </>
        )}
        <Field label="Tags" hint="Type a new name to make a tag.">
          <TagPicker value={tags} onChange={setTags} />
        </Field>
        <Field label={mine ? 'Notes' : 'Description'} hint={mine ? undefined : 'Context, acceptance criteria, links. Sent to the agent along with the task.'}>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={mine ? 'Anything to remember (optional)' : 'What does done look like?'} />
        </Field>
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!title.trim()}>
            Create task
          </button>
        </footer>
      </form>
    </Modal>
  )
}

