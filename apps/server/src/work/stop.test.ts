import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, commentsRepo, queueRepo, reportsRepo, tasksRepo, type AgentRow } from '../db'
import { TMUX_SOCKET_ARGS } from '../agents/env'
import { setRateLimits, updateRuntime } from '../agents/registry'
import { updateSettings } from './settings'
import { active, onPromptSubmitted, resumeTask, startTask, stopActiveTask } from './work'

// Stopping an agent partway through a task (the owner's Stop, the manager's interrupt_agent / stop_task): the task goes
// back to To do at once, marked stopped, with a note and a report; Resume gives it to the same agent again.

const dir = mkdtempSync(join(tmpdir(), 'ao-stop-'))
const tmux = (...args: string[]) => Bun.spawnSync([process.env.TMUX_BIN ?? 'tmux', ...TMUX_SOCKET_ARGS, ...args])
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
  agentId: 'st-w',
  deadline: Date.now() + 3_600_000,
  priority: 'medium',
  status: 'todo',
  ...patch,
})
const idle = (id: string) => updateRuntime(id, (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() }))
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(20)
  }
}
const inbox = () => {
  const out: string[] = []
  for (let next = queueRepo.next('st-mgr'); next; next = queueRepo.next('st-mgr')) {
    out.push(next.text)
    queueRepo.remove(next.id)
  }
  return out
}

beforeAll(() => {
  agentsRepo.insert(agent('st-w'))
  agentsRepo.insert(agent('st-mgr', 'manager')) // no session: what it's sent is queued, so the test can read it
  tmux('new-session', '-d', '-s', 'ao-st-w', 'sleep 300')
  setRateLimits({ fiveHourPct: 1, sevenDayPct: 1, fiveHourResetsAt: null, sevenDayResetsAt: null })
  updateSettings({ managerApproval: false, autoAssign: false })
})
afterAll(() => void tmux('kill-server'))

test('the owner stops a task partway: To do now, stopped, a report for the manager; Resume takes it up again', async () => {
  idle('st-w')
  tasksRepo.put(task('st-1', { title: 'Write the landing page', delegatedBy: 'st-mgr' }))
  await startTask('st-1')
  await until(() => tasksRepo.get('st-1')!.status === 'in_progress')
  onPromptSubmitted('st-w', 'New task: Write the landing page')

  const stopped = stopActiveTask('st-w', { author: 'user' })
  expect(stopped?.id).toBe('st-1')
  const t = tasksRepo.get('st-1')!
  expect(t.status).toBe('todo')
  expect(t.stoppedAt).toBeGreaterThan(0)
  expect(active.has('st-w')).toBe(false)
  expect(commentsRepo.forTask('st-1').some((c) => c.text.startsWith('Stopped by the owner. Back in To do'))).toBe(true)
  expect(reportsRepo.latest(50).find((r) => r.refId === 'st-1')?.text).toContain('Stopped by the owner')
  // the manager follows its task up: it hears
  await until(() => queueRepo.countFor('st-mgr') > 0)
  expect(inbox().join('\n')).toContain('Stopped by the owner')
  // nothing running any more: a second stop finds nothing
  expect(stopActiveTask('st-w', { author: 'user' })).toBeNull()

  idle('st-w')
  await resumeTask('st-1')
  const again = tasksRepo.get('st-1')!
  expect(again.status).toBe('in_progress')
  expect(again.stoppedAt).toBeUndefined()
  expect(active.get('st-w')?.taskId).toBe('st-1')
  // only a task back in To do can be resumed
  await expect(resumeTask('st-1')).rejects.toThrow('Only a stopped task')
})

test('the manager stops it: back in To do with its reason, and no report back to the manager about it', async () => {
  // still running from the test before
  onPromptSubmitted('st-w', 'Resume the task: Write the landing page')
  inbox()
  stopActiveTask('st-w', { author: 'manager', agentId: 'st-mgr' }, 'the owner changed the brief')
  expect(tasksRepo.get('st-1')!.status).toBe('todo')
  expect(commentsRepo.forTask('st-1').some((c) => c.text.startsWith('Stopped by the manager (the owner changed the brief)'))).toBe(true)
  await Bun.sleep(300)
  expect(inbox()).toHaveLength(0)
})
