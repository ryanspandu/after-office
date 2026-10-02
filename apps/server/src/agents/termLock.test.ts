import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireUnlockedTerminal, terminalsOpenUntil, unlockTerminals } from './termLock'

// Terminals open only for a browser session that typed the authenticator code; others (and that one, once it expires)
// are refused before any terminal is attached.

const app = new Hono()
// stands in for the sign-in check, which puts the session's key on the request
app.use('*', async (c, next) => {
  const key = c.req.header('x-session')
  if (key) c.set('sessionKey' as never, key as never)
  return next()
})
app.get('/term', requireUnlockedTerminal, (c) => c.text('attached'))
app.post('/unlock', (c) => c.json({ until: unlockTerminals(c) }))
app.get('/until', (c) => c.json({ until: terminalsOpenUntil(c) }))
const as = (session: string | null, path: string, method = 'GET') => app.request(path, { method, headers: session ? { 'x-session': session } : {} })

test('locked until the code is typed in this session; another session stays locked', async () => {
  expect((await as('s1', '/term')).status).toBe(403)
  expect(((await (await as('s1', '/term')).json()) as { locked: boolean }).locked).toBe(true)
  await as('s1', '/unlock', 'POST')
  expect((await as('s1', '/term')).status).toBe(200)
  expect((await as('s2', '/term')).status).toBe(403)
  expect((await as(null, '/term')).status).toBe(403)
  const { until } = (await (await as('s1', '/until')).json()) as { until: number }
  expect(until).toBeGreaterThan(Date.now() + 29 * 60_000)
})
