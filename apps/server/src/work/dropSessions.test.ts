import { expect, test } from 'bun:test'
import type { WorkReport } from '@after-office/shared'
import { commentsRepo, reportsRepo, tasksRepo } from '../db'
import { addComment, dropProjectSessions } from './work'

// The project page's "sessions" are gone: what they left is deleted once (the owner's choice), nothing else.

test('old project-page sessions go with their comments and reports, and every hidden report; other work stays', () => {
  const base = { agentId: null, projectId: null, deadline: Date.now(), priority: 'low' as const, status: 'review' as const }
  tasksRepo.put({ ...base, id: 'ds-old', title: 'halo', session: true } as never)
  tasksRepo.put({ ...base, id: 'ds-keep', title: 'Real work' })
  addComment({ taskId: 'ds-old', author: 'user', text: 'x' })
  const report = (id: string, refId: string, extra = {}): WorkReport => ({ id, kind: 'task', refId, title: 't', agentId: 'a', text: 'x', ok: true, startedAt: 1, finishedAt: 2, read: false, ...extra })
  reportsRepo.put(report('ds-r1', 'ds-old'))
  reportsRepo.put(report('ds-r2', 'ds-keep', { hidden: true }))
  reportsRepo.put(report('ds-r3', 'ds-keep'))
  dropProjectSessions()
  expect(tasksRepo.get('ds-old')).toBeNull()
  expect(commentsRepo.forTask('ds-old')).toHaveLength(0)
  expect(reportsRepo.get('ds-r1')).toBeNull()
  expect(reportsRepo.get('ds-r2')).toBeNull()
  expect(tasksRepo.get('ds-keep')).not.toBeNull()
  expect(reportsRepo.get('ds-r3')).not.toBeNull()
  tasksRepo.remove('ds-keep')
  reportsRepo.remove('ds-r3')
})
