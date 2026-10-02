import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { OwnerAvatar } from './EditProfile'
import { useShallow } from 'zustand/react/shallow'
import { createPortal } from 'react-dom'
import { usePresence } from '../state/usePresence'
import { LuMonitorDown, LuShare, LuSmartphone, LuBell, LuBot, LuCoins, LuCpu, LuLogOut, LuMaximize2, LuCrown, LuMemoryStick, LuMenu, LuMinimize2, LuMoon, LuSun, LuSunMoon } from 'react-icons/lu'
import { useAuth } from '../state/auth'
import { TIMEZONES, useClock, useNow, zonedParts, type ThemeMode } from '../state/clock'
import { formatTokens, rangeBounds, useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { DateRangePicker } from './DateRangePicker'
import { Select } from './Select'
import { tip } from './Tooltip'
import { UsageMeter } from './UsagePopover'
import { BossModeBadge } from './BossMode'
import { PublicAccessBadge } from './PublicAccess'
import { AutomationButton, useAutomationModal } from './AutomationModal'
import { useLive } from '../state/live'
import { useManager, useManagerPanel } from './ManagerPanel'
import { canOfferInstall, installApp, useInstall } from '../pwa/install'
import { useProfileModal } from './ProfileModal'
import { Brand } from './Brand'

const TZ_OPTIONS = TIMEZONES.map((t) => ({ value: t.tz, label: t.label }))

const MODES: { id: ThemeMode; icon: ReactNode; title: string; short: string }[] = [
  { id: 'auto', icon: <LuSunMoon />, title: 'Follow the office clock', short: 'Auto' },
  { id: 'day', icon: <LuSun />, title: 'Always day', short: 'Day' },
  { id: 'night', icon: <LuMoon />, title: 'Always night', short: 'Night' },
]

export function Navbar() {
  const { metrics, usage, range, fullscreen, toggleFullscreen } = useDashboard(useShallow((s) => ({ metrics: s.metrics, usage: s.usage, range: s.range, fullscreen: s.fullscreen, toggleFullscreen: s.toggleFullscreen })))
  const agents = useOffice((s) => s.agents)
  const { timezone, mode, setTimezone, setMode } = useClock(useShallow((s) => ({ timezone: s.timezone, mode: s.mode, setTimezone: s.setTimezone, setMode: s.setMode })))
  const { user, logout } = useAuth()

  const [from, to] = rangeBounds(range)
  const tokens = useMemo(() => {
    let input = 0
    let output = 0
    for (const u of usage) if (u.date >= from && u.date <= to) (input += u.input), (output += u.output)
    return { input, output, total: input + output }
  }, [usage, from, to])

  const online = agents.filter((a) => a.status !== 'offline').length
  const busy = agents.filter((a) => a.status === 'working' || a.status === 'waiting' || a.status === 'meeting').length
  // nothing measured yet (first moments in live mode): dashes, not a jump from 0
  const measured = metrics.memTotalGb > 0
  const memPct = measured ? (metrics.memUsedGb / metrics.memTotalGb) * 100 : 0
  // phones: timezone, theme and the account move into a menu (no fullscreen: the office already fills the screen) next to the clock
  const mobile = useMediaQuery(MOBILE)
  const live = useOffice((s) => s.source === 'live')
  const paused = useLive((s) => s.automation.quotaPaused)
  const tzSelect = (
    <Select
      ariaLabel="Timezone"
      searchable
      className="tz-select"
      value={timezone}
      options={TZ_OPTIONS}
      onChange={setTimezone}
      // closed control shows just "Jakarta · UTC+7"
      display={(o) => o.label.replace(/ · [^·]+ · /, ' · ')}
    />
  )

  return (
    <header className="navbar">
      <div className="brand">
        <Brand />
      </div>

      <div className="nav-metrics">
        <Meter icon={<LuCpu />} label="CPU" value={measured ? `${metrics.cpu.toFixed(0)}%` : '–'} pct={metrics.cpu} />
        <Meter icon={<LuMemoryStick />} label="RAM" value={measured ? `${metrics.memUsedGb.toFixed(1)} / ${metrics.memTotalGb} GB` : '–'} pct={memPct} />
        <div className="metric" data-tip={`${busy} busy · ${online} online · ${agents.length - online} offline`}>
          <span className="metric__icon">
            <LuBot />
          </span>
          <div>
            <span className="metric__label">Agents busy</span>
            <span className="metric__value">
              {busy}
              <span className="metric__of">/{online}</span>
            </span>
          </div>
        </div>
        <UsageMeter />
        <div className="metric metric--tokens" data-tip={`input ${tokens.input.toLocaleString()} · output ${tokens.output.toLocaleString()}`}>
          <span className="metric__icon">
            <LuCoins />
          </span>
          <div>
            <span className="metric__label">Tokens</span>
            <span className="metric__value">
              {formatTokens(tokens.total)}
              <small>
                {' '}
                in {formatTokens(tokens.input)} · out {formatTokens(tokens.output)}
              </small>
            </span>
          </div>
        </div>
        <DateRangePicker />
      </div>

      <div className="nav-right">
        <div className="clock">
          <ClockTime timezone={timezone} />
          {!mobile && tzSelect}
        </div>
        <BossModeBadge compact={mobile} />
        <PublicAccessBadge compact={mobile} />
        {mobile ? (
          <NavMenu>
            <div className="nav-menu__section">
              <span className="nav-menu__label">Timezone</span>
              {tzSelect}
            </div>
            <div className="nav-menu__section">
              <span className="nav-menu__label">Theme</span>
              <div className="seg nav-menu__seg">
                {MODES.map((m) => (
                  <button key={m.id} aria-label={m.title} className={mode === m.id ? 'active' : ''} onClick={() => setMode(m.id)}>
                    {m.icon} {m.short}
                  </button>
                ))}
              </div>
            </div>
            {live && (
              <button className="nav-menu__item" onClick={() => useAutomationModal.getState().setOpen(true)}>
                <LuBell /> Notifications & quota brake{paused ? ' (paused)' : ''}
              </button>
            )}
            <InstallMenuItem />
            <div className="nav-menu__user">
              <button className="nav-menu__profile" onClick={() => useProfileModal.getState().setOpen(true)}>
                <OwnerAvatar className="avatar--xs" />
                <span className="grow truncate">
                  Signed in as <b>{user}</b>
                </span>
              </button>
              <button className="small" onClick={logout}>
                <LuLogOut /> Sign out
              </button>
            </div>
          </NavMenu>
        ) : (
          <>
            <InstallButton />
            <AutomationButton />
            <ManagerButton />
            <div className="seg">
              {MODES.map((m) => (
                <button key={m.id} data-tip={m.title} aria-label={m.title} className={mode === m.id ? 'active' : ''} onClick={() => setMode(m.id)}>
                  {m.icon}
                </button>
              ))}
            </div>
            <button className="icon-btn" {...tip(fullscreen ? 'Show panels' : 'Fullscreen office')} onClick={toggleFullscreen}>
              {fullscreen ? <LuMinimize2 /> : <LuMaximize2 />}
            </button>
            <div className="user-chip">
              <button className="user-chip__profile" data-tip={`Signed in as ${user} · profile and devices`} onClick={() => useProfileModal.getState().setOpen(true)}>
                <OwnerAvatar className="avatar--xs" />
                <span className="user-chip__name">{user}</span>
              </button>
              <button className="icon-btn small ghost" data-tip="Sign out" aria-label="Sign out" onClick={logout}>
                <LuLogOut />
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  )
}

/** The ticking time: its own component, so only these few characters re-render every second (not the navbar). */
function ClockTime({ timezone }: { timezone: string }) {
  const clock = zonedParts(useNow(1000), timezone)
  return (
    <b>
      {clock.hhmm}
      <span className="clock__sec">:{String(clock.second).padStart(2, '0')}</span>
    </b>
  )
}

/** Desktop: install as an app (only when the browser offers it). */
function InstallButton() {
  const s = useInstall()
  if (!s.prompt || s.installed) return null
  return (
    <button className="icon-btn" {...tip('Install After Office as an app')} onClick={() => void installApp()}>
      <LuMonitorDown />
    </button>
  )
}

/** Phones: install (Android) or how to add it to the home screen (iPhone / iPad). */
function InstallMenuItem() {
  const s = useInstall()
  const [howTo, setHowTo] = useState(false)
  if (!canOfferInstall(s)) return null
  if (s.prompt)
    return (
      <button className="nav-menu__item" onClick={() => void installApp()}>
        <LuSmartphone /> Install app
      </button>
    )
  return (
    <>
      <button className="nav-menu__item" onClick={() => setHowTo((v) => !v)} aria-expanded={howTo}>
        <LuSmartphone /> Add to Home Screen
      </button>
      {howTo && (
        <p className="nav-menu__hint">
          In Safari, tap <LuShare /> <b>Share</b>, then <b>Add to Home Screen</b>. After Office then opens full screen, like an app.
        </p>
      )}
    </>
  )
}

function Meter({ icon, label, value, pct }: { icon: ReactNode; label: string; value: string; pct: number }) {
  const level = pct > 85 ? 'hot' : pct > 60 ? 'warm' : 'ok'
  return (
    <div className="metric">
      <span className="metric__icon">{icon}</span>
      <div>
        <span className="metric__label">{label}</span>
        <span className="metric__value">{value}</span>
        <span className={`meter meter--${level}`}>
          <span style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      </div>
    </div>
  )
}

/** Claude subscription usage (5-hour and 7-day windows) as reported by Claude Code's statusline. Live mode only. */

/** Phones: the burger button and its dropdown (timezone, theme, account). */
/**
 * Phones: the menu button floats on the 3D stage, bottom right (the reload button is bottom left), and the menu opens
 * upwards from it. The button is rendered into the stage (a portal), the menu into the page.
 */
function NavMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const presence = usePresence(open, 140)
  const [pos, setPos] = useState<{ bottom: number; right: number }>({ bottom: 0, right: 12 })
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  // the stage mounts after the navbar: look for it once the page is there
  const [stage, setStage] = useState<HTMLElement | null>(null)
  useEffect(() => setStage(document.querySelector<HTMLElement>('.stage')), [])

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const r = button.current.getBoundingClientRect()
    setPos({ bottom: window.innerHeight - r.top + 8, right: Math.max(12, window.innerWidth - r.right) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // clicks in the timezone dropdown (rendered in a portal) belong to the menu
      if (pop.current?.contains(t) || button.current?.contains(t) || t.closest?.('.rs__menu-portal')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      {stage &&
        createPortal(
          <button ref={button} className="nav-burger" aria-label="Menu" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <LuMenu />
          </button>,
          stage,
        )}
      {presence.mounted &&
        createPortal(
          <div
            ref={pop}
            className={`popover nav-menu nav-menu--up${presence.closing ? ' popover--closing' : ''}`}
            style={pos}
            role="dialog"
            aria-label="Menu"
            // an item that opens something (profile, notifications, fullscreen, install) closes the menu first, so it
            // never sits on top of what it opened; theme and timezone keep it open
            onClick={(e) => {
              const item = (e.target as HTMLElement).closest('.nav-menu__item, .nav-menu__profile')
              if (item && !item.hasAttribute('aria-expanded')) setOpen(false)
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}

/** Desktop: open the manager's panel; the badge counts replies you haven't read. */
function ManagerButton() {
  const manager = useManager()
  const setOpen = useManagerPanel((s) => s.setOpen)
  if (!manager) return null
  return (
    <button className="manager-btn" onClick={() => setOpen(true)} {...tip(manager.unread ? `${manager.unread} new from the manager` : 'Talk to the manager')}>
      <LuCrown /> Manager
      {!!manager.unread && <span className="icon-btn__count">{manager.unread > 9 ? '9+' : manager.unread}</span>}
    </button>
  )
}
