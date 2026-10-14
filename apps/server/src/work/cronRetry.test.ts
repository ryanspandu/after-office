import { expect, test } from 'bun:test'
import { agentsRepo, cronsRepo, queueRepo, reportsRepo, type AgentRow } from '../db'
import { API_RETRY_MS, isApiErrorReply, retrying } from './parallel'
import { active, onAgentStopped } from './work'

// A daily job's run cut by an API error (a lost connection, an overloaded API): the agent carries on with it later, as
// with a task; no report meanwhile. When every try is used, the manager hears about it (with the job's prompt, to run
// it again), and it isn't one of the owner's unread reports.

const agent = (id: string, kind: AgentRow['kind']) => ({ id, name: id.toUpperCase(), tmux_session: `ao-${id}`, cwd: '/tmp', desk: Math.floor(Math.random() * 1e6), role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind }) as AgentRow
agentsRepo.insert(agent('cr-w', 'worker'))
if (!agentsRepo.all().some((a) => a.kind === 'manager')) agentsRepo.insert(agent('cr-m', 'manager'))
const manager = agentsRepo.all().find((a) => a.kind === 'manager')!
cronsRepo.put({ id: 'cron-cr', name: 'Morning SEO check', prompt: 'Check the rankings and write the summary.', times: ['07:00'], days: [1, 2, 3, 4, 5], agentId: 'cr-w', enabled: true, lastRuns: [] })
const run = () => active.set('cr-w', { cronId: 'cron-cr', title: 'Morning SEO check', startedAt: Date.now(), promptHead: 'Check the rankings and write the summary.' })
const reports = () => reportsRepo.latest(200).filter((r) => r.refId === 'cron-cr')
const ERROR = 'API Error: Connection error.'

test("Claude Code's API error as the whole answer is a failed turn", () => {
  expect(isApiErrorReply(ERROR)).toBe(true)
  expect(isApiErrorReply('API Error: 529 Overloaded')).toBe(true)
  expect(isApiErrorReply('Rankings are up 3 places. The API error from yesterday is gone.')).toBe(false)
})

test('cut by an API error (even with a normal Stop): tried again later, no report', () => {
  run()
  onAgentStopped('cr-w', ERROR)
  expect(reports()).toHaveLength(0)
  expect(retrying.has('cron:cron-cr')).toBe(true)
  expect(active.has('cr-w')).toBe(false)
})

test('every try used: the manager hears about it with the prompt; not an unread report for the owner', async () => {
  // the tries that are left (the timers haven't fired: each cut counts)
  for (let i = 1; i < API_RETRY_MS.length; i++) {
    run()
    onAgentStopped('cr-w', ERROR, true)
    expect(reports()).toHaveLength(0)
  }
  run()
  onAgentStopped('cr-w', ERROR, true)
  const [r] = reports()
  expect(r).toMatchObject({ ok: false, read: true, viaManager: true })
  // it's handed over in the background
  await Bun.sleep(200)
  const told: string[] = []
  for (let q = queueRepo.next(manager.id); q; q = queueRepo.next(manager.id)) {
    told.push(q.text)
    queueRepo.remove(q.id)
  }
  expect(told.some((t) => t.includes('Morning SEO check') && t.includes('Check the rankings and write the summary.') && t.includes('delegate_task'))).toBe(true)
})
