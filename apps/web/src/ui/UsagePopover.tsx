import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placePopover } from '../state/placePopover'
import { usePresence } from '../state/usePresence'
import { LuChevronDown, LuGauge, LuSettings } from 'react-icons/lu'
import { useClock, useNow } from '../state/clock'
import { useLive } from '../state/live'
import { useAutomationModal } from './AutomationModal'
import { useOffice } from '../state/store'
import { ago } from './FollowUps'

// Navbar "Plan usage" + popover with the plan's rate limits and each agent's context window, like Claude Desktop.
// Everything comes from Claude Code's statusline (rate_limits, context_window); no extra API calls.

const level = (pct: number) => (pct > 85 ? 'hot' : pct > 60 ? 'warm' : 'ok')

/** 91875 → "91.9k", 1000000 → "1M" */
export function compactTokens(n: number) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
  return String(n)
}

function resetsLabel(resetsAtSec: number | null, now: number, tz: string) {
  if (!resetsAtSec) return ''
  const ms = resetsAtSec * 1000 - now
  if (ms <= 0) return 'Resetting now'
  const mins = Math.round(ms / 60_000)
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return `Resets in ${h ? `${h} hr ` : ''}${m} min`
  }
  const when = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(resetsAtSec * 1000)
  return `Resets ${when}`
}

function Bar({ pct }: { pct: number }) {
  return (
    <span className={`usage-bar usage-bar--${level(pct)}`}>
      <span style={{ width: `${Math.min(100, Math.max(pct > 0 ? 1.5 : 0, pct))}%` }} />
    </span>
  )
}

export function UsageMeter() {
  const live = useOffice((s) => s.source === 'live')
  const rl = useLive((s) => s.rateLimits)
  const [open, setOpen] = useState(false)
  const presence = usePresence(open, 140)
  const [pos, setPos] = useState<{ top: number; left: number; transformOrigin?: string }>({ top: 0, left: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // after the popover is in the DOM, so its real width decides left- or right-alignment
  useLayoutEffect(() => {
    if (!open || !presence.mounted || !button.current) return
    setPos(placePopover(button.current, pop.current))
  }, [open, presence.mounted])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!live) return null
  const five = rl?.fiveHourPct ?? null
  // the 5-hour window when known, else the weekly one (so the navbar never jumps between a number and "–")
  const shown = five ?? rl?.sevenDayPct ?? null
  return (
    <>
      <button ref={button} className="metric metric--btn" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} data-tip={open ? undefined : 'Plan usage and context windows'}>
        <span className="metric__icon">
          <LuGauge />
        </span>
        <span className="metric__col">
          <span className="metric__label">
            Plan usage <LuChevronDown className="metric__chev" />
          </span>
          <span className="metric__value">
            {shown != null ? `${Math.round(shown)}%` : '–'}
            {five == null && shown != null && <span className="metric__unit"> wk</span>}
          </span>
          {/* always there, so the navbar keeps its height (a changing height resized the office and reset its zoom) */}
          <span className={`meter meter--${level(shown ?? 0)}`}>
            <span style={{ width: `${Math.min(100, shown ?? 0)}%` }} />
          </span>
        </span>
      </button>
      {presence.mounted &&
        createPortal(
          <div ref={pop} className={`popover usage-pop${presence.closing ? ' popover--closing' : ''}`} style={pos} role="dialog" aria-label="Plan usage">
            <UsageDetails onClose={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </>
  )
}

function UsageDetails({ onClose }: { onClose: () => void }) {
  const rl = useLive((s) => s.rateLimits)
  const agents = useOffice((s) => s.agents)
  const tz = useClock((s) => s.timezone)
  const now = useNow(30_000).getTime()
  const withContext = agents.filter((a) => a.status !== 'offline' && (a.contextPct != null || a.contextTokens != null))

  return (
    <>
      <section className="usage-pop__section">
        <h3>Context window</h3>
        {withContext.map((a) => {
          const pct = a.contextPct ?? (a.contextTokens && a.contextSize ? (a.contextTokens / a.contextSize) * 100 : 0)
          return (
            <div key={a.id} className="usage-row">
              <div className="usage-row__head">
                <span className="truncate">
                  {a.name} <span className="muted">· {a.modelName ?? a.model}</span>
                </span>
                <span className="muted usage-row__num">
                  {a.contextTokens != null && a.contextSize ? `${compactTokens(a.contextTokens)} / ${compactTokens(a.contextSize)} ` : ''}({Math.round(pct)}%)
                </span>
              </div>
              <Bar pct={pct} />
            </div>
          )
        })}
        {!withContext.length && <p className="muted usage-pop__empty">Shows up once an agent is running.</p>}
      </section>

      <section className="usage-pop__section">
        <h3>Plan usage limits</h3>
        {rl && (rl.fiveHourPct != null || rl.sevenDayPct != null) ? (
          <>
            {rl.fiveHourPct != null ? (
              <div className="usage-row">
                <div className="usage-row__head">
                  <span>5-hour limit</span>
                  <span className="muted usage-row__num">
                    {resetsLabel(rl.fiveHourResetsAt, now, tz)} <b>{Math.round(rl.fiveHourPct)}%</b>
                  </span>
                </div>
                <Bar pct={rl.fiveHourPct} />
              </div>
            ) : (
              <p className="muted usage-pop__empty">5-hour limit: not reported yet in this window.</p>
            )}
            {rl.sevenDayPct != null && (
              <div className="usage-row">
                <div className="usage-row__head">
                  <span>Weekly · all models</span>
                  <span className="muted usage-row__num">
                    {resetsLabel(rl.sevenDayResetsAt, now, tz)} <b>{Math.round(rl.sevenDayPct)}%</b>
                  </span>
                </div>
                <Bar pct={rl.sevenDayPct} />
              </div>
            )}
          </>
        ) : (
          <p className="muted usage-pop__empty">Appears after an agent's first reply.</p>
        )}
      </section>
      <BrakeLine onClose={onClose} />
      <p className="usage-pop__note">
        {rl?.checkedAt
          ? `As of ${ago(now - rl.checkedAt)}, when an agent last worked. `
          : 'As of an agent’s last reply. '}
        Usage from Claude desktop or claude.ai shows up here after an agent’s next reply.
      </p>
    </>
  )
}

/** Where the quota brake stands, with a way into its settings. */
function BrakeLine({ onClose }: { onClose: () => void }) {
  const settings = useLive((s) => s.settings)
  const paused = useLive((s) => s.automation.quotaPaused)
  if (!settings) return null
  return (
    <p className={`usage-pop__brake${paused ? ' is-paused' : ''}`}>
      {paused ? `Automatic work paused (${paused.replace(/ \(brake.*\)$/, '')})` : settings.quota.enabled ? `Quota brake at ${settings.quota.threshold}%` : 'Quota brake off'}
      <button
        type="button"
        className="icon-btn small ghost"
        data-tip="Quota brake settings"
        aria-label="Quota brake settings"
        onClick={() => {
          // close this popover first so it doesn't sit on top of the modal
          onClose()
          useAutomationModal.getState().setOpen(true)
        }}
      >
        <LuSettings />
      </button>
    </p>
  )
}
