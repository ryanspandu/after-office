import { create } from 'zustand'
import type { ReportJob } from '@after-office/shared'
import { api } from './auth'
import { beginBusy } from './busy'
import { useDashboard } from './dashboard'

// Reports → pick several → Read / Unread / Delete. The server runs it (work/reportJobs.ts) and says how far it is
// over the live feed (WorkState.reportJob), so every device shows it: the rows, the bar, the pill; with the Reports
// window closed and after a reload too.

export type ReportBulk = ReportJob

interface State {
  run: ReportBulk | null
  /** deleted by one: never drawn again in a list, even if a refresh races the reload */
  gone: Set<string>
  /** when the last one finished: lists reload then */
  finishedAt: number
}

export const useReportBulk = create<State>(() => ({ run: null, gone: new Set(), finishedAt: 0 }))

/** What a report row is going through, if a run is about it. */
export function bulkStateOf(run: ReportBulk | null, id: string): 'deleting' | 'updating' | 'removing' | undefined {
  if (!run || !run.ids.includes(id)) return undefined
  if (run.removing) return 'removing'
  return run.kind === 'delete' ? 'deleting' : 'updating'
}

// the pill (ui/BusyPill.tsx) follows the server's job
let pill: { id: string; busy: ReturnType<typeof beginBusy> } | null = null

/** The server's word on it (state/live.ts applyWork): start, progress, end. */
export function applyReportJob(job: ReportJob | null) {
  const prev = useReportBulk.getState().run
  if (job) {
    if (pill?.id !== job.id) {
      pill?.busy.end()
      const n = job.ids.length
      pill = { id: job.id, busy: beginBusy(job.kind === 'delete' ? 'delete' : 'save', `${n} report${n === 1 ? '' : 's'}`, n) }
    }
    pill.busy.progress(job.done)
    // the ones done: out of (or updated in) the older reports loaded by scrolling, which the live list doesn't cover
    const done = new Set(job.ids.slice(0, job.done))
    if (done.size)
      useDashboard.setState((s) => {
        const older = Object.values(s.olderReports)
        if (!older.some((r) => done.has(r.id))) return {}
        return {
          olderReports: Object.fromEntries(
            job.kind === 'delete' ? older.filter((r) => !done.has(r.id)).map((r) => [r.id, r]) : older.map((r) => [r.id, done.has(r.id) ? { ...r, read: job.kind === 'read' } : r]),
          ),
        }
      })
    useReportBulk.setState((s) => ({ run: job, gone: job.removing ? new Set([...s.gone, ...job.ids]) : s.gone }))
  } else {
    pill?.busy.end()
    pill = null
    useReportBulk.setState({ run: null, ...(prev ? { finishedAt: Date.now() } : {}) })
  }
}

/** Ask the server to start one. Its rows show it right away; the server's updates take over. */
export async function runReportBulk(kind: ReportBulk['kind'], ids: string[]) {
  if (!ids.length || useReportBulk.getState().run) return
  const local: ReportBulk = { id: 'local', kind, ids, done: 0, removing: false, startedAt: Date.now() }
  useReportBulk.setState({ run: local })
  const res = await api('/api/reports/bulk', { method: 'POST', body: JSON.stringify({ kind, ids }) }, { activity: false }).catch(() => null)
  if (res?.ok) return
  // refused (another one running, the server unreachable): the rows go back to normal
  if (useReportBulk.getState().run?.id === 'local') useReportBulk.setState({ run: null })
  const why = (await res?.json().catch(() => null))?.error
  useDashboard.setState({ syncError: why ?? `Could not ${kind === 'delete' ? 'delete' : 'update'} the reports${res ? ` (${res.status})` : ': the server is unreachable'}` })
}
