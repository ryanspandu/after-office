import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { agentsRepo } from '../db'
import { toInfo } from './registry'
import { agentRoutes } from '../routes/agents'

// Pinned agents stay on top of the list on every device: the pin is kept on the server.
test('pin and unpin an agent', async () => {
  const app = new Hono().route('/api', agentRoutes)
  agentsRepo.insert({ id: 'pin-a', name: 'Pinny', tmux_session: 'ao-pin-a', cwd: '/tmp/pin-a', desk: 951, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
  const put = (pinned: unknown) => app.request('/api/agents/pin-a/pin', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned }) })
  expect(toInfo(agentsRepo.get('pin-a')!).pinned).toBeUndefined()
  expect((await put(true)).status).toBe(200)
  expect(toInfo(agentsRepo.get('pin-a')!).pinned).toBe(true)
  expect((await put(false)).status).toBe(200)
  expect(toInfo(agentsRepo.get('pin-a')!).pinned).toBeUndefined()
  expect((await app.request('/api/agents/nope/pin', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"pinned":true}' })).status).toBe(404)
  agentsRepo.remove('pin-a')
})

// Its character's look: a random style kept on the server; "Shuffle look" draws a new one (the figure stays).
test('shuffle an agent\'s look', async () => {
  const app = new Hono().route('/api', agentRoutes)
  agentsRepo.insert({ id: 'sty-a', name: 'Styley', tmux_session: 'ao-sty-a', cwd: '/tmp/sty-a', desk: 952, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker', figure: 'woman' })
  expect(toInfo(agentsRepo.get('sty-a')!).style).toBeUndefined() // older agents: drawn from the desk
  const seen = new Set<number>()
  for (let i = 0; i < 3; i++) {
    const res = await app.request('/api/agents/sty-a/style', { method: 'POST' })
    expect(res.status).toBe(200)
    const { style } = (await res.json()) as { style: number }
    expect(Number.isInteger(style) && style >= 0).toBe(true)
    expect(toInfo(agentsRepo.get('sty-a')!).style).toBe(style)
    seen.add(style)
  }
  expect(seen.size).toBeGreaterThan(1)
  expect(toInfo(agentsRepo.get('sty-a')!).figure).toBe('woman')
  expect((await app.request('/api/agents/nope/style', { method: 'POST' })).status).toBe(404)
  agentsRepo.remove('sty-a')
})

// Effort is kept per agent and shown to the dashboards; a level that isn't one is refused before any restart.
test('agent effort', async () => {
  const app = new Hono().route('/api', agentRoutes)
  agentsRepo.insert({ id: 'eff-a', name: 'Effy', tmux_session: 'ao-eff-a', cwd: '/tmp/eff-a', desk: 953, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
  expect(toInfo(agentsRepo.get('eff-a')!).effort).toBeUndefined()
  agentsRepo.update('eff-a', { effort: 'xhigh' })
  expect(toInfo(agentsRepo.get('eff-a')!).effort).toBe('xhigh')
  const res = await app.request('/api/agents/eff-a/effort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"effort":"turbo"}' })
  expect(res.status).toBe(400)
  expect(agentsRepo.get('eff-a')!.effort).toBe('xhigh')
  agentsRepo.remove('eff-a')
})
