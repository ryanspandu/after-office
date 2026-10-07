import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, commentsRepo, reportsRepo, sideSessionsRepo, tasksRepo, type AgentRow } from '../db'
import { updateRuntime, updateSideRuntime } from '../agents/registry'
import { LOST_REPORT_MS, tickTasks } from './work'
import { updateSettings } from './settings'
import { isTransientApiError, onParallelStopped, ORPHAN_IDLE_MS, parallelBlocker, tidyParallel } from './parallel'

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

  const side = (key: string, patch: Partial<{ name: string; created_at: number }> = {}) => {
    sideSessionsRepo.insert({ agent_id: agent.id, key, tmux_session: `ao-par-w--${key}`, session_id: crypto.randomUUID(), title: null, created_at: patch.created_at ?? Date.now(), closed_at: null })
    if (patch.name) sideSessionsRepo.update(agent.id, key, { name: patch.name })
  }

  test("the main session going idle doesn't touch a task running in a parallel one", async () => {
    side('s4')
    const long = Date.now() - LOST_REPORT_MS * 2
    tasksRepo.put(task('par-busy', { status: 'in_progress', sessionKey: 's4', startedAt: long, folder: third }))
    updateRuntime(agent.id, (r) => ({ ...r, status: 'idle', lastEventAt: Date.now() }))
    updateSideRuntime(agent.id, 's4', (r) => ({ ...r, status: 'working', lastEventAt: Date.now() }))
    await tickTasks()
    expect(tasksRepo.get('par-busy')!.status).toBe('in_progress')
    // its own session quiet and idle that long: review, but it keeps the session (a late report still counts)
    updateSideRuntime(agent.id, 's4', (r) => ({ ...r, status: 'idle', lastEventAt: long }))
    await tickTasks()
    expect(tasksRepo.get('par-busy')!.status).toBe('review')
    expect(tasksRepo.get('par-busy')!.sessionKey).toBe('s4')
  })

  test('a report that comes after the task went to review is still filed', () => {
    expect(onParallelStopped(agent.id, 's4', 'Late but done.', false)).toBe(true)
    const t = tasksRepo.get('par-busy')!
    expect(t.status).toBe('review')
    expect(t.sessionKey).toBeUndefined()
    expect(reportsRepo.latest().some((r) => r.refId === 'par-busy' && r.text === 'Late but done.')).toBe(true)
  })

  test('a turn cut by a connection error carries on instead of failing', () => {
    side('s5')
    tasksRepo.put(task('par-cut', { status: 'in_progress', sessionKey: 's5', startedAt: Date.now(), folder: third }))
    expect(onParallelStopped(agent.id, 's5', 'API Error: Connection lost mid-response. The response above may be incomplete.', true)).toBe(true)
    const t = tasksRepo.get('par-cut')!
    expect(t.status).toBe('in_progress')
    expect(t.sessionKey).toBe('s5')
    expect(reportsRepo.latest().some((r) => r.refId === 'par-cut')).toBe(false)
    expect(commentsRepo.forTask('par-cut').some((c) => /API error/.test(c.text))).toBe(true)
  })

  test("errors that waiting won't fix are not tried again", () => {
    expect(isTransientApiError('API Error: Connection lost mid-response.')).toBe(true)
    expect(isTransientApiError('API Error: 529 Overloaded')).toBe(true)
    expect(isTransientApiError("Claude AI usage limit reached")).toBe(false)
    expect(isTransientApiError('API Error: 400 prompt is too long')).toBe(false)
    expect(isTransientApiError('Done, all tests pass.')).toBe(false)
  })

  test("task sessions with no task left are closed once idle a while; the owner's own aren't", async () => {
    const old = Date.now() - ORPHAN_IDLE_MS * 2
    side('s6', { name: 'Task: gone', created_at: old })
    side('s7', { name: 'orenjus', created_at: old })
    updateSideRuntime(agent.id, 's6', (r) => ({ ...r, status: 'idle', lastEventAt: old }))
    updateSideRuntime(agent.id, 's7', (r) => ({ ...r, status: 'idle', lastEventAt: old }))
    tidyParallel()
    await Bun.sleep(300)
    expect(sideSessionsRepo.get(agent.id, 's6')!.closed_at).not.toBeNull()
    expect(sideSessionsRepo.get(agent.id, 's7')!.closed_at).toBeNull()
  })
})
