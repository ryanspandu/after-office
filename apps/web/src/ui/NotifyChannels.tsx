import { useEffect, useState, type ReactNode } from 'react'
import { LuBell, LuPencil, LuSend, LuSmartphone, LuTrash2, LuWebhook } from 'react-icons/lu'
import { FaTelegram } from 'react-icons/fa'
import { api } from '../state/auth'
import { confirm } from './Confirm'
import { CodeInput } from './TwoFactor'
import { describeAgent } from './ProfileModal'
import { ago } from './FollowUps'
import { enablePush, pushState, pushSupport, removeDevice, testPush, thisDevice, type PushDevice } from '../pwa/push'

// Where push notifications go (Automation → Notifications): this app itself (Web Push), ntfy, Telegram, a webhook. Set up here instead of the
// server's .env; saving asks for the 2FA code (it sends the office's news somewhere new). Secrets are kept encrypted
// on the server and never come back: the list only shows a hint of each. A channel set in the .env wins and is
// read-only here.

type Name = 'ntfy' | 'telegram' | 'webhook'
type Status = Record<Name, { source: 'env' | 'dashboard' | null; preview?: string }>

const META: Record<Name, { label: string; icon: ReactNode; hint: string }> = {
  ntfy: { label: 'ntfy', icon: <LuBell />, hint: 'Install the ntfy app on your phone and subscribe to the same topic. Pick a topic nobody can guess.' },
  telegram: { label: 'Telegram', icon: <FaTelegram />, hint: 'Make a bot with @BotFather, send it a message, then use your chat ID (e.g. from @userinfobot).' },
  webhook: { label: 'Webhook', icon: <LuWebhook />, hint: 'POST JSON { event, title, text, url, at } to your URL (Slack, Discord, n8n…).' },
}

type Tab = Name | 'app'

export function NotifyChannels({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  // "This app" (Web Push) first: nothing to set up elsewhere
  const [tab, setTab] = useState<Tab>('app')
  const [editing, setEditing] = useState(false)
  const [appDevices, setAppDevices] = useState(0)
  useEffect(() => {
    api('/api/notify/channels')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => s && setStatus(s))
      .catch(() => {})
  }, [])

  const remove = async (name: Name) => {
    if (!(await confirm({ title: `Remove ${META[name].label}?`, message: 'Notifications stop going there.', confirmLabel: 'Remove', danger: true }))) return
    const r = await api(`/api/notify/channels/${name}`, { method: 'DELETE' })
    if (r.ok) setStatus(await r.json())
    onChanged()
  }

  const pick = (t: Tab) => {
    setTab(t)
    setEditing(false)
  }
  const tabs = (
    // one tab per channel; a dot on the ones in use
    <div className="seg channels__tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'app'} className={tab === 'app' ? 'active' : ''} onClick={() => pick('app')}>
        <LuSmartphone /> This app
        {appDevices > 0 && <span className="channels__dot" aria-label="on" />}
      </button>
      {(Object.keys(META) as Name[]).map((name) => (
        <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'active' : ''} onClick={() => pick(name)}>
          {META[name].icon} {META[name].label}
          {status?.[name].source && <span className="channels__dot" aria-label="set up" />}
        </button>
      ))}
    </div>
  )

  if (tab === 'app')
    return (
      <div className="channels">
        {tabs}
        <div key="app" className="ui-switch">
        <AppPush
          onDevices={(n) => {
            setAppDevices(n)
            onChanged()
          }}
        />
        </div>
      </div>
    )
  if (!status)
    return (
      <div className="channels">
        {tabs}
        <p className="muted">Loading…</p>
      </div>
    )
  const s = status[tab]
  const m = META[tab]
  return (
    <div className="channels">
      {tabs}
      <div key={tab} className={`channel ui-switch${s.source ? ' is-on' : ''}`}>
        <div className="channel__row">
          <span className="channel__body">
            <b>{s.source === 'env' ? "Set in the server's .env" : s.source ? 'Sending here' : 'Not set up'}</b>
            <span className="muted truncate">{s.source === 'dashboard' ? s.preview : s.source === 'env' ? 'Change it there, then restart the server.' : m.hint}</span>
          </span>
          {s.source !== 'env' && !editing && (
            <span className="channel__actions">
              <button className="small" onClick={() => setEditing(true)}>
                {s.source ? <LuPencil /> : null} {s.source ? 'Change' : 'Set up'}
              </button>
              {s.source && (
                <button className="icon-btn small ghost" aria-label={`Remove ${m.label}`} onClick={() => void remove(tab)}>
                  <LuTrash2 />
                </button>
              )}
            </span>
          )}
        </div>
        {editing && (
          <div className="ui-drop">
          <ChannelForm
            key={tab}
            name={tab}
            hasSaved={!!s.source}
            onCancel={() => setEditing(false)}
            onSaved={(next) => {
              setStatus(next)
              setEditing(false)
              onChanged()
            }}
          />
          </div>
        )}
      </div>
    </div>
  )
}

const WHY: Record<string, string> = {
  'ios-install': 'On iPhone and iPad, notifications work in the app on your Home Screen: tap Share → Add to Home Screen, open it from there, and turn them on here.',
  insecure: 'Notifications need the dashboard over HTTPS (your VPS address), not plain http.',
  'no-worker': 'Available in the installed app or the production build (not the dev server). Reload once if you just opened it.',
  unsupported: "This browser can't show notifications from web apps.",
  denied: 'Notifications are blocked for this site: allow them in the browser (site settings), then come back.',
}

/** Notifications from the dashboard app itself, on this device and the others that turned them on. */
function AppPush({ onDevices }: { onDevices: (n: number) => void }) {
  const [support, setSupport] = useState<Awaited<ReturnType<typeof pushSupport>> | null>(null)
  const [devices, setDevices] = useState<PushDevice[] | null>(null)
  const [mine, setMine] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const show = (list: PushDevice[]) => {
    setDevices(list)
    onDevices(list.length)
  }
  useEffect(() => {
    void (async () => {
      const sup = await pushSupport()
      setSupport(sup)
      try {
        show((await pushState()).devices)
        if (sup.ok) setMine(await thisDevice(sup.reg))
      } catch {
        setDevices([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await f()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Something went wrong' })
    } finally {
      setBusy(false)
    }
  }
  const turnOn = () =>
    run(async () => {
      if (!support?.ok) return
      const r = await enablePush(support.reg, describeAgent(navigator.userAgent).label)
      setMine(r.id)
      show(r.devices)
      const t = await testPush(r.id)
      setMsg(t.results[0]?.ok ? { ok: true, text: 'On. A test notification is on its way.' } : { ok: false, text: t.results[0]?.error ?? 'Turned on, but the test failed' })
    })
  const test = (id?: string) =>
    run(async () => {
      const t = await testPush(id)
      show(t.devices)
      const bad = t.results.filter((x) => !x.ok)
      setMsg(bad.length ? { ok: false, text: bad.map((b) => `${b.device}: ${b.error}`).join('; ') } : { ok: true, text: 'Sent.' })
    })
  const remove = (d: PushDevice) =>
    run(async () => {
      const r = await removeDevice(d.id, support?.ok ? support.reg : null, d.id === mine)
      if (d.id === mine) setMine(null)
      show(r.devices)
    })

  return (
    <div className={`channel${devices?.length ? ' is-on' : ''}`}>
      <div className="channel__row">
        <span className="channel__body">
          <b>{mine ? 'On for this device' : 'Notifications from this app'}</b>
          <span className="muted">
            {support && !support.ok ? WHY[support.why] : mine ? 'A tap on one opens what it is about.' : 'Straight to this phone or computer, no other app needed. Android, desktop browsers, and iPhone (from the Home Screen app).'}
          </span>
        </span>
        {support?.ok && (
          <span className="channel__actions">
            {mine ? (
              <button className="small" onClick={() => void test(mine)} disabled={busy}>
                <LuSend /> Test
              </button>
            ) : (
              <button className="small accent" onClick={() => void turnOn()} disabled={busy}>
                <LuBell /> {busy ? 'Turning on…' : 'Turn on here'}
              </button>
            )}
          </span>
        )}
      </div>
      {msg && <p className={`channel__msg ${msg.ok ? 'is-ok' : 'danger-text'}`}>{msg.text}</p>}
      {!!devices?.length && (
        <ul className="channel__devices">
          {devices.map((d) => (
            <li key={d.id}>
              <span className="grow truncate">
                {d.label}
                {d.id === mine && <span className="muted"> · this device</span>}
              </span>
              <span className="muted">{d.lastOkAt ? `last sent ${ago(Date.now() - d.lastOkAt)}` : `added ${ago(Date.now() - d.createdAt)}`}</span>
              <button className="icon-btn small ghost" aria-label={`Remove ${d.label}`} onClick={() => void remove(d)} disabled={busy}>
                <LuTrash2 />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ChannelForm({ name, hasSaved, onCancel, onSaved }: { name: Name; hasSaved: boolean; onCancel: () => void; onSaved: (s: Status) => void }) {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filled = name === 'telegram' ? (!!token.trim() || hasSaved) && !!chatId.trim() : !!url.trim()

  const save = async (c = code) => {
    if (busy || !filled || c.length !== 6) return
    setBusy(true)
    setError('')
    try {
      const body = name === 'ntfy' ? { url, token, keepToken: hasSaved && !token } : name === 'telegram' ? { token, chatId, keepToken: hasSaved && !token } : { url }
      const r = await api(`/api/notify/channels/${name}`, { method: 'PUT', body: JSON.stringify({ ...body, code: c }) })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error ?? 'Could not save')
      onSaved(data as Status)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="channel__form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {hasSaved && <p className="field__hint">{META[name].hint}</p>}
      {name !== 'telegram' && (
        <label className="field">
          <span className="field__label">{name === 'ntfy' ? 'Topic URL' : 'Webhook URL'}</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={name === 'ntfy' ? 'https://ntfy.sh/your-secret-topic' : 'https://…'} autoComplete="off" spellCheck={false} autoFocus />
        </label>
      )}
      {name !== 'webhook' && (
        <label className="field">
          <span className="field__label">{name === 'ntfy' ? 'Access token (optional)' : 'Bot token'}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasSaved ? 'Leave empty to keep the saved one' : name === 'ntfy' ? 'tk_… (protected topic or your own server)' : '123456789:AA…'}
            autoComplete="off"
            data-1p-ignore
            autoFocus={name === 'telegram'}
          />
        </label>
      )}
      {name === 'telegram' && (
        <label className="field">
          <span className="field__label">Chat ID</span>
          <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="123456789" autoComplete="off" spellCheck={false} />
        </label>
      )}
      <label className="field">
        <span className="field__label">Code from your authenticator app</span>
        <CodeInput value={code} onChange={setCode} onComplete={(v) => void save(v)} disabled={busy || !filled} />
      </label>
      {error && <p className="danger-text">{error}</p>}
      <div className="channel__form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !filled || code.length !== 6}>
          <LuSend /> {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
