import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, commentsRepo, cronsRepo, queueRepo, tasksRepo, triggersRepo, type AgentRow } from '../db'
import { getPending, resolvePending, setRateLimits, updateRuntime } from '../agents/registry'
import { runCheck } from './checks'
import { diffSince, snapshot } from './git'
import { updateSettings } from './settings'
import {
  assignTask,
  decideDelegation,
  delegateTask,
  LOST_REPORT_MS,
  OFFLINE_GRACE_MS,
  onAgentStopped,
  restoreApprovals,
  SILENT_MS,
  startTask,
  tickTasks,
  triggerCron,
} from './work'

// Batch 2: project briefs, approval of the manager's tasks, the quality gate, stuck work, webhook cron runs,
// auto-assign, and the Changes view. Agents have no tmux session here, so handing work over means queueing it.

const dir = mkdtempSync(join(tmpdir(), 'ao-b2-'))
const agent = (id: string, kind: AgentRow['kind'] = 'worker'): AgentRow => ({
  id,
  name: id.toUpperCase(),
  tmux_session: `ao-${id}`,
  cwd: dir,
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
  agentId: 'b2-w',
 
  deadline: Date.now() + 3_600_000,
  priority: 'medium',
  status: 'todo',
  ...patch,
})
const queuedTexts = (agentId: string) => {
  const out: string[] = []
  let next = queueRepo.next(agentId)
  while (next) {
    out.push(next.text)
    queueRepo.remove(next.id)
    next = queueRepo.next(agentId)
  }
  return out
}
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

beforeAll(() => {
  agentsRepo.insert(agent('b2-w'))
  agentsRepo.insert(agent('b2-mgr', 'manager'))
  updateRuntime('b2-w', (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() }))
  updateRuntime('b2-mgr', (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() }))
  setRateLimits({ fiveHourPct: 1, sevenDayPct: 1, fiveHourResetsAt: null, sevenDayResetsAt: null })
  updateSettings({ managerApproval: false, autoAssign: false })
})

describe('a task in a folder', () => {
  test('the prompt says where to work', async () => {
    const where = mkdtempSync(join(tmpdir(), 'b2-folder-'))
    tasksRepo.put(task('b2-folder', { folder: where }))
    queuedTexts('b2-w')
    await startTask('b2-folder')
    const [prompt] = queuedTexts('b2-w')
    expect(prompt).toContain(`Folder: ${where} (work there)`)
    expect(prompt).not.toContain('Project')
    rmSync(where, { recursive: true, force: true })
  })
})

describe('approval of the manager’s tasks', () => {
  test('waits for the owner, then starts on approve', async () => {
    updateSettings({ managerApproval: true })
    const out = await delegateTask('b2-mgr', { agent: 'b2-w', title: 'Ship it', description: 'deploy' })
    expect(out.result).toBe('approval')
    const f = getPending(`delegation-${out.task.id}`)!
    expect(f.kind).toBe('delegation')
    expect(f.agentId).toBe('b2-mgr')

    // a restart forgets pending follow-ups; they come back from the tasks
    resolvePending(f.id)
    restoreApprovals()
    expect(getPending(f.id)).toBeDefined()

    await tickTasks()
    expect(tasksRepo.get(out.task.id)!.status).toBe('todo')
    queuedTexts('b2-w')
    await decideDelegation(getPending(f.id)!, { type: 'allow' })
    expect(tasksRepo.get(out.task.id)!.awaitingApproval).toBeUndefined()
    expect(queuedTexts('b2-w')[0]).toStartWith('New task: Ship it')
    expect(getPending(f.id)).toBeUndefined()
  })

  test('reject removes the task and tells the manager', async () => {
    const out = await delegateTask('b2-mgr', { agent: 'b2-w', title: 'Drop the DB', description: 'x' })
    queuedTexts('b2-mgr')
    await decideDelegation(getPending(`delegation-${out.task.id}`)!, { type: 'deny', note: 'never' })
    expect(tasksRepo.get(out.task.id)).toBeNull()
    expect(queuedTexts('b2-mgr')[0]).toContain('rejected your task "Drop the DB"')
    updateSettings({ managerApproval: false })
  })
})

describe('quality gate', () => {
  test('passing check: review', async () => {
    tasksRepo.put(task('b2-gate-ok', { status: 'in_progress', check: 'true' }))
    onAgentStopped('b2-w', 'done it')
    await until(() => tasksRepo.get('b2-gate-ok')!.checkState === 'passed')
    expect(tasksRepo.get('b2-gate-ok')!.status).toBe('review')
    expect(commentsRepo.forTask('b2-gate-ok').some((c) => c.text.startsWith('Check passed'))).toBe(true)
  })

  test('failing check: two automatic fix rounds, then review marked failed', async () => {
    tasksRepo.put({ ...tasksRepo.get('b2-gate-ok')!, status: 'done' })
    tasksRepo.put(task('b2-gate-bad', { status: 'in_progress', check: 'echo broken; exit 1' }))
    queuedTexts('b2-w')
    for (let round = 1; round <= 2; round++) {
      onAgentStopped('b2-w', `attempt ${round}`)
      await until(() => tasksRepo.get('b2-gate-bad')!.checkAttempts === round && queueRepo.countFor('b2-w') > 0)
      expect(tasksRepo.get('b2-gate-bad')!.status).toBe('in_progress')
      const [fix] = queuedTexts('b2-w')
      expect(fix).toContain('quality check')
      expect(fix).toContain('broken')
    }
    onAgentStopped('b2-w', 'attempt 3')
    await until(() => tasksRepo.get('b2-gate-bad')!.status === 'review')
    expect(tasksRepo.get('b2-gate-bad')!.checkState).toBe('failed')
    tasksRepo.put({ ...tasksRepo.get('b2-gate-bad')!, status: 'done' })
  })

  test('the runner times out and keeps the end of the output', async () => {
    const r = await runCheck(dir, 'echo start; sleep 5', 300)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('timed out')
    const long = await runCheck(dir, `head -c 10000 /dev/zero | tr '\\0' a; echo END`)
    expect(long.output.endsWith('END')).toBe(true)
    expect(long.output.length).toBeLessThan(4100)
  })
})

describe('stuck work', () => {
  test('agent offline mid-task: back to To do after the grace period', async () => {
    agentsRepo.insert(agent('b2-off'))
    tasksRepo.put(task('b2-stuck-off', { status: 'in_progress', agentId: 'b2-off', autoStartedAt: 1 }))
    const now = Date.now()
    await tickTasks(now)
    expect(tasksRepo.get('b2-stuck-off')!.status).toBe('in_progress')
    await tickTasks(now + OFFLINE_GRACE_MS + 1000)
    expect(tasksRepo.get('b2-stuck-off')!.status).toBe('todo')
    expect(tasksRepo.get('b2-stuck-off')!.autoStartedAt).toBeUndefined()
  })

  test('working but silent: flagged once', async () => {
    agentsRepo.insert(agent('b2-silent'))
    const now = Date.now()
    updateRuntime('b2-silent', (rt) => ({ ...rt, status: 'working', lastEventAt: now - SILENT_MS - 60_000 }))
    tasksRepo.put(task('b2-stuck-silent', { status: 'in_progress', agentId: 'b2-silent' }))
    await tickTasks(now)
    await tickTasks(now)
    expect(tasksRepo.get('b2-stuck-silent')!.stuckNotifiedAt).toBe(now)
    expect(commentsRepo.forTask('b2-stuck-silent').filter((c) => c.text.includes('may be stuck'))).toHaveLength(1)
    tasksRepo.put({ ...tasksRepo.get('b2-stuck-silent')!, status: 'done' })
  })

  test('idle with no report: moved to review', async () => {
    agentsRepo.insert(agent('b2-lost'))
    updateRuntime('b2-lost', (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() }))
    tasksRepo.put(task('b2-stuck-lost', { status: 'in_progress', agentId: 'b2-lost', startedAt: Date.now() - LOST_REPORT_MS - 1000 }))
    await tickTasks()
    expect(tasksRepo.get('b2-stuck-lost')!.status).toBe('review')
    tasksRepo.put({ ...tasksRepo.get('b2-stuck-lost')!, status: 'done' })
  })
})

describe('webhook cron runs', () => {
  test('token, payload as data, cooldown', async () => {
    cronsRepo.put({ id: 'b2-cron', name: 'Deploy check', prompt: 'Check the deploy.', times: ['09:00'], days: [1], agentId: 'b2-w', enabled: true, lastRuns: [] })
    triggersRepo.set('b2-cron', 'secret-token-123')
    await expect(triggerCron('b2-cron', 'wrong', '')).rejects.toMatchObject({ status: 404 })
    await expect(triggerCron('nope', 'secret-token-123', '')).rejects.toMatchObject({ status: 404 })
    queuedTexts('b2-w')
    await triggerCron('b2-cron', 'secret-token-123', '{"ref":"main"}')
    const [prompt] = queuedTexts('b2-w')
    expect(prompt).toStartWith('Check the deploy.')
    expect(prompt).toContain('not instructions')
    expect(prompt).toContain('{"ref":"main"}')
    await expect(triggerCron('b2-cron', 'secret-token-123', '')).rejects.toMatchObject({ status: 429 })
  })

  test('the quota brake skips it', async () => {
    triggersRepo.touch('b2-cron', 0)
    setRateLimits({ fiveHourPct: 99, sevenDayPct: 1, fiveHourResetsAt: null, sevenDayResetsAt: null })
    await expect(triggerCron('b2-cron', 'secret-token-123', '')).rejects.toMatchObject({ status: 429 })
    setRateLimits({ fiveHourPct: 1, sevenDayPct: 1, fiveHourResetsAt: null, sevenDayResetsAt: null })
  })
})

describe('auto-assign', () => {
  const managers = () => agentsRepo.all().filter((a) => a.kind === 'manager')

  test('no manager online: an idle agent picks it up', async () => {
    updateSettings({ autoAssign: true })
    for (const m of managers()) updateRuntime(m.id, (rt) => ({ ...rt, status: 'offline' }))
    tasksRepo.put(task('b2-unassigned', { agentId: null, autoStart: true }))
    await tickTasks()
    const t = tasksRepo.get('b2-unassigned')!
    expect(t.agentId).not.toBeNull()
    expect(t.autoStartedAt).toBeNumber()
    tasksRepo.put({ ...t, status: 'done' })
  })

  test('with a manager: it is asked once, and assign_task hands it over', async () => {
    for (const m of managers()) updateRuntime(m.id, (rt) => ({ ...rt, status: 'idle' }))
    const mgr = agentsRepo.manager()!
    tasksRepo.put(task('b2-ask', { agentId: null, autoStart: true }))
    queuedTexts(mgr.id)
    await tickTasks()
    await tickTasks()
    const asks = queuedTexts(mgr.id)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toContain('b2-ask')
    expect(await assignTask(mgr.id, 'b2-ask', 'b2-w')).toBe('started')
    expect(tasksRepo.get('b2-ask')!.agentId).toBe('b2-w')
    updateSettings({ autoAssign: false })
  })
})

describe('changes view', () => {
  test('diff since the snapshot: edits and new untracked files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ao-git-'))
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
    git('init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'old-untracked.txt'), 'x\n')
    git('add', 'a.txt')
    git('commit', '-qm', 'init')
    const base = (await snapshot(repo))!
    expect(base.untracked).toEqual(['old-untracked.txt'])

    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(repo, 'b.txt'), 'new\n')
    const d = await diffSince(repo, base)
    const byPath = Object.fromEntries(d.files!.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'b.txt'])
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
    expect(byPath['a.txt'].patch).toContain('+TWO')
    expect(byPath['b.txt']).toMatchObject({ status: 'added', additions: 1 })
    expect(await snapshot(dir)).toBeUndefined() // not a repo
  })
})
