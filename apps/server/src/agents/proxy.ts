import { agentsRepo, settingsRepo } from '../db'
import { seal, unseal } from '../totp'
import { AgentError } from './errors'
import { restartWhenIdle } from './reconciler'

// The office's residential proxy (Office settings → Residential proxy): one provider's gateway (DataImpulse, Bright
// Data, Oxylabs…) the agents use for scraping and other requests that get blocked from a server's IP. It reaches their
// sessions as RESIDENTIAL_PROXY_URL (and its parts), never as HTTP(S)_PROXY: that would send Claude Code's own API
// traffic through it too. The password is sealed with the server's key and never sent back to the dashboard. A change
// restarts the agents once they're idle, so their sessions get it.

export type ProxyProtocol = 'http' | 'socks5'

export interface ProxyInfo {
  enabled: boolean
  provider: string
  protocol: ProxyProtocol
  host: string
  port: number
  username: string
  /** a password is saved (its value never leaves the server) */
  hasPassword: boolean
  updatedAt: number
}
interface Stored extends Omit<ProxyInfo, 'hasPassword'> {
  sealed?: string
}

const KEY = 'residentialProxy'
const HOST = /^[a-zA-Z0-9.-]{1,253}$/

const serverKey = () => {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 32) throw new AgentError('Sign-in is not set up on this server (SESSION_SECRET)', 500)
  return s
}

function load(): Stored | null {
  try {
    const v = JSON.parse(settingsRepo.get(KEY) ?? 'null')
    return v && typeof v.host === 'string' ? v : null
  } catch {
    return null
  }
}

const info = (s: Stored): ProxyInfo => ({ enabled: s.enabled, provider: s.provider, protocol: s.protocol, host: s.host, port: s.port, username: s.username, hasPassword: !!s.sealed, updatedAt: s.updatedAt })

/** As the dashboard sees it: everything but the password. */
export const proxyInfo = (): ProxyInfo | null => {
  const s = load()
  return s ? info(s) : null
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim() : '').slice(0, max)
const oneLine = (v: string, what: string) => {
  if (/[\0\r\n]/.test(v)) throw new AgentError(`The ${what} must be one line`, 400)
  return v
}

/** Who gets restarted when the proxy changes: every agent whose sessions should see the new values. */
function restartAll() {
  for (const a of agentsRepo.all()) restartWhenIdle(a.id)
}

/** Save it. An empty password keeps the saved one. */
export function putProxy(input: Record<string, unknown>): ProxyInfo {
  const prev = load()
  const protocol: ProxyProtocol = input.protocol === 'socks5' ? 'socks5' : 'http'
  const host = text(input.host, 253).replace(/^[a-z0-9]+:\/\//i, '').replace(/\/.*$/, '')
  if (!HOST.test(host)) throw new AgentError('A host like gw.dataimpulse.com', 400)
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AgentError('A port between 1 and 65535', 400)
  const username = oneLine(text(input.username, 500), 'username')
  const password = oneLine(typeof input.password === 'string' ? input.password : '', 'password')
  if (password.length > 500) throw new AgentError('That password is too long', 400)
  const sealed = password ? seal(password, serverKey()) : prev?.sealed
  if (username && !sealed) throw new AgentError('Paste the password too', 400)
  const next: Stored = {
    enabled: input.enabled !== false,
    provider: text(input.provider, 40) || 'custom',
    protocol,
    host,
    port,
    username,
    ...(sealed ? { sealed } : {}),
    updatedAt: Date.now(),
  }
  settingsRepo.set(KEY, JSON.stringify(next))
  restartAll()
  return info(next)
}

export function removeProxy() {
  if (!load()) return
  settingsRepo.delete(KEY)
  restartAll()
}

/** The proxy as a URL, credentials included (encoded). Null when off or not set. */
export function proxyUrl(s: Stored | null = load()): string | null {
  if (!s?.enabled) return null
  const k = process.env.SESSION_SECRET
  const password = s.sealed && k ? unseal(s.sealed, k) : null
  const auth = s.username ? `${encodeURIComponent(s.username)}${password !== null ? `:${encodeURIComponent(password)}` : ''}@` : ''
  return `${s.protocol === 'socks5' ? 'socks5h' : 'http'}://${auth}${s.host}:${s.port}`
}

/** For the agents' sessions: RESIDENTIAL_PROXY_URL and its parts, when the proxy is on. */
export function proxyEnv(): Record<string, string> {
  const s = load()
  const url = proxyUrl(s)
  if (!s || !url) return {}
  const k = process.env.SESSION_SECRET
  const password = s.sealed && k ? unseal(s.sealed, k) : null
  return {
    RESIDENTIAL_PROXY_URL: url,
    RESIDENTIAL_PROXY_PROTOCOL: s.protocol,
    RESIDENTIAL_PROXY_HOST: s.host,
    RESIDENTIAL_PROXY_PORT: String(s.port),
    ...(s.username ? { RESIDENTIAL_PROXY_USERNAME: s.username } : {}),
    ...(password !== null ? { RESIDENTIAL_PROXY_PASSWORD: password } : {}),
  }
}

export interface ProxyTest {
  ok: boolean
  ip?: string
  country?: string
  city?: string
  org?: string
  ms?: number
  error?: string
}

/**
 * One request through it: the IP (and where it is) a site sees. curl reads the proxy from its standard input, so the
 * credentials never show in the process list.
 */
export async function testProxy(): Promise<ProxyTest> {
  const s = load()
  if (!s) throw new AgentError('Save a proxy first', 400)
  const url = proxyUrl({ ...s, enabled: true })!
  const started = Date.now()
  const config = `proxy = "${url.replace(/["\\]/g, '\\$&')}"\nurl = "https://ipinfo.io/json"\nmax-time = 25\nsilent\nshow-error\n`
  const p = Bun.spawn(['curl', '-K', '-'], { stdin: new Blob([config]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  const ms = Date.now() - started
  if (code !== 0) return { ok: false, ms, error: (err.trim().split('\n').pop() ?? `curl exited ${code}`).replace(url, '<proxy>').slice(0, 200) }
  try {
    const j = JSON.parse(out) as { ip?: string; country?: string; city?: string; org?: string }
    return { ok: !!j.ip, ip: j.ip, country: j.country, city: j.city, org: j.org, ms, ...(j.ip ? {} : { error: 'No IP in the answer' }) }
  } catch {
    return { ok: false, ms, error: 'The proxy answered, but not with the IP check (wrong host or port?)' }
  }
}
