import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, reportsRepo, sideSessionsRepo, tasksRepo, type AgentRow } from '../db'
import { updateSettings } from './settings'
import { onParallelStopped, parallelBlocker, tidyParallel } from './parallel'

// Parallel sessions: when a busy agent's task may start next to its other work, and what its end does.

const dir = mkdtempSync(join(tmpdir(), 'ao-par-'))
const own = join(dir, 'own')
const other = join(dir, 'other')
const third = join(dir, 'third')
for (const d of [own, other, third]) mkdirSync(d)

const agent: AgentRow = {
  id: 'par-w',
  name: 'PAR',
  tmux_session: 'ao-par-w',
  cwd: own,
  desk: Math.floor(Math.random() * 1e6),
  role: '',
  model: 'haiku',
  permission_mode: 'default',
  session_id: crypto.randomUUID(),
  created_at: Date.now(),
  kind: 'worker',
}
const task = (id: string, patch: Partial<OfficeTask> = {}): OfficeTask => ({
  id,
  title: id,
  agentId: agent.id,
  deadline: Date.now() + 3_600_000,
  priority: 'medium',
  status: 'todo',
  parallel: true,
  folder: other,
  ...patch,
})

beforeAll(() => agentsRepo.insert(agent))
afterAll(() => {
  for (const t of tasksRepo.active().filter((x) => x.agentId === agent.id)) tasksRepo.remove(t.id)
  for (const s of sideSessionsRepo.forAgent(agent.id)) sideSessionsRepo.remove(agent.id, s.key)
  agentsRepo.remove(agent.id)
  updateSettings({ parallelSessions: 0 })
})

describe('parallel sessions', () => {
  test('off by default: the task waits in the queue', () => {
    updateSettings({ parallelSessions: 0 })
    expect(parallelBlocker(task('par-a'), agent.id)).toContain('off')
  })

  test('allowed for another folder, not for the one the agent is busy in', () => {
    updateSettings({ parallelSessions: 1 })
    expect(parallelBlocker(task('par-a'), agent.id)).toBeNull()
    expect(parallelBlocker(task('par-a', { folder: undefined }), agent.id)).toContain('overlaps')
    expect(parallelBlocker(task('par-a', { folder: join(own) }), agent.id)).toContain('overlaps')
    expect(parallelBlocker(task('par-a', { parallel: undefined }), agent.id)).toContain('not marked')
  })

  test('at most the limit per agent, and never two in the same folder', () => {
    updateSettings({ parallelSessions: 1 })
    tasksRepo.put(task('par-run', { status: 'in_progress', sessionKey: 's2', startedAt: Date.now() }))
    expect(parallelBlocker(task('par-b', { folder: third }), agent.id)).toContain('already 1')
    updateSettings({ parallelSessions: 2 })
    expect(parallelBlocker(task('par-b', { folder: third }), agent.id)).toBeNull()
    expect(parallelBlocker(task('par-b', { folder: other }), agent.id)).toContain('overlaps')
  })

  test("its turn's end: report filed, task in review, out of its session", () => {
    sideSessionsRepo.insert({ agent_id: agent.id, key: 's2', tmux_session: 'ao-par-w--s2', session_id: crypto.randomUUID(), title: null, created_at: Date.now(), closed_at: null })
    expect(onParallelStopped(agent.id, 's2', 'All done.', false)).toBe(true)
    const t = tasksRepo.get('par-run')!
    expect(t.status).toBe('review')
    expect(t.sessionKey).toBeUndefined()
    expect(reportsRepo.latest().some((r) => r.refId === 'par-run' && r.text === 'All done.')).toBe(true)
    // the owner's own chat in a side session isn't a task's
    expect(onParallelStopped(agent.id, 's3', 'hi', false)).toBe(false)
  })

  test('a parallel session that closed early: its task back to To do', () => {
    tasksRepo.put(task('par-gone', { status: 'in_progress', sessionKey: 's9', startedAt: Date.now() }))
    tidyParallel()
    const t = tasksRepo.get('par-gone')!
    expect(t.status).toBe('todo')
    expect(t.sessionKey).toBeUndefined()
  })
})
