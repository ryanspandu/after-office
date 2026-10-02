import { afterAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { OwnerNote, WorkReport } from '@after-office/shared'
import { ownerNotesRepo, projectsRepo, reportsRepo } from '../db'
import { workRoutes } from '../routes/work'
import { noteSummaries, plainText } from './notes'

// The owner's notes (Reports → Notes) and moving a report to another project: the owner's own edits, checked like
// the rest of the work routes.
const app = new Hono().route('/api', workRoutes)
const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

projectsRepo.put({ id: 'pj-notes', name: 'notes-proj', color: '#3b82f6' })
afterAll(() => {
  for (const n of ownerNotesRepo.all()) ownerNotesRepo.remove(n.id)
  reportsRepo.remove('rep-move')
  projectsRepo.remove('pj-notes')
})

test("notes: made, changed, listed without their text, and removed", async () => {
  const made = (await (await call('POST', '/notes', { title: '  Ide artikel ', html: '<p>Satu &amp; <strong>dua</strong></p><p>tiga</p>' })).json()) as OwnerNote
  expect(made.title).toBe('Ide artikel')
  // the list: the words only, no markup
  const listed = noteSummaries().find((n) => n.id === made.id)!
  expect(listed.excerpt).toBe('Satu & dua tiga')
  expect('html' in listed).toBe(false)

  // project and tags like a report; an unknown project is refused, none clears it
  expect((await call('PUT', `/notes/${made.id}`, { projectId: 'nope' })).status).toBe(400)
  expect(((await (await call('PUT', `/notes/${made.id}`, { projectId: 'pj-notes' })).json()) as OwnerNote).projectId).toBe('pj-notes')
  const cleared = (await (await call('PUT', `/notes/${made.id}`, { projectId: null, html: '<p>baru</p>' })).json()) as OwnerNote
  expect(cleared.projectId).toBeUndefined()
  expect(((await (await call('GET', `/notes/${made.id}`)).json()) as OwnerNote).html).toBe('<p>baru</p>')

  // too long is refused
  expect((await call('PUT', `/notes/${made.id}`, { html: 'x'.repeat(200_001) })).status).toBe(400)

  expect((await call('DELETE', `/notes/${made.id}`)).status).toBe(200)
  expect((await call('GET', `/notes/${made.id}`)).status).toBe(404)
})

test('plain text of a note: block ends become spaces, entities decoded', () => {
  expect(plainText('<h1>Judul</h1><ul><li>a</li><li>b &lt;c&gt;</li></ul>')).toBe('Judul a b <c>')
})

test("a report moves to another project (or none); its task isn't touched", async () => {
  const r: WorkReport = { id: 'rep-move', kind: 'task', refId: 'task-x', title: 'R', agentId: 'x', text: 't', ok: true, startedAt: 1, finishedAt: 1, read: true, projectId: 'old' }
  reportsRepo.put(r)
  expect((await call('PUT', '/reports/rep-move/project', { projectId: 'nope' })).status).toBe(400)
  expect((await call('PUT', '/reports/rep-move/project', { projectId: 'pj-notes' })).status).toBe(200)
  expect(reportsRepo.get('rep-move')?.projectId).toBe('pj-notes')
  expect((await call('PUT', '/reports/rep-move/project', { projectId: null })).status).toBe(200)
  expect(reportsRepo.get('rep-move')?.projectId).toBeUndefined()
})
