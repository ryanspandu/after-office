import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, queueRepo, tasksRepo, type AgentRow } from '../db'
import { TMUX_SOCKET_ARGS } from '../agents/env'
import { gateTiming, sendPrompt, typedInput, untilReady, withoutGhostText } from '../agents/manager'
import { updateRuntime } from '../agents/registry'
import { fakeTuiCommand, fastGate } from '../agents/testing/tui'
import { CLAUDE_PROJECTS_DIR } from '../fsroots'
import { deliver, deliveryTiming, drainQueues, startTask, tickTasks } from './work'

// Prompts reach an agent's session only when it's ready for them, and a task's prompt is confirmed to have arrived
// (else typed again, and in the end marked as not delivered). The agents here are fake Claude Code screens
// (agents/testing/fakeTui.ts) that write each prompt they get to a transcript.

const tmux = (...args: string[]) => Bun.spawnSync([process.env.TMUX_BIN ?? 'tmux', ...TMUX_SOCKET_ARGS, ...args])
const cwd = `/tmp/ao-delivery-${process.pid}`
const transcripts = join(CLAUDE_PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const agent = (id: string): AgentRow => ({
  id,
  name: id.toUpperCase(),
  tmux_session: `ao-${id}`,
  cwd,
  desk: Math.floor(Math.random() * 1e6),
  role: '',
  model: 'haiku',
  permission_mode: 'default',
  session_id: crypto.randomUUID(),
  created_at: Date.now(),
  kind: 'worker',
})
const task = (id: string, agentId: string): OfficeTask => ({ id, title: 'Do the thing', agentId, deadline: Date.now() + 3_600_000, priority: 'medium', status: 'todo' })
const idle = (id: string) => updateRuntime(id, (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() }))
const start = (id: string, opts: { readyAfter?: number; clearMs?: number; drop?: number } = {}) => {
  tmux('kill-session', '-t', `=ao-${id}`)
  tmux('new-session', '-d', '-s', `ao-${id}`, '-x', '200', '-y', '50', fakeTuiCommand({ dir: transcripts, ...opts }))
}
/** Every prompt the fake sessions wrote down. */
const received = () =>
  readdirSync(transcripts)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(transcripts, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l).message.content as string)
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(50)
  }
}
// the watchdog's agent has transcripts of its own (an old conversation, nothing since the task started)
const dogCwd = `/tmp/ao-delivery-dog-${process.pid}`
const dogTranscripts = join(CLAUDE_PROJECTS_DIR, dogCwd.replace(/[^a-zA-Z0-9]/g, '-'))
const ids = ['dl-wake', 'dl-clear', 'dl-retry', 'dl-fail', 'dl-busy', 'dl-dog']

beforeAll(() => {
  fastGate()
  Object.assign(deliveryTiming, { confirmMs: 1_500, pollMs: 100 })
  for (const id of ids) agentsRepo.insert(id === 'dl-dog' ? { ...agent(id), cwd: dogCwd } : agent(id))
})
afterAll(() => {
  for (const id of ids) tmux('kill-session', '-t', `=ao-${id}`)
})

describe('the screen', () => {
  test('dim ghost text in the box is not typed text', () => {
    const rule = '─'.repeat(30)
    expect(typedInput(`${rule}\n❯ \x1b[2mTry "fix it"\x1b[0m\n${rule}`)).toBe('')
    expect(typedInput(`${rule}\n❯ hello \x1b[38;5;2mgreen\x1b[0m\n${rule}`)).toBe('hello green')
    expect(typedInput('Starting…')).toBeNull()
    expect(withoutGhostText('a\x1b[2mb\nc\x1b[22md')).toBe('a\nd')
  })
})

describe('the input gate', () => {
  test('wake-up: a prompt sent while the session is still starting waits for it, and arrives', async () => {
    start('dl-wake', { readyAfter: 1200 })
    await sendPrompt('dl-wake', 'New task: wake path')
    expect(received()).toContain('New task: wake path')
  }, 15_000)

  test('never typed onto a line that already holds other text', async () => {
    tmux('send-keys', '-t', '=ao-dl-wake:', '-l', 'half-typed')
    const was = gateTiming.readyMs
    gateTiming.readyMs = 800
    await expect(untilReady('ao-dl-wake')).rejects.toThrow('already holds other text')
    gateTiming.readyMs = was
    tmux('send-keys', '-t', '=ao-dl-wake:', 'C-u')
  })

  test('/clear then the job: the prompt waits for the clear to finish and is not glued to it', async () => {
    start('dl-clear', { clearMs: 1500 })
    idle('dl-clear')
    await Bun.sleep(300)
    expect(await deliver('dl-clear', 'Daily job: clear path', { clearFirst: true, cronId: 'cron-dl' })).toBe('sent')
    const got = received()
    expect(got.some((p) => p.startsWith('Daily job: clear path'))).toBe(true)
    expect(got.some((p) => p.startsWith('/clear') && p.length > '/clear'.length)).toBe(false)
  }, 15_000)
})

describe('delivery confirmation', () => {
  test('a task prompt carries its id', async () => {
    start('dl-busy')
    await Bun.sleep(300)
    idle('dl-busy')
    tasksRepo.put(task('task-dl-id', 'dl-busy'))
    await startTask('task-dl-id')
    await until(() => received().some((p) => p.includes('(Task id: task-dl-id)')))
  }, 15_000)

  test('a prompt that never shows up is sent again, and arrives on the second try', async () => {
    start('dl-retry', { drop: 1 })
    await Bun.sleep(300)
    idle('dl-retry')
    tasksRepo.put(task('task-dl-retry', 'dl-retry'))
    expect(await startTask('task-dl-retry')).toBe('sent')
    await until(() => received().filter((p) => p.includes('task-dl-retry')).length === 1, 10_000)
    // confirmed: it stays in progress, nothing left in the queue
    await Bun.sleep(deliveryTiming.confirmMs + 300)
    expect(tasksRepo.get('task-dl-retry')?.status).toBe('in_progress')
    expect(tasksRepo.get('task-dl-retry')?.deliveryFailedAt).toBeUndefined()
    expect(queueRepo.countFor('dl-retry')).toBe(0)
  }, 20_000)

  test('never arriving after every try: back in To do, marked as not delivered', async () => {
    start('dl-fail', { drop: 99 })
    await Bun.sleep(300)
    idle('dl-fail')
    tasksRepo.put(task('task-dl-fail', 'dl-fail'))
    await startTask('task-dl-fail')
    await until(() => !!tasksRepo.get('task-dl-fail')?.deliveryFailedAt, 20_000)
    expect(tasksRepo.get('task-dl-fail')?.status).toBe('todo')
    expect(queueRepo.countFor('dl-fail')).toBe(0)
    void drainQueues()
  }, 30_000)
})

describe('the watchdog', () => {
  test('in progress, idle, and nothing of it in the session for minutes (after a restart too): typed again', async () => {
    mkdirSync(dogTranscripts, { recursive: true })
    const old = join(dogTranscripts, 'old.jsonl')
    const longAgo = Date.now() - 3_600_000
    writeFileSync(old, `${JSON.stringify({ type: 'user', timestamp: new Date(longAgo).toISOString(), message: { content: 'hi' } })}\n`)
    utimesSync(old, longAgo / 1000, longAgo / 1000)
    tmux('kill-session', '-t', '=ao-dl-dog')
    tmux('new-session', '-d', '-s', 'ao-dl-dog', '-x', '200', '-y', '50', fakeTuiCommand({ dir: dogTranscripts }))
    await Bun.sleep(300)
    idle('dl-dog')
    // "started" 3 minutes ago by a server that's gone (nothing in memory about it)
    tasksRepo.put({ ...task('task-dl-dog', 'dl-dog'), status: 'in_progress', startedAt: Date.now() - 3 * 60_000 })
    await tickTasks()
    const got = () => readdirSync(dogTranscripts).flatMap((f) => readFileSync(join(dogTranscripts, f), 'utf8').split('\n')).filter((l) => l.includes('task-dl-dog'))
    await until(() => got().length === 1, 10_000)
    expect(tasksRepo.get('task-dl-dog')?.status).toBe('in_progress')
  }, 20_000)
})
