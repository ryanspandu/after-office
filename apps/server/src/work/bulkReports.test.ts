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
