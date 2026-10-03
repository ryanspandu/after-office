import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { LuGlobe, LuLoader, LuLock, LuShieldCheck, LuTriangleAlert, LuX } from 'react-icons/lu'
import { liveApi, useLive } from '../state/live'
import { useNow } from '../state/clock'
import { confirm } from './Confirm'
import { Modal } from './Modal'
import { CodeInput } from './TwoFactor'
import { DateTimeField } from './pickers'
import { tip } from './Tooltip'

// Public access: on a server whose domain lives on the tailnet (setup-vps.sh --tailscale --domain … --dns cloudflare),
// the dashboard can also be opened from the internet for a while: the server opens its web ports and points the domain
// at its public IP, then back once the time is up (a root helper does it, also when the dashboard is down).
// Tailscale stays on the whole time. Turned on only with the authenticator code.

const HOURS = [1, 4, 24]
/** the longest it may stay on (the server checks the same) */
const MAX_DAYS = 7
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const when = (ms: number) => (new Date(ms).toDateString() === new Date().toDateString() ? time(ms) : new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))
/** The navbar's short form: 04/10/2026, 11:23 (the full sentence is its tooltip). */
const short = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const label = (h: number) => (h === 24 ? '1 day' : `${h} hour${h > 1 ? 's' : ''}`)

/** On right now (with its end), or null. */
export function usePublicAccess() {
  const p = useLive((s) => s.publicAccess)
  const now = useNow(30_000).getTime()
  return p.supported && p.public && (p.until ?? 0) > now ? p : null
}

/** Opening or closing right now (the server is moving the ports and the domain): the badge and the switch show it. */
export const usePublicBusy = create<'opening' | 'closing' | null>(() => null)

const turnOff = async () => {
  if (!(await confirm({ title: 'Turn public access off?', message: 'The dashboard goes back to your tailnet only. Devices without Tailscale lose it within a minute or two.', confirmLabel: 'Turn off', danger: false }))) return
  usePublicBusy.setState('closing', true)
  const r = await liveApi.stopPublicAccess().catch((e: Error) => ({ warning: e.message }))
  usePublicBusy.setState(null, true)
  if (r && 'warning' in r && r.warning) void confirm({ title: 'Public access', message: r.warning, confirmLabel: 'OK', danger: false })
}

/** The switch (Automation → Access). Shown only where the server supports it. */
export function PublicAccessSwitch() {
  const info = useLive((s) => s.publicAccess)
  const on = usePublicAccess()
  const [open, setOpen] = useState(false)
  const busy = usePublicBusy()
  if (!info.supported) return null
  return (
    <>
      <label className="switch-row">
        <span className="toggle">
          <input type="checkbox" role="switch" checked={busy ? busy === 'opening' : !!on} disabled={!!busy} onChange={(e) => (e.target.checked ? setOpen(true) : void turnOff())} />
          <span />
        </span>
        <span>
          <span className="switch-row__label">
            Public access{' '}
            {busy ? (
              <span className={`boss-chip public-chip public-badge--busy public-badge--${busy}`}>
                <LuLoader className="spin" /> {busy === 'opening' ? 'Opening…' : 'Closing…'}
              </span>
            ) : (
              on?.until && <span className="boss-chip public-chip ui-pop">on until {when(on.until)}</span>
            )}
          </span>
          <span className="field__hint">
            Open {info.domain} from any device, without Tailscale, until a time you pick. Tailscale keeps working throughout. Needs your two-factor code.
          </span>
        </span>
      </label>
      {open && <PublicAccessModal domain={info.domain ?? 'the dashboard'} onClose={() => setOpen(false)} />}
    </>
  )
}

function PublicAccessModal({ domain, onClose }: { domain: string; onClose: () => void }) {
  const [hours, setHours] = useState<number | 'until'>(4)
  const [until, setUntil] = useState(() => Date.now() + 8 * 3_600_000)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const end = hours === 'until' ? until : Date.now() + hours * 3_600_000
  const tooSoon = hours === 'until' && until <= Date.now() + 60_000

  const start = async (c = code) => {
    if (busy || c.length !== 6) return
    if (tooSoon) return setError('Pick an end time in the future.')
    setBusy(true)
    setError('')
    usePublicBusy.setState('opening', true)
    try {
      await liveApi.startPublicAccess({ code: c, ...(hours === 'until' ? { until } : { hours }) })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn it on')
      setCode('')
    } finally {
      setBusy(false)
      usePublicBusy.setState(null, true)
    }
  }

  return (
    <Modal open onClose={onClose} title="Open the dashboard to the internet?" description={`${domain}, from any device, for a while.`} width={500}>
      <form
        className="modal__body boss-modal"
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
      >
        <div className="boss-modal__lists public-modal__lists">
          <div>
            <span className="boss-modal__head">While it's on</span>
            <ul>
              <li>
                <LuGlobe /> {domain} opens from any device, no Tailscale needed
              </li>
              <li>
                <LuTriangleAlert /> Anyone can reach the sign-in page (and the preview links)
              </li>
              <li>
                <LuTriangleAlert /> Takes a minute or two to reach every device (DNS)
              </li>
            </ul>
          </div>
          <div>
            <span className="boss-modal__head">Stays the same</span>
            <ul className="is-kept">
              <li>
                <LuShieldCheck /> Password and two-factor on every sign-in
              </li>
              <li>
                <LuLock /> Tailscale keeps working, and SSH isn't touched
              </li>
              <li>
                <LuLock /> Closes on its own at the time you pick, also if the dashboard is down
              </li>
            </ul>
          </div>
        </div>

        <div className="field">
          <span className="field__label">How long</span>
          <div className="seg boss-modal__hours">
            {HOURS.map((h) => (
              <button type="button" key={h} className={hours === h ? 'active' : ''} onClick={() => setHours(h)}>
                {label(h)}
              </button>
            ))}
            <button type="button" className={hours === 'until' ? 'active' : ''} onClick={() => setHours('until')}>
              Until…
            </button>
          </div>
          {hours === 'until' && (
            <span className="boss-modal__time">
              <DateTimeField value={until} onChange={setUntil} min={Date.now()} max={Date.now() + MAX_DAYS * 86_400_000} ariaLabel="Public access ends at" />
            </span>
          )}
          <span className={`field__hint${tooSoon ? ' danger-text' : ''}`}>
            {tooSoon ? 'That time has passed: pick one in the future.' : `Back to your tailnet only ${when(end)} (at most ${MAX_DAYS} days). You get a report and a notification when it opens and closes.`}
          </span>
        </div>

        <label className="field">
          <span className="field__label">Code from your authenticator app</span>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => void start(v)} autoFocus disabled={busy} />
        </label>
        {busy && <PublicSteps domain={domain} />}
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || code.length !== 6}>
            {busy ? <LuLoader className="spin" /> : <LuGlobe />} {busy ? 'Opening…' : 'Open to the internet'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** While it opens: what the server is doing, one step after another, under a moving bar. */
function PublicSteps({ domain }: { domain: string }) {
  const steps = ['Opening the web ports', `Pointing ${domain} at the server`, 'Checking it answers']
  const [at, setAt] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setAt((n) => Math.min(n + 1, steps.length - 1)), 1600)
    return () => clearInterval(t)
  }, [steps.length])
  return (
    <div className="public-progress" role="status">
      <span className="public-progress__bar" aria-hidden />
      <ol className="public-progress__steps">
        {steps.map((s, i) => (
          <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>
            {i < at ? <LuShieldCheck /> : i === at ? <LuLoader className="spin" /> : <span className="public-progress__dot" />} {s}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Navbar badge while it's on: until when (the date and time; the whole sentence in its tooltip); click to close it
 *  now. While it's opening or closing it says so, moving. */
export function PublicAccessBadge({ compact = false }: { compact?: boolean }) {
  const on = usePublicAccess()
  const busy = usePublicBusy()
  if (busy)
    return (
      <span className={`boss-badge public-badge public-badge--busy public-badge--${busy}`} role="status" {...tip(busy === 'opening' ? 'Opening the dashboard to the internet…' : 'Closing it: back to your tailnet only…')}>
        <LuLoader className="spin" />
        {compact ? null : busy === 'opening' ? 'Opening…' : 'Closing…'}
      </span>
    )
  if (!on?.until) return null
  return (
    <button className="boss-badge public-badge ui-pop" onClick={() => void turnOff()} {...tip(`Public access: ${on.domain} is open on the internet until ${when(on.until)}. Click to close it now.`)}>
      <LuGlobe />
      {compact ? time(on.until) : short(on.until)}
      {!compact && <LuX className="boss-badge__x" />}
    </button>
  )
}
