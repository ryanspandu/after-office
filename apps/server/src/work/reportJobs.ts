import type { ReportJob } from '@after-office/shared'
import { settingsRepo } from '../db'
import { AgentError } from '../agents/manager'
import { bulkIds, markReports, removeReports } from './reports'
import { publishWork } from './work'

// Reports → pick several → Read / Unread / Delete, run here rather than in one browser: every device (and the
// dashboard after a reload) sees it going (WorkState.reportJob), and a server restart picks it up where it stopped
// (it's kept in the settings table until it's done). One at a time.

const KEY = 'reportJob'
/** a short pause between steps, so its progress can be seen and followed on every screen */
const STEP_MS = 60
/** how long deleted rows fold away before it ends */
const REMOVING_MS = 300

let job: ReportJob | null = load()
let running = false

function load(): ReportJob | null {
  try {
    const j = JSON.parse(settingsRepo.get(KEY) ?? 'null')
    return j && Array.isArray(j.ids) && ['read', 'unread', 'delete'].includes(j.kind) ? { ...j, removing: false } : null
  } catch {
    return null
  }
}
const save = () => (job ? settingsRepo.set(KEY, JSON.stringify(job)) : settingsRepo.delete(KEY))
const set = (next: ReportJob | null) => {
  job = next
  save()
  publishWork('reportJob')
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The one running, if any (for the dashboard's state). */
export const reportJob = () => job

/** Start one. Refused while another runs. */
export function startReportJob(kindIn: unknown, idsIn: unknown): ReportJob {
  const kind = kindIn === 'read' || kindIn === 'unread' || kindIn === 'delete' ? kindIn : null
  if (!kind) throw new AgentError('kind: read, unread or delete', 400)
  const ids = bulkIds(idsIn)
  if (!ids.length) throw new AgentError('Pick at least one report', 400)
  if (job) throw new AgentError('Another action on reports is still running: try again when it is done', 409)
  set({ id: crypto.randomUUID().slice(0, 12), kind, ids, done: 0, removing: false, startedAt: Date.now() })
  void run()
  return job!
}

async function run() {
  if (running || !job) return
  running = true
  try {
    // about ten steps, so the bar moves
    const size = Math.max(1, Math.ceil(job.ids.length / 10))
    while (job && job.done < job.ids.length) {
      const chunk = job.ids.slice(job.done, job.done + size)
      if (job.kind === 'delete') removeReports(chunk)
      else markReports(chunk, job.kind === 'read')
      set({ ...job, done: job.done + chunk.length })
      await sleep(STEP_MS)
    }
    if (job?.kind === 'delete') {
      set({ ...job, removing: true })
      await sleep(REMOVING_MS)
    }
  } catch (e) {
    console.error('[reports] bulk action failed', e)
  } finally {
    running = false
    set(null)
  }
}

/** At startup: one cut short by a restart carries on. */
export function resumeReportJob() {
  if (job) void run()
}
