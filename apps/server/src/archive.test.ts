import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { gunzipSync } from 'bun'
import { rmSync } from 'node:fs'
import type { OfficeTask } from '@after-office/shared'
import { ARCHIVE_DAYS, db, tasksRepo } from './db'
import { backupNow, BACKUP_DIR } from './backup'
import { workState } from './work/work'

const task = (id: string, status: OfficeTask['status'], title = id): OfficeTask => ({
  id,
  title,
  agentId: null,
  projectId: null,
  deadline: Date.now(),
  priority: 'medium',
  status,
})
const age = (id: string, days: number) => db.query('UPDATE tasks SET updated_at = ?2 WHERE id = ?1').run(id, Date.now() - days * 86_400_000)

describe('task archive', () => {
  test('old done tasks leave the dashboard state, everything else stays', () => {
    tasksRepo.put(task('arc-old-done', 'done', 'Old report'))
    tasksRepo.put(task('arc-new-done', 'done'))
    tasksRepo.put(task('arc-old-todo', 'todo'))
    age('arc-old-done', ARCHIVE_DAYS + 1)
    age('arc-old-todo', ARCHIVE_DAYS + 1)

    const ids = workState().tasks.map((t) => t.id)
    expect(ids).toContain('arc-new-done')
    expect(ids).toContain('arc-old-todo') // not done: never archived
    expect(ids).not.toContain('arc-old-done')
    expect(workState().archivedTasks).toBe(1)
    expect(tasksRepo.get('arc-old-done')).not.toBeNull() // still in the DB
  })

  test('search and paging', () => {
    expect(tasksRepo.archived({ q: 'report' }).tasks.map((t) => t.id)).toEqual(['arc-old-done'])
    expect(tasksRepo.archived({ q: 'nope' }).total).toBe(0)
    expect(tasksRepo.archived({ offset: 1 }).tasks).toHaveLength(0)
  })

  test('restore brings it back', () => {
    expect(tasksRepo.touch('arc-old-done')).toBe(true)
    expect(workState().tasks.map((t) => t.id)).toContain('arc-old-done')
    expect(workState().archivedTasks).toBe(0)
    expect(tasksRepo.touch('missing')).toBe(false)
  })
})

describe('backup', () => {
  test('writes a gzipped, readable copy of the database', async () => {
    const file = await backupNow()
    expect(file.startsWith(BACKUP_DIR)).toBe(true)
    const raw = `${file}.check.db`
    await Bun.write(raw, gunzipSync(await Bun.file(file).bytes()))
    const copy = new Database(raw, { readonly: true })
    expect(copy.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tasks').get()!.n).toBe(tasksRepo.count())
    copy.close()
    rmSync(raw)
  })
})
