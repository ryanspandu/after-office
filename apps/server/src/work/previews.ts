import type { Context } from 'hono'
import { readSessionFromCookie, SESSION_COOKIE_NAMES } from '../auth'
import { AgentError } from '../agents/errors'
import { runAsAgent } from '../agents/asagent'
import { AGENTS_DIR } from '../fsroots'

// Previews: the apps agents run while they work (a dev server on a preview port, 3000–3009 by default), opened from
// the dashboard. On your own machine the link is simply http://localhost:<port>. On a server they come through a
// small proxy here (OFFICE_PREVIEW_PROXY=true), on 127.0.0.1:<port + PROXY_OFFSET>, which Tailscale publishes as
// https://<office host>:<port>, or Caddy as https://<office host>:<port + PUBLIC_OFFSET> (see below):
// - only for someone signed in to the dashboard (the session cookie reaches the other port of the same host);
// - and that cookie is taken off the request before it reaches the app: an agent's app never sees your session.

/** The proxy for app port p listens on 127.0.0.1:(p + this). */
export const PROXY_OFFSET = Number(process.env.OFFICE_PREVIEW_PROXY_OFFSET) || 10_000
/** A preview opens at https://<host>:(p + this). 0 with Tailscale serve, which takes no port on the server. Caddy does
 * take the port it serves on (every address, 127.0.0.1 too): on the app's own port, the app couldn't start and the
 * port would look busy. So behind Caddy previews are at p + 10000 and the proxy moves to p + 20000 (setup-vps.sh). */
export const PUBLIC_OFFSET = Number(process.env.OFFICE_PREVIEW_PUBLIC_OFFSET) || 0

/** "3000-3009,5173" → ports (at most 50). Default 3000–3009. */
export function previewPorts(spec = process.env.OFFICE_PREVIEW_PORTS ?? '3000-3009'): number[] {
  const out = new Set<number>()
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map(Number)
    const from = Math.max(1024, a)
    const to = Math.min(55_535, Number.isFinite(b) ? b : a)
    for (let p = from; p <= to && out.size < 50; p++) out.add(p)
  }
  return [...out].sort((x, y) => x - y)
}

/** Is something listening on 127.0.0.1:port? */
async function listening(port: number) {
  try {
    const s = await Promise.race([
      Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }),
      new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 400)),
    ])
    s.end()
    return true
  } catch {
    return false
  }
}

/** The page's <title>, to tell previews apart (best effort, short timeout). */
async function pageTitle(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200), headers: { accept: 'text/html' } })
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) return null
    const html = (await res.text()).slice(0, 50_000)
    const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export interface Preview {
  port: number
  url: string
  title: string | null
}

/** The preview ports something is listening on, with the link to open each one from this browser. */
export async function listPreviews(c: Context): Promise<Preview[]> {
  const ports = previewPorts()
  const open = (await Promise.all(ports.map(async (p) => ((await listening(p)) ? p : null)))).filter((p): p is number => p !== null)
  const base = process.env.OFFICE_PUBLIC_URL ? new URL(process.env.OFFICE_PUBLIC_URL) : new URL(c.req.url)
  // on a server: the public host, same scheme (the proxy's port is published there); locally: this browser's host
  const proto = process.env.OFFICE_PUBLIC_URL ? base.protocol : 'http:'
  const host = process.env.OFFICE_PUBLIC_URL ? base.hostname : (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'localhost').split(':')[0]
  const shown = (port: number) => (process.env.OFFICE_PUBLIC_URL ? port + PUBLIC_OFFSET : port)
  return Promise.all(open.map(async (port) => ({ port, url: `${proto}//${host}:${shown(port)}/`, title: await pageTitle(port) })))
}

/**
 * Stop the app on a preview port: the processes listening on it get SIGTERM (then SIGKILL if it's still up after a few
 * seconds). Found and stopped with the agents' rights (runAsAgent): on a server that is the agents' own Unix user, so
 * only an agent's app can be stopped this way, never the dashboard, Caddy or anything else on the machine.
 */
export async function stopPreview(port: number): Promise<{ stopped: boolean }> {
  if (!previewPorts().includes(port)) throw new AgentError('Not a preview port', 400)
  if (!(await listening(port))) return { stopped: true }
  const pids = (await listenerPids(port)).filter((pid) => pid !== process.pid && pid !== process.ppid)
  if (!pids.length) throw new AgentError(`Nothing the agents run is listening on ${port}: it may belong to another user`, 409)
  await runAsAgent(['kill', '-TERM', ...pids.map(String)], { cwd: AGENTS_DIR, timeoutMs: 5000 })
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(250)
    if (!(await listening(port))) return { stopped: true }
  }
  // still up (ignores SIGTERM, or a new listener took over): the hard way
  const left = (await listenerPids(port)).filter((pid) => pid !== process.pid && pid !== process.ppid)
  if (left.length) await runAsAgent(['kill', '-KILL', ...left.map(String)], { cwd: AGENTS_DIR, timeoutMs: 5000 })
  await Bun.sleep(400)
  return { stopped: !(await listening(port)) }
}

/** The processes (that the agents' user can see) listening on a TCP port: lsof, else fuser, else ss. */
async function listenerPids(port: number): Promise<number[]> {
  const script = [
    `if command -v lsof >/dev/null 2>&1; then lsof -t -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`,
    `elif command -v fuser >/dev/null 2>&1; then fuser -n tcp ${port} 2>/dev/null`,
    `else ss -ltnpH "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2; fi`,
  ].join('; ')
  const r = await runAsAgent(['sh', '-c', script], { cwd: AGENTS_DIR, timeoutMs: 5000 })
  return [...new Set((r.out.match(/\d+/g) ?? []).map(Number).filter((n) => n > 1))]
}

/** A Cookie header without the dashboard's session cookie. */
export function withoutSessionCookie(cookie: string | null) {
  if (!cookie) return null
  const kept = cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !SESSION_COOKIE_NAMES.includes(c.split('=')[0]))
  return kept.length ? kept.join('; ') : null
}

type WsData = { upstream: WebSocket | null; url: string; protocols: string[]; queue: (string | ArrayBuffer)[] }

/** The proxy for one preview port: 127.0.0.1:<port + PROXY_OFFSET> → the app on 127.0.0.1:<port>. */
export function startProxy(port: number) {
  const target = `127.0.0.1:${port}`
  return Bun.serve<WsData>({
    hostname: '127.0.0.1',
    port: port + PROXY_OFFSET,
    async fetch(req, server) {
      // signed in to the dashboard? (the browser sends its cookie to every port of the office's host)
      if (!(await readSessionFromCookie(req.headers.get('cookie')))) {
        const home = process.env.OFFICE_PUBLIC_URL ?? '/'
        return new Response(`Sign in to the dashboard first: ${home}`, { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
      const url = new URL(req.url)
      // hot reload and other WebSockets: bridged to the app
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim()).filter(Boolean)
        const ok = server.upgrade(req, {
          data: { upstream: null, url: `ws://${target}${url.pathname}${url.search}`, protocols, queue: [] },
          headers: protocols[0] ? { 'Sec-WebSocket-Protocol': protocols[0] } : undefined,
        })
        return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
      }
      const headers = new Headers(req.headers)
      const cookie = withoutSessionCookie(req.headers.get('cookie'))
      if (cookie) headers.set('cookie', cookie)
      else headers.delete('cookie')
      // dev servers trust localhost (Vite refuses unknown hosts); where the page really is goes in X-Forwarded-*
      headers.set('x-forwarded-host', req.headers.get('host') ?? '')
      headers.set('x-forwarded-proto', req.headers.get('x-forwarded-proto') ?? 'https')
      headers.set('host', `localhost:${port}`)
      try {
        const res = await fetch(`http://${target}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
          redirect: 'manual',
          // @ts-expect-error Bun: stream the request body
          duplex: 'half',
          decompress: false,
        })
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
      } catch {
        return new Response(`Nothing is running on port ${port} right now.`, { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(ws.data.url, ws.data.protocols)
        up.binaryType = 'arraybuffer'
        ws.data.upstream = up
        up.onopen = () => {
          for (const m of ws.data.queue) up.send(m)
          ws.data.queue = []
        }
        up.onmessage = (e) => ws.send(e.data as string | ArrayBuffer)
        up.onclose = () => ws.close()
        up.onerror = () => ws.close()
      },
      message(ws, msg) {
        const up = ws.data.upstream
        const data = typeof msg === 'string' ? msg : (msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer)
        if (up?.readyState === WebSocket.OPEN) up.send(data)
        else ws.data.queue.push(data)
      },
      close(ws) {
        ws.data.upstream?.close()
      },
    },
  })
}

/** On a server (OFFICE_PREVIEW_PROXY=true): one proxy per preview port. */
export function startPreviewProxies() {
  if (process.env.OFFICE_PREVIEW_PROXY !== 'true') return
  for (const port of previewPorts()) {
    try {
      startProxy(port)
    } catch (e) {
      console.error(`[preview] could not listen on ${port + PROXY_OFFSET}:`, e instanceof Error ? e.message : e)
    }
  }
  console.log(`[preview] proxies for ports ${previewPorts().join(', ')} on 127.0.0.1:(port + ${PROXY_OFFSET})`)
}
