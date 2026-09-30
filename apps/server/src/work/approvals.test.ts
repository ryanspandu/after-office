import { describe, expect, test } from 'bun:test'
import type { LiveFollowUp, OfficeTask } from '@after-office/shared'
import { agentsRepo, queueRepo, tasksRepo } from '../db'
import { addPending } from '../agents/registry'
import { decideCheck, decideDelegation } from './work'

// Notes the owner writes when approving the manager's requests reach whoever needs them.

const mgr = { id: 'ap-mgr', name: 'Boss', tmux_session: 'ao-ap-mgr', cwd: '/tmp/ap-mgr', desk: 971, role: '', model: 'haiku', permission_mode: 'default' as const, session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'manager' as const }
const task = (id: string, patch: Partial<OfficeTask> = {}): OfficeTask => ({ id, title: id, agentId: null, projectId: null, deadline: Date.now() + 3_600_000, priority: 'medium', status: 'todo', delegatedBy: 'ap-mgr', ...patch })
const follow = (id: string, kind: LiveFollowUp['kind'], taskId: string): LiveFollowUp => {
  const f = { id, agentId: 'ap-mgr', kind, tool: kind, message: id, input: { taskId }, createdAt: Date.now() }
  addPending(f)
  return f
}
// the office's manager (other test files may have put one in first)
const inbox = () => {
  const id = agentsRepo.manager()!.id
  const out: string[] = []
  for (let n = queueRepo.next(id); n; n = queueRepo.next(id)) {
    out.push(n.text)
    queueRepo.remove(n.id)
  }
  return out
}

describe('approval notes', () => {
  test("approving the manager's task with a note: the note goes into the task the agent gets", async () => {
    agentsRepo.insert(mgr)
    tasksRepo.put(task('ap-t1', { description: 'Write the landing page', awaitingApproval: true }))
    await decideDelegation(follow('ap-f1', 'delegation', 'ap-t1'), { type: 'allow', note: 'Use Next.js' })
    expect(tasksRepo.get('ap-t1')!.description).toBe('Write the landing page\n\nNote from the owner: Use Next.js')
    expect(tasksRepo.get('ap-t1')!.awaitingApproval).toBeUndefined()
  })

  test('approving a quality check with a note tells the manager; without a note it stays quiet', async () => {
    tasksRepo.put(task('ap-t2', { pendingCheck: 'bun test' }))
    await decideCheck(follow('ap-f2', 'check', 'ap-t2'), { type: 'allow', note: 'Also run the linter next time' })
    expect(tasksRepo.get('ap-t2')!.check).toBe('bun test')
    const [msg] = inbox()
    expect(msg).toContain('approved the quality check `bun test`')
    expect(msg).toContain('Also run the linter next time')

    tasksRepo.put(task('ap-t3', { pendingCheck: 'bun lint' }))
    await decideCheck(follow('ap-f3', 'check', 'ap-t3'), { type: 'allow' })
    expect(inbox()).toEqual([])
    for (const id of ['ap-t1', 'ap-t2', 'ap-t3']) tasksRepo.remove(id)
    agentsRepo.remove('ap-mgr')
  })
})
