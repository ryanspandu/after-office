import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { agentsRepo, type AgentRow } from '../db'
import { agentRoutes } from '../routes/agents'
import { commitStaged, safeName, saveUpload, stageUpload, sweepStaged, withAttachments } from './uploads'

// Files attached in the chat: saved in the agent's folder, never overwriting, never through a symlink.

const row = (cwd: string): AgentRow => ({ id: 'up-a', name: 'Uppy', tmux_session: 'ao-up-a', cwd, desk: 961, role: '', model: 'haiku', permission_mode: 'default', session_id: 'x', created_at: 0, kind: 'worker' })

test('safe names', () => {
  expect(safeName('../../etc/passwd')).toBe('passwd')
  expect(safeName('C:\\Users\\me\\photo.png')).toBe('photo.png')
  expect(safeName('.env')).toBe('env')
  expect(safeName('a<b>|c?.txt')).toBe('a_b__c_.txt')
  expect(safeName('   ')).toBe('file')
})

test('uploads go to uploads/<date>/ and never overwrite', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-up-'))
  const at = new Date(2026, 8, 28)
  const a = saveUpload(row(cwd), 'shot.png', new TextEncoder().encode('one'), at)
  const b = saveUpload(row(cwd), 'shot.png', new TextEncoder().encode('two'), at)
  expect(a.path).toBe(join(cwd, 'uploads', '2026-09-28', 'shot.png'))
  expect(b.path).toBe(join(cwd, 'uploads', '2026-09-28', 'shot (2).png'))
  expect(a.image).toBe(true)
  expect(readFileSync(a.path, 'utf8')).toBe('one')
  expect(readFileSync(b.path, 'utf8')).toBe('two')
  rmSync(cwd, { recursive: true, force: true })
})

test('an uploads folder that is a symlink out of the agent folder is refused', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-up-'))
  const outside = mkdtempSync(join(tmpdir(), 'ao-out-'))
  symlinkSync(outside, join(cwd, 'uploads'))
  expect(() => saveUpload(row(cwd), 'x.txt', new Uint8Array([1]))).toThrow('outside')
  rmSync(cwd, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('the message lists the files at the end', () => {
  expect(withAttachments('look at this', ['/a/b.png'])).toBe('look at this\n\n[Attached files]\n- /a/b.png')
  expect(withAttachments('', ['/a/b.png', '/a/c.pdf'])).toBe('[Attached files]\n- /a/b.png\n- /a/c.pdf')
  expect(withAttachments('hi', [])).toBe('hi')
})

test('attaching only stages the file; sending moves it into the agent folder; removing deletes it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-up-'))
  agentsRepo.insert(row(cwd))
  const app = new Hono().route('/api', agentRoutes)
  const send = (name: string, body: Uint8Array, origin = 'http://localhost') =>
    app.request('/api/agents/up-a/uploads', { method: 'POST', body: new Blob([body as BlobPart]), headers: { origin, host: 'localhost', 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) } })
  expect((await send('note.txt', new TextEncoder().encode('hello'), 'https://evil.example')).status).toBe(403)
  const a = (await (await send('catatan rapat.txt', new TextEncoder().encode('hello'))).json()) as { id: string; name: string; size: number; image?: boolean }
  expect([a.name, a.size, !!a.image]).toEqual(['catatan rapat.txt', 5, false])
  // nothing in the agent's folder yet
  expect(existsSync(join(cwd, 'uploads'))).toBe(false)
  const b = (await (await send('pic.png', new Uint8Array([137, 80]))).json()) as { id: string; image?: boolean }
  expect(b.image).toBe(true)
  expect((await send('empty.txt', new Uint8Array())).status).toBe(400)

  // removed from the message: deleted; unknown or malformed ids are refused
  expect((await app.request(`/api/agents/up-a/uploads/${b.id}`, { method: 'DELETE' })).status).toBe(200)
  expect(() => commitStaged(row(cwd), b.id)).toThrow('gone')
  expect((await app.request('/api/agents/up-a/uploads/..%2F..%2Fx', { method: 'DELETE' })).status).toBe(404)

  // sent: moved into uploads/<date>/ and out of staging
  const saved = commitStaged(row(cwd), a.id, new Date(2026, 8, 29))
  expect(saved.path).toBe(join(cwd, 'uploads', '2026-09-29', 'catatan rapat.txt'))
  expect(readFileSync(saved.path, 'utf8')).toBe('hello')
  expect(() => commitStaged(row(cwd), a.id)).toThrow('gone')
  agentsRepo.remove('up-a')
  rmSync(cwd, { recursive: true, force: true })
})

test('attachments never sent are swept after a day', () => {
  const s = stageUpload('up-b', 'old.txt', new TextEncoder().encode('x'))
  expect(sweepStaged(24 * 3600_000)).toBe(0) // fresh: kept
  expect(sweepStaged(24 * 3600_000, Date.now() + 25 * 3600_000)).toBe(1)
  expect(() => commitStaged(row('/tmp'), s.id)).toThrow('gone')
})

// As Claude Code stores it (seen live, v2.1.283): the picture's path is taken out of the text, "[Image #1]" left in
// its place, and the path comes as a block of its own. The chat gets the owner's text and every file back.
test('an owner message with an attached picture, as read back from the transcript', async () => {
  const { ownerMessage } = await import('./transcripts')
  const texts = ['[Image #1]\n\n<pasted_content id="0b1e">\nWhat is in the picture?\n\n[Attached files]\n-\n- /u/notes.pdf\n</pasted_content id="0b1e">\n']
  expect(ownerMessage(texts, ['/u/shot.png'])).toBe('What is in the picture?\n\n[Attached files]\n- /u/shot.png\n- /u/notes.pdf')
  // only pictures, no text
  expect(ownerMessage(['[Image #1][Image #2]\n\n[Attached files]\n-\n-'], ['/u/a.png', '/u/b.png'])).toBe('[Attached files]\n- /u/a.png\n- /u/b.png')
  // an ordinary message stays as it is
  expect(ownerMessage(['hello [Image #1] literally'])).toBe('hello [Image #1] literally')
})
