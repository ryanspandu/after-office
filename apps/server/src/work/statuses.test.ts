import { afterAll, describe, expect, test } from 'bun:test'
import type { OfficeTask } from '@after-office/shared'
import { settingsRepo, tasksRepo } from '../db'
import { cleanCustomStatus, cleanStatuses, DEFAULT_STATUSES, saveStatuses, statusLabel, taskStatuses } from './statuses'

// The owner's task statuses: built-in ones renamed and kept, their own counting as one of them.

afterAll(() => {
  settingsRepo.set('taskStatuses', JSON.stringify(DEFAULT_STATUSES))
  tasksRepo.remove('st-task')
})

describe('task statuses', () => {
  test('the built-in ones can be renamed and moved, never removed', () => {
    const renamed = DEFAULT_STATUSES.map((s) => (s.id === 'todo' ? { ...s, label: 'Backlog' } : s)).reverse()
    expect(cleanStatuses(renamed).map((s) => s.label)).toContain('Backlog')
    expect(() => cleanStatuses(DEFAULT_STATUSES.filter((s) => s.id !== 'review'))).toThrow('renamed, not removed')
    // a built-in one keeps its own meaning whatever is sent
    expect(cleanStatuses([...DEFAULT_STATUSES.slice(0, 3), { ...DEFAULT_STATUSES[3], base: 'todo' }]).find((s) => s.id === 'done')!.base).toBe('done')
  })

  test("the owner's own: a new id, and it must say what it counts as", () => {
    const list = cleanStatuses([...DEFAULT_STATUSES, { label: 'Blocked', color: '#e05252', base: 'todo' }])
    const blocked = list.find((s) => s.label === 'Blocked')!
    expect(blocked.id).toMatch(/^st-/)
    expect(() => cleanStatuses([...DEFAULT_STATUSES, { label: 'Nope', color: '#000000' }])).toThrow('counts as')
  })

  test('a task shows in its own status only while that counts as its built-in one; a removed one lets go', () => {
    const list = saveStatuses([...DEFAULT_STATUSES, { label: 'Blocked', color: '#e05252', base: 'todo' }])
    const blocked = list.find((s) => s.label === 'Blocked')!
    expect(cleanCustomStatus(blocked.id, 'todo')).toBe(blocked.id)
    expect(cleanCustomStatus(blocked.id, 'in_progress')).toBeUndefined()
    expect(statusLabel('todo', blocked.id)).toBe('Blocked')
    expect(statusLabel('in_progress', blocked.id)).toBe('In progress')
    const t: OfficeTask = { id: 'st-task', title: 'x', agentId: null, deadline: 0, priority: 'medium', status: 'todo', customStatus: blocked.id }
    tasksRepo.put(t)
    // moved on the board: it now works like in progress, and its task goes with it
    saveStatuses([...DEFAULT_STATUSES, { ...blocked, base: 'in_progress' }])
    expect(tasksRepo.get('st-task')!.status).toBe('in_progress')
    expect(tasksRepo.get('st-task')!.customStatus).toBe(blocked.id)
    saveStatuses(DEFAULT_STATUSES)
    expect(tasksRepo.get('st-task')!.customStatus).toBeUndefined()
    expect(taskStatuses()).toHaveLength(4)
  })
})
