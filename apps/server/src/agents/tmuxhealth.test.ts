import { expect, test } from 'bun:test'
import { tmux } from './tmux'

// "Restart all agents": the dashboard can tell whether the agents' tmux server still starts working sessions, and
// stop it (the test run has its own tmux server, see test-setup.ts).
test('tmux health probe and kill-server', async () => {
  expect(await tmux.canStartSessions()).toBe(true)
  // the probe leaves nothing behind
  expect((await tmux.listSessions()).filter((s) => s.startsWith('_ao_probe_'))).toEqual([])
  await tmux.newSession({ name: 'ao-health-a', cwd: '/tmp', env: {}, command: ['sleep', '30'] })
  expect(await tmux.hasSession('ao-health-a')).toBe(true)
  await tmux.killServer()
  expect(await tmux.listSessions()).toEqual([])
  // a new server starts with the next session
  expect(await tmux.canStartSessions()).toBe(true)
  await tmux.killServer()
}, 20000)
