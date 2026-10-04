import { expect, test } from 'bun:test'
import { reportsRepo } from '../db'
import { markReports, removeReports } from './work'

// Reports → pick several → Read / Unread / Delete: one call for all of them, unknown ids skipped, bad input refused.

const mk = (id: string, read = false) =>
  reportsRepo.put({ id, kind: 'task', refId: id, agentId: 'a', title: id, text: 'x', startedAt: 1, finishedAt: Date.now(), read } as never)

test('mark several read, then unread; only those that change count', () => {
  mk('bulk-1')
  mk('bulk-2', true)
  expect(markReports(['bulk-1', 'bulk-2', 'nope'], true)).toBe(1)
  expect(reportsRepo.get('bulk-1')?.read).toBe(true)
  expect(markReports(['bulk-1', 'bulk-2'], false)).toBe(2)
  expect(reportsRepo.get('bulk-2')?.read).toBe(false)
})

test('delete several at once; unknown ids skipped', () => {
  mk('bulk-3')
  mk('bulk-4')
  expect(removeReports(['bulk-3', 'bulk-4', 'bulk-3', 'gone'])).toBe(2)
  expect(reportsRepo.get('bulk-3')).toBeNull()
  expect(reportsRepo.get('bulk-4')).toBeNull()
})

test('refuses what is not a list of ids', () => {
  expect(() => removeReports('bulk-1')).toThrow('ids')
  expect(() => markReports([1, 2], true)).toThrow('ids')
  expect(() => removeReports(Array.from({ length: 501 }, (_, i) => `x${i}`))).toThrow('ids')
})

test('a job on many: runs in steps on the server, shows in the work state, one at a time', async () => {
  const { startReportJob, reportJob, workState } = await import('./work')
  const ids = Array.from({ length: 12 }, (_, i) => `job-${i}`)
  for (const id of ids) mk(id)
  const job = startReportJob('delete', ids)
  expect(job.ids).toEqual(ids)
  expect(workState().reportJob?.id).toBe(job.id)
  expect(() => startReportJob('read', ['job-0'])).toThrow('still running')
  // it ends on its own (steps 60 ms apart, then the rows fold away)
  for (let i = 0; i < 60 && reportJob(); i++) await new Promise((r) => setTimeout(r, 50))
  expect(reportJob()).toBeNull()
  for (const id of ids) expect(reportsRepo.get(id)).toBeNull()
})

test('a job refuses a bad kind or no reports', async () => {
  const { startReportJob } = await import('./work')
  expect(() => startReportJob('archive', ['x'])).toThrow('kind')
  expect(() => startReportJob('read', [])).toThrow('at least one')
})

test('old reports get a tag added or taken off; unchanged ones are not counted', async () => {
  const { retagReports } = await import('./work')
  mk('tag-1')
  reportsRepo.put({ ...reportsRepo.get('tag-1')!, tags: ['a'] })
  mk('tag-2')
  expect(retagReports(['tag-1', 'tag-2', 'missing'], ['b'], [])).toBe(2)
  expect(reportsRepo.get('tag-1')?.tags).toEqual(['a', 'b'])
  expect(reportsRepo.get('tag-2')?.tags).toEqual(['b'])
  expect(retagReports(['tag-1'], ['b'], [])).toBe(0)
  expect(retagReports(['tag-1', 'tag-2'], [], ['b', 'a'])).toBe(2)
  expect(reportsRepo.get('tag-2')?.tags).toBeUndefined()
})
