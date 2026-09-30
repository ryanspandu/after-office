import { Hono } from 'hono'
import type { CronJob, LiveMode, OfficeTask, Project, TaskArchivePage, TaskPriority, TaskStatus, WorkReport } from '@after-office/shared'
import { activityRepo, ARCHIVE_DAYS, agentsRepo, type ActivityFilter, commentsRepo, cronsRepo, projectsRepo, reportsRepo, settingsRepo, tasksRepo, triggersRepo } from '../db'
import { diffSince } from '../work/git'
import { deleteOrphanFolder, folderFile, listFolder, recentCommits, workspaces, zipFromFolder } from '../work/workspaces'
import { fileResponse, reportFile, reportFiles } from '../agents/files'
import { countEntries, deleteProjectFolder, isOwnProjectFolder, makeProjectFolder } from '../work/projectFolders'
import { addPushDevice, pushDeviceFor, pushDevices, pushPublicKey, removePushDevice, sendPush } from '../push'
import { channelStatus, removeChannel, saveChannel, sendTest, type ChannelName } from '../notify'
import { publish } from '../agents/registry'
import { updateSettings } from '../work/settings'
import { cleanTagIds, deleteTag, putTag } from '../work/tags'
import { listPreviews } from '../work/previews'
import { AgentError, resolveCwd } from '../agents/manager'
import { taskFolder, addComment, checkQuota, endBossMode, makesCycle, markAllReportsRead, markReport, publishWork, setReportTags, reviseTask, runCron, startBossMode, startTask, tickTasks } from '../work/work'
import { requestWho, requireFreshCode } from '../auth'

// /api routes for tasks, projects, cron jobs and settings (live mode). Every change is pushed to all dashboards.

export const workRoutes = new Hono()

workRoutes.onError((err, c) => {
  if (err instanceof AgentError) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: 'Something went wrong' }, 500)
})

const bad = (m: string) => new AgentError(m, 400)
const str = (v: unknown, max: number, field: string) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${field} is required (max ${max} characters)`)
  return v.trim()
}
const ID_RE = /^[\w-]{1,64}$/

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'review', 'done']
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high']

const TASK_MODES: LiveMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions']

function cleanTask(id: string, b: Partial<OfficeTask>, prev: OfficeTask | null): OfficeTask {
  if (!ID_RE.test(id)) throw bad('Invalid id')
  if (!STATUSES.includes(b.status as TaskStatus)) throw bad('Invalid status')
  if (!PRIORITIES.includes(b.priority as TaskPriority)) throw bad('Invalid priority')
  if (typeof b.deadline !== 'number' || !Number.isFinite(b.deadline)) throw bad('Invalid deadline')
  return {
    id,
    title: str(b.title, 200, 'Title'),
    agentId: typeof b.agentId === 'string' ? b.agentId : null,
    projectId: typeof b.projectId === 'string' ? b.projectId : null,
    deadline: b.deadline,
    priority: b.priority as TaskPriority,
    status: b.status as TaskStatus,
    description: typeof b.description === 'string' ? b.description.slice(0, 20_000) : undefined,
    startedAt: typeof b.startedAt === 'number' ? b.startedAt : undefined,
    ...autoStartFields(b, prev),
    blockedBy: cleanBlockedBy(id, b.blockedBy),
    tags: cleanTagIds(b.tags),
    check: typeof b.check === 'string' && b.check.trim() ? b.check.trim().slice(0, 1000) : undefined,
    // server-owned
    delegatedBy: prev?.delegatedBy,
    awaitingApproval: prev?.awaitingApproval,
    checkState: prev?.checkState,
    checkAttempts: prev?.checkAttempts,
    gitBase: prev?.gitBase,
    stuckNotifiedAt: prev?.stuckNotifiedAt,
    assignAskedAt: prev?.assignAskedAt,
    pendingCheck: prev?.pendingCheck,
  }
}

function cleanBlockedBy(id: string, v: unknown) {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === 'string' && ID_RE.test(x))) throw bad('Invalid "waits for" list')
  const ids = [...new Set(v as string[])].filter((x) => x !== id && tasksRepo.get(x))
  if (makesCycle(id, ids)) throw bad('That would make tasks wait for each other in a loop')
  return ids.length ? ids : undefined
}

function autoStartFields(b: Partial<OfficeTask>, prev: OfficeTask | null): Partial<OfficeTask> {
  if (b.mode !== undefined && !TASK_MODES.includes(b.mode)) throw bad('Invalid mode')
  if (b.mode === 'bypassPermissions' && process.env.OFFICE_ALLOW_BYPASS !== 'true') throw bad('bypassPermissions is disabled on this server')
  const autoStart = b.autoStart === true
  const startAt = autoStart && typeof b.startAt === 'number' && Number.isFinite(b.startAt) ? b.startAt : undefined
  // fired already, and the schedule hasn't changed since: don't fire again
  const keep = prev?.autoStartedAt && prev.autoStart === autoStart && prev.startAt === startAt
  return { autoStart: autoStart || undefined, startAt, mode: b.mode, autoStartedAt: keep ? prev!.autoStartedAt : undefined }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function cleanCron(id: string, b: Partial<CronJob>, prev: CronJob | null): CronJob {
  if (!ID_RE.test(id)) throw bad('Invalid id')
  const times = [...new Set(Array.isArray(b.times) ? b.times : [])].filter((t) => TIME_RE.test(t)).sort()
  const days = [...new Set(Array.isArray(b.days) ? b.days : [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
  if (!times.length) throw bad('Add at least one time (HH:MM)')
  if (!days.length) throw bad('Pick at least one day')
  return {
    id,
    name: str(b.name, 120, 'Name'),
    prompt: str(b.prompt, 20_000, 'Prompt'),
    times,
    days,
    agentId: typeof b.agentId === 'string' ? b.agentId : null,
    enabled: b.enabled !== false,
    fresh: !!b.fresh,
    // run history is server-owned
    lastRuns: prev?.lastRuns ?? [],
  }
}

// ── projects ──
workRoutes.put('/projects/:id', async (c) => {
  const id = c.req.param('id')
  if (!ID_RE.test(id)) throw bad('Invalid id')
  const b = await c.req.json<Partial<Project> & { createFolder?: boolean }>()
  const prev = projectsRepo.get(id)
  const color = typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#9a9a96'
  const opt = (v: unknown, max: number, field: string) => {
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string' || v.length > max) throw bad(`${field} is too long (max ${max} characters)`)
    return v.trim() || undefined
  }
  // a folder must be one agents may work in (inside OFFICE_ROOT, symlinks resolved)
  const folderIn = opt(b.folder, 1000, 'Folder')
  const name = str(b.name, 60, 'Name')
  // createFolder (a new project, or one without a folder): it gets <agents dir>/project/<name>
  // an edit that doesn't mention the folder keeps it ("" removes it)
  const folder = folderIn
    ? resolveCwd(folderIn)
    : !prev?.folder && b.createFolder === true
      ? makeProjectFolder(name)
      : prev && !('folder' in b)
        ? prev.folder
        : undefined
  projectsRepo.put({ id, name, color, brief: opt(b.brief, 5000, 'Brief'), check: opt(b.check, 1000, 'Check command'), folder })
  publishWork('projects')
  return c.json({ ok: true, folder: folder ?? null })
})
/** Can the project's folder be deleted with it (one the office made), and how much is in it. */
workRoutes.get('/projects/:id/folder', (c) => {
  const folder = projectsRepo.get(c.req.param('id'))?.folder
  const deletable = isOwnProjectFolder(folder)
  return c.json({ folder: folder ?? null, deletable, entries: deletable ? countEntries(folder!) : 0 })
})
workRoutes.delete('/projects/:id', async (c) => {
  const p = projectsRepo.get(c.req.param('id'))
  // ?folder=1: its folder goes too (only one the office made in the projects folder)
  if (p?.folder && c.req.query('folder') === '1') await deleteProjectFolder(p.folder)
  projectsRepo.remove(c.req.param('id'))
  publishWork('projects')
  return c.json({ ok: true })
})

// ── tasks ──
workRoutes.get('/tasks/archive', (c) => {
  const q = (c.req.query('q') ?? '').slice(0, 200)
  const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0))
  const limit = Math.min(100, Math.max(1, Math.floor(Number(c.req.query('limit')) || 50)))
  return c.json({ ...tasksRepo.archived({ q, offset, limit }), archiveDays: ARCHIVE_DAYS } satisfies TaskArchivePage)
})
workRoutes.get('/tasks/:id/diff', async (c) => {
  const t = tasksRepo.get(c.req.param('id'))
  if (!t) throw new AgentError('No such task', 404)
  const cwd = taskFolder(t)
  if (!t.gitBase || !cwd) return c.json({ files: null, truncated: false, reason: t.gitBase ? 'The agent is gone.' : "No git snapshot: the agent's folder isn't a git repo, or the task started before this feature." })
  return c.json(await diffSince(cwd, t.gitBase))
})
workRoutes.post('/tasks/:id/restore', (c) => {
  if (!tasksRepo.touch(c.req.param('id'))) throw new AgentError('No such task', 404)
  publishWork('tasks')
  return c.json({ ok: true })
})
workRoutes.put('/tasks/:id', async (c) => {
  const id = c.req.param('id')
  const prev = tasksRepo.get(id)
  const next = cleanTask(id, await c.req.json(), prev)
  // the Activity log's "why": a task made here is the owner's, from this device
  next.origin = prev?.origin ?? { kind: 'owner', label: 'Made in the dashboard', ...requestWho(c), at: Date.now() }
  // waiting for other tasks again after it already fired: let it fire again once they finish
  if (next.blockedBy && prev?.autoStartedAt && next.status === 'todo' && JSON.stringify(prev.blockedBy) !== JSON.stringify(next.blockedBy)) next.autoStartedAt = undefined
  tasksRepo.put(next)
  if (prev?.status === 'review' && next.status === 'done') addComment({ taskId: id, author: 'user', text: 'Accepted.' })
  publishWork('tasks')
  void tickTasks() // "start as soon as the agent is free" shouldn't wait for the next tick
  return c.json({ ok: true })
})
workRoutes.delete('/tasks/:id', (c) => {
  tasksRepo.remove(c.req.param('id'))
  commentsRepo.removeTask(c.req.param('id'))
  publishWork('tasks')
  return c.json({ ok: true })
})
workRoutes.post('/tasks/:id/start', async (c) => {
  const body = await c.req.json<{ agentId?: string }>().catch(() => ({}) as { agentId?: string })
  return c.json({ result: await startTask(c.req.param('id'), body.agentId) })
})

workRoutes.post('/tasks/:id/revise', async (c) => {
  const body = await c.req.json<{ feedback?: string }>().catch(() => ({}) as { feedback?: string })
  if (typeof body.feedback !== 'string' || body.feedback.length > 20_000) throw bad('Feedback is required')
  return c.json({ result: await reviseTask(c.req.param('id'), body.feedback) })
})

// ── cron ──
workRoutes.put('/crons/:id', async (c) => {
  const id = c.req.param('id')
  cronsRepo.put(cleanCron(id, await c.req.json(), cronsRepo.get(id)))
  publishWork('crons')
  return c.json({ ok: true })
})
workRoutes.delete('/crons/:id', (c) => {
  cronsRepo.remove(c.req.param('id'))
  triggersRepo.remove(c.req.param('id'))
  publishWork('crons')
  return c.json({ ok: true })
})
workRoutes.post('/crons/:id/run', async (c) => {
  const cron = cronsRepo.get(c.req.param('id'))
  if (!cron) throw new AgentError('No such daily job', 404)
  return c.json({ result: await runCron(cron) })
})

// ── reports ──
workRoutes.post('/reports/read-all', (c) => {
  markAllReportsRead()
  return c.json({ ok: true })
})
workRoutes.post('/reports/:id/read', async (c) => {
  const b = await c.req.json<{ read?: boolean }>().catch(() => ({}) as { read?: boolean })
  markReport(c.req.param('id'), b.read !== false)
  return c.json({ ok: true })
})
// "View all": every stored report (not just the newest the dashboard holds), filtered, searched and paged
const REPORT_FILTERS = ['all', 'unread', 'manager', 'agents', 'task', 'cron', 'failed'] as const
workRoutes.get('/reports', (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 200)
  const filter = REPORT_FILTERS.find((f) => f === c.req.query('filter')) ?? 'all'
  const from = Number(c.req.query('from')) || 0
  const to = Number(c.req.query('to')) || Infinity
  const per = Math.min(100, Math.max(1, Number(c.req.query('per')) || 25))
  const page = Math.max(1, Math.floor(Number(c.req.query('page')) || 1))
  const agents = new Map(agentsRepo.all().map((a) => [a.id, a]))
  const isManager = (r: WorkReport) => r.kind === 'note' || agents.get(r.agentId)?.kind === 'manager'
  // project: its id, or "none" for reports about no project
  const project = c.req.query('project') ?? ''
  // tags: comma-separated ids, a report with any of them matches
  const tags = (c.req.query('tag') ?? '').split(',').filter(Boolean)
  // by: one agent's id, or "removed" for agents no longer in the office
  const by = c.req.query('by') ?? ''
  const matches = reportsRepo.latest(1000).filter((r) => {
    if (by && (by === 'removed' ? agents.has(r.agentId) : r.agentId !== by)) return false
    if (r.finishedAt < from || r.finishedAt > to) return false
    if (filter === 'unread' && r.read) return false
    if (filter === 'failed' && r.ok) return false
    if (filter === 'manager' && !isManager(r)) return false
    if (filter === 'agents' && isManager(r)) return false
    if ((filter === 'task' || filter === 'cron') && r.kind !== filter) return false
    if (project && (project === 'none' ? !!r.projectId : r.projectId !== project)) return false
    if (tags.length && !r.tags?.some((t) => tags.includes(t))) return false
    if (q && !`${r.title}\n${r.text}\n${agents.get(r.agentId)?.name ?? ''}`.toLowerCase().includes(q)) return false
    return true
  })
  const pages = Math.max(1, Math.ceil(matches.length / per))
  const at = Math.min(page, pages)
  return c.json({ items: matches.slice((at - 1) * per, at * per), total: matches.length, page: at, pages, per })
})
// a report's attachments: reachable through the report itself (also after its agent was removed)
workRoutes.get('/reports/:id/files', (c) => {
  const r = reportsRepo.get(c.req.param('id'))
  if (!r) throw new AgentError('No such report', 404)
  return c.json(reportFiles(r))
})
workRoutes.get('/reports/:id/file', (c) => {
  const r = reportsRepo.get(c.req.param('id'))
  const f = r ? reportFile(r, c.req.query('path') ?? '') : null
  if (!f) return c.json({ error: 'This file no longer exists' }, 404)
  return fileResponse(f.real, f.size, c.req.query('inline') === '1')
})
workRoutes.put('/reports/:id/tags', async (c) => {
  const { tags } = await c.req.json<{ tags?: unknown }>().catch(() => ({ tags: undefined }))
  setReportTags(c.req.param('id'), cleanTagIds(tags ?? []))
  return c.json({ ok: true })
})

// the apps agents are running on preview ports (Projects → Previews)
workRoutes.get('/previews', async (c) => c.json(await listPreviews(c)))

// tags: the owner's labels for tasks and reports
workRoutes.put('/tags/:id', async (c) => {
  const tag = putTag(c.req.param('id'), await c.req.json().catch(() => ({})))
  publishWork('tags')
  return c.json(tag)
})
workRoutes.delete('/tags/:id', (c) => {
  deleteTag(c.req.param('id'))
  publishWork('tags', 'tasks', 'reports')
  return c.json({ ok: true })
})

workRoutes.delete('/reports/:id', (c) => {
  reportsRepo.remove(c.req.param('id'))
  publishWork('reports')
  return c.json({ ok: true })
})

// ── webhook triggers for cron jobs (the public endpoint is /trigger/cron/:id in index.ts) ──
// OFFICE_TRIGGER_URL: where outside services reach the webhooks when the dashboard itself isn't public
// (e.g. a Tailscale Funnel on its own port); else the dashboard's public address
const triggerUrl = (reqUrl: string, id: string) =>
  `${(process.env.OFFICE_TRIGGER_URL || process.env.OFFICE_PUBLIC_URL)?.replace(/\/+$/, '') || new URL(reqUrl).origin}/trigger/cron/${id}`
workRoutes.post('/crons/:id/trigger', (c) => {
  const id = c.req.param('id')
  if (!cronsRepo.get(id)) throw new AgentError('No such cron job', 404)
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  triggersRepo.set(id, token)
  publishWork('crons')
  return c.json({ url: triggerUrl(c.req.url, id), token })
})
// the token itself can't be shown again (only its hash is kept): regenerate to get a new one
workRoutes.get('/crons/:id/trigger', (c) => {
  const id = c.req.param('id')
  if (!triggersRepo.get(id)) throw new AgentError('No webhook for this daily job', 404)
  return c.json({ url: triggerUrl(c.req.url, id), token: null })
})
workRoutes.delete('/crons/:id/trigger', (c) => {
  triggersRepo.remove(c.req.param('id'))
  publishWork('crons')
  return c.json({ ok: true })
})

// ── projects tab: the agents' folders ──
workRoutes.get('/workspaces', async (c) => c.json(await workspaces(c.req.query('fresh') === '1')))
// file manager: read-only, inside a folder the Projects tab shows
workRoutes.get('/workspaces/files', (c) => c.json(listFolder(c.req.query('root') ?? '', c.req.query('path') ?? '')))
workRoutes.get('/workspaces/file', (c) => {
  const f = folderFile(c.req.query('root') ?? '', c.req.query('path') ?? '')
  return fileResponse(f.real, f.size, c.req.query('inline') === '1')
})
// a folder whose agent was removed: delete it with everything in it (only those)
workRoutes.delete('/workspaces/folder', async (c) => {
  await deleteOrphanFolder(c.req.query('path') ?? '')
  return c.json({ ok: true })
})
// several at once: POST (the list can be long) → one ZIP
workRoutes.post('/workspaces/zip', async (c) => {
  const b = await c.req.json<{ root?: unknown; paths?: unknown }>().catch(() => ({}) as { root?: unknown; paths?: unknown })
  const paths = Array.isArray(b.paths) ? b.paths.filter((p): p is string => typeof p === 'string') : []
  const z = zipFromFolder(typeof b.root === 'string' ? b.root : '', paths)
  return new Response(z.data.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(z.data.length),
      'content-disposition': `attachment; filename="${z.name.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(z.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
})
workRoutes.get('/workspaces/commits', async (c) => c.json(await recentCommits(c.req.query('path') ?? '')))

// ── task timeline ──
workRoutes.get('/tasks/:id/comments', (c) => c.json(commentsRepo.forTask(c.req.param('id'))))
workRoutes.post('/tasks/:id/comments', async (c) => {
  const id = c.req.param('id')
  if (!tasksRepo.get(id)) throw new AgentError('No such task', 404)
  const b = await c.req.json<{ text?: string }>()
  return c.json(addComment({ taskId: id, author: 'user', kind: 'note', text: str(b.text, 20_000, 'Comment') }))
})
workRoutes.delete('/comments/:id', (c) => {
  const comment = commentsRepo.get(c.req.param('id'))
  if (!comment) throw new AgentError('No such comment', 404)
  if (comment.author !== 'user' || comment.kind === 'revision') throw bad('Only your own notes can be deleted')
  commentsRepo.remove(comment.id)
  publish({ type: 'comment-removed', id: comment.id, taskId: comment.taskId })
  return c.json({ ok: true })
})

// ── automation: notifications and the quota brake ──
// Boss mode: the manager works without approvals until a time the owner picks. Only with the authenticator code, typed
// just now (a signed-in browser alone isn't enough); turning it off needs nothing.
workRoutes.post('/boss-mode', async (c) => {
  const body = await c.req.json<{ code?: unknown; hours?: unknown; until?: unknown; runWaiting?: unknown }>().catch(() => null)
  const hours = Number(body?.hours)
  const until = typeof body?.until === 'number' ? body.until : [4, 8, 12].includes(hours) ? Date.now() + hours * 3_600_000 : NaN
  if (!Number.isFinite(until)) throw new AgentError('Pick how long: 4, 8 or 12 hours, or an end time')
  const refused = requireFreshCode(c, body?.code)
  if (refused) return refused
  return c.json(await startBossMode(until, body?.runWaiting === true))
})
workRoutes.delete('/boss-mode', (c) => c.json({ ok: endBossMode('owner') }))

workRoutes.put('/automation', async (c) => {
  updateSettings(await c.req.json())
  publishWork('settings')
  checkQuota()
  void tickTasks() // the brake may just have been released
  return c.json({ ok: true })
})
// notification channels (ntfy, Telegram, a webhook): set up here instead of the .env. Saving one sends the office's
// news somewhere new, so it takes the 2FA code; what comes back never includes a secret.
const CHANNELS: ChannelName[] = ['ntfy', 'telegram', 'webhook']
const channelName = (v: string) => {
  if (!CHANNELS.includes(v as ChannelName)) throw new AgentError('Unknown channel', 404)
  return v as ChannelName
}
workRoutes.get('/notify/channels', (c) => c.json(channelStatus()))
workRoutes.put('/notify/channels/:name', async (c) => {
  const name = channelName(c.req.param('name'))
  if (channelStatus()[name].source === 'env') throw new AgentError("This channel is set in the server's .env: change it there", 409)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) throw new AgentError('Expected the channel settings')
  const refused = requireFreshCode(c, body.code)
  if (refused) return refused
  try {
    saveChannel(name, body)
  } catch (e) {
    throw new AgentError(e instanceof Error ? e.message : 'Invalid settings')
  }
  publishWork('automation')
  return c.json(channelStatus())
})
workRoutes.delete('/notify/channels/:name', (c) => {
  const name = channelName(c.req.param('name'))
  if (channelStatus()[name].source === 'env') throw new AgentError("This channel is set in the server's .env: remove it there", 409)
  removeChannel(name)
  publishWork('automation')
  return c.json(channelStatus())
})

// notifications from the dashboard app itself (Web Push): each device turns them on for itself
workRoutes.get('/push', (c) => c.json({ publicKey: pushPublicKey(), devices: pushDevices() }))
workRoutes.post('/push/devices', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { subscription?: unknown; label?: unknown } | null
  try {
    const id = addPushDevice(body?.subscription, typeof body?.label === 'string' ? body.label : '')
    publishWork('automation')
    return c.json({ id, devices: pushDevices() })
  } catch (e) {
    throw new AgentError(e instanceof Error ? e.message : 'Invalid subscription')
  }
})
// is this browser one of them? (by its subscription's endpoint, which only the browser knows)
workRoutes.post('/push/devices/lookup', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null
  return c.json({ id: typeof body?.endpoint === 'string' ? pushDeviceFor(body.endpoint) : null })
})
workRoutes.delete('/push/devices/:id', (c) => {
  removePushDevice(c.req.param('id'))
  publishWork('automation')
  return c.json({ devices: pushDevices() })
})
workRoutes.post('/push/test', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null
  const results = await sendPush({ title: 'Test notification', body: 'Notifications work on this device.', url: '/', tag: 'test' }, typeof body?.id === 'string' ? body.id : undefined)
  publishWork('automation')
  return c.json({ results, devices: pushDevices() })
})

// the Activity log: what agents did with connectors (newest first, paged by time), and the same as CSV
function activityFilter(q: (k: string) => string | undefined): ActivityFilter {
  const num = (k: string) => (q(k) && Number.isFinite(Number(q(k))) ? Number(q(k)) : undefined)
  const access = q('access')
  return {
    agentId: q('agent') || undefined,
    connector: q('connector') || undefined,
    access: access === 'read' || access === 'write' ? access : undefined,
    problems: q('problems') === '1',
    q: q('q')?.slice(0, 200) || undefined,
    from: num('from'),
    to: num('to'),
    before: num('before'),
  }
}
workRoutes.get('/activity', (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  const entries = activityRepo.list({ ...activityFilter((k) => c.req.query(k)), limit: limit + 1 })
  const more = entries.length > limit
  const page = entries.slice(0, limit)
  return c.json({ entries: page, next: more ? page[page.length - 1].at : null, connectors: activityRepo.connectors() })
})
workRoutes.get('/activity/export.csv', (c) => {
  const rows = activityRepo.list({ ...activityFilter((k) => c.req.query(k)), limit: 5000 })
  const cell = (v: unknown) => {
    const t = v === undefined || v === null ? '' : String(v)
    // quoted, and never read as a formula by a spreadsheet
    return `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`
  }
  const chain = (o?: { label: string; kind: string; device?: string; ip?: string; boss?: boolean; via?: unknown }): string =>
    o ? [`${o.kind}: ${o.label}`, o.device, o.ip, o.boss ? 'Boss mode' : '', o.via ? `← ${chain(o.via as typeof o)}` : ''].filter(Boolean).join(' · ') : ''
  const lines = [
    ['time', 'agent', 'connector', 'tool', 'access', 'status', 'allowed by', 'approved from', 'origin', 'input', 'result', 'read before'].map(cell).join(','),
    ...rows.map((e) =>
      [
        new Date(e.at).toISOString(),
        e.agentName,
        e.connector ?? '',
        e.tool ?? e.message ?? '',
        e.access ?? '',
        e.status,
        e.decision ? (e.decision.by === 'owner' ? (e.decision.allowed ? 'owner (approved)' : 'owner (denied)') : 'automatic') : '',
        e.decision?.by === 'owner' ? [e.decision.device, e.decision.ip].filter(Boolean).join(' · ') : '',
        chain(e.origin),
        e.input ?? '',
        e.result ?? '',
        (e.readBefore ?? []).join(' | '),
      ]
        .map(cell)
        .join(','),
    ),
  ]
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"` },
  })
})

workRoutes.post('/automation/test', async (c) => {
  const results = await sendTest()
  if (!results.length) throw bad('No notification channel is set up on the server yet (see .env.example)')
  return c.json({ results })
})

// ── settings ──
workRoutes.put('/settings', async (c) => {
  const b = await c.req.json<{ timezone?: string }>()
  if (b.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: b.timezone })
    } catch {
      throw bad('Unknown timezone')
    }
    settingsRepo.set('timezone', b.timezone)
    publishWork('timezone')
  }
  return c.json({ ok: true })
})
