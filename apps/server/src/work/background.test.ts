import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficeTask } from '@after-office/shared'
import { agentsRepo, queueRepo, reportsRepo, tasksRepo, type AgentRow } from '../db'
import { TMUX_SOCKET_ARGS } from '../agents/env'
import { setRateLimits, updateRuntime } from '../agents/registry'
import { updateSettings } from './settings'
import { CLAUDE_PROJECTS_DIR } from '../fsroots'
import { deliver, expectReply, handleStop, onAgentStopped, onPromptSubmitted, startTask } from './work'

// Work handed to background subagents, and answers to the manager's messages. The worker has a real (idle) tmux
// session on the tests' own tmux server, so prompts are typed instead of queued and the run is tracked.

const dir = mkdtempSync(join(tmpdir(), 'ao-bg-'))
const tmux = (...args: string[]) => Bun.spawnSync([process.env.TMUX_BIN ?? 'tmux', ...TMUX_SOCKET_ARGS, ...args])
const agent = (id: string, kind: AgentRow['kind'] = 'worker'): AgentRow => ({
  id,
  name: id.toUpperCase(),
  tmux_session: `ao-${id}`,
  cwd: dir,
  desk: Math.floor(Math.random() * 1e6),
  role: '',
  model: 'haiku',
  permission_mode: 'default',
  session_id: crypto.randomUUID(),
  created_at: Date.now(),
  kind,
})
const task = (id: string, patch: Partial<OfficeTask> = {}): OfficeTask => ({
  id,
  title: id,
  agentId: 'bg-w',
 
  deadline: Date.now() + 3_600_000,
  priority: 'medium',
  status: 'todo',
  delegatedBy: 'bg-mgr',
  ...patch,
})
const idle = (id: string) => updateRuntime(id, (rt) => ({ ...rt, status: 'idle', lastEventAt: Date.now() }))
const managerInbox = () => {
  const out: string[] = []
  for (let next = queueRepo.next('bg-mgr'); next; next = queueRepo.next('bg-mgr')) {
    out.push(next.text)
    queueRepo.remove(next.id)
  }
  return out
}
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(20)
  }
}
// the worker's transcript: Claude Code writes a turn_duration entry (with the background agents still out) per turn
const transcript = join(CLAUDE_PROJECTS_DIR, 'bg-test', 'session.jsonl')
const turnEnded = (pending: number) =>
  appendFileSync(
    transcript,
    JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: new Date().toISOString(), ...(pending ? { pendingBackgroundAgentCount: pending } : {}) }) + '\n',
  )
const reportsFor = (taskId: string) => reportsRepo.latest(100).filter((r) => r.refId === taskId)

beforeAll(() => {
  agentsRepo.insert(agent('bg-w'))
  agentsRepo.insert(agent('bg-mgr', 'manager')) // no session: what it's sent is queued, so the test can read it
  tmux('new-session', '-d', '-s', 'ao-bg-w', 'sleep 300')
  mkdirSync(join(CLAUDE_PROJECTS_DIR, 'bg-test'), { recursive: true })
  updateRuntime('bg-w', (rt) => ({ ...rt, transcriptPath: transcript }))
  setRateLimits({ fiveHourPct: 1, sevenDayPct: 1, fiveHourResetsAt: null, sevenDayResetsAt: null })
  updateSettings({ managerApproval: false, autoAssign: false })
})
afterAll(() => void tmux('kill-server'))

describe('background subagents', () => {
  test('the task is finished when the last one is back, not when the first turn ends', async () => {
    idle('bg-w')
    tasksRepo.put(task('bg-1', { title: 'Keyword research' }))
    await startTask('bg-1')
    await until(() => tasksRepo.get('bg-1')!.status === 'in_progress')
    onPromptSubmitted('bg-w', 'New task: Keyword research')

    // five researchers sent off in the background; the turn ends with "they're running"
    turnEnded(5)
    await handleStop('bg-w', 'Both researchers are running in the background.')
    expect(tasksRepo.get('bg-1')!.status).toBe('in_progress')
    expect(reportsFor('bg-1')).toHaveLength(0)
    expect(managerInbox()).toHaveLength(0)

    // one reports back: the agent wakes up (not the user moving on), four still to go
    onPromptSubmitted('bg-w', '<task-notification>researcher a finished</task-notification>')
    await Bun.sleep(600) // a turn later
    turnEnded(4)
    await handleStop('bg-w', 'One back, waiting for the others.')
    expect(tasksRepo.get('bg-1')!.status).toBe('in_progress')

    await Bun.sleep(600)
    turnEnded(0)
    await handleStop('bg-w', 'All done: see keywords.md')
    expect(tasksRepo.get('bg-1')!.status).toBe('review')
    const reports = reportsFor('bg-1')
    expect(reports).toHaveLength(1)
    expect(reports[0].text).toBe('All done: see keywords.md')
    await until(() => queueRepo.countFor('bg-mgr') > 0)
    const [forwarded] = managerInbox()
    expect(forwarded).toContain('Report from BG-W on task "Keyword research"')
    expect(forwarded).toContain('All done: see keywords.md')
  })
})

describe('prompts added to a running turn', () => {
  test("a subagent's result handed back mid-turn isn't the user moving on", async () => {
    idle('bg-w')
    tasksRepo.put(task('bg-2', { title: 'Market research' }))
    await startTask('bg-2')
    await until(() => tasksRepo.get('bg-2')!.status === 'in_progress')
    onPromptSubmitted('bg-w', 'New task: Market research')
    // still working (no Stop yet) when the helper's result comes in, in whatever wording
    onPromptSubmitted('bg-w', 'Subagent result: the market is …', true)
    expect(tasksRepo.get('bg-2')!.status).toBe('in_progress')
    expect(reportsFor('bg-2')).toHaveLength(0)
    // after the turn stopped without its Stop (interrupted), a new prompt does mean it moved on
    onPromptSubmitted('bg-w', 'Something else entirely', false)
    expect(tasksRepo.get('bg-2')!.status).toBe('todo')
    // (its "interrupted" report reaches the manager)
    await until(() => queueRepo.countFor('bg-mgr') > 0)
    expect(managerInbox()[0]).toContain('Interrupted')
  })
})

describe("the manager's messages", () => {
  test('the answer goes back to the manager', async () => {
    idle('bg-w')
    await deliver('bg-w', '[From the manager] Is the file there yet?')
    expectReply('bg-w', 'bg-mgr')
    onAgentStopped('bg-w', 'Yes, keywords.md is ready.')
    await until(() => queueRepo.countFor('bg-mgr') > 0)
    const [reply] = managerInbox()
    expect(reply).toContain('BG-W answered your message')
    expect(reply).toContain('Yes, keywords.md is ready.')

    // only the next answer
    onAgentStopped('bg-w', 'Something else entirely.')
    await Bun.sleep(100)
    expect(managerInbox()).toHaveLength(0)
  })
})
