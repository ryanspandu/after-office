import { afterAll, expect, test } from 'bun:test'
import { agentsRepo, queueRepo, sideSessionsRepo } from '../db'
import { updateRuntime } from '../agents/registry'
import { deliverToManager } from './work'

// Work the manager started from one of its side sessions (the owner started it there): what comes back about it goes to
// that session while it's open; once it's closed (or gone), to the main session as before.

const tmuxName = process.env.OFFICE_TMUX_NAME!
const sh = (...a: string[]) => Bun.spawnSync(['tmux', '-L', tmuxName, ...a])
const screen = (name: string) => sh('capture-pane', '-p', '-t', `=${name}:`).stdout.toString()
const id = 'mgr-session-test'
afterAll(() => {
  sh('kill-session', '-t', 'ao-mgr-test')
  sh('kill-session', '-t', 'ao-mgr-test--s2')
})

test('to the side session it came from while open, else the main one', async () => {
  agentsRepo.insert({ id, name: 'Boss', tmux_session: 'ao-mgr-test', cwd: '/tmp', desk: 92, role: 'GM', model: 'opus', permission_mode: 'auto', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'manager' } as never)
  sideSessionsRepo.insert({ agent_id: id, key: 's2', tmux_session: 'ao-mgr-test--s2', session_id: crypto.randomUUID(), title: null, created_at: Date.now(), closed_at: null } as never)
  // two "Claude Code"s: plain shells that show what's typed into them
  sh('new-session', '-d', '-s', 'ao-mgr-test', 'cat')
  sh('new-session', '-d', '-s', 'ao-mgr-test--s2', 'cat')
  updateRuntime(id, (rt) => ({ ...rt, status: 'idle' }))
  await Bun.sleep(300)

  expect(await deliverToManager(id, 'REPORT-FOR-SIDE', 's2')).toBe('sent')
  await Bun.sleep(400)
  expect(screen('ao-mgr-test--s2')).toContain('REPORT-FOR-SIDE')
  expect(screen('ao-mgr-test')).not.toContain('REPORT-FOR-SIDE')

  // the owner closed that session: the main one gets it
  sideSessionsRepo.update(id, 's2', { closed_at: Date.now() })
  await deliverToManager(id, 'REPORT-FOR-MAIN', 's2')
  await Bun.sleep(400)
  const main = screen('ao-mgr-test')
  const queued = queueRepo.next(id)?.text ?? ''
  expect(main.includes('REPORT-FOR-MAIN') || queued.includes('REPORT-FOR-MAIN')).toBe(true)
  expect(screen('ao-mgr-test--s2')).not.toContain('REPORT-FOR-MAIN')
}, 30_000)
