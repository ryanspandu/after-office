import { create } from 'zustand'
import { api } from './auth'
import { beginBusy } from './busy'
import { useDashboard } from './dashboard'

// Reports → pick several → Read / Unread / Delete, as a job of the app rather than of the Reports window: it keeps
// going (and showing: the rows, the bar, the pill) when the window is closed, and after a reload it picks up where it
// stopped (the ids still to do are kept in the browser until it's done).

export interface ReportBulk {
  kind: 'read' | 'unread' | 'delete'
  /** every report it's about */
  ids: string[]
  /** how many are done (the first `done` of ids) */
  done: number
  /** deleted, the rows folding away for a moment before the list reloads without them */
  removing: boolean
}

interface State {
  run: ReportBulk | null
  /** deleted by one: never drawn again in a list, even if a refresh races the reload */
  gone: Set<string>
  /** when the last one finished: lists reload then */
  finishedAt: number
}

export const useReportBulk = create<State>(() => ({ run: null, gone: new Set(), finishedAt: 0 }))

const KEY = 'after-office:report-bulk'
const save = (run: ReportBulk | null) => {
  try {
    if (run) localStorage.setItem(KEY, JSON.stringify({ kind: run.kind, ids: run.ids, done: run.done }))
    else localStorage.removeItem(KEY)
  } catch {
    // private mode: it can't pick up after a reload, that's all
  }
}

/** What a report row is going through, if a run is about it. */
export function bulkStateOf(run: ReportBulk | null, id: string): 'deleting' | 'updating' | 'removing' | undefined {
  if (!run || !run.ids.includes(id)) return undefined
  if (run.removing) return 'removing'
  return run.kind === 'delete' ? 'deleting' : 'updating'
}

/** Start one (or, from a reload, carry on with one at `done`). Only one at a time. */
export async function runReportBulk(kind: ReportBulk['kind'], ids: string[], doneBefore = 0) {
  if (!ids.length || useReportBulk.getState().run) return
  const n = ids.length
  const what = `${n} report${n === 1 ? '' : 's'}`
  const busy = beginBusy(kind === 'delete' ? 'delete' : 'save', what, n)
  busy.progress(doneBefore)
  let run: ReportBulk = { kind, ids, done: doneBefore, removing: false }
  useReportBulk.setState({ run })
  save(run)
  // about ten steps, so the bar moves
  const size = Math.max(1, Math.ceil(n / 10))
  let failed = ''
  for (let i = doneBefore; i < n; i += size) {
    const chunk = ids.slice(i, i + size)
    const res = await api(
      kind === 'delete' ? '/api/reports/bulk/delete' : '/api/reports/bulk/read',
      { method: 'POST', body: JSON.stringify(kind === 'delete' ? { ids: chunk } : { ids: chunk, read: kind === 'read' }) },
      { activity: false },
    ).catch(() => null)
    if (!res?.ok) {
      failed = (await res?.json().catch(() => null))?.error ?? `Could not ${kind === 'delete' ? 'delete' : 'update'} ${run.done ? 'all of them' : 'them'}${res ? ` (${res.status})` : ': the server is unreachable'}`
      break
    }
    run = { ...run, done: run.done + chunk.length }
    busy.progress(run.done)
    useReportBulk.setState({ run })
    save(run)
  }
  // the dashboard's own copy too (the server's update also comes over the live feed)
  const finished = new Set(ids.slice(0, run.done))
  useDashboard.setState((s) => {
    const older = Object.values(s.olderReports)
    return kind === 'delete'
      ? { reports: s.reports.filter((r) => !finished.has(r.id)), olderReports: Object.fromEntries(older.filter((r) => !finished.has(r.id)).map((r) => [r.id, r])) }
      : {
          reports: s.reports.map((r) => (finished.has(r.id) ? { ...r, read: kind === 'read' } : r)),
          olderReports: Object.fromEntries(older.map((r) => [r.id, finished.has(r.id) ? { ...r, read: kind === 'read' } : r])),
        }
  })
  if (kind === 'delete' && finished.size) {
    // fold the deleted rows away, then they're gone for good
    useReportBulk.setState({ run: { ...run, ids: [...finished], removing: true } })
    await new Promise((r) => setTimeout(r, 260))
    useReportBulk.setState((s) => ({ gone: new Set([...s.gone, ...finished]) }))
  }
  save(null)
  busy.end(failed || undefined)
  if (failed) useDashboard.setState({ syncError: failed })
  useReportBulk.setState({ run: null, finishedAt: Date.now() })
}

/** After a reload (signed in, live): the one that was running carries on. */
export function resumeReportBulk() {
  if (useReportBulk.getState().run) return
  let saved: { kind?: ReportBulk['kind']; ids?: unknown; done?: number } | null = null
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {
    saved = null
  }
  const ids = Array.isArray(saved?.ids) ? (saved!.ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
  if (!saved?.kind || !['read', 'unread', 'delete'].includes(saved.kind) || !ids.length) return save(null)
  void runReportBulk(saved.kind, ids, Math.min(Math.max(0, Number(saved.done) || 0), ids.length))
}
