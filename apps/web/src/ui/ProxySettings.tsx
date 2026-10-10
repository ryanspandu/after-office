import { useEffect, useState } from 'react'
import { LuCircleCheck, LuCircleX, LuGlobe, LuLoader, LuPencil, LuTrash2 } from 'react-icons/lu'
import { api } from '../state/auth'
import { confirm } from './Confirm'
import { Modal } from './Modal'
import { Select } from './Select'

// Office settings → Residential proxy: one provider's gateway the agents use for scraping (their sessions get it as
// RESIDENTIAL_PROXY_URL and its parts; server: agents/proxy.ts). Any provider: pick one to fill its usual gateway, or
// paste what the provider shows ("host:port:user:pass" or a proxy URL). The password is never shown again.

interface ProxyInfo {
  enabled: boolean
  provider: string
  protocol: 'http' | 'socks5'
  host: string
  port: number
  username: string
  hasPassword: boolean
  updatedAt: number
}
interface ProxyTest {
  ok: boolean
  ip?: string
  country?: string
  city?: string
  org?: string
  ms?: number
  error?: string
}

/** Their usual gateway (the provider's dashboard has the exact one) and how to pick a country, which differs for each. */
const PROVIDERS: { value: string; label: string; host: string; port: number; socksPort?: number; country?: string }[] = [
  { value: 'dataimpulse', label: 'DataImpulse', host: 'gw.dataimpulse.com', port: 823, socksPort: 824, country: 'add __cr.us to the username (us = the country code)' },
  { value: 'brightdata', label: 'Bright Data', host: 'brd.superproxy.io', port: 33335, country: 'add -country-us to the username' },
  { value: 'oxylabs', label: 'Oxylabs', host: 'pr.oxylabs.io', port: 7777, country: 'add -cc-US to the username' },
  { value: 'decodo', label: 'Decodo (Smartproxy)', host: 'gate.decodo.com', port: 7000, country: 'pick it in the provider’s dashboard, or add -country-us to the username' },
  { value: 'iproyal', label: 'IPRoyal', host: 'geo.iproyal.com', port: 12321, country: 'add _country-us to the password' },
  { value: 'webshare', label: 'Webshare', host: 'p.webshare.io', port: 80 },
  { value: 'custom', label: 'Other provider', host: '', port: 0 },
]
const providerOf = (v: string) => PROVIDERS.find((p) => p.value === v) ?? PROVIDERS[PROVIDERS.length - 1]

/** What providers hand out: "http://user:pass@host:port", "user:pass@host:port" or "host:port:user:pass". */
export function parseProxy(raw: string): { protocol?: 'http' | 'socks5'; host: string; port: number; username?: string; password?: string } | null {
  const s = raw.trim()
  if (!s) return null
  const scheme = s.match(/^([a-z0-9]+):\/\//i)?.[1]?.toLowerCase()
  const protocol = scheme ? (scheme.startsWith('socks') ? 'socks5' : 'http') : undefined
  const rest = s.replace(/^[a-z0-9]+:\/\//i, '').replace(/\/+$/, '')
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    const [host, port] = rest.slice(at + 1).split(':')
    const cred = rest.slice(0, at)
    const colon = cred.indexOf(':')
    const dec = (x: string) => {
      try {
        return decodeURIComponent(x)
      } catch {
        return x
      }
    }
    if (!host || !Number(port)) return null
    return { protocol, host, port: Number(port), username: dec(colon < 0 ? cred : cred.slice(0, colon)), password: colon < 0 ? undefined : dec(cred.slice(colon + 1)) }
  }
  const parts = rest.split(':')
  if (parts.length >= 2 && Number(parts[1])) {
    return { protocol, host: parts[0], port: Number(parts[1]), username: parts[2], password: parts.length > 3 ? parts.slice(3).join(':') : undefined }
  }
  return null
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(j?.error ?? `Request failed (${res.status})`)
  return j as T
}

function TestResult({ test }: { test: ProxyTest }) {
  if (!test.ok)
    return (
      <p className="proxy__test proxy__test--bad">
        <LuCircleX /> {test.error ?? 'It did not answer'}
      </p>
    )
  return (
    <p className="proxy__test proxy__test--ok">
      <LuCircleCheck /> Works: sites see <b className="mono">{test.ip}</b>
      {[test.city, test.country].filter(Boolean).length ? ` (${[test.city, test.country].filter(Boolean).join(', ')})` : ''}
      {test.ms != null && <span className="muted"> · {(test.ms / 1000).toFixed(1)} s</span>}
    </p>
  )
}

/** The section in Office settings: what's set, and its buttons. */
export function ProxySection() {
  const [proxy, setProxy] = useState<ProxyInfo | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [test, setTest] = useState<ProxyTest | null>(null)
  const [busy, setBusy] = useState<'' | 'test' | 'toggle' | 'remove'>('')
  const [error, setError] = useState('')
  useEffect(() => {
    void call<{ proxy: ProxyInfo | null }>('/api/proxy').then((r) => setProxy(r.proxy), () => setProxy(null))
  }, [])

  const run = async (what: typeof busy, fn: () => Promise<unknown>) => {
    setBusy(what)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy('')
    }
  }
  const doTest = () => run('test', async () => setTest(await call<ProxyTest>('/api/proxy/test', 'POST')))
  const toggle = (on: boolean) =>
    run('toggle', async () => {
      if (!proxy) return
      const r = await call<{ proxy: ProxyInfo }>('/api/proxy', 'PUT', { ...proxy, enabled: on, password: '' })
      setProxy(r.proxy)
    })
  const remove = () =>
    run('remove', async () => {
      if (!(await confirm({ title: 'Remove the residential proxy?', message: 'Agents lose RESIDENTIAL_PROXY_URL once they restart (when idle).', confirmLabel: 'Remove', danger: true }))) return
      await call('/api/proxy', 'DELETE')
      setProxy(null)
      setTest(null)
    })

  return (
    <div className="field proxy">
      <span className="field__label">Residential proxy</span>
      {proxy === undefined ? (
        <span className="field__hint">
          <LuLoader className="spin" /> Loading…
        </span>
      ) : proxy ? (
        <>
          <div className="proxy__summary">
            <LuGlobe />
            <span className="proxy__what">
              <b>{providerOf(proxy.provider).label}</b>
              <span className="mono muted">
                {proxy.protocol === 'socks5' ? 'socks5://' : ''}
                {proxy.host}:{proxy.port}
                {proxy.username ? ` · ${proxy.username}` : ''}
              </span>
            </span>
            <label className="toggle" data-tip={proxy.enabled ? 'On: agents get it' : 'Off: agents don’t get it'}>
              <input type="checkbox" role="switch" aria-label="Use the proxy" checked={proxy.enabled} disabled={!!busy} onChange={(e) => void toggle(e.target.checked)} />
              <span />
            </label>
          </div>
          <div className="project-settings__move-actions">
            <button type="button" className="small" onClick={() => setEditing(true)}>
              <LuPencil /> Edit
            </button>
            <button type="button" className="small" disabled={!!busy} onClick={() => void doTest()}>
              {busy === 'test' ? <LuLoader className="spin" /> : <LuCircleCheck />} Test
            </button>
            <button type="button" className="small ghost" disabled={!!busy} onClick={() => void remove()}>
              <LuTrash2 /> Remove
            </button>
          </div>
          {test && <TestResult test={test} />}
        </>
      ) : (
        <div className="project-settings__move-actions">
          <button type="button" className="small" onClick={() => setEditing(true)}>
            <LuGlobe /> Set up a proxy
          </button>
        </div>
      )}
      {error && <p className="danger-text">{error}</p>}
      <span className="field__hint">
        For scraping and sites that block a server’s IP. Agents get it as <span className="mono">RESIDENTIAL_PROXY_URL</span> and use it only where it’s needed (it’s billed per GB); Claude Code’s own traffic never goes through it.
      </span>
      {editing && (
        <ProxyModal
          proxy={proxy ?? null}
          onClose={() => setEditing(false)}
          onSaved={(p, t) => {
            setProxy(p)
            setTest(t)
            setEditing(false)
          }}
        />
      )}
    </div>
  )
}

function ProxyModal({ proxy, onClose, onSaved }: { proxy: ProxyInfo | null; onClose: () => void; onSaved: (p: ProxyInfo, test: ProxyTest | null) => void }) {
  const [provider, setProvider] = useState(proxy?.provider ?? 'dataimpulse')
  const [protocol, setProtocol] = useState<'http' | 'socks5'>(proxy?.protocol ?? 'http')
  const [host, setHost] = useState(proxy?.host ?? providerOf('dataimpulse').host)
  const [port, setPort] = useState(String(proxy?.port ?? providerOf('dataimpulse').port))
  const [username, setUsername] = useState(proxy?.username ?? '')
  const [password, setPassword] = useState('')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const preset = providerOf(provider)

  const pickProvider = (v: string) => {
    setProvider(v)
    const p = providerOf(v)
    if (!p.host) return
    setHost(p.host)
    setPort(String(protocol === 'socks5' && p.socksPort ? p.socksPort : p.port))
  }
  const pickProtocol = (v: 'http' | 'socks5') => {
    setProtocol(v)
    // the provider's own port for that protocol, when it has one and the port is still its default
    if (preset.socksPort && (port === String(preset.port) || port === String(preset.socksPort))) setPort(String(v === 'socks5' ? preset.socksPort : preset.port))
  }
  const fromPaste = (raw: string) => {
    setPaste(raw)
    const p = parseProxy(raw)
    if (!p) return
    setHost(p.host)
    setPort(String(p.port))
    if (p.protocol) setProtocol(p.protocol)
    if (p.username !== undefined) setUsername(p.username)
    if (p.password !== undefined) setPassword(p.password)
    const known = PROVIDERS.find((x) => x.host && p.host.toLowerCase().endsWith(x.host.split('.').slice(-2).join('.')))
    setProvider(known?.value ?? 'custom')
  }

  const save = async (andTest: boolean) => {
    setBusy(true)
    setError('')
    try {
      const r = await call<{ proxy: ProxyInfo }>('/api/proxy', 'PUT', { enabled: proxy?.enabled ?? true, provider, protocol, host: host.trim(), port: Number(port), username: username.trim(), password })
      const t = andTest ? await call<ProxyTest>('/api/proxy/test', 'POST').catch((e: Error) => ({ ok: false, error: e.message })) : null
      onSaved(r.proxy, t)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Residential proxy" description="The gateway your provider gives you. Saved on the server; the password is never shown again." width={460}>
      <form
        className="modal__body proxy-form"
        onSubmit={(e) => {
          e.preventDefault()
          // it sits inside Office settings' form (React events cross portals): this submit is only this one's
          e.stopPropagation()
          void save(true)
        }}
      >
        <label className="field">
          <span className="field__label">Paste from your provider (optional)</span>
          <input value={paste} onChange={(e) => fromPaste(e.target.value)} placeholder="host:port:user:pass or http://user:pass@host:port" autoComplete="off" spellCheck={false} className="mono" />
          <span className="field__hint">Fills the fields below.</span>
        </label>
        <div className="field">
          <span className="field__label">Provider</span>
          <Select ariaLabel="Provider" value={provider} options={PROVIDERS.map(({ value, label }) => ({ value, label }))} onChange={pickProvider} />
          {preset.country && <span className="field__hint">A country: {preset.country}.</span>}
        </div>
        <div className="field">
          <span className="field__label">Protocol</span>
          <div className="seg proxy-form__seg">
            {(['http', 'socks5'] as const).map((p) => (
              <button type="button" key={p} className={protocol === p ? 'active' : ''} onClick={() => pickProtocol(p)}>
                {p === 'http' ? 'HTTP(S)' : 'SOCKS5'}
              </button>
            ))}
          </div>
        </div>
        <div className="proxy-form__row">
          <label className="field">
            <span className="field__label">Host</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="gw.example.com" autoComplete="off" spellCheck={false} required />
          </label>
          <label className="field proxy-form__port">
            <span className="field__label">Port</span>
            <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="823" required />
          </label>
        </div>
        <label className="field">
          <span className="field__label">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={proxy?.hasPassword ? 'Saved: leave empty to keep it' : ''} />
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={() => void save(false)}>
            Save
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save & test'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
