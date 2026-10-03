import { afterAll, describe, expect, test } from 'bun:test'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, tasksRepo, type AgentRow } from '../db'
import { ownerTask, startTask, waitingOn } from './work'

// The owner's own tasks: tracked like the rest, never sent to an agent, and other tasks can wait for them.

const manager: AgentRow = {
  id: 'own-mgr',
  name: 'MGR',
  tmux_session: 'ao-own-mgr',
  cwd: '/tmp',
  desk: Math.floor(Math.random() * 1e6),
  role: '',
  model: 'haiku',
  permission_mode: 'default',
  session_id: crypto.randomUUID(),
  created_at: Date.now(),
  kind: 'manager',
}
agentsRepo.insert(manager)
const made: string[] = []
afterAll(() => {
  made.forEach((id) => tasksRepo.remove(id))
  agentsRepo.remove(manager.id)
})

describe("the owner's own tasks", () => {
  test('the manager gives the owner a task: theirs, no agent, never started on one', async () => {
    const t = ownerTask(manager.id, { title: 'Approve the TV Stand article', job: 'Artikel TV Stand' })
    made.push(t.id)
    expect(t.forOwner).toBe(true)
    expect(t.agentId).toBeNull()
    expect(t.delegatedBy).toBe(manager.id)
    expect(t.job?.title).toBe('Artikel TV Stand')
    await expect(startTask(t.id)).rejects.toThrow('your own task')
  })

  test("an agent's task waits for the owner's, until they mark it done", () => {
    const mine = ownerTask(manager.id, { title: 'Upload the logo' })
    made.push(mine.id)
    const next: OfficeTask = { id: 'own-next', title: 'Publish', agentId: null, deadline: Date.now() + 3_600_000, priority: 'medium', status: 'todo', blockedBy: [mine.id] }
    tasksRepo.put(next)
    made.push(next.id)
    expect(waitingOn(next).map((t) => t.id)).toEqual([mine.id])
    tasksRepo.put({ ...tasksRepo.get(mine.id)!, status: 'done' })
    expect(waitingOn(next)).toHaveLength(0)
  })
})
