import { afterAll, expect, test } from 'bun:test'
import { agentsRepo } from '../db'
import { compactSession, compactTiming, sendPrompt } from './manager'
import { runtimeOf, updateRuntime } from './registry'

// /compact: marked on the server while it runs (every dashboard shows it, a reload keeps it); nothing is sent to the
// session meanwhile; it ends when "Compacting conversation…" has left the screen.

const tmuxName = process.env.OFFICE_TMUX_NAME!
const sh = (...a: string[]) => Bun.spawnSync(['tmux', '-L', tmuxName, ...a])
const id = 'compact-test'
compactTiming.pollMs = 100
compactTiming.noShowMs = 1500
afterAll(() => void sh('kill-session', '-t', 'ao-compact-test'))

test('compacting marks the session, refuses chat meanwhile, and ends when the screen is clear', async () => {
  agentsRepo.insert({ id, name: 'Compactor', tmux_session: 'ao-compact-test', cwd: '/tmp', desk: 91, role: 'x', model: 'opus', permission_mode: 'auto', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' } as never)
  // a "Claude Code" that shows the compacting line for a second, then a clear screen
  sh('new-session', '-d', '-s', 'ao-compact-test', "sh -c \"echo 'Compacting conversation…'; sleep 1.2; clear; sleep 60\"")
  updateRuntime(id, (rt) => ({ ...rt, status: 'idle', contextPct: 80 }))
  await Bun.sleep(300)

  await compactSession(id)
  expect(runtimeOf(id).compactingSince).toBeGreaterThan(0)
  // meanwhile: no chat, no second compact
  await expect(sendPrompt(id, 'hello')).rejects.toThrow('Compacting')
  await expect(compactSession(id)).rejects.toThrow('already')
  // it ends on its own
  for (let i = 0; i < 60 && runtimeOf(id).compactingSince; i++) await Bun.sleep(100)
  expect(runtimeOf(id).compactingSince).toBeUndefined()
})

test('a busy agent is not compacted', async () => {
  updateRuntime(id, (rt) => ({ ...rt, status: 'working' }))
  await expect(compactSession(id)).rejects.toThrow('busy')
  expect(runtimeOf(id).compactingSince).toBeUndefined()
})
