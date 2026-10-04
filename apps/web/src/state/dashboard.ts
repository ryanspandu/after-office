import { create } from 'zustand'
import { api } from './auth'
import { useOffice } from './store'
import type { Tag, CronJob, FollowUp, OfficeTask, SystemMetrics, TaskPriority, TaskStatus, TokenUsage, WorkReport } from '@after-office/shared'

// Dashboard data (cron jobs, tasks, follow-ups, metrics, token usage). Mock for now; Phase 2 loads it from Hono.

/** Local calendar date as YYYY-MM-DD. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const HOUR = 3_600_000
const DAY = 24 * HOUR
let seq = 100
const uid = (prefix: string) => `${prefix}-${seq++}`

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const WEEKDAYS = [1, 2, 3, 4, 5]

const INITIAL_CRONS: CronJob[] = [
  { id: 'cron-1', name: 'Summarize yesterday’s PRs', prompt: 'Summarize all PRs merged yesterday', times: ['08:30'], days: WEEKDAYS, agentId: 'agent-0', enabled: true },
  { id: 'cron-2', name: 'Dependency audit', prompt: 'Run npm audit and open fixes', times: ['09:00'], days: EVERY_DAY, agentId: 'agent-2', enabled: true },
  { id: 'cron-3', name: 'Check CI health', prompt: 'Look at failing CI runs and summarize the causes', times: ['10:00', '14:00', '18:00'], days: WEEKDAYS, agentId: 'agent-1', enabled: true },
  { id: 'cron-4', name: 'Nightly e2e suite', prompt: 'Run the e2e suite and report failures', times: ['02:00'], days: EVERY_DAY, agentId: 'agent-4', enabled: true },
  { id: 'cron-5', name: 'Clean stale branches', prompt: 'Delete merged branches older than 14 days', times: ['18:00'], days: [5], agentId: 'agent-1', enabled: false },
]

function initialTasks(now: number): OfficeTask[] {
  const t = (id: string, title: string, agentId: string | null, _area: string, deadline: number, priority: TaskPriority, status: TaskStatus): OfficeTask => ({
    id, title, agentId, deadline, priority, status,
  })
  return [
    t('task-1', 'Fix checkout race condition', 'agent-2', 'proj-api', now - 3 * HOUR, 'high', 'in_progress'),
    t('task-2', 'Ship settings page v2', 'agent-1', 'proj-web', now + 2 * HOUR, 'high', 'review'),
    t('task-3', 'Migrate db schema to v4', 'agent-0', 'proj-api', now + 20 * HOUR, 'medium', 'in_progress'),
    t('task-4', 'Write onboarding docs', 'agent-3', 'proj-docs', now + 3 * DAY, 'low', 'todo'),
    t('task-5', 'Load-test the websocket gateway', null, 'proj-infra', now + 6 * DAY, 'medium', 'todo'),
    t('task-6', 'Rotate API keys', 'agent-5', 'proj-infra', now - DAY, 'medium', 'done'),
    t('task-7', 'Dark mode for settings', 'agent-1', 'proj-web', now + 4 * DAY, 'low', 'todo'),
    t('task-8', 'Add rate limiting to /login', 'agent-0', 'proj-api', now + 2 * DAY, 'high', 'todo'),
    t('task-9', 'Terraform: split staging state', 'agent-2', 'proj-infra', now + 5 * DAY, 'medium', 'review'),
  ]
}

function initialReports(now: number): WorkReport[] {
  const r = (id: string, kind: WorkReport['kind'], refId: string, title: string, agentId: string, minsAgo: number, took: number, text: string, read = false, ok = true): WorkReport => ({
    id, kind, refId, title, agentId, text, ok, read, finishedAt: now - minsAgo * 60_000, startedAt: now - (minsAgo + took) * 60_000,
  })
  return [
    r('rep-1', 'cron', 'cron-1', 'Summarize yesterday’s PRs', 'agent-0', 42, 3, '**7 PRs merged yesterday.**\n\n- #412 Rate limiter for the public API\n- #415 Fix flaky checkout test\n- #418 Bump Next.js to 15.3\n\nNothing needs your attention; #418 is worth a quick look at the build size.'),
    r('rep-2', 'task', 'task-2', 'Write migration for invoices table', 'agent-3', 95, 18, 'Added `2026_09_invoices_due_date` with a backfill. Ran it against a copy of staging: 41k rows in 3.2 s.\n\n**Review:** the backfill assumes `net_days` is never null.', true),
    r('rep-3', 'cron', 'cron-4', 'Nightly e2e suite', 'agent-4', 380, 26, '2 of 148 specs failed:\n\n- `checkout/coupon.spec.ts`: timeout waiting for the payment iframe\n- `profile/avatar.spec.ts`: 413 from the upload endpoint', false, false),
  ]
}

function initialReviews(now: number): FollowUp[] {
  return [
    {
      id: 'fu-plan',
      agentId: 'agent-4',
      kind: 'plan',
      message: 'Plan: move sessions from cookies to signed JWTs',
      createdAt: now - 12 * 60_000,
      detail: `## Context
Sessions are stored server-side in Redis and looked up on every request. The API gateway now runs on 3 regions, so the Redis round-trip adds ~40 ms p95.

## Plan
1. Add \`packages/auth/jwt.ts\` with \`sign()\` / \`verify()\` using EdDSA keys from \`AUTH_SIGNING_KEY\`.
2. Issue a short-lived access token (15 min) + rotating refresh token (7 days) on login.
3. Replace \`sessionMiddleware\` with \`jwtMiddleware\`; keep reading the old cookie for 14 days as a fallback.
4. Add a \`/auth/refresh\` endpoint with refresh-token reuse detection.
5. Update the web client to refresh tokens in the fetch wrapper.
6. Tests: unit tests for sign/verify + expiry, e2e login → refresh → logout.

## Files
- packages/auth/jwt.ts (new)
- apps/api/src/middleware/session.ts → jwt.ts
- apps/api/src/routes/auth.ts
- apps/web/src/lib/fetch.ts

## Risks
- Logged-in users keep working through the cookie fallback; after 14 days they must log in again.
- Key rotation needs a \`kid\` header — included in step 1.`,
    },
    {
      id: 'fu-1',
      agentId: 'agent-0',
      kind: 'review',
      message: 'PR #128 “auth middleware refactor” is ready for review',
      createdAt: now - 25 * 60_000,
      detail: `## Summary
Splits the 600-line \`auth.ts\` into \`session.ts\`, \`permissions.ts\` and \`rate-limit.ts\`. No behaviour change.

## Changes
- 14 files changed, +412 −389
- New tests: \`permissions.test.ts\` (22 cases)
- All 318 existing tests pass`,
    },
    {
      id: 'fu-2',
      agentId: 'agent-3',
      kind: 'question',
      message: 'Docs: should the API reference live in /docs or a separate site?',
      createdAt: now - 70 * 60_000,
      detail: `I'm writing the onboarding docs and need to know where the generated API reference goes.

- **Option A: /docs in the main site.** One deploy, shared search, but the site build gets ~30 s slower.
- **Option B: separate docs.example.com.** Independent deploys and versioning, but a second project to maintain.

I'd lean towards A for now.`,
    },
    { id: 'fu-3', agentId: 'agent-1', kind: 'review', message: 'Settings page preview deployed — please check the design', createdAt: now - 5 * 60_000 },
  ]
}

/** Deterministic fake token history for the last 90 days. */
function mockUsage(now: number): TokenUsage[] {
  const out: TokenUsage[] = []
  let r = 42
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647)
  for (let d = 89; d >= 0; d--) {
    const date = ymd(new Date(now - d * DAY))
    const weekend = [0, 6].includes(new Date(now - d * DAY).getDay())
    for (let a = 0; a < 7; a++) {
      const scale = (weekend ? 0.4 : 1) * (0.5 + rand())
      out.push({ date, agentId: `agent-${a}`, input: Math.round(180_000 * scale), output: Math.round(42_000 * scale) })
    }
  }
  return out
}

export type RangePreset = 'today' | '7d' | '30d' | 'custom'

interface DashboardStore {
  crons: CronJob[]
  tasks: OfficeTask[]
  reviews: FollowUp[]
  /** Finished task / cron reports, newest first */
  reports: WorkReport[]
  /** older reports than the live list holds, loaded as the Reports panel scrolls down (by id): opened, marked and
   *  deleted like the others */
  olderReports: Record<string, WorkReport>
  keepOlderReports: (items: WorkReport[]) => void
  markReport: (id: string, read: boolean) => void
  setReportTags: (id: string, tags: string[]) => void
  /** the owner's labels for tasks and reports */
  tags: Tag[]
  /** create or change a tag (returns its id) */
  putTag: (tag: Omit<Tag, 'id'> & { id?: string }) => string
  /** removes it from every task and report too */
  removeTag: (id: string) => void
  markAllReportsRead: () => void
  removeReport: (id: string) => void
  usage: TokenUsage[]
  metrics: SystemMetrics
  range: { preset: RangePreset; from: string; to: string }
  fullscreen: boolean

  addCron: (c: Omit<CronJob, 'id'>) => void
  updateCron: (id: string, patch: Partial<CronJob>) => void
  removeCron: (id: string) => void
  addTask: (t: Omit<OfficeTask, 'id' | 'status'> & { status?: TaskStatus }) => void
  toggleTask: (id: string) => void
  updateTask: (id: string, patch: Partial<OfficeTask>) => void
  removeTask: (id: string) => void
  resolveReview: (id: string) => void
  setRange: (range: Partial<DashboardStore['range']>) => void
  setMetrics: (m: SystemMetrics) => void
  toggleFullscreen: () => void
  /** Last failed save in live mode, shown to the user. */
  syncError: string | null
  /** deleted, playing their way out (the row folds away) before they leave the lists: see useLeaving */
  leaving: Record<string, true>
  /** Back to the built-in sample data (leaving live mode). */
  loadDemoWork: () => void
}

const today = () => ymd(new Date())

// ── live mode: tasks and cron jobs live on the server ──
// Actions update local state right away (snappy UI), then PUT the changed document; the server broadcasts the
// canonical lists back over SSE (state/live.ts applyWork), which replaces what we have.

const isLive = () => useOffice.getState().source === 'live'

// Documents with edits that haven't reached the server yet. Typing in a task's title fires many saves; the
// server echoes each one back, and an older echo must not overwrite newer local text (see mergeServer).
const unsaved = new Map<string, { timer: ReturnType<typeof setTimeout> | null; inflight: number }>()
export const hasUnsaved = (id: string) => unsaved.has(id)

function push(path: string, id: string, body: () => unknown, method: 'PUT' | 'POST' | 'DELETE' = 'PUT', delay = 0) {
  if (!isLive()) return
  const entry = unsaved.get(id) ?? { timer: null, inflight: 0 }
  unsaved.set(id, entry)
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    const data = body()
    if (data === null) return settle(id, entry)
    entry.inflight++
    api(path, { method, body: data === undefined ? undefined : JSON.stringify(data) })
      .then(async (r) => {
        if (!r.ok) useDashboard.setState({ syncError: (await r.json().catch(() => null))?.error ?? `Could not save (${r.status})` })
      })
      .catch(() => useDashboard.setState({ syncError: 'Could not reach the server' }))
      .finally(() => {
        entry.inflight--
        settle(id, entry)
      })
  }, delay)
}

function settle(id: string, entry: { timer: unknown; inflight: number }) {
  if (!entry.timer && entry.inflight <= 0 && unsaved.get(id) === entry) unsaved.delete(id)
}

/** Server list wins, except for documents we're still saving: keep (or keep out) our local version of those. */
export function mergeServer<T extends { id: string }>(server: T[], local: T[]): T[] {
  if (!unsaved.size) return server
  const localById = new Map(local.map((d) => [d.id, d]))
  const out = server.flatMap((d) => (unsaved.has(d.id) ? (localById.has(d.id) ? [localById.get(d.id)!] : []) : [d]))
  for (const d of local) if (unsaved.has(d.id) && !server.some((x) => x.id === d.id)) out.push(d)
  return out
}

/** Stable-enough ids that the client can create before the server has seen the document. */
/** An older report changed (read, tags), if it's one of those loaded. */
function patchOlder(older: Record<string, WorkReport>, id: string, patch: Partial<WorkReport>) {
  return older[id] ? { ...older, [id]: { ...older[id], ...patch } } : older
}

/** How long a deleted row takes to fold away (styles: .is-leaving, the same length). */
export const LEAVE_MS = 240

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`

export const useDashboard = create<DashboardStore>((set, get) => {
  const now = Date.now()
  // text fields save as you type, so task saves are debounced
  const saveTask = (id: string) => push(`/api/tasks/${id}`, id, () => get().tasks.find((x) => x.id === id) ?? null, 'PUT', 400)
  const saveCron = (id: string) => push(`/api/crons/${id}`, id, () => get().crons.find((x) => x.id === id) ?? null)
  // a delete: the row plays its way out first (styles: .is-leaving), then it's removed and the server told
  const leaveThen = (id: string, remove: () => void) => {
    if (get().leaving[id]) return
    set((s) => ({ leaving: { ...s.leaving, [id]: true } }))
    setTimeout(() => {
      remove()
      set((s) => {
        const { [id]: _, ...rest } = s.leaving
        return { leaving: rest }
      })
    }, LEAVE_MS)
  }
  // live mode starts empty: the server's snapshot fills it (sample data first would flash and then jump)
  const demo = useOffice.getState().source === 'demo'
  return {
    crons: demo ? INITIAL_CRONS : [],
    tasks: demo ? initialTasks(now) : [],
    reviews: demo ? initialReviews(now) : [],
    reports: demo ? initialReports(now) : [],
    usage: demo ? mockUsage(now) : [],
    metrics: demo ? { cpu: 34, memUsedGb: 5.8, memTotalGb: 16 } : { cpu: 0, memUsedGb: 0, memTotalGb: 0 },
    range: { preset: 'today', from: today(), to: today() },
    fullscreen: false,
    syncError: null,
    leaving: {},
    olderReports: {},
    keepOlderReports: (items) => set((s) => ({ olderReports: { ...s.olderReports, ...Object.fromEntries(items.map((r) => [r.id, r])) } })),

    addCron: (c) => {
      const id = newId('cron')
      set((s) => ({ crons: [...s.crons, { ...c, id }] }))
      saveCron(id)
    },
    updateCron: (id, patch) => {
      set((s) => ({ crons: s.crons.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
      // run history is server-owned; don't echo local lastRuns back
      if (!('lastRuns' in patch && Object.keys(patch).length === 1)) saveCron(id)
    },
    removeCron: (id) =>
      leaveThen(id, () => {
        set((s) => ({ crons: s.crons.filter((c) => c.id !== id) }))
        push(`/api/crons/${id}`, id, () => undefined, 'DELETE')
      }),
    addTask: (t) => {
      const id = newId('task')
      set((s) => ({ tasks: [...s.tasks, { status: 'todo', ...t, id }] }))
      saveTask(id)
    },
    updateTask: (id, patch) => {
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
      saveTask(id)
    },
    toggleTask: (id) => {
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: t.status === 'done' ? 'todo' : 'done' } : t)) }))
      saveTask(id)
    },
    removeTask: (id) =>
      leaveThen(id, () => {
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
        push(`/api/tasks/${id}`, id, () => undefined, 'DELETE')
      }),
    tags: [],
    putTag: (tag) => {
      const id = tag.id ?? newId('tag')
      const next: Tag = { id, name: tag.name.trim(), color: tag.color, ...(tag.icon ? { icon: tag.icon } : {}) }
      set((s) => ({ tags: s.tags.some((t) => t.id === id) ? s.tags.map((t) => (t.id === id ? next : t)) : [...s.tags, next] }))
      push(`/api/tags/${id}`, id, () => ({ name: next.name, color: next.color, icon: next.icon }))
      return id
    },
    removeTag: (id) =>
      leaveThen(id, () => {
        const strip = <T extends { tags?: string[] }>(x: T): T => (x.tags?.includes(id) ? { ...x, tags: x.tags.filter((t) => t !== id) } : x)
        set((s) => ({ tags: s.tags.filter((t) => t.id !== id), tasks: s.tasks.map(strip), reports: s.reports.map(strip) }))
        push(`/api/tags/${id}`, id, () => undefined, 'DELETE')
      }),
    setReportTags: (id, tags) => {
      set((s) => ({ reports: s.reports.map((r) => (r.id === id ? { ...r, tags } : r)), olderReports: patchOlder(s.olderReports, id, { tags }) }))
      push(`/api/reports/${id}/tags`, `${id}:tags`, () => ({ tags }))
    },
    markReport: (id, read) => {
      set((s) => ({ reports: s.reports.map((r) => (r.id === id ? { ...r, read } : r)), olderReports: patchOlder(s.olderReports, id, { read }) }))
      push(`/api/reports/${id}/read`, id, () => ({ read }), 'POST')
    },
    markAllReportsRead: () => {
      set((s) => ({ reports: s.reports.map((r) => ({ ...r, read: true })), olderReports: Object.fromEntries(Object.entries(s.olderReports).map(([id, r]) => [id, { ...r, read: true }])) }))
      push('/api/reports/read-all', 'reports:all', () => ({}), 'POST')
    },
    removeReport: (id) =>
      leaveThen(id, () => {
        set((s) => {
          const { [id]: _, ...olderReports } = s.olderReports
          return { reports: s.reports.filter((r) => r.id !== id), olderReports }
        })
        push(`/api/reports/${id}`, id, () => undefined, 'DELETE')
      }),
    resolveReview: (id) => set((s) => ({ reviews: s.reviews.filter((r) => r.id !== id) })),
    setRange: (range) => set((s) => ({ range: { ...s.range, ...range } })),
    setMetrics: (metrics) => set({ metrics }),
    toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
    loadDemoWork: () => {
      const t = Date.now()
      set({ crons: INITIAL_CRONS, tasks: initialTasks(t), reviews: initialReviews(t), reports: initialReports(t), usage: mockUsage(t), syncError: null })
    },
  }
})

/** Resolve a range preset to inclusive YYYY-MM-DD bounds. */
export function rangeBounds(range: DashboardStore['range']): [string, string] {
  const d = (offset: number) => ymd(new Date(Date.now() - offset * DAY))
  switch (range.preset) {
    case 'today':
      return [d(0), d(0)]
    case '7d':
      return [d(6), d(0)]
    case '30d':
      return [d(29), d(0)]
    default:
      return range.from <= range.to ? [range.from, range.to] : [range.to, range.from]
  }
}

export function formatTokens(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

/** This one was just deleted and is on its way out (give its row .is-leaving). */
export const useLeaving = (id: string) => useDashboard((s) => !!s.leaving[id])
