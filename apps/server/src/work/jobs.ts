import type { WorkJob } from '@after-office/shared'
import { reportsRepo, tasksRepo } from '../db'

// Jobs: the owner's one request, made of several tasks (write → review → revise → review again). The manager names
// it on each step (delegate_task `job`); the same name within a couple of weeks is the same job, and a step chained
// with `after` joins the job of the step before it. Its reports then show as one item in the dashboard.

const RECENT_MS = 14 * 86_400_000
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The job called `title` (a recent one of that name, or a new one). */
export function jobNamed(title: string, now = Date.now()): WorkJob | undefined {
  const name = title.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!name) return undefined
  const fromTasks = tasksRepo
    .active()
    .filter((t) => t.job && same(t.job.title, name) && now - (t.createdAt ?? t.startedAt ?? now) < RECENT_MS)
    .map((t) => t.job!)[0]
  if (fromTasks) return fromTasks
  const fromReports = reportsRepo.latest(500).find((r) => r.job && same(r.job.title, name) && now - r.finishedAt < RECENT_MS)?.job
  return fromReports ?? { id: `job-${crypto.randomUUID().slice(0, 12)}`, title: name }
}

/** A new task's job: the one it was given, else that of the first task it waits for. */
export function jobForTask(named: string | undefined, after: string[] = []) {
  if (named?.trim()) return jobNamed(named)
  for (const id of after) {
    const job = tasksRepo.get(id)?.job
    if (job) return job
  }
  return undefined
}
