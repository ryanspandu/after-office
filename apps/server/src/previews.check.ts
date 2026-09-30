// Run by previews.test.ts in its own process, with a throwaway login: the preview proxy end to end.
import { Hono } from 'hono'

const { login, requireAuth, requireJsonForWrites, twoFactorEnable, twoFactorSetup } = await import('./auth')
const { startProxy, PROXY_OFFSET, withoutSessionCookie, previewPorts } = await import('./work/previews')
const { signInAndEnroll } = await import('./auth.testkit')
const app = new Hono()
app.use('/api/*', requireJsonForWrites, requireAuth)
app.post('/api/auth/login', login)
app.post('/api/auth/2fa/setup', twoFactorSetup)
app.post('/api/auth/2fa/enable', twoFactorEnable)
// signed in with the password only (2FA not set up yet): not enough for a preview
const r = await app.request('http://office.test/api/auth/login', { method: 'POST', headers: { host: 'office.test', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'old-password-123' }) })
const setupOnly = (r.headers.get('set-cookie') ?? '').split(';')[0]
const session = (await signInAndEnroll(app, 'owner', 'old-password-123'))!.cookie

const PORT = 4591
// the "agent's app": says which cookie and host it got; echoes WebSocket messages
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return
    return Response.json({ cookie: req.headers.get('cookie'), host: req.headers.get('host'), fwd: req.headers.get('x-forwarded-host'), path: new URL(req.url).pathname })
  },
  websocket: { message(ws, m) { ws.send(`echo:${m}`) } },
})
startProxy(PORT)
const base = `http://127.0.0.1:${PORT + PROXY_OFFSET}`
const out: Record<string, unknown> = {}
out.noSession = (await fetch(`${base}/x`)).status
out.setupOnly = (await fetch(`${base}/x`, { headers: { cookie: setupOnly } })).status
const ok = await fetch(`${base}/hello?a=1`, { headers: { cookie: `${session}; theme=dark`, host: 'office.test:3000' } })
out.withSession = ok.status
out.upstreamSaw = await ok.json()
out.strip = withoutSessionCookie('__Host-ao_session=abc; a=1; ao_session=x')
out.ports = previewPorts('3000-3002, 5173, 80')
// WebSocket through the proxy (hot reload)
out.ws = await new Promise((done) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT + PROXY_OFFSET}/hmr`, { headers: { cookie: session } } as never)
  ws.onopen = () => ws.send('ping')
  ws.onmessage = (e) => (done(String(e.data)), ws.close())
  ws.onerror = () => done('error')
  setTimeout(() => done('timeout'), 3000)
})
upstream.stop()
console.log(JSON.stringify(out))
process.exit(0)
