import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { LuSlidersHorizontal, LuCheckCheck, LuMail, LuMinus, LuChevronLeft, LuChevronRight, LuCircleAlert, LuCircleCheck, LuCircleX, LuClock, LuHourglass, LuLoader, LuRefreshCw, LuHand, LuCrown, LuFileText, LuFolder, LuLayers, LuListTodo, LuMessageSquareText, LuNotebookPen, LuPlus, LuRotateCcw, LuSearch, LuTrash2, LuX } from 'react-icons/lu'
import type { OfficeTask, ReportOutcome, WorkJob, WorkReport } from '@after-office/shared'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice, avatarStyle } from '../state/store'
import { ago, Markdown } from './FollowUps'
import { Attachments, reportUrl, useReportFiles } from './Attachments'
import { FileLinksProvider } from './fileLinks'
import { Modal } from './Modal'
import { useModalMaximize } from './Maximize'
import { confirm } from './Confirm'
import { tip } from './Tooltip'
import { useWorkReady } from '../state/live'
import { api } from '../state/auth'
import { bulkStateOf, runReportBulk, useReportBulk, type ReportBulk } from '../state/reportBulk'
import { openUrl, setUrl, useUrl } from '../state/url'
import { RangePicker, type PickedRange } from './DateRangePicker'
import { Select } from './Select'
import { TagChips, TagFilter, TagPicker } from './tags'
import { NotesList } from './OwnerNotes'
import { REPORTS, useMinimized } from '../state/minimized'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { ScrollTabs } from './ScrollTabs'

// Reports: what an agent said when it finished a task or a cron run (its final message), kept apart from the chat
// so finished work can be reviewed later. Written by the server on the agent's Stop hook; no LLM involved.

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const KindIcon = ({ r }: { r: WorkReport }) =>
  !r.ok ? (
    <LuCircleAlert className="report__icon report__icon--bad" />
  ) : r.kind === 'note' ? (
    <LuCrown className="report__icon report__icon--note" />
  ) : r.kind === 'cron' ? (
    <LuClock className="report__icon" />
  ) : r.kind === 'chat' ? (
    <LuMessageSquareText className="report__icon" />
  ) : (
    <LuListTodo className="report__icon" />
  )

export function ReportRow({
  r,
  now,
  onOpen,
  showJob = true,
  picked,
  checked,
  onCheck,
  busy,
}: {
  r: WorkReport
  now: number
  onOpen: () => void
  showJob?: boolean
  picked?: boolean
  /** View all: the row can be picked for an action on several (onCheck) */
  checked?: boolean
  onCheck?: (on: boolean) => void
  /** an action on it is running (it can't be picked meanwhile); "removing": deleted, folding away */
  busy?: RowBusy
}) {
  const agent = useOffice((s) => s.agents.find((a) => a.id === r.agentId))
  const firstLine = r.text.replace(/[#*`>_-]/g, '').split('\n').find((l) => l.trim()) ?? ''
  return (
    <li
      className={`report-row${r.read ? '' : ' report-row--unread'}${picked ? ' is-picked' : ''}${onCheck ? ' report-row--checkable' : ''}${checked ? ' is-checked' : ''}${busy ? ` is-${busy}` : ''}`}
      aria-current={picked || undefined}
      aria-busy={busy ? true : undefined}
    >
      {onCheck && <input type="checkbox" className="report-row__check" checked={!!checked} disabled={!!busy} onChange={(e) => onCheck(e.target.checked)} aria-label={`Pick “${r.title}”`} />}
      <button className="report-row__main" onClick={onOpen}>
        <KindIcon r={r} />
        <span className="report-row__body">
          <span className="report-row__title-line">
            <span className="report-row__title clamp2">{r.title}</span>
            <OutcomeBadge state={outcomeOf(r)} />
          </span>
          <span className="report-row__text clamp2">{firstLine}</span>
          <span className="report-row__meta">
            {/* who: a small initial in the agent's colour, about the size of the text */}
            <span className="report-row__who" style={agent ? avatarStyle(agent.look.shirt) : undefined} aria-hidden>
              {(agent?.name ?? '?')[0]}
            </span>
            <span className="truncate">
              {agent?.name ?? 'Removed agent'} · {ago(now - r.finishedAt)}
            </span>
            {showJob && r.job && (
              <span className="report-row__job truncate">
                <LuLayers /> {r.job.title}
              </span>
            )}
            <TagChips ids={r.tags} max={1} />
          </span>
        </span>
        {!r.read && <span className="report-row__dot" aria-label="Unread" />}
      </button>
      {busy && busy !== 'removing' && <BusyTag busy={busy} />}
    </li>
  )
}

/** What a row being acted on is going through (Reports → pick → Delete / Read / Unread). */
export type RowBusy = 'deleting' | 'updating' | 'removing'
function BusyTag({ busy }: { busy: RowBusy }) {
  return (
    <span className={`row-busy row-busy--${busy}`} aria-hidden>
      <LuLoader className="row-busy__spin" />
      {busy === 'deleting' ? 'Deleting…' : 'Updating…'}
    </span>
  )
}

/** The day a report belongs to, as an inbox says it: Today, Yesterday, a weekday this week, else the date. */
export function dayLabel(at: number, now: number) {
  const start = (t: number) => new Date(new Date(t).toDateString()).getTime()
  const days = Math.round((start(now) - start(at)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(at)
  if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })
}

/** A list split by day: a heading before the first item of each day. */
function withDays<T>(items: T[], at: (x: T) => number, now: number, render: (x: T) => ReactNode, key: (x: T) => string): ReactNode[] {
  const out: ReactNode[] = []
  let last = ''
  for (const x of items) {
    const label = dayLabel(at(x), now)
    if (label !== last) {
      out.push(
        <li key={`day-${label}-${key(x)}`} className="report-day" aria-hidden>
          {label}
        </li>,
      )
      last = label
    }
    out.push(render(x))
  }
  return out
}

/** How a report turned out: what the manager said, a failed run, or the review's verdict in its first lines. */
export function outcomeOf(r: WorkReport): ReportOutcome | null {
  if (r.outcome) return r.outcome
  if (!r.ok) return 'failed'
  const head = r.text.slice(0, 600)
  if (/\bPASS(ED)?\b/.test(head)) return 'pass'
  if (/\b(REVISE|REVISI)\b/.test(head)) return 'revise'
  return null
}

type BadgeState = ReportOutcome | 'working' | 'waiting' | 'review'
const BADGES: Record<BadgeState, { label: string; icon: ReactNode }> = {
  done: { label: 'Done', icon: <LuCircleCheck /> },
  pass: { label: 'Pass', icon: <LuCircleCheck /> },
  revise: { label: 'Revise', icon: <LuRefreshCw /> },
  failed: { label: 'Failed', icon: <LuCircleX /> },
  needs_you: { label: 'Needs you', icon: <LuHand /> },
  working: { label: 'Working', icon: <LuLoader /> },
  waiting: { label: 'Waiting', icon: <LuHourglass /> },
  review: { label: 'To review', icon: <LuCircleCheck /> },
}
/** The verdict at a glance, before the words. */
export function OutcomeBadge({ state }: { state: BadgeState | null }) {
  if (!state) return null
  const b = BADGES[state]
  return (
    <span className={`outcome outcome--${state}`}>
      {b.icon} {b.label}
    </span>
  )
}

/** Reports that read as one item: every report of one job, or the rounds of one task; anything else on its own. */
interface ReportGroup {
  key: string
  job?: WorkJob
  /** newest first */
  reports: WorkReport[]
}
export function groupReports(list: WorkReport[]): ReportGroup[] {
  const groups = new Map<string, ReportGroup>()
  for (const r of list) {
    const key = r.job ? `job:${r.job.id}` : r.kind === 'task' ? `task:${r.refId}` : r.id
    const g = groups.get(key)
    if (g) g.reports.push(r)
    else groups.set(key, { key, job: r.job, reports: [r] })
  }
  return [...groups.values()]
    .map((g) => ({ ...g, reports: [...g.reports].sort((a, b) => b.finishedAt - a.finishedAt) }))
    .sort((a, b) => b.reports[0].finishedAt - a.reports[0].finishedAt)
}

/** Where a job (or a task) stands, from its tasks still on the board. */
function jobState(tasks: OfficeTask[]): 'working' | 'waiting' | 'review' | 'done' | null {
  if (!tasks.length) return null
  if (tasks.some((t) => t.status === 'in_progress')) return 'working'
  if (tasks.some((t) => t.status === 'todo')) return 'waiting'
  if (tasks.some((t) => t.status === 'review')) return 'review'
  return 'done'
}

/**
 * One job: its title, how it stands, the latest step's words; opens into its steps. View all: `step` draws each step
 * (its checkbox, picked for reading), the job's checkbox picks them all, and it's open while one of them is read.
 */
function JobRow({
  g,
  now,
  step,
  holds,
  checked,
  onCheck,
  busy,
}: {
  g: ReportGroup
  now: number
  step?: (r: WorkReport) => ReactNode
  /** a step of it is the one being read: shown open */
  holds?: boolean
  checked?: 'all' | 'some' | 'none'
  onCheck?: (on: boolean) => void
  /** every report of it is being acted on */
  busy?: RowBusy
}) {
  const [open, setOpen] = useState(!!holds)
  useEffect(() => {
    if (holds) setOpen(true)
  }, [holds])
  const reports = [...g.reports].sort((a, b) => b.finishedAt - a.finishedAt)
  // its words: the manager's latest summary if there is one, else the latest step's
  const latest = reports.find((r) => r.kind === 'note') ?? reports[0]
  const newest = reports[0]
  const refIds = new Set(g.reports.map((r) => r.refId))
  const tasks = useDashboard(useShallow((s) => s.tasks.filter((t) => (g.job ? t.job?.id === g.job.id : refIds.has(t.id)))))
  const agents = useOffice((s) => s.agents)
  const who = [...new Set(g.reports.map((r) => r.agentId))].map((id) => agents.find((a) => a.id === id)).filter((a) => !!a)
  const state = jobState(tasks)
  // still going: that first; else what the latest word on it says, else where its tasks stand
  const badge: BadgeState | null = state === 'working' || state === 'waiting' ? state : (outcomeOf(latest) ?? (state === 'review' ? 'review' : state))
  const unread = g.reports.some((r) => !r.read)
  const firstLine = latest.text.replace(/[#*`>_-]/g, '').split('\n').find((l) => l.trim()) ?? ''
  const steps = g.reports.length
  return (
    <li
      className={`report-row job-row${unread ? ' report-row--unread' : ''}${open ? ' is-open' : ''}${onCheck ? ' report-row--checkable' : ''}${checked === 'all' ? ' is-checked' : ''}${busy ? ` is-${busy}` : ''}`}
      aria-busy={busy ? true : undefined}
    >
      {onCheck && (
        <input
          type="checkbox"
          className="report-row__check"
          disabled={!!busy}
          checked={checked === 'all'}
          ref={(el) => void (el && (el.indeterminate = checked === 'some'))}
          onChange={(e) => onCheck(e.target.checked)}
          aria-label={`Pick every report of “${g.job?.title ?? latest.title}”`}
        />
      )}
      <button className="report-row__main" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <LuLayers className="report__icon" />
        <span className="report-row__body">
          <span className="report-row__title-line">
            <span className="report-row__title clamp2">{g.job?.title ?? latest.title}</span>
            <OutcomeBadge state={badge} />
          </span>
          <span className="report-row__text clamp2">{firstLine}</span>
          <span className="report-row__meta">
            <span className="job-row__who" aria-hidden>
              {who.slice(0, 4).map((a) => (
                <span key={a.id} className="report-row__who" style={avatarStyle(a.look.shirt)}>
                  {a.name[0]}
                </span>
              ))}
            </span>
            <span className="truncate">
              {steps} {steps === 1 ? 'report' : 'reports'} · {ago(now - newest.finishedAt)}
            </span>
          </span>
        </span>
        {unread && <span className="report-row__dot" aria-label="Unread" />}
        <LuChevronRight className={`job-row__chev${open ? ' open' : ''}`} />
      </button>
      {busy && busy !== 'removing' && <BusyTag busy={busy} />}
      {open && (
        <ul className="job-row__steps ui-drop ui-stagger">
          {reports.map((r) => (step ? <Fragment key={r.id}>{step(r)}</Fragment> : <ReportRow key={r.id} r={r} now={now} showJob={false} onOpen={() => openUrl({ report: r.id })} />))}
        </ul>
      )}
    </li>
  )
}

type PanelView = 'reports' | 'notes'
const VIEW_KEY = 'ao-reports-view'
const remembered = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}
const remember = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* this visit only */
  }
}

/** The card: Reports (the manager's summaries, the agents' reports) | Notes (the owner's own). */
/** Does a report belong under a filter tab? The same rules as the server's (GET /api/reports ?filter). */
function inFilter(r: WorkReport, f: Filter, managerIds: Set<string>) {
  const manager = r.kind === 'note' || managerIds.has(r.agentId)
  if (f === 'unread') return !r.read
  if (f === 'failed') return !r.ok
  if (f === 'manager') return manager
  if (f === 'agents') return !manager
  if (f === 'task') return r.kind === 'task'
  if (f === 'daily') return r.kind === 'cron'
  return true
}

const PANEL_TAB_KEY = 'after-office:reports-panel-tab'
const PANEL_STEP = 20
const PANEL_PAGE = 50

/**
 * The Reports panel's list under a tab: the live reports first (the newest the dashboard holds), then older ones
 * loaded from the server as it scrolls down. `more()` shows the next few (and fetches a page when those run out).
 */
function useReportFeed(filter: Filter) {
  const live = useOffice((s) => s.source === 'live')
  const reports = useDashboard((s) => s.reports)
  const older = useDashboard((s) => s.olderReports)
  const agents = useOffice((s) => s.agents)
  const [limit, setLimit] = useState(PANEL_STEP)
  // server pages fetched for this tab, and whether there are more
  const [paging, setPaging] = useState({ page: 0, more: true, loading: false })
  const pagingRef = useRef(paging)
  pagingRef.current = paging
  useEffect(() => {
    setLimit(PANEL_STEP)
    setPaging({ page: 0, more: true, loading: false })
  }, [filter])
  const managerIds = useMemo(() => new Set(agents.filter((a) => a.kind === 'manager').map((a) => a.id)), [agents])
  // the live list is the newest of them all, so under any tab it's the start of the server's list too: the server's
  // pages are fetched from where it ends (not from the first, which it already holds)
  const liveUnderTab = useMemo(() => reports.filter((r) => inFilter(r, filter, managerIds)).length, [reports, filter, managerIds])
  const all = useMemo(() => {
    const ids = new Set(reports.map((r) => r.id))
    // an older one newer than the oldest live one but not among them was deleted since
    const oldestLive = reports.reduce((m, r) => Math.min(m, r.finishedAt), Infinity)
    const extra = Object.values(older).filter((r) => !ids.has(r.id) && r.finishedAt < oldestLive)
    // a step of the manager's task is left to the manager's summary (shown inside that job's item)
    return [...reports, ...extra].filter((r) => (!r.viaManager || r.job) && inFilter(r, filter, managerIds)).sort((a, b) => b.finishedAt - a.finishedAt)
  }, [reports, older, managerIds, filter])
  const fetchPage = async () => {
    const p = pagingRef.current
    if (!live || p.loading || !p.more) return
    setPaging({ ...p, loading: true })
    try {
      const page = p.page ? p.page + 1 : Math.floor(liveUnderTab / PANEL_PAGE) + 1
      const res = await api(`/api/reports?${new URLSearchParams({ filter: filter === 'daily' ? 'cron' : filter, per: String(PANEL_PAGE), page: String(page) })}`)
      if (!res.ok) throw new Error()
      const d = (await res.json()) as ReportPage
      useDashboard.getState().keepOlderReports(d.items)
      setPaging({ page: d.page, more: d.page < d.pages, loading: false })
      setLimit((n) => n + PANEL_STEP)
    } catch {
      // try again on the next scroll
      setPaging({ ...p, loading: false })
    }
  }
  const more = () => {
    if (limit < all.length) setLimit((n) => n + PANEL_STEP)
    else void fetchPage()
  }
  // a short list that doesn't fill the panel yet: fetch until it does (or there's no more)
  const exhausted = !live || !paging.more
  return { items: all.slice(0, limit), more, loading: paging.loading, page: paging.page, end: limit >= all.length && exhausted, total: all.length }
}

export function ReportsPanel() {
  const ready = useWorkReady()
  const reports = useDashboard((s) => s.reports)
  const now = useNow(60_000).getTime()
  const [view, setView] = useState<PanelView>(() => remembered(VIEW_KEY, ['reports', 'notes'] as const, 'reports'))
  const pickView = (v: PanelView) => (setView(v), remember(VIEW_KEY, v))
  // which kind of report: one tab each (remembered)
  const [tab, setTab] = useState<Filter>(() => remembered(PANEL_TAB_KEY, FILTERS.map((f) => f.id), 'all'))
  const pickTab = (f: Filter) => (setTab(f), remember(PANEL_TAB_KEY, f))
  const unread = reports.filter((r) => (!r.viaManager || r.job) && !r.read).length
  const feed = useReportFeed(tab)
  // a Read / Unread / Delete on picked reports, running: its rows show it here too (and deleted ones stay out)
  const bulk = useReportBulk((st) => st.run)
  const gone = useReportBulk((st) => st.gone)
  const items = groupReports(feed.items.filter((r) => !gone.has(r.id)))
  // the list's end: in view (or nearly) → the next ones
  const listRef = useRef<HTMLUListElement>(null)
  const endRef = useRef<HTMLLIElement>(null)
  const moreRef = useRef(feed.more)
  moreRef.current = feed.more
  useEffect(() => {
    const end = endRef.current
    if (!end || view !== 'reports') return
    // the box that scrolls: the list itself on a computer, the sheet on a phone
    let root: HTMLElement | null = listRef.current
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && moreRef.current(), { root, rootMargin: '0px 0px 320px 0px' })
    io.observe(end)
    return () => io.disconnect()
    // watched again after each step, so a list still short of the bottom keeps loading
  }, [view, tab, feed.end, feed.items.length, feed.page])
  return (
    <section className="card card--reports">
      <header className="card__head">
        <div className="card__titletabs" role="tablist" aria-label="Reports or notes">
          <button role="tab" aria-selected={view === 'reports'} className={view === 'reports' ? 'is-on' : ''} onClick={() => pickView('reports')}>
            <LuFileText /> <span className="card__titletabs-label">Reports</span>
            {unread > 0 && <span className="badge badge--accent reports-tabs__count">{unread}</span>}
          </button>
          <span className="card__titletabs-sep" aria-hidden>
            |
          </span>
          <button role="tab" aria-selected={view === 'notes'} className={view === 'notes' ? 'is-on' : ''} onClick={() => pickView('notes')}>
            <LuNotebookPen /> <span className="card__titletabs-label">Notes</span>
          </button>
        </div>
        <span className="grow" />
        <span className="card__actions">
          {view === 'notes' && (
            <button className="icon-btn small" onClick={() => openUrl({ note: 'new' })} aria-label="New note" data-tip="New note">
              <LuPlus />
            </button>
          )}
          <button className="small" onClick={() => (view === 'notes' ? openUrl({ notes: '1' }) : openUrl({ reports: tab === 'all' ? 'all' : tab, page: null, q: null }))}>
            View all
          </button>
        </span>
      </header>
      {view === 'notes' ? (
        <NotesList />
      ) : (
        <>
          <div className="reports-panel__tabs">
            <ScrollTabs className="reports-panel__tabrow" label="Kinds of reports" active={tab}>
              {FILTERS.map((f) => (
                <button key={f.id} role="tab" aria-selected={tab === f.id} className={tab === f.id ? 'active' : ''} onClick={() => pickTab(f.id)}>
                  {f.label}
                  {f.id === 'unread' && unread > 0 && <span className="reports-panel__tabcount">{unread}</span>}
                </button>
              ))}
            </ScrollTabs>
          </div>
          <ul ref={listRef} key={tab} className="list reports-panel__list ui-switch">
            {withDays(
              items,
              (g) => g.reports[0].finishedAt,
              now,
              (g) =>
                g.reports.length > 1 ? (
                  <JobRow key={g.key} g={g} now={now} busy={g.reports.every((r) => bulkStateOf(bulk, r.id)) ? bulkStateOf(bulk, g.reports[0].id) : undefined} />
                ) : (
                  <ReportRow key={g.key} r={g.reports[0]} now={now} onOpen={() => openUrl({ report: g.reports[0].id })} busy={bulkStateOf(bulk, g.reports[0].id)} />
                ),
              (g) => g.key,
            )}
            {/* the end of the list: coming into view loads the next ones (a few rows that look like rows meanwhile) */}
            {!feed.end && (
              <li ref={endRef} className="reports-panel__more" aria-busy={feed.loading || undefined}>
                {[0, 1].map((i) => (
                  <span key={i} className="reports-panel__skeleton" aria-hidden>
                    <span />
                    <span />
                  </span>
                ))}
              </li>
            )}
            {feed.end && feed.total > PANEL_STEP && <li className="reports-panel__end muted">That's all.</li>}
            {!feed.total && ready && feed.end && (
              <li className="empty">{tab === 'all' ? "Finished work shows up here: the manager's summaries, your own tasks and daily jobs." : 'Nothing here.'}</li>
            )}
          </ul>
        </>
      )}
    </section>
  )
}

type Filter = 'all' | 'unread' | 'manager' | 'agents' | 'task' | 'daily' | 'failed'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'manager', label: 'Manager' },
  { id: 'agents', label: 'Agents' },
  { id: 'unread', label: 'Unread' },
  { id: 'task', label: 'Tasks' },
  { id: 'daily', label: 'Daily' },
  { id: 'failed', label: 'Failed' },
]

const RANGE_PRESETS = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
]
const PER_PAGE = [10, 25, 50, 75, 100]
const DAY = 86_400_000
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayStart = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}
function rangeDays(r: PickedRange): [string, string] | null {
  const back = (n: number) => ymdOf(new Date(Date.now() - n * DAY))
  if (r.preset === 'today') return [back(0), back(0)]
  if (r.preset === '7d') return [back(6), back(0)]
  if (r.preset === '30d') return [back(29), back(0)]
  if (r.preset === 'custom' && r.from && r.to) return r.from <= r.to ? [r.from, r.to] : [r.to, r.from]
  return null
}
const isDay = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)

interface ReportPage {
  items: WorkReport[]
  total: number
  page: number
  pages: number
  per: number
}

/**
 * "View all": every stored report (the server keeps the last 1000), by filter, date range and search, a page at a
 * time. Everything is in the URL (?reports=manager&range=7d&q=…&page=2&per=50), so a view can be opened from a link.
 */
export function ReportsModal({ onClose, onMinimize }: { onClose: () => void; onMinimize?: () => void }) {
  const markAllReportsRead = useDashboard((s) => s.markAllReportsRead)
  // full size (remembered); its chip goes once it's open again
  const max = useModalMaximize(1180, 'after-office:reports-full')
  useEffect(() => useMinimized.getState().remove(REPORTS), [])
  // reports picked for one action on all of them (read, unread, delete)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reload, setReload] = useState(0)
  // an action on picked ones, running (state/reportBulk.ts): it goes on (and shows) with this window closed too
  const bulk = useReportBulk((st) => st.run)
  const gone = useReportBulk((st) => st.gone)
  const bulkDone = useReportBulk((st) => st.finishedAt)
  const anyUnread = useDashboard((s) => s.reports.some((r) => !r.read))
  // the newest report the dashboard knows: a new one arriving (or one changing) refreshes the page
  // refetch when a report arrives, is read, or is (un)tagged
  const latestKey = useDashboard((s) => s.reports.map((r) => `${r.id}${r.read ? 1 : 0}${r.tags?.join('+') ?? ''}`).join(','))
  const now = useNow(60_000).getTime()
  const params = useUrl((s) => s.params)
  const filter = (FILTERS.find((f) => f.id === params.reports)?.id ?? 'all') as Filter
  const q = params.q ?? ''
  const range: PickedRange = isDay(params.from) && isDay(params.to) ? { preset: 'custom', from: params.from!, to: params.to! } : { preset: RANGE_PRESETS.find((p) => p.id === params.range)?.id ?? 'all', from: '', to: '' }
  const per = PER_PAGE.includes(Number(params.per)) ? Number(params.per) : 25
  // one folder's reports (?folder=<path>, from a folder's details → Reports → View all)
  const folder = params.folder ?? ''
  // tags: ids, comma-separated in the address bar (?tag=a,b): a report with any of them
  const tagIds = (params.tag ?? '').split(',').filter(Boolean)
  // one agent's reports (?by=<id>), or those of agents removed since ("removed"); not on the manager's tab
  const agents = useOffice((s) => s.agents)
  const by = filter === 'manager' ? '' : (params.by ?? '')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const page = Math.max(1, Number(params.page) || 1)

  const [search, setSearch] = useState(q)
  useEffect(() => setSearch(q), [q])
  // typing: the URL (and the list) follow a moment later
  useEffect(() => {
    if (search === q) return
    const t = setTimeout(() => setUrl({ q: search.trim() || null, page: null }), 300)
    return () => clearTimeout(t)
  }, [search, q])

  const [data, setData] = useState<ReportPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const days = rangeDays(range)
  // shown on the folded filters button (phones): agent, folder, tags, dates
  // what the fold button hides: agent, folder and tags on larger screens; the dates too on phones
  const pickedFilters = [!!by, !!folder, tagIds.length > 0].filter(Boolean).length
  const activeFilters = pickedFilters + (days ? 1 : 0)
  const query = new URLSearchParams({
    // daily jobs are "cron" reports on the server
    filter: filter === 'daily' ? 'cron' : filter,
    per: String(per),
    page: String(page),
    ...(q ? { q } : {}),
    ...(folder ? { folder } : {}),
    ...(by ? { by } : {}),
    ...(tagIds.length ? { tag: tagIds.join(',') } : {}),
    ...(days ? { from: String(dayStart(days[0])), to: String(dayStart(days[1]) + DAY - 1) } : {}),
  }).toString()
  useEffect(() => {
    // the page holds still while an action on it runs (its rows show the progress); it reloads once that's done
    if (useReportBulk.getState().run) return
    let gone = false
    api(`/api/reports?${query}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not load reports (${r.status})`)
        return r.json() as Promise<ReportPage>
      })
      .then((d) => {
        if (gone) return
        setData(d)
        setError(null)
        // past the last page (e.g. after narrowing the search): show the last one
        if (d.page !== page && page !== 1) setUrl({ page: d.page === 1 ? null : d.page })
      })
      .catch((e: Error) => !gone && setError(e.message))
    return () => void (gone = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, latestKey, reload, bulkDone])
  // another page or filter: nothing picked any more
  useEffect(() => setSelected(new Set()), [query])

  // a computer: an inbox, the list on the left and the report picked (?ri=<id>) on the right; phones open it on top
  const wide = !useMediaQuery(MOBILE)
  const picked = params.ri ?? ''
  const pickedReport = useDashboard((s) => s.reports.find((r) => r.id === picked)) ?? data?.items.find((r) => r.id === picked)
  const pick = (id: string) => (wide ? setUrl({ ri: id }) : openUrl({ report: id }))
  const rowBusy = (id: string): RowBusy | undefined => bulkStateOf(bulk, id)
  const runBulk = (kind: ReportBulk['kind']) => {
    const ids = [...selected]
    if (!ids.length || bulk) return
    setSelected(new Set())
    if (kind === 'delete' && ids.includes(picked)) setUrl({ ri: null })
    void runReportBulk(kind, ids)
  }
  const first = data && data.total ? (data.page - 1) * data.per + 1 : 0
  const last = data ? Math.min(data.total, data.page * data.per) : 0
  return (
    <Modal
      open
      onClose={onClose}
      title="Reports"
      description="The manager's summaries, and what each agent reported when it finished a task or a daily run."
      {...max.modalProps}
      width={max.full ? max.modalProps.width : wide ? 1180 : 720}
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
      <div className={`modal__body reports-modal${wide ? ' reports-modal--inbox' : ''}`} ref={max.bodyRef}>
        <div className="reports-modal__side">
        <div className="reports-modal__bar reports-modal__bar--tabs">
          <div className="seg reports-modal__filter-tabs" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setUrl({ reports: f.id, page: null })}>
                {f.label}
              </button>
            ))}
          </div>
          <span className="grow" />
          {/* phones: just its icon beside the tabs (the filters row folds away there) */}
          <button className="small reports-modal__mark reports-modal__mark--tabs" onClick={markAllReportsRead} disabled={!anyUnread} aria-label="Mark all read" data-tip="Mark all read">
            <LuCheckCheck /> <span className="reports-modal__mark-label">Mark all read</span>
          </button>
        </div>
        <div className={`reports-modal__bar reports-modal__bar--filters${filtersOpen ? '' : ' is-folded'}`}>
          <label className="search-box grow">
            <LuSearch />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title, text or agent" aria-label="Search reports" maxLength={200} />
            {search && (
              <button className="icon-btn small ghost" onClick={() => setSearch('')} aria-label="Clear search" data-tip="Clear">
                <LuX />
              </button>
            )}
            {/* agent and tags fold away behind this (phones: the dates and reset too) */}
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
              {!filtersOpen && pickedFilters > 0 && <span className="toolbar__fold-count toolbar__fold-count--wide">{pickedFilters}</span>}
              {!filtersOpen && activeFilters > 0 && <span className="toolbar__fold-count toolbar__fold-count--narrow">{activeFilters}</span>}
            </button>
          </label>
          <div className="reports-modal__filters">
          <div className={`reports-modal__picks${filtersOpen ? '' : ' is-folded'}`}>
          {filter !== 'manager' && (
            <Select
              ariaLabel="Agent"
              searchable
              className="reports-modal__agent"
              value={by}
              options={[
                { value: '', label: 'All agents' },
                // on the Agents tab the manager has its own tab: not listed here
                ...agents.filter((a) => filter !== 'agents' || a.kind !== 'manager').map((a) => ({ value: a.id, label: a.name })),
                { value: 'removed', label: 'Removed agents' },
              ]}
              onChange={(v) => setUrl({ by: v || null, page: null })}
            />
          )}
          {folder && (
            <span className="chat-ctx__project reports-modal__folder" data-tip={folder}>
              <span className="chat-ctx__pick">
                <LuFolder /> <span className="truncate">{folder.split('/').filter(Boolean).pop()}</span>
              </span>
              <button type="button" className="chat-ctx__unpick" aria-label="Any folder" onClick={() => setUrl({ folder: null, page: null })}>
                <LuX />
              </button>
            </span>
          )}
          <TagFilter className="reports-modal__tags" value={tagIds} onChange={(ids) => setUrl({ tag: ids.join(',') || null, page: null })} />
          </div>
          <RangePicker
            value={range}
            presets={RANGE_PRESETS}
            bounds={rangeDays}
            onChange={(r) =>
              setUrl(
                r.preset === 'custom'
                  ? { range: null, from: r.from, to: r.to, page: null }
                  : { range: r.preset === 'all' ? null : r.preset, from: null, to: null, page: null },
              )
            }
          />
          {/* back to everything: all reports, any folder, all time, no search (per-page stays) */}
          <button
            className="icon-btn reports-modal__reset"
            disabled={filter === 'all' && !q && !by && !folder && !tagIds.length && !days && page === 1}
            onClick={() => {
              setSearch('')
              setUrl({ reports: 'all', q: null, by: null, folder: null, tag: null, range: null, from: null, to: null, page: null })
            }}
            data-tip="Reset filters"
            aria-label="Reset filters"
          >
            <LuRotateCcw />
          </button>
          {/* larger screens: on the right of the dates / reset row */}
          <button className="small reports-modal__mark reports-modal__mark--filters" onClick={markAllReportsRead} disabled={!anyUnread}>
            <LuCheckCheck /> Mark all read
          </button>
          </div>
        </div>
        {error && <div className="row__error">{error}</div>}
        {data && data.items.length > 0 && (
          <BulkBar
            items={data.items}
            selected={selected}
            onSelect={setSelected}
            bulk={bulk}
            onRead={(read) => void runBulk(read ? 'read' : 'unread')}
            onDelete={async () => {
              const n = selected.size
              if (!(await confirm({ title: `Delete ${n} report${n === 1 ? '' : 's'}?`, message: "They're removed from Reports. This can't be undone.", confirmLabel: 'Delete' }))) return
              void runBulk('delete')
            }}
          />
        )}
        <ul key={query} className={`list reports-modal__list ui-stagger${selected.size ? ' is-picking' : ''}`}>
          {/* one item per piece of work (a job's or a task's reports, on this page), opening into its steps */}
          {withDays(
            groupReports((data?.items ?? []).filter((r) => !gone.has(r.id))),
            (g) => g.reports[0].finishedAt,
            now,
            (g) => {
              const checkOne = (ids: string[], on: boolean) =>
                setSelected((cur) => {
                  const next = new Set(cur)
                  for (const id of ids) if (on) next.add(id)
                  else next.delete(id)
                  return next
                })
              const row = (r: WorkReport, inJob = false) => (
                <ReportRow
                  key={r.id}
                  r={r}
                  now={now}
                  showJob={!inJob}
                  picked={wide && r.id === picked}
                  onOpen={() => pick(r.id)}
                  checked={selected.has(r.id)}
                  onCheck={(on) => checkOne([r.id], on)}
                  busy={rowBusy(r.id)}
                />
              )
              if (g.reports.length === 1) return row(g.reports[0])
              const ids = g.reports.map((r) => r.id)
              const jobBusy = ids.every((id) => rowBusy(id)) ? rowBusy(ids[0]) : undefined
              const n = ids.filter((id) => selected.has(id)).length
              return (
                <JobRow
                  key={g.key}
                  g={g}
                  now={now}
                  step={(r) => row(r, true)}
                  holds={wide && ids.includes(picked)}
                  checked={n === 0 ? 'none' : n === ids.length ? 'all' : 'some'}
                  onCheck={(on) => checkOne(ids, on)}
                  busy={jobBusy}
                />
              )
            },
            (g) => g.key,
          )}
          {data && !data.items.length && <li className="empty">{q || days || folder || filter !== 'all' ? 'No reports match.' : 'Nothing here.'}</li>}
          {!data && !error && <li className="empty">Loading…</li>}
        </ul>
        <footer className="pager">
          <span className="muted pager__count">{data ? (data.total ? `${first}–${last} of ${data.total}` : '0 reports') : ''}</span>
          <span className="grow" />
          <span className="muted">Per page</span>
          <Select
            ariaLabel="Reports per page"
            size="sm"
            value={String(per)}
            options={PER_PAGE.map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => setUrl({ per: v === '25' ? null : v, page: null })}
          />
          <button className="icon-btn small" disabled={!data || data.page <= 1} onClick={() => setUrl({ page: data!.page - 1 === 1 ? null : data!.page - 1 })} aria-label="Previous page" data-tip="Previous page">
            <LuChevronLeft />
          </button>
          <span className="pager__page">
            {data?.page ?? page} / {data?.pages ?? 1}
          </span>
          <button className="icon-btn small" disabled={!data || data.page >= data.pages} onClick={() => setUrl({ page: data!.page + 1 })} aria-label="Next page" data-tip="Next page">
            <LuChevronRight />
          </button>
        </footer>
        </div>
        {wide && (
          <section key={pickedReport?.id ?? 'none'} className="reports-modal__reader report ui-switch" aria-label="Report">
            {pickedReport ? (
              <ReportView key={pickedReport.id} r={pickedReport} title onClose={() => setUrl({ ri: null })} />
            ) : (
              <p className="empty reports-modal__none">
                <LuFileText /> Pick a report to read it here.
              </p>
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}

/** View all: pick reports on this page, then one action on all of them. */
function BulkBar({
  items,
  selected,
  onSelect,
  onRead,
  onDelete,
  bulk,
}: {
  items: WorkReport[]
  selected: Set<string>
  onSelect: (s: Set<string>) => void
  onRead: (read: boolean) => void
  onDelete: () => void
  bulk: ReportBulk | null
}) {
  const all = items.length > 0 && items.every((r) => selected.has(r.id))
  const some = selected.size > 0
  // running: what it's doing and how far, in place of the actions
  if (bulk) {
    const total = bulk.ids.length
    const pct = Math.round((bulk.done / total) * 100)
    const verb = bulk.kind === 'delete' ? (bulk.removing ? 'Deleted' : 'Deleting') : bulk.kind === 'read' ? 'Marking read' : 'Marking unread'
    return (
      <div className={`reports-bulk is-on is-running reports-bulk--${bulk.kind}`} role="status" aria-live="polite">
        <LuLoader className="row-busy__spin" />
        <span className="reports-bulk__progress-text">
          {verb} {total} report{total === 1 ? '' : 's'}
          {!bulk.removing && '…'}
          <span className="muted">
            {bulk.done}/{total}
          </span>
        </span>
        <span className="reports-bulk__bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </span>
      </div>
    )
  }
  return (
    <div className={`reports-bulk${some ? ' is-on' : ''}`}>
      <label className="reports-bulk__all">
        <input
          type="checkbox"
          checked={all}
          ref={(el) => {
            if (el) el.indeterminate = some && !all
          }}
          onChange={() => onSelect(all ? new Set() : new Set(items.map((r) => r.id)))}
          aria-label="Pick every report on this page"
        />
        {some ? `${selected.size} picked` : 'Pick all'}
      </label>
      {some && (
        <span className="reports-bulk__actions ui-pop">
          <button className="small" onClick={() => onRead(true)}>
            <LuCheckCheck /> Read
          </button>
          <button className="small" onClick={() => onRead(false)}>
            <LuMail /> Unread
          </button>
          <button className="small danger-text" onClick={onDelete}>
            <LuTrash2 /> Delete
          </button>
          <button className="icon-btn small ghost" aria-label="Clear the selection" data-tip="Clear" onClick={() => onSelect(new Set())}>
            <LuX />
          </button>
        </span>
      )}
    </div>
  )
}

/** One report. Opening it marks it read. */
export function ReportModal({ id, onClose, onMinimize }: { id: string; onClose: () => void; onMinimize?: (title: string) => void }) {
  const r = useDashboard((s) => s.reports.find((x) => x.id === id) ?? s.olderReports[id])
  // full size for long reports and wide tables
  const max = useModalMaximize(640)
  // its chip goes once it's open again
  useEffect(() => useMinimized.getState().remove(`report:${id}`), [id])
  if (!r) return null
  return (
    <Modal
      open
      onClose={onClose}
      title={r.title}
      {...max.modalProps}
      // a click beside it puts it aside (a chip brings it back)
      onBackdrop={onMinimize ? () => onMinimize(r.title) : undefined}
      actions={
        <>
          {onMinimize && (
            <button className="icon-btn small ghost" data-tip="Minimize" aria-label="Minimize" onClick={() => onMinimize(r.title)}>
              <LuMinus />
            </button>
          )}
          {max.modalProps.actions}
        </>
      }
    >
      <div className="modal__body report" ref={max.bodyRef}>
        <ReportView r={r} onClose={onClose} />
      </div>
    </Modal>
  )
}

/** A report in full: who and when, its tags, its words and files, and what to do with it. Seeing it marks it read. */
function ReportView({ r, onClose, title }: { r: WorkReport; onClose: () => void; title?: boolean }) {
  const { markReport, removeReport, setReportTags } = useDashboard(
    useShallow((s) => ({ markReport: s.markReport, removeReport: s.removeReport, setReportTags: s.setReportTags })),
  )
  const taskExists = useDashboard((s) => r.kind === 'task' && s.tasks.some((t) => t.id === r.refId))
  const agent = useOffice((s) => s.agents.find((a) => a.id === r.agentId))
  // attachments through the report itself: still there after its agent was removed, "gone" once deleted
  const files = useReportFiles(r.id, r.files)

  useEffect(() => {
    if (!r.read) markReport(r.id, true)
    // only when it's shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.id])

  return (
    <>
      {title && (
        <h3 className="report__title">
          {r.title} <OutcomeBadge state={outcomeOf(r)} />
        </h3>
      )}
      <div className="report__meta">
        <span className={`status-pill${r.ok ? '' : ' status-pill--bad'}`}>{r.ok ? (r.kind === 'cron' ? 'Daily run' : r.kind === 'note' ? 'From the manager' : r.kind === 'chat' ? 'From the chat' : 'Task') : 'Failed'}</span>
        <span>{agent?.name ?? 'Removed agent'}</span>
        <span>·</span>
        <span>{new Date(r.finishedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <span>·</span>
        <span>took {duration(r.finishedAt - r.startedAt)}</span>
        {r.job && (
          <span className="report-row__job">
            <LuLayers /> {r.job.title}
          </span>
        )}
      </div>
      <div className="report__tags">
        <TagPicker size="sm" value={r.tags ?? []} onChange={(tags) => setReportTags(r.id, tags)} />
      </div>
      <div className="report__text">
        <FileLinksProvider agentId={r.agentId} files={files} urlFor={reportUrl(r.id)}>
          <Markdown text={r.text} />
        </FileLinksProvider>
      </div>
      <Attachments agentId={r.agentId} files={files} urlFor={reportUrl(r.id)} />
      <footer className="modal__foot">
        <button
          className="ghost"
          onClick={async () => {
            if (!(await confirm({ title: 'Delete this report?', message: <>“{r.title}” is removed from Reports. This can't be undone.</> }))) return
            removeReport(r.id)
            onClose()
          }}
        >
          <LuTrash2 /> Delete
        </button>
        <span className="grow" />
        <button className="small" onClick={() => (markReport(r.id, false), onClose())}>
          Mark unread
        </button>
        {taskExists && (
          <button onClick={() => openUrl({ task: r.refId })}>
            <LuListTodo /> Open task
          </button>
        )}
        {agent && (
          <button
            // the chat opens over this window (both stay: closing the chat comes back here)
            onClick={() => openUrl({ agent: agent.id })}
          >
            <LuMessageSquareText /> Open chat
          </button>
        )}
      </footer>
    </>
  )
}

/** Reports of one task, newest first (task detail). */
export function TaskReports({ taskId }: { taskId: string }) {
  const all = useDashboard((s) => s.reports)
  const reports = useMemo(() => all.filter((r) => r.kind === 'task' && r.refId === taskId), [all, taskId])
  const markReport = useDashboard((s) => s.markReport)
  const [older, setOlder] = useState(false)
  const latest = reports[0]
  useEffect(() => {
    if (latest && !latest.read) markReport(latest.id, true)
  }, [latest, markReport])
  if (!latest) return null
  return (
    <div className="field">
      <span className="field__label">
        Report{' '}
        <span className="muted">
          · {new Date(latest.finishedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · took {duration(latest.finishedAt - latest.startedAt)}
        </span>
      </span>
      <div className={`report__text report__text--inline${latest.ok ? '' : ' report__text--bad'}`}>
        <ReportBody r={latest} />
      </div>
      {reports.length > 1 && (
        <>
          <button type="button" className="link" onClick={() => setOlder((v) => !v)}>
            {older ? 'Hide' : 'Show'} {reports.length - 1} earlier run{reports.length > 2 ? 's' : ''}
          </button>
          {older &&
            reports.slice(1).map((r) => (
              <div key={r.id} className="report__text report__text--inline report__text--old ui-drop">
                <span className="muted">{new Date(r.finishedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <ReportBody r={r} />
              </div>
            ))}
        </>
      )}
    </div>
  )
}

/** A report's text and attachments, files opened through the report itself (so they outlive its agent). */
function ReportBody({ r }: { r: WorkReport }) {
  const files = useReportFiles(r.id, r.files)
  return (
    <>
      <FileLinksProvider agentId={r.agentId} files={files} urlFor={reportUrl(r.id)}>
        <Markdown text={r.text} />
      </FileLinksProvider>
      <Attachments agentId={r.agentId} files={files} urlFor={reportUrl(r.id)} />
    </>
  )
}

/**
 * A folder's reports (Folders tab → a folder's details): the manager's latest summary about it on top, then what the
 * agents reported on the work in it (or in folders inside it). Read from the server, so older ones are there too.
 */
export function FolderReports({ folder }: { folder: string }) {
  const now = useNow(60_000).getTime()
  const latestKey = useDashboard((s) => s.reports.map((r) => `${r.id}${r.read ? 1 : 0}`).join(','))
  const [items, setItems] = useState<WorkReport[] | null>(null)
  const [total, setTotal] = useState(0)
  useEffect(() => {
    let gone = false
    api(`/api/reports?${new URLSearchParams({ folder, per: '10' })}`)
      .then((r) => (r.ok ? (r.json() as Promise<ReportPage>) : null))
      .then((d) => {
        if (gone || !d) return
        setItems(d.items)
        setTotal(d.total)
      })
      .catch(() => {})
    return () => void (gone = true)
  }, [folder, latestKey])
  if (!items) return <span className="muted">Loading…</span>
  if (!items.length) return <span className="muted">No reports yet. The manager's summaries and the agents' reports on work in this folder show up here.</span>
  const summary = items.find((r) => r.kind === 'note')
  const rest = items.filter((r) => r !== summary)
  return (
    <div className="project-reports">
      {summary && (
        <div className="project-reports__summary">
          <span className="field__hint">Latest summary from the manager</span>
          <ul className="list">
            <ReportRow r={summary} now={now} onOpen={() => openUrl({ report: summary.id })} />
          </ul>
        </div>
      )}
      {rest.length > 0 && (
        <ul className="list">
          {rest.map((r) => (
            <ReportRow key={r.id} r={r} now={now} onOpen={() => openUrl({ report: r.id })} />
          ))}
        </ul>
      )}
      {total > items.length && (
        <button type="button" className="link" onClick={() => openUrl({ reports: 'all', folder, page: null, q: null })}>
          View all {total} reports
        </button>
      )}
    </div>
  )
}
