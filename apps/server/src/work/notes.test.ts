import { afterAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { OfficeTask, OwnerNote, WorkReport } from '@after-office/shared'
import { db, folderNotesRepo, ownerNotesRepo, reportsRepo, tasksRepo } from '../db'
import { PROJECTS_DIR } from '../fsroots'
import { moveProjectsToFolders } from './folders'
import { workRoutes } from '../routes/work'
import { moveFolderNotes, noteSummaries, plainText } from './notes'

// The owner's notes (Docs → Notes, a folder's notes): the owner's own edits, checked like the rest of the work routes.
// And the old projects: their tasks, reports and notes get the project's folder, then the projects are gone.
const app = new Hono().route('/api', workRoutes)
const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

mkdirSync(join(PROJECTS_DIR, 'notes-folder'), { recursive: true })
const FOLDER = realpathSync(join(PROJECTS_DIR, 'notes-folder'))
afterAll(() => {
  for (const n of ownerNotesRepo.all()) ownerNotesRepo.remove(n.id)
  reportsRepo.remove('rep-old')
  tasksRepo.remove('task-old')
  rmSync(FOLDER, { recursive: true, force: true })
})

test("notes: made, changed, listed without their text, and removed", async () => {
  const made = (await (await call('POST', '/notes', { title: '  Ide artikel ', html: '<p>Satu &amp; <strong>dua</strong></p><p>tiga</p>' })).json()) as OwnerNote
  expect(made.title).toBe('Ide artikel')
  // the list: the words only, no markup
  const listed = noteSummaries().find((n) => n.id === made.id)!
  expect(listed.excerpt).toBe('Satu & dua tiga')
  expect('html' in listed).toBe(false)

  // a folder like a report; one outside the dashboard's folders is refused, none clears it
  expect((await call('PUT', `/notes/${made.id}`, { folder: '/etc' })).status).toBe(403)
  expect(((await (await call('PUT', `/notes/${made.id}`, { folder: FOLDER })).json()) as OwnerNote).folder).toBe(FOLDER)
  const cleared = (await (await call('PUT', `/notes/${made.id}`, { folder: null, html: '<p>baru</p>' })).json()) as OwnerNote
  expect(cleared.folder).toBeUndefined()
  expect(((await (await call('GET', `/notes/${made.id}`)).json()) as OwnerNote).html).toBe('<p>baru</p>')

  // too long is refused
  expect((await call('PUT', `/notes/${made.id}`, { html: 'x'.repeat(200_001) })).status).toBe(400)

  expect((await call('DELETE', `/notes/${made.id}`)).status).toBe(200)
  expect((await call('GET', `/notes/${made.id}`)).status).toBe(404)
})

test('plain text of a note: block ends become spaces, entities decoded', () => {
  expect(plainText('<h1>Judul</h1><ul><li>a</li><li>b &lt;c&gt;</li></ul>')).toBe('Judul a b <c>')
})

test("the old projects: their tasks, reports and notes get the project's folder, then the projects are gone", () => {
  db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, brief TEXT, check_cmd TEXT, folder TEXT)')
  db.query('INSERT INTO projects (id, name, color, brief, check_cmd, folder) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').run('pj-old', 'Old', '#000000', 'brief', 'bun test', FOLDER)
  const legacy = { projectId: 'pj-old' }
  tasksRepo.put({ id: 'task-old', title: 'T', agentId: null, deadline: 1, priority: 'low', status: 'todo', ...legacy } as OfficeTask)
  reportsRepo.put({ id: 'rep-old', kind: 'task', refId: 'task-old', title: 'R', agentId: 'x', text: 't', ok: true, startedAt: 1, finishedAt: 1, read: true, ...legacy } as WorkReport)
  const note = { id: 'note-old', title: 'N', html: '', createdAt: 1, updatedAt: 1, ...legacy } as OwnerNote
  ownerNotesRepo.put(note)
  moveProjectsToFolders()
  expect(tasksRepo.get('task-old')).toMatchObject({ folder: FOLDER })
  expect('projectId' in tasksRepo.get('task-old')!).toBe(false)
  expect(reportsRepo.get('rep-old')).toMatchObject({ folder: FOLDER })
  expect('projectId' in reportsRepo.get('rep-old')!).toBe(false)
  expect(ownerNotesRepo.get('note-old')).toMatchObject({ folder: FOLDER })
  expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()).toBeNull()
  // again: nothing left to do
  moveProjectsToFolders()
})

test("the list's order: a new note on top, the owner's drag-and-drop order kept, pinned ones above", async () => {
  const a = (await (await call('POST', '/notes', { title: 'A' })).json()) as OwnerNote
  await Bun.sleep(2)
  const b = (await (await call('POST', '/notes', { title: 'B' })).json()) as OwnerNote
  await Bun.sleep(2)
  const c = (await (await call('POST', '/notes', { title: 'C' })).json()) as OwnerNote
  const order = () => noteSummaries().filter((n) => [a.id, b.id, c.id].includes(n.id)).map((n) => n.title)
  expect(order()).toEqual(['C', 'B', 'A'])
  expect((await call('PUT', '/notes/order', { ids: [a.id, c.id, b.id] })).status).toBe(200)
  expect(order()).toEqual(['A', 'C', 'B'])
  // a change doesn't move it
  await call('PUT', `/notes/${b.id}`, { html: '<p>baru</p>' })
  expect(order()).toEqual(['A', 'C', 'B'])
  await call('PUT', `/notes/${b.id}`, { pinned: true })
  expect(order()).toEqual(['B', 'A', 'C'])
  expect((await call('PUT', '/notes/order', { ids: 'x' })).status).toBe(400)
})

test("a folder's one old note becomes a note of that folder (its text and time kept), once", () => {
  folderNotesRepo.set('/tmp/old-folder', 'baris satu\nbaris <dua>')
  moveFolderNotes()
  const n = ownerNotesRepo.all().find((x) => x.folder === '/tmp/old-folder')!
  expect(n).toMatchObject({ title: 'Notes', html: '<p>baris satu</p><p>baris &lt;dua&gt;</p>' })
  expect(folderNotesRepo.get('/tmp/old-folder')).toBeNull()
  moveFolderNotes()
  expect(ownerNotesRepo.all().filter((x) => x.folder === '/tmp/old-folder')).toHaveLength(1)
  // the folder renamed: the note follows
  ownerNotesRepo.moveFolder('/tmp/old-folder', '/tmp/new-folder')
  expect(ownerNotesRepo.get(n.id)?.folder).toBe('/tmp/new-folder')
})
