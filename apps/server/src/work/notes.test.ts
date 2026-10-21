import { afterAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { NotePage, OfficeTask, OwnerNote, WorkReport } from '@after-office/shared'
import { db, folderNotesRepo, notePagesRepo, ownerNotesRepo, reportsRepo, tasksRepo } from '../db'
import { PROJECTS_DIR } from '../fsroots'
import { moveProjectsToFolders } from './folders'
import { workRoutes } from '../routes/work'
import { listNotePages, moveFolderNotes, noteSummaries, plainText } from './notes'

// The owner's notes (Docs → Notes, a folder's notes): the owner's own edits, checked like the rest of the work routes.
// And the old projects: their tasks, reports and notes get the project's folder, then the projects are gone.
const app = new Hono().route('/api', workRoutes)
const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

mkdirSync(join(PROJECTS_DIR, 'notes-folder'), { recursive: true })
const FOLDER = realpathSync(join(PROJECTS_DIR, 'notes-folder'))
afterAll(() => {
  for (const n of ownerNotesRepo.all()) ownerNotesRepo.remove(n.id)
  for (const p of notePagesRepo.all()) notePagesRepo.remove(p.id)
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

test('a note on the calendar: a day, a range or a day with a time; checked, kept in the list, cleared', async () => {
  const made = (await (await call('POST', '/notes', { title: 'Rapat', date: '2026-10-21', time: '14:00' })).json()) as OwnerNote
  expect(made).toMatchObject({ date: '2026-10-21', time: '14:00' })
  const put = async (body: unknown) => call('PUT', `/notes/${made.id}`, body)
  // the summaries the dashboard's calendar reads carry it
  expect(noteSummaries().find((n) => n.id === made.id)).toMatchObject({ date: '2026-10-21', time: '14:00' })

  // bad formats, an end before the start, a time on a range: refused
  for (const body of [{ date: '21-10-2026' }, { date: '2026-02-30' }, { time: '25:00' }, { dateEnd: '2026-10-20' }, { dateEnd: '2026-10-24', time: '09:00' }])
    expect((await put(body)).status).toBe(400)

  // a range: all day (its time goes)
  const range = (await (await put({ dateEnd: '2026-10-24' })).json()) as OwnerNote
  expect(range).toMatchObject({ date: '2026-10-21', dateEnd: '2026-10-24' })
  expect(range.time).toBeUndefined()
  // the same end day as the start: one day again
  expect(((await (await put({ dateEnd: '2026-10-21' })).json()) as OwnerNote).dateEnd).toBeUndefined()
  // other changes leave it alone
  expect(((await (await put({ title: 'Rapat tim' })).json()) as OwnerNote).date).toBe('2026-10-21')
  // no day: none of it
  const cleared = (await (await put({ date: null })).json()) as OwnerNote
  expect([cleared.date, cleared.dateEnd, cleared.time]).toEqual([undefined, undefined, undefined])
  await call('DELETE', `/notes/${made.id}`)
})

test("pages: made, renamed, a note put on one; deleting one keeps its notes, on no page", async () => {
  expect((await call('POST', '/note-pages', { name: '   ' })).status).toBe(400)
  const work = (await (await call('POST', '/note-pages', { name: ' Kerja ' })).json()) as NotePage
  expect(work.name).toBe('Kerja')
  const home = (await (await call('POST', '/note-pages', { name: 'Rumah', order: 0 })).json()) as NotePage
  // the placed one first
  expect(listNotePages().map((p) => p.name)).toEqual(['Rumah', 'Kerja'])
  expect(((await (await call('PUT', `/note-pages/${work.id}`, { name: 'Kantor' })).json()) as NotePage).name).toBe('Kantor')
  expect((await call('PUT', '/note-pages/nope', { name: 'X' })).status).toBe(404)

  // a note on a page (only one that exists); "" takes it off
  expect((await call('POST', '/notes', { title: 'X', pageId: 'nope' })).status).toBe(400)
  const n = (await (await call('POST', '/notes', { title: 'Rapat', pageId: work.id })).json()) as OwnerNote
  expect(noteSummaries().find((x) => x.id === n.id)?.pageId).toBe(work.id)
  expect(((await (await call('PUT', `/notes/${n.id}`, { pageId: home.id })).json()) as OwnerNote).pageId).toBe(home.id)
  expect(((await (await call('PUT', `/notes/${n.id}`, { pageId: '' })).json()) as OwnerNote).pageId).toBeUndefined()

  await call('PUT', `/notes/${n.id}`, { pageId: work.id })
  expect(await (await call('DELETE', `/note-pages/${work.id}`)).json()).toEqual({ moved: 1, pages: 0 })
  expect(notePagesRepo.get(work.id)).toBeNull()
  const kept = ownerNotesRepo.get(n.id)!
  expect(kept.title).toBe('Rapat')
  expect('pageId' in kept).toBe(false)
  expect((await call('DELETE', `/note-pages/${work.id}`)).status).toBe(404)
  await call('DELETE', `/notes/${n.id}`)
  await call('DELETE', `/note-pages/${home.id}`)
})

test('pages in pages: made inside one, no loops, listed; deleting one moves its notes and sub-pages up', async () => {
  expect((await call('POST', '/note-pages', { name: 'X', parentId: 'nope' })).status).toBe(400)
  const top = (await (await call('POST', '/note-pages', { name: 'Proyek' })).json()) as NotePage
  expect(top.parentId).toBeUndefined()
  const mid = (await (await call('POST', '/note-pages', { name: 'Klien', parentId: top.id })).json()) as NotePage
  expect(mid.parentId).toBe(top.id)
  const leaf = (await (await call('POST', '/note-pages', { name: 'Rapat', parentId: mid.id })).json()) as NotePage
  const other = (await (await call('POST', '/note-pages', { name: 'Lain', parentId: mid.id })).json()) as NotePage
  // listed with their parents
  const listed = listNotePages()
  expect(listed.find((p) => p.id === leaf.id)?.parentId).toBe(mid.id)
  expect(listed.filter((p) => p.parentId === mid.id).map((p) => p.name).sort()).toEqual(['Lain', 'Rapat'])
  // siblings reordered among themselves
  await call('PUT', '/note-pages/order', { ids: [other.id, leaf.id] })
  expect(listNotePages().filter((p) => p.parentId === mid.id).map((p) => p.name)).toEqual(['Lain', 'Rapat'])

  // not under itself or its own sub-pages
  expect((await call('PUT', `/note-pages/${top.id}`, { parentId: top.id })).status).toBe(400)
  expect((await call('PUT', `/note-pages/${top.id}`, { parentId: leaf.id })).status).toBe(400)
  expect((await call('PUT', `/note-pages/${mid.id}`, { parentId: 'nope' })).status).toBe(400)
  expect(notePagesRepo.get(top.id)?.parentId).toBeUndefined()
  // moved elsewhere, then back to the top level (null)
  expect(((await (await call('PUT', `/note-pages/${other.id}`, { parentId: top.id })).json()) as NotePage).parentId).toBe(top.id)
  expect('parentId' in ((await (await call('PUT', `/note-pages/${other.id}`, { parentId: null })).json()) as NotePage)).toBe(false)

  // deleting the middle one: its note and sub-page go up to its parent
  const n = (await (await call('POST', '/notes', { title: 'Catatan', pageId: mid.id })).json()) as OwnerNote
  expect(await (await call('DELETE', `/note-pages/${mid.id}`)).json()).toEqual({ moved: 1, pages: 1 })
  expect(ownerNotesRepo.get(n.id)?.pageId).toBe(top.id)
  expect(notePagesRepo.get(leaf.id)?.parentId).toBe(top.id)
  // deleting a top-level one: to the top level, on no page
  expect(await (await call('DELETE', `/note-pages/${top.id}`)).json()).toEqual({ moved: 1, pages: 1 })
  expect('pageId' in ownerNotesRepo.get(n.id)!).toBe(false)
  expect('parentId' in notePagesRepo.get(leaf.id)!).toBe(false)

  await call('DELETE', `/notes/${n.id}`)
  for (const id of [leaf.id, other.id]) await call('DELETE', `/note-pages/${id}`)
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
