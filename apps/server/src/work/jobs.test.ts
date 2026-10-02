import { afterAll, describe, expect, test } from 'bun:test'
import type { OfficeTask } from '@after-office/shared'
import { tasksRepo } from '../db'
import { jobForTask, jobNamed } from './jobs'

// Jobs: one request's tasks under one name, so their reports read as one item.

const task = (id: string, patch: Partial<OfficeTask> = {}): OfficeTask => ({
  id,
  title: id,
  agentId: null,
  deadline: Date.now() + 3_600_000,
  priority: 'medium',
  status: 'todo',
  createdAt: Date.now(),
  ...patch,
})
afterAll(() => ['job-a', 'job-b'].forEach((id) => tasksRepo.remove(id)))

describe('jobs', () => {
  test('the same name (any case, extra spaces) is the same job', () => {
    const first = jobNamed('Artikel TV Stand')!
    tasksRepo.put(task('job-a', { job: first }))
    expect(jobNamed('  artikel  tv stand ')!.id).toBe(first.id)
    expect(jobNamed('Artikel Modular Storage')!.id).not.toBe(first.id)
    expect(jobNamed('   ')).toBeUndefined()
  })

  test('a step chained with `after` joins the job of the step before it', () => {
    const job = tasksRepo.get('job-a')!.job!
    expect(jobForTask(undefined, ['job-a'])).toEqual(job)
    tasksRepo.put(task('job-b'))
    expect(jobForTask(undefined, ['job-b'])).toBeUndefined()
    // a name given wins
    expect(jobForTask('Something else', ['job-a'])!.id).not.toBe(job.id)
  })
})
