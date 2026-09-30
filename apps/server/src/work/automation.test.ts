import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { CronJob, OfficeTask } from '@after-office/shared'
import { agentsRepo, commentsRepo, cronsRepo, queueRepo, reportsRepo, tasksRepo, type AgentRow } from '../db'
import { setRateLimits, updateRuntime } from '../agents/registry'
import { notify } from '../notify'
import { officeSettings, updateSettings } from './settings'
import { addComment, delegateTask, makesCycle, quotaPause, tickCrons, tickTasks, waitingOn } from './work'

// Task dependencies, the timeline, the quota brake and push notifications. Agents here have no tmux session, so
// "starting" work means it lands in their queue.

const agent = (id: string, kind: AgentRow['kind'] = 'worker'): AgentRow => ({
  id,
  name: id.toUpperCase(),
  tmux_session: `ao-${id}`,
  cwd: `/tmp/${id}`,
  desk: Math.floor(Math.random() * 1e6),
  role: '',
  model: 'haiku',
  permission_mode: 'default',
  session_id: crypto.randomUUID(),
  created_at: Date.now(),
  kind,
})
const task = (id: string, patch: Partial<OfficeTask> = {}): OfficeTask => ({
  id,
  title: id,
  agentId: 'dep-w',
  projectId: null,
  deadline: Date.now() + 3_600_000,
  priority: 'medium',
  status: 'todo',
  ...patch,
})
const noLimits = () => setRateLimits({ fiveHourPct: 5, sevenDayPct: 5, fiveHourResetsAt: null, sevenDayResetsAt: null })

beforeAll(() => {
  agentsRepo.insert(agent('dep-w'))
  agentsRepo.insert(agent('dep-mgr', 'manager'))
  updateRuntime('dep-w', (rt) => ({ ...rt, status: 'idle' }))
  noLimits()
})

describe('task dependencies', () => {
  test('waits until every blocker is finished (review counts), then starts on its own, once', async () => {
    tasksRepo.put(task('dep-a', { status: 'in_progress' }))
    tasksRepo.put(task('dep-b', { status: 'todo' }))
    tasksRepo.put(task('dep-c', { blockedBy: ['dep-a', 'dep-b'] }))
    expect(waitingOn(tasksRepo.get('dep-c')!).map((t) => t.id)).toEqual(['dep-a', 'dep-b'])

    await tickTasks()
    expect(tasksRepo.get('dep-c')!.autoStartedAt).toBeUndefined()

    tasksRepo.put({ ...tasksRepo.get('dep-a')!, status: 'review' })
    tasksRepo.put({ ...tasksRepo.get('dep-b')!, status: 'done' })
    const queued = queueRepo.countFor('dep-w')
    await tickTasks()
    expect(tasksRepo.get('dep-c')!.autoStartedAt).toBeNumber()
    expect(queueRepo.countFor('dep-w')).toBe(queued + 1)
    expect(commentsRepo.forTask('dep-c').at(-1)!.author).toBe('system')

    await tickTasks()
    expect(queueRepo.countFor('dep-w')).toBe(queued + 1) // not twice
  })

  test('a deleted blocker does not block', () => {
    expect(waitingOn(task('dep-x', { blockedBy: ['gone'] }))).toEqual([])
  })

  test('cycles are detected', () => {
    tasksRepo.put(task('cyc-1', { blockedBy: ['cyc-2'] }))
    tasksRepo.put(task('cyc-2'))
    expect(makesCycle('cyc-2', ['cyc-1'])).toBe(true)
    expect(makesCycle('cyc-3', ['cyc-1'])).toBe(false)
  })

  test('the manager can chain tasks with `after`', async () => {
    tasksRepo.put(task('chain-1', { status: 'in_progress' }))
    const out = await delegateTask('dep-mgr', { agent: 'dep-w', title: 'Test it', description: 'after the build', after: ['chain-1'] })
    expect(out.result).toBe('waiting')
    expect(out.task.blockedBy).toEqual(['chain-1'])
    expect(commentsRepo.forTask(out.task.id)[0].author).toBe('manager')
    await expect(delegateTask('dep-mgr', { agent: 'dep-w', title: 'x', description: 'y', after: ['nope'] })).rejects.toThrow('No task nope')
  })
})

describe('task timeline', () => {
  test('keeps entries in order and caps the length', () => {
    tasksRepo.put(task('tl-1'))
    for (let i = 0; i < 205; i++) addComment({ taskId: 'tl-1', author: 'user', kind: 'note', text: `n${i}` })
    const all = commentsRepo.forTask('tl-1')
    expect(all).toHaveLength(200)
    expect(all[0].text).toBe('n5')
    expect(all.at(-1)!.text).toBe('n204')
  })
})

describe('quota brake', () => {
  afterAll(noLimits)

  test('engages at the threshold and ignores windows that already reset', () => {
    updateSettings({ quota: { enabled: true, threshold: 80 } })
    setRateLimits({ fiveHourPct: 85, sevenDayPct: 10, fiveHourResetsAt: Date.now() / 1000 + 3600, sevenDayResetsAt: null })
    expect(quotaPause()).toContain('5-hour plan limit at 85%')
    setRateLimits({ fiveHourPct: 85, sevenDayPct: 10, fiveHourResetsAt: Date.now() / 1000 - 60, sevenDayResetsAt: null })
    expect(quotaPause()).toBeNull()
    setRateLimits({ fiveHourPct: 10, sevenDayPct: 92, fiveHourResetsAt: null, sevenDayResetsAt: null })
    expect(quotaPause()).toContain('Weekly')
    updateSettings({ quota: { enabled: false } })
    expect(quotaPause()).toBeNull()
    updateSettings({ quota: { enabled: true, threshold: 5 } })
    expect(officeSettings().quota.threshold).toBe(10) // clamped
  })

  test('holds auto-start and skips cron slots while engaged', async () => {
    updateSettings({ quota: { enabled: true, threshold: 80 } })
    setRateLimits({ fiveHourPct: 90, sevenDayPct: 10, fiveHourResetsAt: null, sevenDayResetsAt: null })
    tasksRepo.put(task('brake-1', { autoStart: true }))
    await tickTasks()
    expect(tasksRepo.get('brake-1')!.autoStartedAt).toBeUndefined()

    const out = await delegateTask('dep-mgr', { agent: 'dep-w', title: 'Later', description: 'when usage drops' })
    expect(out.result).toBe('paused')
    expect(out.task.autoStart).toBe(true)

    const now = new Date()
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
    const cron: CronJob = { id: 'brake-cron', name: 'Nightly', prompt: 'go', times: [hhmm], days: [0, 1, 2, 3, 4, 5, 6], agentId: 'dep-w', enabled: true, lastRuns: [] }
    cronsRepo.put(cron)
    const queued = queueRepo.countFor('dep-w')
    await tickCrons(now)
    expect(queueRepo.countFor('dep-w')).toBe(queued)
    expect(cronsRepo.get('brake-cron')!.lastRuns).toHaveLength(1)
    expect(reportsRepo.latest(5).find((r) => r.refId === 'brake-cron')!.text).toStartWith('Skipped')

    noLimits()
    await tickTasks()
    expect(tasksRepo.get('brake-1')!.autoStartedAt).toBeNumber()
    expect(tasksRepo.get(out.task.id)!.autoStartedAt).toBeNumber()
  })
})

describe('notifications', () => {
  test('webhook receives switched-on events only, once per duplicate', async () => {
    const got: any[] = []
    const server = Bun.serve({ port: 0, fetch: async (req) => (got.push(await req.json()), new Response('ok')) })
    process.env.OFFICE_WEBHOOK_URL = `http://127.0.0.1:${server.port}/hook`
    try {
      updateSettings({ notify: { review: true, cronFailed: false }, notifyDetail: 'full' })
      await notify('review', 'Nova finished "Docs"', 'All done')
      await notify('review', 'Nova finished "Docs"', 'All done')
      await notify('cronFailed', 'Cron failed', 'x')
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ event: 'review', title: 'Nova finished "Docs"', text: 'All done' })

      // minimal (the default): the details stay on the server
      updateSettings({ notifyDetail: 'minimal' })
      await notify('review', 'Nova finished "Secrets"', 'token=abc123')
      expect(got[1].text).not.toContain('abc123')
    } finally {
      delete process.env.OFFICE_WEBHOOK_URL
      server.stop(true)
    }
  })
})
