import { afterAll, beforeAll, expect, test, setDefaultTimeout } from 'bun:test'
import type { OfficeThread } from '@after-office/shared'
import { agentsRepo, ownerNotesRepo, queueRepo, sideSessionsRepo, threadQueueRepo, threadsRepo, type AgentRow } from '../db'
import { updateSideRuntime } from '../agents/registry'
import { askAboutNote, helperThreads, noteHelperOf, NOTE_SNAPSHOT_MAX } from './noteAssist'
import { createNote, deleteNote } from './notes'
import { editQueued, listThreads } from './threads'
import { fakeTuiCommand, fastGate } from '../agents/testing/tui'

setDefaultTimeout(15_000)

// "Ask Marcus" in a note: one hidden thread per note, told what it's for and what the note says; gone with the note.

const tmuxName = process.env.OFFICE_TMUX_NAME!
const sh = (...a: string[]) => Bun.spawnSync(['tmux', '-L', tmuxName, ...a])
const SIDE = 'ao-na-m--s5'

const manager: AgentRow = {
  id: 'na-m',
  name: 'Marcus',
  tmux_session: 'ao-na-m',
  cwd: '/tmp',
  desk: Math.floor(Math.random() * 1e6),
  role: '',
  model: 'haiku',
  permission_mode: 'default',
  session_id: crypto.randomUUID(),
  created_at: Date.now(),
  kind: 'manager',
}

// the helper's session: a fake Claude Code screen instead of a real one
let made = 0
const realCreate = helperThreads.create
beforeAll(() => {
  agentsRepo.insert(manager)
  fastGate()
  helperThreads.create = async (input) => {
    made++
    sideSessionsRepo.insert({ agent_id: 'na-m', key: 's5', tmux_session: SIDE, session_id: crypto.randomUUID(), title: null, created_at: Date.now(), closed_at: null })
    sh('new-session', '-d', '-s', SIDE, '-x', '200', '-y', '50', fakeTuiCommand({ dir: `/tmp/ao-na-${process.pid}` }))
    const t: OfficeThread = { id: 'thr-note', title: String(input.title), managerId: 'na-m', sessionKey: 's5', noteId: input.noteId, createdAt: Date.now(), lastActivityAt: Date.now() }
    sideSessionsRepo.update('na-m', 's5', { thread_id: t.id })
    threadsRepo.put(t)
    // a question open: what's sent waits in the queue, where it can be read
    updateSideRuntime('na-m', 's5', (rt) => ({ ...rt, status: 'waiting' }))
    return t
  }
})
afterAll(() => {
  helperThreads.create = realCreate
  sh('kill-session', '-t', `=${SIDE}`)
  threadQueueRepo.removeThread('thr-note')
  threadsRepo.remove('thr-note')
  sideSessionsRepo.removeAgent('na-m')
  queueRepo.removeAgent('na-m')
  agentsRepo.remove('na-m')
  for (const n of ownerNotesRepo.all()) ownerNotesRepo.remove(n.id)
})

test('one helper per note, hidden, told what it is for and what the note says', async () => {
  const note = createNote({ title: 'Artikel TV Stand', html: '<h2>Intro</h2><p>Meja TV <strong>kayu</strong></p>' })
  const first = await askAboutNote(note.id, 'Tolong rapikan')
  expect(first).toEqual({ threadId: 'thr-note', sessionKey: 's5', queued: true })
  const t = noteHelperOf(note.id)!
  expect(t.noteId).toBe(note.id)
  // the first message: the helper's block, the note's text, then the owner's words
  const sent = threadQueueRepo.next(t.id)!.text
  expect(sent.startsWith('[Note helper: "Artikel TV Stand"]')).toBe(true)
  expect(sent).toContain('```note')
  expect(sent).not.toContain('[Thread: ')
  expect(sent).toContain('<<<NOTE\n## Intro\n\nMeja TV **kayu**\nNOTE>>>')
  expect(sent.endsWith('\n\nTolong rapikan')).toBe(true)
  // editing the queued message keeps the office's part
  const q = listThreads().find((x) => x.id === t.id)!.queued![0]
  editQueued(t.id, q.id, 'Tolong singkatkan')
  expect(threadQueueRepo.next(t.id)!.text).toMatch(/^\[Note helper: [\s\S]*NOTE>>>\n\nTolong singkatkan$/)
  threadQueueRepo.removeThread(t.id)

  // the same thread again; the note's text only when it changed
  await askAboutNote(note.id, 'Lagi')
  expect(made).toBe(1)
  expect(threadQueueRepo.next(t.id)!.text).toBe('Lagi')
  threadQueueRepo.removeThread(t.id)
  ownerNotesRepo.put({ ...note, html: `<p>${'x'.repeat(NOTE_SNAPSHOT_MAX + 100)}</p>` })
  await askAboutNote(note.id, 'Sekarang?')
  const again = threadQueueRepo.next(t.id)!.text
  expect(again.startsWith('[The note now: "Artikel TV Stand"]')).toBe(true)
  expect(again).toContain('cut short')
  expect(again.length).toBeLessThan(NOTE_SNAPSHOT_MAX + 300)
  threadQueueRepo.removeThread(t.id)
})

test('no manager: a clear refusal; a deleted note takes its helper with it', async () => {
  await expect(askAboutNote('no-such-note', 'hi')).rejects.toThrow('no longer exists')
  const note = ownerNotesRepo.all().find((n) => n.title === 'Artikel TV Stand')!
  deleteNote(note.id)
  for (let i = 0; i < 60 && threadsRepo.get('thr-note'); i++) await Bun.sleep(50)
  expect(threadsRepo.get('thr-note')).toBeNull()
  expect(sideSessionsRepo.get('na-m', 's5')).toBeNull()
  // without a manager there is nothing to ask
  const other = createNote({ title: 'x', html: '<p>y</p>' })
  // (other test files may leave managers of their own behind: none, as far as this asks)
  const realManager = agentsRepo.manager
  agentsRepo.manager = () => null
  try {
    await expect(askAboutNote(other.id, 'hi')).rejects.toThrow('needs the manager')
  } finally {
    agentsRepo.manager = realManager
  }
})
