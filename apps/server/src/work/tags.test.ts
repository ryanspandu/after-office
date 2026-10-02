import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { OfficeTask, WorkReport } from '@after-office/shared'
import { reportsRepo, tasksRepo } from '../db'
import { workRoutes } from '../routes/work'
import { listTags, tagIdsByName } from './tags'

// Tags: the owner's labels on tasks and reports. Made and renamed from the dashboard, filtered by in Reports; deleting
// one takes it off everything. The manager can only use existing ones (by name).
const app = new Hono().route('/api', workRoutes)
const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

test('tags on tasks and reports', async () => {
  expect((await call('PUT', '/tags/tag-seo', { name: '  SEO ', color: '#e8762c' })).status).toBe(200)
  expect((await call('PUT', '/tags/tag-urgent', { name: 'Urgent', color: 'red' })).status).toBe(200) // bad colour: grey
  expect((await call('PUT', '/tags/tag-dup', { name: 'seo' })).status).toBe(409)
  expect(listTags()).toEqual([
    { id: 'tag-seo', name: 'SEO', color: '#e8762c' },
    { id: 'tag-urgent', name: 'Urgent', color: '#9a9a96' },
  ])
  // rename keeps the id
  await call('PUT', '/tags/tag-urgent', { name: 'ASAP', color: '#ef4444' })
  expect(listTags()[1]).toEqual({ id: 'tag-urgent', name: 'ASAP', color: '#ef4444' })

  // a task keeps only known tags
  const task: Partial<OfficeTask> = { title: 'Tagged', agentId: null, deadline: Date.now() + 3600_000, priority: 'medium', status: 'todo', tags: ['tag-seo', 'nope', 'tag-seo'] }
  expect((await call('PUT', '/tasks/task-tagged', task)).status).toBe(200)
  expect(tasksRepo.get('task-tagged')?.tags).toEqual(['tag-seo'])

  // reports: tagged by the owner, filtered by tag
  const base: WorkReport = { id: 'rep-a', kind: 'task', refId: 'task-tagged', title: 'A', agentId: 'x', text: 'a', ok: true, startedAt: 2e12, finishedAt: 2e12, read: false }
  reportsRepo.put(base)
  reportsRepo.put({ ...base, id: 'rep-b', title: 'B' })
  expect((await call('PUT', '/reports/rep-a/tags', { tags: ['tag-seo', 'tag-urgent'] })).status).toBe(200)
  const only = (await (await call('GET', '/reports?tag=tag-urgent')).json()) as { items: WorkReport[] }
  expect(only.items.map((r) => r.id)).toEqual(['rep-a'])

  // the manager uses names; unknown names say which tags exist
  expect(tagIdsByName(['seo', 'ASAP'])).toEqual(['tag-seo', 'tag-urgent'])
  expect(() => tagIdsByName(['Nope'])).toThrow('Existing tags: SEO, ASAP')

  // deleting a tag takes it off everything
  expect((await call('DELETE', '/tags/tag-seo')).status).toBe(200)
  expect(tasksRepo.get('task-tagged')?.tags).toEqual([])
  expect(reportsRepo.get('rep-a')?.tags).toEqual(['tag-urgent'])
  expect(listTags().map((t) => t.name)).toEqual(['ASAP'])

  tasksRepo.remove('task-tagged')
  reportsRepo.remove('rep-a')
  reportsRepo.remove('rep-b')
  await call('DELETE', '/tags/tag-urgent')
})
