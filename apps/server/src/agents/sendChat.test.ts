import { afterAll, expect, test } from 'bun:test'
import { agentsRepo } from '../db'
import { chatTiming, sendChat } from './manager'
import { updateRuntime } from './registry'

// The owner's chat message counts as sent only once Claude Code took it: typed into a screen that isn't at its message
// box, it would be lost without a word.

const tmuxName = process.env.OFFICE_TMUX_NAME!
const sh = (...a: string[]) => Bun.spawnSync(['tmux', '-L', tmuxName, ...a])
const id = 'chat-confirm-test'
chatTiming.confirmMs = 600
chatTiming.pollMs = 50
afterAll(() => void sh('kill-session', '-t', 'ao-chat-confirm'))

test("a message that didn't go in is an error, not a silent loss", async () => {
  agentsRepo.insert({ id, name: 'Confirm', tmux_session: 'ao-chat-confirm', cwd: '/tmp', desk: 93, role: 'x', model: 'opus', permission_mode: 'auto', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' } as never)
  // not a Claude Code at its message box: whatever is typed goes nowhere
  sh('new-session', '-d', '-s', 'ao-chat-confirm', 'sleep 60')
  updateRuntime(id, (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() - 5000 }))
  await Bun.sleep(200)
  await expect(sendChat(id, 'hello there')).rejects.toThrow('did not reach')
})

test('taken (its prompt hook came in): sent', async () => {
  const done = sendChat(id, 'hello again')
  setTimeout(() => updateRuntime(id, (rt) => ({ ...rt, status: 'working', lastEventAt: Date.now() })), 100)
  await expect(done).resolves.toBeUndefined()
})
