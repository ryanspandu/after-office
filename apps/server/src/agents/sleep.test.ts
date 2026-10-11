import { afterAll, expect, test } from 'bun:test'
import { agentsRepo, queueRepo, type AgentRow } from '../db'
import { mainBusy } from '../work/parallel'
import { toInfo, updateRuntime } from './registry'
import { autoSleep, isAsleep, sleepAgent, sleepBlocker } from './sleep'
import { updateSettings } from '../work/settings'

// Sleep: an idle agent's session stops (memory back) and stays stopped; busy agents and the manager never sleep.

const tmuxName = process.env.OFFICE_TMUX_NAME!
const sh = (...a: string[]) => Bun.spawnSync(['tmux', '-L', tmuxName, ...a])
const alive = (s: string) => sh('has-session', '-t', `=${s}`).exitCode === 0

const row = (id: string, kind: AgentRow['kind'] = 'worker'): AgentRow => ({
  id,
  name: id,
  tmux_session: `ao-${id}`,
  cwd: '/tmp',
  desk: Math.floor(Math.random() * 1e6),
  role: '',
  model: 'haiku',
  permission_mode: 'default',
  session_id: crypto.randomUUID(),
  created_at: Date.now(),
  kind,
})
const ids = ['sleep-a', 'sleep-b', 'sleep-m']
afterAll(() => {
  for (const id of ids) {
    sh('kill-session', '-t', `=ao-${id}`)
    queueRepo.removeAgent(id)
    agentsRepo.remove(id)
  }
})

test('an idle agent sleeps: its session stops, it shows asleep and stays out of "busy"', async () => {
  agentsRepo.insert(row('sleep-a'))
  sh('new-session', '-d', '-s', 'ao-sleep-a', 'sleep 60')
  updateRuntime('sleep-a', (rt) => ({ ...rt, status: 'idle' }))
  expect(sleepBlocker('sleep-a')).toBeNull()
  await sleepAgent('sleep-a')
  expect(isAsleep('sleep-a')).toBe(true)
  expect(alive('ao-sleep-a')).toBe(false)
  expect(toInfo(agentsRepo.get('sleep-a')!).status).toBe('asleep')
  // its work goes the normal way (queued, waking it), not to a parallel session
  expect(mainBusy('sleep-a')).toBe(false)
  await expect(sleepAgent('sleep-a')).rejects.toThrow('already asleep')
})

test('busy agents, agents with queued work and the manager stay awake', () => {
  agentsRepo.insert(row('sleep-b'))
  agentsRepo.insert(row('sleep-m', 'manager'))
  updateRuntime('sleep-b', (rt) => ({ ...rt, status: 'working' }))
  expect(sleepBlocker('sleep-b')).toContain('working')
  updateRuntime('sleep-b', (rt) => ({ ...rt, status: 'idle' }))
  queueRepo.add({ id: crypto.randomUUID(), agent_id: 'sleep-b', text: 'x', clear_first: 0, task_id: null, cron_id: null })
  expect(sleepBlocker('sleep-b')).toContain('queue')
  queueRepo.removeAgent('sleep-b')
  expect(sleepBlocker('sleep-m')).toContain('manager')
})

test('auto-sleep: only after the idle hours, never the manager, never with it off', async () => {
  const t0 = Date.now()
  updateRuntime('sleep-b', (rt) => ({ ...rt, status: 'idle' }))
  updateRuntime('sleep-m', (rt) => ({ ...rt, status: 'idle' }))
  await autoSleep(120, t0)
  await autoSleep(120, t0 + 3_600_000)
  expect(isAsleep('sleep-b')).toBe(false)
  // off: idle for days, still awake
  await autoSleep(0, t0 + 72 * 3_600_000)
  expect(isAsleep('sleep-b')).toBe(false)
  await autoSleep(120, t0 + 2 * 3_600_000 + 1)
  expect(isAsleep('sleep-b')).toBe(true)
  expect(isAsleep('sleep-m')).toBe(false)
})

test('working in between starts the idle clock again', async () => {
  agentsRepo.update('sleep-b', { asleep_at: null })
  const t0 = Date.now()
  updateRuntime('sleep-b', (rt) => ({ ...rt, status: 'idle' }))
  await autoSleep(60, t0)
  updateRuntime('sleep-b', (rt) => ({ ...rt, status: 'working' }))
  await autoSleep(60, t0 + 30 * 60_000)
  updateRuntime('sleep-b', (rt) => ({ ...rt, status: 'idle' }))
  await autoSleep(60, t0 + 61 * 60_000)
  expect(isAsleep('sleep-b')).toBe(false)
  await autoSleep(60, t0 + 122 * 60_000)
  expect(isAsleep('sleep-b')).toBe(true)
})

test('the idle time is any number of minutes: at least 5, at most a week, 0 is never', () => {
  const minutes = (v: unknown) => updateSettings({ autoSleepMinutes: v }).autoSleepMinutes
  expect(minutes(95)).toBe(95)
  expect(minutes(2)).toBe(5)
  expect(minutes(99_999)).toBe(7 * 24 * 60)
  expect(minutes(0)).toBe(0)
  expect(minutes('lots')).toBe(0)
  updateSettings({ autoSleepMinutes: 120 })
})
