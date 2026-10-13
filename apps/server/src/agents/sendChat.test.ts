import { afterAll, expect, test } from 'bun:test'
import { agentsRepo } from '../db'
import { chatTiming, sendChat } from './manager'
import { updateRuntime } from './registry'
import { fakeTuiCommand, fastGate } from './testing/tui'

// The owner's chat message counts as sent only once Claude Code took it: typed into a screen that isn't at its message
// box, it would be lost without a word.

const tmuxName = process.env.OFFICE_TMUX_NAME!
const sh = (...a: string[]) => Bun.spawnSync(['tmux', '-L', tmuxName, ...a])
const id = 'chat-confirm-test'
chatTiming.confirmMs = 600
chatTiming.pollMs = 50
fastGate()
afterAll(() => void sh('kill-session', '-t', 'ao-chat-confirm'))
const fake = () => fakeTuiCommand({ dir: `/tmp/ao-chat-${process.pid}` })

test("a message that didn't go in is an error, not a silent loss", async () => {
  agentsRepo.insert({ id, name: 'Confirm', tmux_session: 'ao-chat-confirm', cwd: '/tmp', desk: 93, role: 'x', model: 'opus', permission_mode: 'auto', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' } as never)
  // not a Claude Code at its message box: whatever is typed goes nowhere
  sh('new-session', '-d', '-s', 'ao-chat-confirm', 'sleep 60')
  updateRuntime(id, (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() - 5000 }))
  await Bun.sleep(200)
  await expect(sendChat(id, 'hello there')).rejects.toThrow("isn't ready")
})

test('taken (its prompt hook came in): sent', async () => {
  sh('kill-session', '-t', 'ao-chat-confirm')
  sh('new-session', '-d', '-s', 'ao-chat-confirm', '-x', '200', '-y', '50', fake())
  await Bun.sleep(300)
  const done = sendChat(id, 'hello again')
  setTimeout(() => updateRuntime(id, (rt) => ({ ...rt, status: 'working', lastEventAt: Date.now() })), 100)
  await expect(done).resolves.toBeUndefined()
})
