import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { LuSlidersHorizontal, LuCheckCheck, LuChevronLeft, LuChevronRight, LuCircleAlert, LuClock, LuCrown, LuFileText, LuListTodo, LuMessageSquareText, LuRotateCcw, LuSearch, LuTrash2, LuX } from 'react-icons/lu'
import type { WorkReport } from '@after-office/shared'
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
import { openUrl, setUrl, useUrl } from '../state/url'
import { RangePicker, type PickedRange } from './DateRangePicker'
import { Select } from './Select'
import { TagChips, TagFilter, TagPicker } from './tags'

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

export function ReportRow({ r, now, onOpen }: { r: WorkReport; now: number; onOpen: () => void }) {
  const agent = useOffice((s) => s.agents.find((a) => a.id === r.agentId))
  const project = useDashboard((s) => (r.projectId ? s.projects.find((p) => p.id === r.projectId) : undefined))
  const firstLine = r.text.replace(/[#*`>_-]/g, '').split('\n').find((l) => l.trim()) ?? ''
  return (
    <li className={`report-row${r.read ? '' : ' report-row--unread'}`}>
      <button className="report-row__main" onClick={onOpen}>
        <KindIcon r={r} />
        <span className="report-row__body">
          <span className="report-row__title truncate">{r.title}</span>
          <span className="report-row__text truncate">{firstLine}</span>
          <span className="report-row__meta">
            {/* who: a small initial in the agent's colour, about the size of the text */}
            <span className="report-row__who" style={agent ? avatarStyle(agent.look.shirt) : undefined} aria-hidden>
              {(agent?.name ?? '?')[0]}
            </span>
            <span className="truncate">
              {agent?.name ?? 'Removed agent'} · {ago(now - r.finishedAt)}
            </span>
            {project && (
              <span className="report-row__project" data-tip={`Project “${project.name}”`}>
                <span className="chip__dot" style={{ background: project.color }} />
                <span className="truncate">{project.name}</span>
              </span>
            )}
            <TagChips ids={r.tags} />
          </span>
        </span>
        {!r.read && <span className="report-row__dot" aria-label="Unread" />}
      </button>
    </li>
  )
}

type PanelTab = 'manager' | 'agents'
const TAB_KEY = 'ao-reports-tab'
/**
 * Reports that belong under "Manager": the manager's own notes, and anything the manager itself ran (a cron job or
 * a task assigned to it). Everything else is an agent's.
 */
function useIsManagerReport() {
  const managerIds = useOffice(useShallow((s) => s.agents.filter((a) => a.kind === 'manager').map((a) => a.id)))
  return (r: WorkReport) => r.kind === 'note' || managerIds.includes(r.agentId)
}

export function ReportsPanel() {
  const ready = useWorkReady()
  const reports = useDashboard((s) => s.reports)
  const now = useNow(60_000).getTime()
  // the manager's summaries apart from the agents' own task and cron reports
  const [tab, setTab] = useState<PanelTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'agents' ? 'agents' : 'manager'
    } catch {
      return 'manager'
    }
  })
  const pick = (t: PanelTab) => {
    setTab(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      /* this visit only */
    }
  }
  const isManagerReport = useIsManagerReport()
  const fromManager = reports.filter(isManagerReport)
  const fromAgents = reports.filter((r) => !isManagerReport(r))
  const shown = tab === 'manager' ? fromManager : fromAgents
  const unreadOf = (list: WorkReport[]) => list.filter((r) => !r.read).length
  return (
    <section className="card card--reports">
      <header className="card__head">
        <h2>
          <LuFileText /> Reports
        </h2>
        <button className="small" onClick={() => openUrl({ reports: tab === 'manager' ? 'manager' : 'agents', page: null, q: null })}>
          View all
        </button>
      </header>
      <div className="seg task-tabs reports-tabs" role="tablist" aria-label="Reports from">
        {(
          [
            ['manager', <LuCrown key="i" />, 'Manager', fromManager],
            ['agents', <LuListTodo key="i" />, 'Agents', fromAgents],
          ] as const
        ).map(([id, icon, label, list]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => pick(id)}>
            {icon} {label}
            {unreadOf(list) > 0 && (
              <span className="badge badge--accent reports-tabs__count" {...tip(`${unreadOf(list)} unread`)}>
                {unreadOf(list)}
              </span>
            )}
          </button>
        ))}
      </div>
      <ul className="list">
        {shown.slice(0, 20).map((r) => (
          <ReportRow key={r.id} r={r} now={now} onOpen={() => openUrl({ report: r.id })} />
        ))}
        {!shown.length && ready && (
          <li className="empty">{tab === 'manager' ? "The manager's summaries of finished work show up here." : 'Finished tasks and daily runs show up here.'}</li>
        )}
      </ul>
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
export function ReportsModal({ onClose }: { onClose: () => void }) {
  const markAllReportsRead = useDashboard((s) => s.markAllReportsRead)
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
  const projects = useDashboard((s) => s.projects)
  const project = params.project ?? ''
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
  // shown on the folded filters button (phones): project, tags, dates
  const activeFilters = [!!by, !!project, tagIds.length > 0, !!days].filter(Boolean).length
  const query = new URLSearchParams({
    // daily jobs are "cron" reports on the server
    filter: filter === 'daily' ? 'cron' : filter,
    per: String(per),
    page: String(page),
    ...(q ? { q } : {}),
    ...(project ? { project } : {}),
    ...(by ? { by } : {}),
    ...(tagIds.length ? { tag: tagIds.join(',') } : {}),
    ...(days ? { from: String(dayStart(days[0])), to: String(dayStart(days[1]) + DAY - 1) } : {}),
  }).toString()
  useEffect(() => {
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
  }, [query, latestKey])

  const first = data && data.total ? (data.page - 1) * data.per + 1 : 0
  const last = data ? Math.min(data.total, data.page * data.per) : 0
  return (
    <Modal open onClose={onClose} title="Reports" description="The manager's summaries, and what each agent reported when it finished a task or a daily run." width={720}>
      <div className="modal__body reports-modal">
        <div className="reports-modal__bar reports-modal__bar--tabs">
          <div className="seg reports-modal__filter-tabs" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setUrl({ reports: f.id, page: null })}>
                {f.label}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button className="small reports-modal__mark" onClick={markAllReportsRead} disabled={!anyUnread} aria-label="Mark all read" data-tip="Mark all read">
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
            {/* phones: project, tags, dates and reset fold away behind this */}
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
          <div className="reports-modal__filters">
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
          <Select
            ariaLabel="Project"
            searchable
            className="reports-modal__project"
            value={project}
            options={[{ value: '', label: 'All projects' }, { value: 'none', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => setUrl({ project: v || null, page: null })}
          />
          <TagFilter className="reports-modal__tags" value={tagIds} onChange={(ids) => setUrl({ tag: ids.join(',') || null, page: null })} />
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
          {/* back to everything: all reports, any project, all time, no search (per-page stays) */}
          <button
            className="icon-btn reports-modal__reset"
            disabled={filter === 'all' && !q && !by && !project && !tagIds.length && !days && page === 1}
            onClick={() => {
              setSearch('')
              setUrl({ reports: 'all', q: null, by: null, project: null, tag: null, range: null, from: null, to: null, page: null })
            }}
            data-tip="Reset filters"
            aria-label="Reset filters"
          >
            <LuRotateCcw />
          </button>
          </div>
        </div>
        {error && <div className="row__error">{error}</div>}
        <ul className="list reports-modal__list">
          {(data?.items ?? []).map((r) => (
            <ReportRow key={r.id} r={r} now={now} onOpen={() => openUrl({ report: r.id })} />
          ))}
          {data && !data.items.length && <li className="empty">{q || days || project || filter !== 'all' ? 'No reports match.' : 'Nothing here.'}</li>}
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
    </Modal>
  )
}

/** One report. Opening it marks it read. */
export function ReportModal({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useDashboard((s) => s.reports.find((x) => x.id === id))
  const { markReport, removeReport, setReportTags } = useDashboard(useShallow((s) => ({ markReport: s.markReport, removeReport: s.removeReport, setReportTags: s.setReportTags })))
  const taskExists = useDashboard((s) => !!r && r.kind === 'task' && s.tasks.some((t) => t.id === r.refId))
  const agent = useOffice((s) => s.agents.find((a) => a.id === r?.agentId))
  // attachments through the report itself: still there after its agent was removed, "gone" once deleted
  const files = useReportFiles(id, r?.files)
  // full size for long reports and wide tables
  const max = useModalMaximize(640)
  const openProfile = useOffice((s) => s.openProfile)

  useEffect(() => {
    if (r && !r.read) markReport(r.id, true)
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (!r) return null
  return (
    <Modal open onClose={onClose} title={r.title} {...max.modalProps}>
      <div className="modal__body report" ref={max.bodyRef}>
        <div className="report__meta">
          <span className={`status-pill${r.ok ? '' : ' status-pill--bad'}`}>{r.ok ? (r.kind === 'cron' ? 'Daily run' : r.kind === 'note' ? 'From the manager' : r.kind === 'chat' ? 'From the chat' : 'Task') : 'Failed'}</span>
          <span>{agent?.name ?? 'Removed agent'}</span>
          <span>·</span>
          <span>{new Date(r.finishedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          <span>·</span>
          <span>took {duration(r.finishedAt - r.startedAt)}</span>
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
              onClick={() => {
                onClose()
                openProfile(agent.id)
              }}
            >
              <LuMessageSquareText /> Open chat
            </button>
          )}
        </footer>
      </div>
    </Modal>
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
              <div key={r.id} className="report__text report__text--inline report__text--old">
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
 * A project's reports (Projects tab → a project's folder): the manager's latest summary for it on top, then what
 * the agents reported on its tasks. Read from the server, so older ones than the dashboard holds are there too.
 */
export function ProjectReports({ projectId }: { projectId: string }) {
  const now = useNow(60_000).getTime()
  const latestKey = useDashboard((s) => s.reports.map((r) => `${r.id}${r.read ? 1 : 0}`).join(','))
  const [items, setItems] = useState<WorkReport[] | null>(null)
  const [total, setTotal] = useState(0)
  useEffect(() => {
    let gone = false
    api(`/api/reports?${new URLSearchParams({ project: projectId, per: '10' })}`)
      .then((r) => (r.ok ? (r.json() as Promise<ReportPage>) : null))
      .then((d) => {
        if (gone || !d) return
        setItems(d.items)
        setTotal(d.total)
      })
      .catch(() => {})
    return () => void (gone = true)
  }, [projectId, latestKey])
  if (!items) return <span className="muted">Loading…</span>
  if (!items.length) return <span className="muted">No reports yet. The manager's summaries and the agents' task reports for this project show up here.</span>
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
        <button type="button" className="link" onClick={() => openUrl({ reports: 'all', project: projectId, page: null, q: null })}>
          View all {total} reports
        </button>
      )}
    </div>
  )
}
