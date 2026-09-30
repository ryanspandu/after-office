import { useState } from 'react'
import { LuCheck, LuCrown, LuShieldCheck, LuX } from 'react-icons/lu'
import { liveApi, useLive } from '../state/live'
import { useDashboard } from '../state/dashboard'
import { useNow } from '../state/clock'
import { confirm } from './Confirm'
import { Modal } from './Modal'
import { CodeInput } from './TwoFactor'
import { DateTimeField } from './pickers'
import { tip } from './Tooltip'

// Boss mode: for a stretch the owner trusts the manager with (a night of work), it delegates, messages agents and
// sends work back without approvals, until a time picked here. Turned on only with the authenticator code; off at
// that time on its own, or from the navbar badge. The server enforces all of it (routes/work.ts, work/work.ts).

const HOURS = [4, 8, 12]
/** the longest it may run (the server checks the same) */
const MAX_DAYS = 7
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
/** "08:00" today, "Wed 08:00" within a week */
const when = (ms: number) => (new Date(ms).toDateString() === new Date().toDateString() ? time(ms) : new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))

/** Tomorrow 08:00: the usual end of a night of work. */
function tomorrowMorning() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}

/** On right now (the server ends it at `until`; the badge doesn't wait for that). */
export function useBossMode() {
  const b = useLive((s) => s.bossMode)
  const now = useNow(30_000).getTime()
  return b && b.until > now ? b : null
}

const turnOff = async () => {
  if (!(await confirm({ title: 'Turn Boss mode off?', message: "The manager's new tasks and messages ask for your approval again.", confirmLabel: 'Turn off', danger: false }))) return
  await liveApi.stopBossMode().catch(() => {})
}

/** The switch (Automation → Manager & hand-offs): on opens the confirmation, off turns it off. */
export function BossModeSwitch() {
  const boss = useBossMode()
  const [open, setOpen] = useState(false)
  return (
    <>
      <label className="switch-row">
        <span className="toggle">
          <input type="checkbox" role="switch" checked={!!boss} onChange={(e) => (e.target.checked ? setOpen(true) : void turnOff())} />
          <span />
        </span>
        <span>
          <span className="switch-row__label">
            Boss mode {boss && <span className="boss-chip">on until {when(boss.until)}</span>}
          </span>
          <span className="field__hint">
            The manager delegates, messages agents and sends work back without asking you, until a time you pick. Needs your two-factor code.
          </span>
        </span>
      </label>
      {open && <BossModeModal onClose={() => setOpen(false)} />}
    </>
  )
}

export function BossModeModal({ onClose }: { onClose: () => void }) {
  const waiting = useDashboard((s) => s.tasks.filter((t) => t.awaitingApproval).length)
  const [hours, setHours] = useState<number | 'until'>(8)
  const [until, setUntil] = useState(tomorrowMorning)
  const [runWaiting, setRunWaiting] = useState(true)
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
    try {
      await liveApi.startBossMode({ code: c, ...(hours === 'until' ? { until } : { hours }), runWaiting: runWaiting && waiting > 0 })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn it on')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Turn on Boss mode?" description="For work you trust the manager to run on its own." width={500}>
      <form
        className="modal__body boss-modal"
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
      >
        <div className="boss-modal__lists">
          <div>
            <span className="boss-modal__head">Without asking you</span>
            <ul>
              <li>
                <LuCheck /> New tasks start right away, also right after an agent's report
              </li>
              <li>
                <LuCheck /> Messages to any agent
              </li>
              <li>
                <LuCheck /> Sending work back for more rounds, no limit
              </li>
            </ul>
          </div>
          <div>
            <span className="boss-modal__head">Still asks you</span>
            <ul className="is-kept">
              <li>
                <LuShieldCheck /> Hiring agents
              </li>
              <li>
                <LuShieldCheck /> Connectors that write (email, deploys…)
              </li>
              <li>
                <LuShieldCheck /> Quality check commands, agents' own permission prompts
              </li>
            </ul>
          </div>
        </div>

        <div className="field">
          <span className="field__label">How long</span>
          <div className="seg boss-modal__hours">
            {HOURS.map((h) => (
              <button type="button" key={h} className={hours === h ? 'active' : ''} onClick={() => setHours(h)}>
                {h} hours
              </button>
            ))}
            <button type="button" className={hours === 'until' ? 'active' : ''} onClick={() => setHours('until')}>
              Until…
            </button>
          </div>
          {hours === 'until' && (
            <span className="boss-modal__time">
              <DateTimeField value={until} onChange={setUntil} min={Date.now()} max={Date.now() + MAX_DAYS * 86_400_000} ariaLabel="Boss mode ends at" />
            </span>
          )}
          <span className={`field__hint${tooSoon ? ' danger-text' : ''}`}>
            {tooSoon ? 'That time has passed: pick one in the future.' : `Ends ${when(end)} on its own (at most ${MAX_DAYS} days). You get a report of what the manager did.`}
          </span>
        </div>

        {waiting > 0 && (
          <label className="check">
            <input type="checkbox" checked={runWaiting} onChange={(e) => setRunWaiting(e.target.checked)} /> Also start the {waiting} task{waiting > 1 ? 's' : ''} waiting for your approval
          </label>
        )}

        <label className="field">
          <span className="field__label">Code from your authenticator app</span>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => void start(v)} autoFocus disabled={busy} />
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || code.length !== 6}>
            <LuCrown /> {busy ? 'Turning on…' : 'Turn on Boss mode'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** Navbar badge while it's on: when it ends; click to turn it off. */
export function BossModeBadge({ compact = false }: { compact?: boolean }) {
  const boss = useBossMode()
  if (!boss) return null
  return (
    <button className="boss-badge" onClick={() => void turnOff()} {...tip(`Boss mode: the manager works without your approval until ${when(boss.until)}. Click to turn it off.`)}>
      <LuCrown />
      {compact ? time(boss.until) : `Boss mode · until ${when(boss.until)}`}
      {!compact && <LuX className="boss-badge__x" />}
    </button>
  )
}
